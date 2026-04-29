import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import type ImaSyncPlugin from "./main";
import { FolderMapping } from "./types";
import { ImaApiClient, ImaApiError, ImaNotebookMeta } from "./providers/ImaApiClient";

/** Sentinel value used inside the dropdown to represent "don't sync this folder". */
const DONT_SYNC = "__SKIP__";

/**
 * Per-folder selection kept in memory during the wizard lifecycle.
 *   - enabled=false  →  the folder is listed in the rules table with sync=false.
 *   - enabled=true   →  folderId must be a real notebook id (DONT_SYNC is not allowed).
 *
 * Folders that the user never ticks on (and that weren't pre-filled from
 * settings) are simply not added to `folderMappings` at all.
 */
interface RowState {
  enabled: boolean;
  folderId: string; // empty string when no notebook picked yet
}

/**
 * Wizard for the initial folder-to-notebook mapping, plus the "new folder
 * detected" follow-up prompt.
 *
 *   1. Scan the top-level folders in the vault (plus an implicit "root" entry).
 *   2. Call list_notebook to fetch the user's existing IMA notebooks.
 *   3. For each folder the user decides either:
 *        • enable + pick a destination notebook, or
 *        • disable (folder won't be synced at all), or
 *        • leave untouched (treated as "unlisted" — handled by the global
 *          "Unlisted folders" policy in settings).
 *   4. On confirm, settings.folderMappings is rewritten accordingly.
 *
 * The IMA API does not expose a "create notebook" endpoint, so the user has to
 * create the notebook in the IMA desktop app first. This wizard exposes a
 * Refresh button so they can reload the list without leaving the dialog.
 */
export class FolderMappingWizardModal extends Modal {
  private notebooks: ImaNotebookMeta[] = [];
  /** Per-row UI state keyed by localPrefix. */
  private rows: Map<string, RowState> = new Map();
  private localFolders: string[] = [];
  private onFinish?: (didChange: boolean) => void;
  private loadingNotebooks = false;

  constructor(
    app: App,
    private readonly plugin: ImaSyncPlugin,
    opts?: {
      /** If provided, only render the given folders (e.g. the "new folders" prompt). */
      onlyFolders?: string[];
      onFinish?: (didChange: boolean) => void;
    }
  ) {
    super(app);
    this.onFinish = opts?.onFinish;
    if (opts?.onlyFolders && opts.onlyFolders.length > 0) {
      this.localFolders = [...opts.onlyFolders];
    }
  }

  onOpen(): void {
    if (this.localFolders.length === 0) {
      this.localFolders = this.scanLocalFolders();
    }
    // Pre-fill from existing mappings if any. Both "sync to notebook" and
    // "explicitly don't sync" rules are replayed so the user sees their
    // previous choice.
    for (const folder of this.localFolders) {
      const existing = this.plugin.settings.folderMappings.find(
        (m) => m.localPrefix === folder
      );
      if (!existing) continue;
      const syncing = existing.sync !== false; // undefined = legacy = true
      this.rows.set(folder, {
        enabled: syncing,
        folderId: syncing ? existing.folderId : "",
      });
    }
    this.render();
    void this.loadNotebooks();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ---------------------------------------------------------------------

  private scanLocalFolders(): string[] {
    const folders = new Set<string>();
    const root = this.app.vault.getRoot();
    for (const child of root.children) {
      if (child instanceof TFolder) {
        folders.add(child.name);
      }
    }
    // Always include an implicit "vault root" entry so files in the root get
    // their own rule too.
    folders.add("");
    return Array.from(folders).sort((a, b) => a.localeCompare(b));
  }

  private async loadNotebooks(): Promise<void> {
    const { clientId, apiKey } = this.plugin.settings;
    if (!clientId || !apiKey) {
      new Notice("Please configure Client ID and API key first", 5000);
      return;
    }
    this.loadingNotebooks = true;
    this.render();
    try {
      const client = new ImaApiClient({ clientId, apiKey });
      const all: ImaNotebookMeta[] = [];
      let cursor = "0";
      let safety = 0;
      while (safety++ < 50) {
        const res = await client.listNotebook({ cursor, limit: 20 });
        const list = res.note_folder_infos ?? [];
        all.push(...list);
        if (res.is_end || list.length === 0) break;
        if (!res.next_cursor || res.next_cursor === cursor) break;
        cursor = res.next_cursor;
      }
      this.notebooks = all;
    } catch (e) {
      const msg = e instanceof ImaApiError ? `${e.apiMsg} (code=${e.code})` : (e as Error).message;
      new Notice(`Failed to load notebooks — ${msg}`, 5000);
    } finally {
      this.loadingNotebooks = false;
      this.render();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Folder → notebook mapping" });
    contentEl.createEl("p", {
      text:
        "For each local folder, pick a destination IMA notebook — or toggle it off " +
        "to exclude that folder from syncing. You only need to do this once; every " +
        "future sync will route notes automatically.",
    });

    const notice = contentEl.createDiv({ cls: "ima-sync-wizard-notice" });
    notice.createEl("div", {
      text:
        "Note: IMA does not allow creating notebooks via API. " +
        "If the notebook you want isn't in the list below, create it in the IMA app first, " +
        "then click Refresh.",
    });

    // Notebook list status
    const statusRow = new Setting(contentEl);
    statusRow.setName("IMA notebooks");
    if (this.loadingNotebooks) {
      statusRow.setDesc("Loading…");
    } else {
      statusRow.setDesc(`${this.notebooks.length} notebook(s) loaded`);
    }
    statusRow.addButton((b) =>
      b.setButtonText("Refresh").onClick(() => void this.loadNotebooks())
    );

    // One row per local folder: [toggle]  [ folder path ]   [ destination ▼ ]
    for (const folder of this.localFolders) {
      const state = this.rows.get(folder) ?? { enabled: false, folderId: "" };
      const row = new Setting(contentEl);
      row.setName(folder === "" ? "(vault root)" : folder);
      row.setDesc(folder === "" ? "Notes that aren't inside any subfolder" : `vault/${folder}/**`);

      row.addToggle((tg) =>
        tg
          .setTooltip("Sync this folder")
          .setValue(state.enabled)
          .onChange((v) => {
            const cur = this.rows.get(folder) ?? { enabled: false, folderId: "" };
            this.rows.set(folder, { ...cur, enabled: v });
            // Re-render so the dropdown reflects the new enabled state.
            this.render();
          })
      );

      row.addDropdown((dd) => {
        dd.addOption(DONT_SYNC, "— Don't sync —");
        for (const nb of this.notebooks) {
          dd.addOption(nb.folder_id, `${nb.name}  (${nb.note_number ?? 0} notes)`);
        }
        if (!state.enabled) {
          dd.setValue(DONT_SYNC);
          dd.setDisabled(true);
        } else {
          dd.setValue(state.folderId || DONT_SYNC);
          dd.onChange((v) => {
            const cur = this.rows.get(folder) ?? { enabled: true, folderId: "" };
            if (v === DONT_SYNC) {
              // Picking "don't sync" from the dropdown is a shortcut for
              // toggling off — flip the enable switch to keep UI coherent.
              this.rows.set(folder, { enabled: false, folderId: "" });
              this.render();
            } else {
              this.rows.set(folder, { ...cur, enabled: true, folderId: v });
            }
          });
        }
      });
    }

    // Footer
    const footer = contentEl.createDiv({ cls: "ima-sync-wizard-footer" });

    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.onFinish?.(false);
      this.close();
    });

    const confirmBtn = footer.createEl("button", {
      text: "Save mapping",
      cls: "mod-cta",
    });
    confirmBtn.addEventListener("click", async () => {
      await this.persist();
      this.onFinish?.(true);
      this.close();
    });
  }

  private async persist(): Promise<void> {
    const nameById = new Map(this.notebooks.map((nb) => [nb.folder_id, nb.name]));
    // Drop any existing rules whose prefix we just re-displayed; we'll rewrite
    // them from the current UI state (including the new "sync=false" rows).
    const survivors = this.plugin.settings.folderMappings.filter(
      (m) => !this.localFolders.includes(m.localPrefix)
    );

    const added: FolderMapping[] = [];
    let skipCount = 0;
    let syncCount = 0;
    for (const folder of this.localFolders) {
      const state = this.rows.get(folder);
      if (!state) continue; // user never touched this row → treat as "unlisted"
      if (!state.enabled) {
        // Explicit "don't sync" rule.
        added.push({
          localPrefix: folder,
          folderId: "",
          folderName: "",
          sync: false,
        });
        skipCount++;
        continue;
      }
      if (!state.folderId) continue; // enabled but no notebook picked → ignore
      added.push({
        localPrefix: folder,
        folderId: state.folderId,
        folderName: nameById.get(state.folderId) ?? "",
        sync: true,
      });
      syncCount++;
    }

    this.plugin.settings.folderMappings = [...survivors, ...added];
    this.plugin.settings.hasCompletedWizard = true;
    await this.plugin.saveSettings();
    new Notice(
      `${syncCount} folder(s) will sync, ${skipCount} excluded`,
      5000
    );
  }
}
