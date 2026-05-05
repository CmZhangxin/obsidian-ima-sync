# Obsidian IMA Sync

> Sync your Obsidian vault to Tencent **IMA** ([ima.qq.com](https://ima.qq.com)) knowledge base via the official OpenAPI.

![Obsidian](https://img.shields.io/badge/Obsidian-%3E%3D1.5.0-7c3aed)
![License](https://img.shields.io/badge/license-MIT-green)

---

## What it does

- **Push** your markdown notes from Obsidian into IMA notebooks, routed by folder.
- **Pull** notes from IMA back into your vault (plaintext; see limitations below).
- **Bidirectional** mode runs pull then push in one go.
- Auto-sync on file save, on a timer, or manually from the command palette.

Every note is routed to a specific IMA notebook according to a **folder-to-notebook mapping table** that you configure once via the built-in wizard.

> Screenshots:
> - `docs/screenshots/settings.png` – settings tab
> - `docs/screenshots/wizard.png` – folder-to-notebook mapping wizard
>
> *(placeholders — add real images before publishing)*

---

## Requirements

- Obsidian **1.5.0 or newer** (the plugin uses `app.vault.process()` and `app.fileManager.processFrontMatter()`).
- An IMA account with OpenAPI access:
  - Visit <https://ima.qq.com/agent-interface>, sign in, and copy your **Client ID** and **API key**.

---

## Install

### From source

```bash
git clone https://github.com/CmZhangxin/obsidian-ima-sync.git
cd obsidian-ima-sync
npm install
npm run build
```

Copy the three release artifacts into your vault:

```
<YourVault>/.obsidian/plugins/ima-sync/
├── main.js
├── manifest.json
└── styles.css
```

Then enable **IMA Sync** under *Settings → Community plugins*.

### Development

```bash
npm run dev   # esbuild watch mode
```

---

## First run

1. Open *Settings → IMA Sync*.
2. Paste your **Client ID** and **API key**, click **Test** to verify.
3. Under **Folder → notebook mapping**, click **Open wizard**.
4. For each top-level folder in your vault, either pick a destination IMA notebook or toggle it off to exclude it.
   > IMA does not allow creating notebooks via API — create them in the IMA desktop app first, then click **Refresh** in the wizard.
5. Click **Save mapping**. That's it — now every push will route notes according to your rules.

---

## Usage

### Command palette

| Command | What it does |
|---|---|
| **Push all notes** | Upload every mapped markdown file to IMA |
| **Push current note** | Upload just the active note |
| **Pull all notes** | Fetch notes from IMA into your vault |
| **Sync both ways** | Pull first, then push |
| **Open folder mapping wizard** | Reconfigure the mapping table |
| **Show folder-to-notebook mappings** | Display the current mapping as a Notice |
| **Reset local sync state** | Forget all known remote IDs (next push re-uploads everything) |

### Triggers

Under *Settings → Trigger*:

- **Off (manual only)** – nothing happens until you press a button.
- **On file save** – each saved note is pushed (debounced ~1.5s).
- **Every N minutes** – periodic background sync.

### Frontmatter written back

After a successful push, the plugin writes these keys into the note's YAML frontmatter so you can see where each note landed:

```yaml
---
ima_note_id: nt_xxxxxxxx
ima_notebook: My IMA Notebook
ima_last_sync: 2026-04-29T12:00:00.000Z
---
```

If you enable *Advanced → Strip frontmatter*, this writeback is disabled.

---

## How syncing works

### Push (Obsidian → IMA)

- Unchanged files are skipped via a content-hash (`hashContent(transformed)`).
- The destination notebook is picked by [FolderMappingManager](src/FolderMappingManager.ts) in this order:
  1. `ima_notebook` / `ima_folder_id` in the note's own frontmatter (escape hatch).
  2. Longest matching `localPrefix` rule in your mapping table.
  3. Otherwise **skipped** (unmapped folders are never pushed by accident).

Because IMA has **no in-place update API**, content changes are handled per the *Advanced → On-change strategy*:

- `Skip` – keep the first synced version only.
- `Append` – append new content to the existing note with a timestamp separator.
- `Recreate` – create a brand-new note each time the content changes (old note stays on IMA).

### Pull (IMA → Obsidian)

- Uses `list_note` + `get_doc_content` (plaintext only; IMA's `MARKDOWN` format isn't supported by the API).
- New notes land under *Advanced → Pull target folder* (default `IMA/`).
- Optionally mirrors IMA notebooks as subfolders.
- Existing notes are updated atomically via `vault.process()`.

### Bidirectional conflicts

When both sides have changed, the *Conflict strategy* picker decides:

- `Newest wins` (default) – whoever has the more recent timestamp.
- `Local wins` / `Remote wins` – always prefer one side.
- `Keep both` – write a `*.conflict-<timestamp>.md` sibling file.
- `Skip` – do nothing, surface as a "conflicted" item in the summary Notice.

---

## Limitations

- **No delete propagation.** IMA's OpenAPI does not expose a delete endpoint; the plugin never removes notes on IMA even if you delete them locally.
- **No attachment upload.** The OpenAPI channel only accepts markdown bodies. PNG/PDF/etc. are silently skipped even with *Include attachments* on.
- **Pull is plaintext.** `get_doc_content` does not support `MARKDOWN` format, so pulled notes lose their original formatting.
- **Mobile.** Currently desktop-only (`isDesktopOnly: true`). The plugin doesn't rely on desktop-only APIs, so mobile support may be enabled in a future release once it has been properly tested on iOS and Android.
- **No notebook creation via API.** You must create notebooks manually in the IMA desktop app.

---

## Troubleshooting

| Notice you see | What it usually means |
|---|---|
| *"Please configure Client ID and API key first"* | Credentials missing — go to *Settings → Credentials* |
| *"First sync: please configure your folder-to-notebook mapping first"* | You haven't completed the wizard yet |
| *"N note(s) failed because their target notebook no longer exists"* | You deleted/renamed a notebook in the IMA app; reopen the wizard and re-map |
| *"Another sync is already running"* | A previous run is still in flight; wait for it or check the devtools console |

For more detail, open the devtools console (`Ctrl/Cmd+Shift+I`). All plugin logs are prefixed with `[ima-sync]`.

---

## Project layout

```
src/
├── main.ts                     # Plugin entry (commands, events, timers)
├── settings.ts                 # Settings UI
├── SyncEngine.ts               # Push / pull / bidirectional orchestration
├── FolderMappingManager.ts     # Folder-to-notebook routing logic
├── FolderMappingWizardModal.ts # Setup wizard modal
├── transformer.ts              # Wiki-link / Callout conversion
├── types.ts                    # Settings schema & defaults
├── logger.ts                   # Prefixed console wrappers
├── utils.ts                    # hashContent, etc.
└── providers/
    ├── SyncProvider.ts         # Provider interface
    ├── ImaApiClient.ts         # Raw OpenAPI HTTP client
    └── ImaOpenApiProvider.ts   # IMA sync provider implementation
```

---

## Disclaimer

This plugin is a personal project and **not affiliated with Tencent**. Use of the IMA OpenAPI is subject to the terms at [ima.qq.com](https://ima.qq.com). Your API key is only ever sent to `ima.qq.com` over HTTPS and is never written to logs or third-party services.

## License

[MIT](LICENSE)
