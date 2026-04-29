import {
  debounce,
  Debouncer,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
} from "obsidian";
import { DEFAULT_SETTINGS, ImaSyncSettings } from "./types";
import { ImaSyncSettingTab } from "./settings";
import { SyncProvider } from "./providers/SyncProvider";
import { ImaOpenApiProvider } from "./providers/ImaOpenApiProvider";
import { SyncEngine } from "./SyncEngine";
import { FolderMappingWizardModal } from "./FolderMappingWizardModal";
import { logDebug, logWarn } from "./logger";

const ON_SAVE_DEBOUNCE_MS = 1500;

export default class ImaSyncPlugin extends Plugin {
  settings: ImaSyncSettings = DEFAULT_SETTINGS;

  private readonly providers: SyncProvider[] = [];
  private engine!: SyncEngine;
  private debouncedSyncers: Map<string, Debouncer<[TFile], void>> = new Map();
  private statusBarItem: HTMLElement | null = null;
  /**
   * 正在进行 frontmatter writeback 的文件路径集合。
   * processFrontMatter() 写入 ima_* 字段时会触发 vault "modify" 事件，
   * 如果此时 debounce 冷却期已过，会立即触发新一轮 push（recreate 策略下
   * 就会产生重复笔记）。把路径加入此集合可以在 writeback 窗口内屏蔽触发。
   */
  private frontmatterWritebackPaths: Set<string> = new Set();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.rebuildProviders();
    this.engine = new SyncEngine(
      this.app,
      this.settings,
      () => this.providers,
      () => this.saveSettings(),
      (path) => this.frontmatterWritebackPaths.add(path),
      (path) => this.frontmatterWritebackPaths.delete(path)
    );

    this.addSettingTab(new ImaSyncSettingTab(this.app, this));

    // Status-bar indicator: shows the current mapping count and any pending new folders.
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addEventListener("click", () => this.openMappingWizard());
    this.refreshStatusBar();

    // Command names follow Obsidian's guideline: no plugin-name prefix — the
    // command palette adds it automatically.
    this.addCommand({
      id: "push-full-sync",
      name: "Push all notes",
      callback: () => this.runPushCommand(),
    });

    this.addCommand({
      id: "push-current-note",
      name: "Push current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          this.engine.syncFile(file).catch((err: unknown) => logWarn(err));
        }
        return true;
      },
    });

    this.addCommand({
      id: "pull-from-ima",
      name: "Pull all notes",
      callback: () => this.runPullCommand(),
    });

    this.addCommand({
      id: "bidirectional-sync",
      name: "Sync both ways",
      callback: () => this.runBidirectionalCommand(),
    });

    this.addCommand({
      id: "open-mapping-wizard",
      name: "Open folder mapping wizard",
      callback: () => this.openMappingWizard(),
    });

    this.addCommand({
      id: "show-current-mappings",
      name: "Show folder-to-notebook mappings",
      callback: () => this.showCurrentMappings(),
    });

    this.addCommand({
      id: "reset-sync-state",
      name: "Reset local sync state",
      callback: async () => {
        this.settings.fileStates = {};
        this.settings.remoteIndex = {};
        this.settings.lastSyncAt = 0;
        this.settings.lastPullAt = 0;
        await this.saveSettings();
        this.refreshStatusBar();
        new Notice("Local sync state cleared");
      },
    });

    // On-save push (debounced).
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.settings.trigger !== "on-save") return;
        if (this.settings.direction === "pull") return;
        if (!(file instanceof TFile)) return;
        // 忽略由 frontmatter writeback 触发的 modify 事件，避免 recreate 策略
        // 下因 ima_last_sync 时间戳变化而产生重复笔记。
        if (this.frontmatterWritebackPaths.has(file.path)) return;
        this.getOrCreateDebouncedSyncer(file.path)(file);
      })
    );

    // Remote cleanup on local delete.
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (this.settings.fileStates[file.path]) {
          this.engine.removeFile(file.path).catch((err: unknown) => logWarn(err));
        }
      })
    );

    // Keep state keys in sync with renames. saveSettings() already triggers
    // refreshStatusBar(), which also covers the "status bar on rename" case.
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        const prev = this.settings.fileStates[oldPath];
        if (!prev) {
          // Still refresh the status bar so folder-level renames reflect immediately.
          this.refreshStatusBar();
          return;
        }
        delete this.settings.fileStates[oldPath];
        this.settings.fileStates[file.path] = prev;
        if (prev.remoteId) {
          const entry = this.settings.remoteIndex[prev.remoteId];
          if (entry) entry.relativePath = file.path;
        }
        // Move any pending debouncer under the new path, too.
        const pending = this.debouncedSyncers.get(oldPath);
        if (pending) {
          this.debouncedSyncers.delete(oldPath);
          this.debouncedSyncers.set(file.path, pending);
        }
        await this.saveSettings();
      })
    );

    // Refresh the status bar when new folders appear in the vault.
    this.registerEvent(
      this.app.vault.on("create", () => this.refreshStatusBar())
    );

    this.rescheduleTimers();

    logDebug("loaded");
  }

  onunload(): void {
    for (const d of this.debouncedSyncers.values()) {
      d.cancel();
    }
    this.debouncedSyncers.clear();
    logDebug("unloaded");
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<ImaSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    this.settings.pullIncludeNotebookIds = [...(this.settings.pullIncludeNotebookIds ?? [])];
    this.settings.fileStates = { ...(this.settings.fileStates ?? {}) };
    this.settings.remoteIndex = { ...(this.settings.remoteIndex ?? {}) };
    this.settings.folderMappings = [...(this.settings.folderMappings ?? [])];

    // Migration: the "manual" mapping mode has been folded into "smart"
    // (the UI no longer exposes it). Carry existing rules over transparently.
    if ((this.settings.folderMappingMode as string) === "manual") {
      this.settings.folderMappingMode = "smart";
    }

    // Migration: the "append" on-change strategy has been removed — it was
    // the root cause of duplicated note bodies in IMA (the remote note ends
    // up with the same content concatenated multiple times because the API
    // has no diff primitive, only "append the full payload"). Fall back to
    // "recreate", which has the same "don't lose history" property without
    // polluting individual notes.
    if ((this.settings.onChangeStrategy as string) === "append") {
      this.settings.onChangeStrategy = "recreate";
    }

    // Migration: the old "Excluded folders" text box has been replaced by
    // per-folder sync=false rules in the mapping table. Convert any legacy
    // entries so existing users don't lose their exclusions after upgrading.
    // We read the legacy field from the raw JSON (it no longer exists on the
    // typed settings) and merge into folderMappings.
    const legacy = (data ?? {}) as Record<string, unknown>;
    const legacyExcluded = Array.isArray(legacy.excludeFolders)
      ? (legacy.excludeFolders as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.trim().length > 0
        )
      : [];
    if (legacyExcluded.length > 0) {
      const existingPrefixes = new Set(
        this.settings.folderMappings.map((m) => m.localPrefix)
      );
      for (const prefix of legacyExcluded) {
        if (existingPrefixes.has(prefix)) continue;
        this.settings.folderMappings.push({
          localPrefix: prefix,
          folderId: "",
          folderName: "",
          sync: false,
        });
      }
    }

    // Dropped legacy fields (notebookId / notebookName / autoPromptNewFolders /
    // unlistedFolderPolicy) are simply ignored — the new model routes only
    // through the mapping table, and unmatched folders are skipped by design.

    // Scrub obsolete keys that may linger in data.json from older versions.
    // Because loadSettings() uses Object.assign(DEFAULT_SETTINGS, data), any
    // key not explicitly deleted here would otherwise be persisted again on
    // the next saveSettings() call. Deleting them on load makes data.json
    // converge to the current schema the first time the plugin starts after
    // an upgrade.
    const DROPPED_KEYS = [
      "syncMode",
      "mirrorFolder",
      "excludeFolders",
      "notebookId",
      "notebookName",
      "autoPromptNewFolders",
      "unlistedFolderPolicy",
    ];
    const mutable = this.settings as unknown as Record<string, unknown>;
    for (const key of DROPPED_KEYS) {
      if (key in mutable) delete mutable[key];
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshStatusBar();
  }

  /** Rebuild providers in place so the engine's shared reference stays valid. */
  rebuildProviders(): void {
    const list: SyncProvider[] = [new ImaOpenApiProvider(this.settings)];
    this.providers.splice(0, this.providers.length, ...list);
  }

  /**
   * Re-arm (or skip) the interval-based sync timer. Uses `registerInterval()`
   * so Obsidian handles lifecycle cleanup when the plugin is unloaded.
   */
  rescheduleTimers(): void {
    if (this.settings.trigger !== "interval") return;
    const ms = Math.max(1, this.settings.intervalMinutes) * 60 * 1000;
    const id = window.setInterval(() => {
      const dir = this.settings.direction;
      const task =
        dir === "pull"
          ? this.engine.runPull(true)
          : dir === "bidirectional"
          ? this.engine.runBidirectional(true)
          : this.engine.runFullSync(true);
      task.catch((err: unknown) => logWarn(err));
    }, ms);
    this.registerInterval(id);
  }

  /** Returns (and lazily creates) a per-file debouncer for on-save pushes. */
  private getOrCreateDebouncedSyncer(path: string): Debouncer<[TFile], void> {
    const existing = this.debouncedSyncers.get(path);
    if (existing) return existing;
    const created = debounce(
      (file: TFile) => {
        this.engine.syncFile(file).catch((err: unknown) => logWarn(err));
      },
      ON_SAVE_DEBOUNCE_MS,
      true
    );
    this.debouncedSyncers.set(path, created);
    return created;
  }

  // ---------------- Commands ----------------

  async runPushCommand(): Promise<void> {
    if (await this.interceptForWizard()) return;
    await this.engine.runFullSync(false);
    this.refreshStatusBar();
  }

  async runPullCommand(): Promise<void> {
    await this.engine.runPull(false);
    this.refreshStatusBar();
  }

  async runBidirectionalCommand(): Promise<void> {
    if (await this.interceptForWizard()) return;
    await this.engine.runBidirectional(false);
    this.refreshStatusBar();
  }

  /** Open the mapping wizard (triggered from command palette, status bar or the settings page). */
  openMappingWizard(): void {
    new FolderMappingWizardModal(this.app, this, {
      onFinish: () => this.refreshStatusBar(),
    }).open();
  }

  /** Show the current mapping table as a Notice (invoked from the command palette). */
  private showCurrentMappings(): void {
    const m = this.settings.folderMappings;
    if (m.length === 0) {
      new Notice("No folder mappings configured yet");
      return;
    }
    const text = m
      .map((x) => `• ${x.localPrefix || "(root)"} → ${x.folderName || x.folderId}`)
      .join("\n");
    new Notice(`Folder mappings (${m.length}):\n${text}`, 5000);
  }

  /**
   * Pre-push mapping check:
   *   - Smart mode + wizard never completed → force the wizard open.
   * Returns true when the push has been intercepted (the user needs to
   * rerun after finishing).
   */
  private async interceptForWizard(): Promise<boolean> {
    if (this.settings.folderMappingMode !== "smart") return false;
    if (!this.settings.clientId || !this.settings.apiKey) return false;

    // First-ever sync → force the wizard open so the user sets up at
    // least one mapping rule before anything gets pushed.
    if (!this.settings.hasCompletedWizard) {
      new Notice(
        "First sync: please configure your folder-to-notebook mapping first",
        5000
      );
      this.openMappingWizard();
      return true;
    }

    return false;
  }

  /** Refresh the text rendered in the bottom status bar. */
  private refreshStatusBar(): void {
    if (!this.statusBarItem) return;
    const count = this.settings.folderMappings.length;
    this.statusBarItem.setText(`🔄 IMA: ${count} mapped`);
    this.statusBarItem.setAttr(
      "aria-label",
      "Click to open the mapping wizard"
    );
  }
}
