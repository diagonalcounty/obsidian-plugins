/*
  Blinks — better block links for Obsidian
  Trigger: type ^^ inside a wikilink (open OR already closed with ]])
    e.g. pick file → [[Note]] → step before ]] → type ^^ → block picker
  Storage: [[note#^readable-slug]]  (writes ^slug on target if missing)
*/

const {
  Plugin,
  EditorSuggest,
  Notice,
  Modal,
  FuzzySuggestModal,
} = require("obsidian");

/**
 * Find a Blinks trigger at the cursor: [[path^^query]] or [[path^^query
 * Works when the link is already closed with ]].
 * @returns {{ path: string, query: string, start: number, end: number, justAfterCarets: boolean } | null}
 */
function parseBlinksAtCursor(line, ch) {
  const left = line.slice(0, ch);
  const openIdx = left.lastIndexOf("[[");
  if (openIdx < 0) return null;

  // Don't use a [[ that is already closed before the cursor without ^^
  const closedBefore = left.lastIndexOf("]]");
  if (closedBefore > openIdx && !left.slice(openIdx, ch).includes("^^")) {
    return null;
  }

  const rest = line.slice(openIdx);
  // path: no ] # newline; may include |alias
  // query: up to ] or end; optional trailing ]]
  const m = rest.match(/^\[\[([^\[\]#\n]+?)\^\^([^\]\n]*)(?:\]\])?/);
  if (!m) return null;

  const start = openIdx;
  const end = openIdx + m[0].length;
  if (ch < start || ch > end) return null;

  let path = m[1].trim();
  if (path.includes("|")) path = path.split("|")[0].trim();
  if (!path) return null;

  const before = line.slice(0, ch);
  return {
    path,
    query: m[2] || "",
    start,
    end,
    justAfterCarets: before.endsWith("^^"),
  };
}

// ─── text helpers ───────────────────────────────────────────────────────────

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_`~\[\](){}|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripBlockId(line) {
  return line.replace(/\s+\^([a-zA-Z0-9-]+)\s*$/, "");
}

function existingBlockId(line) {
  const m = line.match(/\s+\^([a-zA-Z0-9-]+)\s*$/);
  return m ? m[1] : null;
}

function slugifyWords(text, wordCount) {
  const words = normalizeText(text)
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 1 || /^\d+$/.test(w));
  const take = words.slice(0, Math.max(2, wordCount));
  let slug = take.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug) slug = "block";
  if (slug.length > 48) slug = slug.slice(0, 48).replace(/-[^-]*$/, "") || slug.slice(0, 48);
  return slug;
}

/** Levenshtein distance capped for short strings */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

function wordFuzzyMatch(qWord, tWords) {
  if (tWords.some((w) => w === qWord)) return 1;
  if (tWords.some((w) => w.startsWith(qWord) || qWord.startsWith(w))) return 0.85;
  if (tWords.some((w) => w.includes(qWord) && qWord.length >= 3)) return 0.7;
  let best = 0;
  for (const w of tWords) {
    if (Math.abs(w.length - qWord.length) > 2) continue;
    const d = editDistance(qWord, w);
    const maxLen = Math.max(w.length, qWord.length);
    if (d <= 1 && maxLen >= 4) best = Math.max(best, 0.75);
    else if (d <= 2 && maxLen >= 6) best = Math.max(best, 0.55);
  }
  return best;
}

/**
 * Score how well query matches block text.
 * Higher is better. Empty query → 0 (caller may still list all).
 */
function scorePhrase(query, blockText, section) {
  const q = normalizeText(query);
  const t = normalizeText(blockText);
  if (!q) return 0;
  if (!t) return -1;

  let score = 0;

  // Exact phrase substring (core Craft gap)
  if (t.includes(q)) {
    score += 200 + Math.min(q.length, 40);
    // Prefer earlier occurrence slightly
    const idx = t.indexOf(q);
    score += Math.max(0, 20 - Math.floor(idx / 20));
  } else {
    // Contiguous multi-word windows
    const qWords = q.split(" ").filter(Boolean);
    const tWords = t.split(" ").filter(Boolean);
    if (!qWords.length) return -1;

    let wordHits = 0;
    let fuzzySum = 0;
    for (const qw of qWords) {
      const hit = wordFuzzyMatch(qw, tWords);
      if (hit > 0) {
        wordHits++;
        fuzzySum += hit;
      }
    }
    if (wordHits === 0) return -1;

    const coverage = wordHits / qWords.length;
    score += coverage * 80 + fuzzySum * 15;

    // Bonus if query words appear in order as subsequence
    let ti = 0;
    let ordered = 0;
    for (const qw of qWords) {
      while (ti < tWords.length) {
        if (wordFuzzyMatch(qw, [tWords[ti]]) >= 0.7) {
          ordered++;
          ti++;
          break;
        }
        ti++;
      }
    }
    score += (ordered / qWords.length) * 30;

    if (coverage < 0.5 && fuzzySum < qWords.length * 0.5) return -1;
  }

  // Light section boost for journal when query looks personal
  const sec = normalizeText(section);
  if (sec.includes("journal") && score > 0) score += 5;
  if (sec.includes("gospel") && score > 0) score += 2;

  // Mild demotion for pure boilerplate lines when query is richer
  const preview = t.slice(0, 40);
  if (/^full story$/.test(t) && q !== "full story") score -= 40;

  return score;
}

function previewText(line, maxLen) {
  let s = stripBlockId(line)
    .replace(/^#{1,6}\s*/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s || "(empty)";
}

function headingSlug(headingLine) {
  const raw = headingLine.replace(/^#{1,6}\s*/, "").trim();
  // Namespace headings like "# #Journal" → journal
  const cleaned = raw.replace(/^#\s*/, "").trim();
  return normalizeText(cleaned).replace(/\s+/g, "-") || "body";
}

/**
 * Parse note content into linkable blocks (non-empty content lines).
 * @returns {{ line: number, text: string, section: string, sectionRaw: string }[]}
 * line is 0-based index into lines array
 */
function parseBlocks(content) {
  const lines = content.split("\n");
  const blocks = [];
  let section = "body";
  let sectionRaw = "";
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") inFrontmatter = false;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    // Also treat vault namespace lines like "# #Journal" (already matched)
    // And "#Chrissy..." as both heading and block content
    if (headingMatch) {
      section = headingSlug(line);
      sectionRaw = headingMatch[2].trim();
      // Headings are selectable blocks too (hub tables, etc.)
      if (stripBlockId(line).replace(/^#{1,6}\s*/, "").trim()) {
        blocks.push({
          line: i,
          text: line,
          section,
          sectionRaw,
        });
      }
      continue;
    }

    // Skip pure empty / only block-id lines
    const stripped = stripBlockId(line).trim();
    if (!stripped) continue;

    // Skip horizontal rules and code fence markers
    if (/^(-{3,}|\*{3,}|_{3,}|`{3,})/.test(stripped)) continue;

    blocks.push({
      line: i,
      text: line,
      section,
      sectionRaw,
    });
  }

  return blocks;
}

function collectUsedIds(content) {
  const used = new Set();
  const re = /\^([a-zA-Z0-9-]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) used.add(m[1]);
  return used;
}

function makeUniqueSlug(base, used) {
  let slug = base;
  let n = 2;
  while (used.has(slug)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

function preferredSlugForBlock(blockText, used, startWords) {
  let words = startWords || 4;
  let slug = slugifyWords(stripBlockId(blockText), words);
  // Grow word count if collision on base form until unique or max
  while (used.has(slug) && words < 10) {
    words++;
    const grown = slugifyWords(stripBlockId(blockText), words);
    if (grown !== slug && !used.has(grown)) {
      slug = grown;
      break;
    }
    slug = grown;
  }
  return makeUniqueSlug(slug, used);
}

function rankBlocks(blocks, query, limit) {
  const q = (query || "").trim();
  if (!q) {
    return blocks.slice(0, limit).map((b, i) => ({
      ...b,
      score: 0,
      rank: i,
    }));
  }

  const scored = [];
  for (const b of blocks) {
    const score = scorePhrase(q, b.text, b.sectionRaw || b.section);
    if (score < 0) continue;
    scored.push({ ...b, score });
  }
  scored.sort((a, b) => b.score - a.score || a.line - b.line);
  return scored.slice(0, limit).map((b, i) => ({ ...b, rank: i }));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Opening words of a line as comparable tokens (same rules as slugify). */
function openingWords(lineText) {
  return normalizeText(stripBlockId(lineText))
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 1 || /^\d+$/.test(w));
}

/**
 * True when a readable block slug no longer matches the line's opening words.
 * Skips native-looking random hex ids (e.g. fa5d4c).
 */
function slugDrifted(oldId, lineText) {
  if (!oldId) return false;
  if (/^[a-f0-9]{6,8}$/i.test(oldId)) return false;

  const oldBase = oldId.replace(/-\d+$/, "");
  for (let n = 2; n <= 10; n++) {
    if (slugifyWords(stripBlockId(lineText), n) === oldBase) return false;
  }

  const textWords = openingWords(lineText);
  const oldWords = oldBase.split("-").filter(Boolean);
  if (!oldWords.length) return false;

  // Still an exact prefix of current opening words → aligned
  if (
    oldWords.length <= textWords.length &&
    oldWords.every((w, i) => textWords[i] === w)
  ) {
    return false;
  }

  return true;
}

function proposeSlugForLine(lineText, usedIds, oldId) {
  const used = new Set(usedIds);
  if (oldId) used.delete(oldId);
  return preferredSlugForBlock(lineText, used, 4);
}

// ─── plugin ─────────────────────────────────────────────────────────────────

class BlinksPlugin extends Plugin {
  async onload() {
    this._modalOpen = false;
    this._lastMissingPath = "";
    this._slugAlignTimer = null;
    this._slugAlignPromptOpen = false;
    /** @type {Set<string>} keys user dismissed this session */
    this._slugAlignDismissed = new Set();

    // Primary door: modal when ^^ is typed inside a wikilink (open or closed ]])
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor) => {
        this.onEditorChange(editor);
      })
    );

    // Secondary: inline suggest while typing a query after ^^ (also allows ]])
    this.registerEditorSuggest(new BlinksBlockSuggest(this));

    this.addCommand({
      id: "blinks-link-block",
      name: "Insert block link (pick note…)",
      editorCallback: (editor) => {
        new FileThenBlockModal(this, editor).open();
      },
    });

    this.addCommand({
      id: "blinks-link-block-current",
      name: "Insert block link in current note",
      editorCheckCallback: (checking, editor) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          new BlockPickerModal(this, editor, file, {}).open();
        }
        return true;
      },
    });

    this.addCommand({
      id: "blinks-link-block-at-cursor",
      name: "Insert block link for wikilink at cursor",
      editorCheckCallback: (checking, editor) => {
        const cur = editor.getCursor();
        const line = editor.getLine(cur.line);
        // Allow [[Note]] without ^^ — open picker for that note
        const hit = parseBlinksAtCursor(line, cur.ch) || parsePlainWikilinkAtCursor(line, cur.ch);
        if (!hit) return false;
        if (!checking) this.openPickerForHit(editor, hit, cur.line);
        return true;
      },
    });

    this.addCommand({
      id: "blinks-realign-slug-at-cursor",
      name: "Realign block slug at cursor (update links)",
      editorCheckCallback: (checking, editor) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        const cur = editor.getCursor();
        const line = editor.getLine(cur.line);
        const id = existingBlockId(line);
        if (!id) return false;
        if (!checking) {
          this.promptSlugAlign(editor, file, cur.line, line, id, true);
        }
        return true;
      },
    });

    console.log("Blinks loaded — pick a note, step before ]], type ^^");
  }

  onunload() {
    if (this._slugAlignTimer) {
      window.clearTimeout(this._slugAlignTimer);
      this._slugAlignTimer = null;
    }
  }

  onEditorChange(editor) {
    if (this._modalOpen || this._slugAlignPromptOpen) return;
    if (!editor || typeof editor.getCursor !== "function") return;

    let cur;
    try {
      cur = editor.getCursor();
    } catch (_) {
      return;
    }

    const line = editor.getLine(cur.line);
    const hit = parseBlinksAtCursor(line, cur.ch);
    if (hit && hit.justAfterCarets) {
      this.openPickerForHit(editor, hit, cur.line);
      return;
    }

    // Debounced: prompt if a readable ^slug drifted from opening words
    this.scheduleSlugAlignCheck(editor);
  }

  scheduleSlugAlignCheck(editor) {
    if (this._slugAlignTimer) window.clearTimeout(this._slugAlignTimer);
    this._slugAlignTimer = window.setTimeout(() => {
      this._slugAlignTimer = null;
      this.maybePromptSlugAlign(editor);
    }, 1400);
  }

  async maybePromptSlugAlign(editor) {
    if (this._modalOpen || this._slugAlignPromptOpen) return;
    if (!editor || typeof editor.getCursor !== "function") return;

    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    let cur;
    try {
      cur = editor.getCursor();
    } catch (_) {
      return;
    }

    const lineNo = cur.line;
    const line = editor.getLine(lineNo);
    const oldId = existingBlockId(line);
    if (!oldId) return;
    if (!slugDrifted(oldId, line)) return;

    const dismissKey = `${file.path}::${oldId}`;
    if (this._slugAlignDismissed.has(dismissKey)) return;

    await this.promptSlugAlign(editor, file, lineNo, line, oldId, false);
  }

  /**
   * @param {boolean} force — from command; skip drift check / dismissed
   */
  async promptSlugAlign(editor, file, lineNo, line, oldId, force) {
    if (this._slugAlignPromptOpen) return;
    if (!force && !slugDrifted(oldId, line)) return;

    const content = editor.getValue();
    const used = collectUsedIds(content);
    const newId = proposeSlugForLine(line, used, oldId);
    if (!newId || newId === oldId) return;

    if (!force) {
      const dismissKey = `${file.path}::${oldId}`;
      if (this._slugAlignDismissed.has(dismissKey)) return;
    }

    // Count inbound before modal
    const hits = await this.findBlockIdReferences(oldId, file);
    const linkCount = hits.reduce((n, h) => n + h.count, 0);

    this._slugAlignPromptOpen = true;
    const modal = new SlugAlignModal(this, {
      file,
      editor,
      lineNo,
      line,
      oldId,
      newId,
      linkCount,
      hits,
      onKeep: () => {
        this._slugAlignDismissed.add(`${file.path}::${oldId}`);
      },
      onFinally: () => {
        this._slugAlignPromptOpen = false;
      },
    });
    modal.open();
  }

  /**
   * Find markdown files containing #^blockId references.
   * Prefers files that already link to target (cache), then always includes target itself.
   * @returns {Promise<{ file: import("obsidian").TFile, count: number }[]>}
   */
  async findBlockIdReferences(blockId, targetFile) {
    const needle = `#^${blockId}`;
    const re = new RegExp(`#\\^${escapeRegExp(blockId)}(?=\\]|\\||$)`, "g");
    const candidates = new Map();

    // Always scan the home file
    candidates.set(targetFile.path, targetFile);

    const resolved = this.app.metadataCache.resolvedLinks || {};
    for (const sourcePath of Object.keys(resolved)) {
      const outs = resolved[sourcePath];
      if (outs && outs[targetFile.path]) {
        const f = this.app.vault.getAbstractFileByPath(sourcePath);
        if (f && f.extension === "md") candidates.set(sourcePath, f);
      }
    }

    // Unresolved / other: quick path scan via getMarkdownFiles is heavy;
    // also check unresolvedLinks pointing at this basename
    const unresolved = this.app.metadataCache.unresolvedLinks || {};
    const base = targetFile.basename;
    for (const sourcePath of Object.keys(unresolved)) {
      const outs = unresolved[sourcePath];
      if (!outs) continue;
      for (const key of Object.keys(outs)) {
        if (key === base || key.startsWith(base + "#") || key.includes(base)) {
          const f = this.app.vault.getAbstractFileByPath(sourcePath);
          if (f && f.extension === "md") candidates.set(sourcePath, f);
        }
      }
    }

    const results = [];
    for (const file of candidates.values()) {
      let text;
      try {
        text = await this.app.vault.cachedRead(file);
      } catch (_) {
        continue;
      }
      if (!text.includes(needle)) continue;
      const matches = text.match(re);
      if (matches && matches.length) {
        results.push({ file, count: matches.length });
      }
    }
    return results;
  }

  /**
   * Rewrite ^oldId on target line + all #^oldId links in known referencing files.
   */
  async applySlugRealign(editor, file, lineNo, oldId, newId) {
    const linkReSrc = `#\\^${escapeRegExp(oldId)}(?=\\]|\\||$)`;
    const hits = await this.findBlockIdReferences(oldId, file);
    let filesTouched = 0;
    let linksUpdated = 0;

    const active = this.app.workspace.getActiveFile();
    const isLive = !!(active && active.path === file.path && editor);

    // Other notes first (vault)
    for (const { file: refFile } of hits) {
      if (isLive && refFile.path === file.path) continue;
      const text = await this.app.vault.read(refFile);
      const matches = text.match(new RegExp(linkReSrc, "g"));
      if (!matches) continue;
      const next = text.replace(new RegExp(linkReSrc, "g"), `#^${newId}`);
      if (next !== text) {
        await this.app.vault.modify(refFile, next);
        linksUpdated += matches.length;
        filesTouched++;
      }
    }

    // Target note: update definition line + any same-file links
    if (isLive) {
      let lines = editor.getValue().split("\n");
      let idx = lineNo;
      if (existingBlockId(lines[idx] || "") !== oldId) {
        idx = lines.findIndex((l) => existingBlockId(l) === oldId);
      }
      if (idx < 0) throw new Error("Could not find block id on target line");
      lines[idx] = stripBlockId(lines[idx]).replace(/\s+$/, "") + ` ^${newId}`;
      let full = lines.join("\n");
      const matches = full.match(new RegExp(linkReSrc, "g"));
      if (matches) linksUpdated += matches.length;
      full = full.replace(new RegExp(linkReSrc, "g"), `#^${newId}`);
      const c = editor.getCursor();
      editor.setValue(full);
      try {
        editor.setCursor(c);
      } catch (_) {
        /* line length may have changed */
      }
      filesTouched++;
    } else {
      let text = await this.app.vault.read(file);
      let lines = text.split("\n");
      let idx = lineNo;
      if (existingBlockId(lines[idx] || "") !== oldId) {
        idx = lines.findIndex((l) => existingBlockId(l) === oldId);
      }
      if (idx < 0) throw new Error("Could not find block id on target line");
      lines[idx] = stripBlockId(lines[idx]).replace(/\s+$/, "") + ` ^${newId}`;
      let full = lines.join("\n");
      const matches = full.match(new RegExp(linkReSrc, "g"));
      if (matches) linksUpdated += matches.length;
      full = full.replace(new RegExp(linkReSrc, "g"), `#^${newId}`);
      await this.app.vault.modify(file, full);
      filesTouched++;
    }

    return { filesTouched, linksUpdated };
  }

  openPickerForHit(editor, hit, lineNo) {
    if (this._modalOpen) return;

    const source = this.app.workspace.getActiveFile();
    const file = this.resolveNote(hit.path, source ? source.path : "");
    if (!file) {
      if (this._lastMissingPath !== hit.path) {
        this._lastMissingPath = hit.path;
        new Notice(`Blinks: note not found — “${hit.path}”`);
      }
      return;
    }
    this._lastMissingPath = "";

    this._modalOpen = true;
    const modal = new BlockPickerModal(this, editor, file, {
      replaceRange: {
        from: { line: lineNo, ch: hit.start },
        to: { line: lineNo, ch: hit.end },
      },
      initialQuery: hit.query || "",
      onFinally: () => {
        this._modalOpen = false;
      },
    });
    modal.open();
  }

  /**
   * Ensure target line has a ^block-id; return the id to use in the link.
   * @param {import("obsidian").TFile} file
   * @param {number} lineIndex 0-based
   * @param {string} blockText line content (may be stale)
   */
  async ensureReadableBlockId(file, lineIndex, blockText) {
    let content = await this.app.vault.read(file);
    let lines = content.split("\n");

    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error("Block line out of range");
    }

    let idx = lineIndex;
    const needle = normalizeText(stripBlockId(blockText));
    if (normalizeText(stripBlockId(lines[idx])) !== needle) {
      const found = lines.findIndex(
        (l, i) => i !== idx && normalizeText(stripBlockId(l)) === needle
      );
      if (found >= 0) idx = found;
    }

    const existing = existingBlockId(lines[idx]);
    if (existing) return { id: existing, lineIndex: idx };

    const used = collectUsedIds(content);
    const id = preferredSlugForBlock(lines[idx], used, 4);
    lines[idx] = stripBlockId(lines[idx]).replace(/\s+$/, "") + ` ^${id}`;
    await this.app.vault.modify(file, lines.join("\n"));
    return { id, lineIndex: idx };
  }

  linkTextFor(file, sourcePath) {
    return this.app.metadataCache.fileToLinktext(file, sourcePath || "", true);
  }

  resolveNote(path, sourcePath) {
    let clean = (path || "").trim();
    if (!clean) return null;
    clean = clean.replace(/\.md$/i, "");

    let file = this.app.metadataCache.getFirstLinkpathDest(clean, sourcePath || "");
    if (file) return file;

    // Fallback: basename / path ends-with (handles odd cache timing)
    const base = clean.includes("/") ? clean.split("/").pop() : clean;
    const all = this.app.vault.getMarkdownFiles();
    const exact = all.filter((f) => f.basename === base);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      const byPath = exact.find((f) => f.path.includes(clean) || clean.includes(f.basename));
      return byPath || exact[0];
    }
    const loose = all.find(
      (f) => f.path === clean + ".md" || f.path.endsWith("/" + clean + ".md")
    );
    return loose || null;
  }
}

/**
 * Plain [[Note]] or [[Note|alias]] at cursor (no ^^) — for command palette.
 */
function parsePlainWikilinkAtCursor(line, ch) {
  const left = line.slice(0, ch);
  const openIdx = left.lastIndexOf("[[");
  if (openIdx < 0) return null;
  const rest = line.slice(openIdx);
  const m = rest.match(/^\[\[([^\[\]#\n]+?)(?:\]\])?/);
  if (!m) return null;
  // Prefer closed link if present
  const closed = rest.match(/^\[\[([^\[\]#\n]+?)\]\]/);
  const use = closed || m;
  const start = openIdx;
  const end = openIdx + use[0].length;
  if (ch < start || ch > end) return null;
  if (use[1].includes("^^")) return null;
  let path = use[1].trim();
  if (path.includes("|")) path = path.split("|")[0].trim();
  if (!path) return null;
  return { path, query: "", start, end, justAfterCarets: false };
}

// ─── editor suggest (secondary): filter after ^^, allows trailing ]] ────────

class BlinksBlockSuggest extends EditorSuggest {
  /** @param {BlinksPlugin} plugin */
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.targetFile = null;
    this.pathText = "";
  }

  onTrigger(cursor, editor, file) {
    // Don't fight the modal
    if (this.plugin._modalOpen) return null;

    const line = editor.getLine(cursor.line);
    const hit = parseBlinksAtCursor(line, cursor.ch);
    if (!hit) return null;

    // Suggest only once user is typing a query after ^^ (modal owns bare ^^)
    if (hit.justAfterCarets && !(hit.query || "").length) return null;

    this.pathText = hit.path;
    const sourcePath = file ? file.path : "";
    this.targetFile = this.plugin.resolveNote(hit.path, sourcePath);
    if (!this.targetFile) return null;

    return {
      start: { line: cursor.line, ch: hit.start },
      end: { line: cursor.line, ch: hit.end },
      query: hit.query || "",
    };
  }

  async getSuggestions(context) {
    if (!this.targetFile) return [];
    const content = await this.plugin.app.vault.cachedRead(this.targetFile);
    const blocks = parseBlocks(content);
    const ranked = rankBlocks(blocks, context.query, 40);
    return ranked.map((b) => ({
      ...b,
      file: this.targetFile,
      pathText: this.pathText,
      preview: previewText(b.text, 80),
    }));
  }

  renderSuggestion(value, el) {
    el.empty();
    el.addClass("blinks-suggest-item");
    el.createDiv({ cls: "blinks-suggest-section" }).setText(
      value.sectionRaw || value.section || "body"
    );
    el.createDiv({ cls: "blinks-suggest-preview" }).setText(value.preview);
    el.createDiv({ cls: "blinks-suggest-line" }).setText(`L${value.line + 1}`);
  }

  async selectSuggestion(value) {
    const editor = this.context && this.context.editor;
    if (!editor || !value.file) return;

    const source = this.plugin.app.workspace.getActiveFile();
    try {
      const { id } = await this.plugin.ensureReadableBlockId(
        value.file,
        value.line,
        value.text
      );
      const linkpath = this.plugin.linkTextFor(
        value.file,
        source ? source.path : ""
      );
      const insert = `[[${linkpath}#^${id}]]`;
      editor.replaceRange(insert, this.context.start, this.context.end);
    } catch (e) {
      console.error("Blinks insert failed", e);
      new Notice("Blinks: could not insert block link");
    }
  }
}

// ─── slug realign prompt ────────────────────────────────────────────────────

class SlugAlignModal extends Modal {
  /**
   * @param {BlinksPlugin} plugin
   * @param {object} opts
   */
  constructor(plugin, opts) {
    super(plugin.app);
    this.plugin = plugin;
    this.opts = opts;
  }

  onOpen() {
    const { contentEl, opts } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Blinks — update block slug?" });

    contentEl.createEl("p", {
      text: "Opening words no longer match the readable block id. Update the slug and inbound links?",
    });

    const grid = contentEl.createDiv({ cls: "blinks-align-grid" });
    grid.createDiv({ cls: "blinks-align-label", text: "Current" });
    grid.createDiv({
      cls: "blinks-align-mono",
      text: `^${opts.oldId}`,
    });
    grid.createDiv({ cls: "blinks-align-label", text: "Proposed" });
    grid.createDiv({
      cls: "blinks-align-mono",
      text: `^${opts.newId}`,
    });
    grid.createDiv({ cls: "blinks-align-label", text: "Links found" });
    grid.createDiv({
      text:
        opts.linkCount === 0
          ? "None scanned (definition only)"
          : `${opts.linkCount} reference(s) in ${opts.hits.length} note(s)`,
    });

    contentEl.createEl("p", {
      cls: "blinks-align-preview",
      text: previewText(opts.line, 120),
    });

    const btns = contentEl.createDiv({ cls: "blinks-align-actions" });

    const keep = btns.createEl("button", { text: "Keep slug" });
    keep.addEventListener("click", () => {
      if (typeof opts.onKeep === "function") opts.onKeep();
      this.close();
    });

    const update = btns.createEl("button", {
      text: "Update slug + links",
      cls: "mod-cta",
    });
    update.addEventListener("click", async () => {
      update.setAttr("disabled", "true");
      try {
        const result = await this.plugin.applySlugRealign(
          opts.editor,
          opts.file,
          opts.lineNo,
          opts.oldId,
          opts.newId
        );
        new Notice(
          `Blinks: slug → ^${opts.newId} (${result.linksUpdated} link(s), ${result.filesTouched} file(s))`
        );
        this.close();
      } catch (e) {
        console.error(e);
        new Notice("Blinks: could not update slug");
        update.removeAttribute("disabled");
      }
    });
  }

  onClose() {
    this.contentEl.empty();
    if (typeof this.opts.onFinally === "function") this.opts.onFinally();
  }
}

// ─── command: pick file then block ──────────────────────────────────────────

class FileThenBlockModal extends FuzzySuggestModal {
  /** @param {BlinksPlugin} plugin @param {*} editor */
  constructor(plugin, editor) {
    super(plugin.app);
    this.plugin = plugin;
    this.editor = editor;
    this.setPlaceholder("Pick a note to link a block from…");
  }

  getItems() {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    new BlockPickerModal(this.plugin, this.editor, file, {}).open();
  }
}

class BlockPickerModal extends Modal {
  /**
   * @param {BlinksPlugin} plugin
   * @param {*} editor
   * @param {import("obsidian").TFile} file
   * @param {{ replaceRange?: { from: {line:number,ch:number}, to: {line:number,ch:number} }, initialQuery?: string, onFinally?: () => void }} opts
   */
  constructor(plugin, editor, file, opts) {
    super(plugin.app);
    this.plugin = plugin;
    this.editor = editor;
    this.file = file;
    this.opts = opts || {};
    this.blocks = [];
    this.filtered = [];
    this.selected = 0;
    this.query = this.opts.initialQuery || "";
    this._chosen = false;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Blinks — ${this.file.basename}` });

    const content = await this.plugin.app.vault.cachedRead(this.file);
    this.blocks = parseBlocks(content);

    this.input = contentEl.createEl("input", {
      type: "search",
      cls: "blinks-modal-search",
      placeholder: "Phrase search (e.g. the problem)…",
      value: this.query,
    });
    this.input.addEventListener("input", () => {
      this.query = this.input.value;
      this.selected = 0;
      this.renderList();
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));

    this.listEl = contentEl.createDiv({ cls: "blinks-modal-results" });
    this.renderList();

    window.setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 20);
  }

  onKey(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selected = Math.min(this.selected + 1, Math.max(0, this.filtered.length - 1));
      this.renderList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selected = Math.max(this.selected - 1, 0);
      this.renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (this.filtered[this.selected]) this.choose(this.filtered[this.selected]);
    } else if (e.key === "Escape") {
      this.close();
    }
  }

  renderList() {
    this.filtered = rankBlocks(this.blocks, this.query, 50);
    if (this.selected >= this.filtered.length) {
      this.selected = Math.max(0, this.filtered.length - 1);
    }
    this.listEl.empty();

    if (!this.filtered.length) {
      this.listEl.createDiv({
        cls: "blinks-modal-empty",
        text: this.query ? "No matching blocks." : "No blocks found in this note.",
      });
      return;
    }

    this.filtered.forEach((b, i) => {
      const item = this.listEl.createDiv({
        cls: "blinks-modal-item" + (i === this.selected ? " is-selected" : ""),
      });
      item.createDiv({
        cls: "blinks-suggest-section",
        text: b.sectionRaw || b.section || "body",
      });
      item.createDiv({
        cls: "blinks-suggest-preview",
        text: previewText(b.text, 100),
      });
      item.createDiv({
        cls: "blinks-suggest-line",
        text: `L${b.line + 1}`,
      });
      item.addEventListener("click", () => this.choose(b));
      item.addEventListener("mouseenter", () => {
        if (this.selected === i) return;
        const prev = this.listEl.children[this.selected];
        if (prev) prev.removeClass("is-selected");
        this.selected = i;
        item.addClass("is-selected");
      });
    });
  }

  async choose(block) {
    const source = this.plugin.app.workspace.getActiveFile();
    try {
      const { id } = await this.plugin.ensureReadableBlockId(
        this.file,
        block.line,
        block.text
      );
      const linkpath = this.plugin.linkTextFor(
        this.file,
        source ? source.path : ""
      );
      const insert = `[[${linkpath}#^${id}]]`;
      if (this.editor) {
        if (this.opts.replaceRange) {
          this.editor.replaceRange(
            insert,
            this.opts.replaceRange.from,
            this.opts.replaceRange.to
          );
        } else {
          this.editor.replaceSelection(insert);
        }
      }
      this._chosen = true;
      this.close();
    } catch (e) {
      console.error(e);
      new Notice("Blinks: could not insert block link");
    }
  }

  onClose() {
    this.contentEl.empty();
    if (typeof this.opts.onFinally === "function") this.opts.onFinally();
  }
}

// Exported for tests / future split
BlinksPlugin._internal = {
  normalizeText,
  scorePhrase,
  parseBlocks,
  rankBlocks,
  slugifyWords,
  preferredSlugForBlock,
  previewText,
  parseBlinksAtCursor,
  parsePlainWikilinkAtCursor,
  slugDrifted,
  proposeSlugForLine,
};

module.exports = BlinksPlugin;
