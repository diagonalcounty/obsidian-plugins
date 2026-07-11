# diagonalcounty’s Obsidian plugins

A little workshop of community plugins that scratch itches Obsidian left just itchy enough to notice.

Not a framework. Not a platform. Just plugins that do one job without rewriting your vault into someone else’s religion.

## The shelf

| Plugin | One-liner | Status |
|--------|-----------|--------|
| **[Blinks](https://github.com/diagonalcounty/blinks)** | Better block links — phrase pick, readable `^slugs`, less `#^fa5d4c` cosplay | **0.2.0** · [dedicated repo](https://github.com/diagonalcounty/blinks) for Community Plugins |

More will show up here when they earn a folder.

## Install (pick your adventure)

### A. Manual (honest, works everywhere)

1. Grab the latest **Release** assets for the plugin you want (or copy the folder from this repo).
2. Drop into `<vault>/.obsidian/plugins/<plugin-id>/`.
3. Enable it under **Settings → Community plugins**.
4. Reload if Obsidian is being shy.

### B. BRAT (for people who enjoy living slightly dangerously)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Add this repo / the plugin path per BRAT’s monorepo flow.
3. Accept that beta software occasionally has feelings.

### C. Community Plugins directory

**Blinks** is submitted (or ready to submit) from its [own repo](https://github.com/diagonalcounty/blinks) — Obsidian requires plugin files at the **repo root** and a release tag matching `manifest.json` version. This monorepo stays the catalog / workshop; installable community plugins live one-repo-per-plugin.

Submit / manage via [community.obsidian.md](https://community.obsidian.md/) developer dashboard.

## Philosophy (short enough to ignore)

- **Markdown stays the source of truth.** No proprietary side-cars unless we’re cornered.
- **Core features first.** We extend Obsidian; we don’t cosplay as a second app.
- **Readable > clever.** Your git diff should not look like a password dump.
- **Snark optional. Breakage not.**

## Author

**diagonalcounty** · [github.com/diagonalcounty](https://github.com/diagonalcounty)

## License

[MIT](./LICENSE) — do cool things, don’t sue us when your carefully crafted `^slug` becomes a lifestyle.

---

*PRs welcome if they come with a reason. “I refactored your vibe” is not a reason.*


## Repo layout

| Path | Role |
|------|------|
| `blinks/` | Snapshot / archive copy of Blinks (dev convenience) |
| [diagonalcounty/blinks](https://github.com/diagonalcounty/blinks) | **Canonical** Blinks for releases & Community Plugins |

New plugins will follow the same pattern: workshop here, public installable repo when ready.
