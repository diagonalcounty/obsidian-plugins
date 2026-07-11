# Blinks

**Better block links for Obsidian.**

Obsidian will happily let you link to a paragraph using a dignified identifier like `#^fa5d4c`.  
That’s fine if you enjoy grepping ciphertext. The rest of us remember *words*.

Blinks is the missing door: pick the note (you already know how), type `^^`, find the block by **phrase**, get a link that still works when the plugin is off.

```markdown
[[2026-06-28_Squad_Career_Trajectories#^current-people-bios-have|bios]]
```

Readable. Portable. Slightly smug.

## What it does

| | |
|--|--|
| **Trigger** | Inside a wikilink — open *or* already closed with `]]` — type `^^` |
| **Search** | Phrase-ranked blocks in that note (not “hope the token bag is feeling generous”) |
| **Storage** | Real Obsidian `#^readable-slug` ids (writes the `^slug` on the target line if missing) |
| **Aliases** | Normal `[[note#^slug\|display text]]` — core handles the pretty face |
| **Realign** | If you rewrite the opening words, Blinks can *prompt* to refresh the slug + inbound links |

### The door that matches real life

1. Type `[[`, find the note, **Tab or click** (Obsidian will close with `]]` — of course it will).
2. Move the cursor **before** the `]]`.
3. Type `^^` → block picker.
4. Type the words you actually remember. Pick. Done.

Also works if you never closed the link: `[[Note^^`.

### Commands (Command palette)

- **Blinks: Insert block link (pick note…)**
- **Blinks: Insert block link in current note**
- **Blinks: Insert block link for wikilink at cursor**
- **Blinks: Realign block slug at cursor (update links)**

## What it does *not* do (yet)

- Vault-wide “I forgot which file” block search (Craft nostalgia; later)
- Replace Obsidian’s soul
- Make `#^fa5d4c` cool

Native random hex block ids still work. We just refuse to make more of them on purpose.

## Durability (the part that matters)

Links follow the **`^slug` on the line**, not the poetry of the paragraph.

| You do this | Link |
|-------------|------|
| Reword the sentence, keep `^slug` | ✅ lives |
| Move the line *with* its `^slug` inside the same note | ✅ lives |
| Delete or rename the slug and ghost the old id | ❌ dies (as it should) |
| Disable Blinks | ✅ still works — it’s core `#^` syntax |

Optional **prompt on edit**: if opening words drift from a *readable* slug, Blinks offers to update the slug and the inbound links it can find. You can always hit **Keep slug** and live with a slightly nostalgic id.

## Install

See the [repo root README](../README.md), or:

1. Download `main.js`, `manifest.json`, `styles.css` from the latest **blinks** release  
2. Put them in `.obsidian/plugins/blinks/`  
3. Enable **Blinks** → reload if needed  

Requires Obsidian **1.5.0+**.

## Author

**diagonalcounty** · part of [obsidian-plugins](https://github.com/diagonalcounty/obsidian-plugins)

## License

MIT — same as the monorepo. Break links responsibly.
