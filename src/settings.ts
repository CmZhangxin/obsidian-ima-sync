import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ImaSyncPlugin from "./main";
import { ImaApiClient, ImaApiError } from "./providers/ImaApiClient";
import { FolderMappingWizardModal } from "./FolderMappingWizardModal";
import {
  ConflictStrategy,
  FolderMappingMode,
  OnChangeStrategy,
  SyncDirection,
  SyncTrigger,
  WikiLinkStrategy,
} from "./types";

/**
 * Settings tab for the IMA Sync plugin.
 *
 * Layout strategy:
 *   - The top half covers everything a first-time user must configure
 *     (credentials, default notebook, folder mapping wizard).
 *   - Everything else is tucked into a collapsible "Advanced options" block
 *     so the settings screen doesn't overwhelm casual users.
 */
export class ImaSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ImaSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text:
        "Sync your Obsidian vault with Tencent IMA (ima.qq.com). " +
        "Get your Client ID / API key at https://ima.qq.com/agent-interface.",
    });

    // ======================================================
    //                 1. Getting started
    // ======================================================
    this.renderCredentials(containerEl);
    this.renderFolderMapping(containerEl);

    this.renderDirection(containerEl);

    // ======================================================
    //                 2. Sync (auto + manual)
    // ======================================================
    this.renderAutoSync(containerEl);
    this.renderActions(containerEl);

    // ======================================================
    //                 3. Advanced (collapsed by default)
    // ======================================================
    this.renderAdvanced(containerEl);
  }

  // =====================================================================
  //                           Top-level blocks
  // =====================================================================

  private renderCredentials(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Credentials").setHeading();

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("From https://ima.qq.com/agent-interface.")
      .addText((t) =>
        t
          .setPlaceholder("your-client-id")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Keep this private — never commit it to a public repository.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("your-api-key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the credentials work by listing your notebooks.")
      .addButton((b) =>
        b
          .setButtonText("Test")
          .setCta()
          .onClick(() => this.testConnection())
      );
  }

  private renderFolderMapping(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Folder → notebook mapping").setHeading();

    const mode = this.plugin.settings.folderMappingMode;

    // ---- Mode picker (always shown) -------------------------------------
    new Setting(containerEl)
      .setName("Mode")
      .setDesc(this.describeMappingMode(mode))
      .addDropdown((dd) =>
        dd
          .addOption("smart", "Smart (recommended)")
          .addOption("default-only", "Default notebook only")
          .setValue(mode)
          .onChange(async (value) => {
            this.plugin.settings.folderMappingMode = value as FolderMappingMode;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    // default-only mode has nothing left to configure — every note goes to
    // the IMA account's default notebook automatically.
    if (mode !== "default-only") {
      this.renderSmartSection(containerEl);
    }
  }

  // --------------------------------------------------------------------
  //                       Mode-specific renderers
  // --------------------------------------------------------------------

  private describeMappingMode(mode: FolderMappingMode): string {
    if (mode === "default-only") {
      return "Every note goes to your IMA account's default notebook. Nothing to configure here.";
    }
    return (
      "Notes are routed to different notebooks based on their folder. " +
      "Folders you don't configure won't be synced."
    );
  }

  /** Everything that only matters in Smart mode (wizard + rules table). */
  private renderSmartSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Smart mapping").setHeading();

    new Setting(containerEl)
      .setName("Mapping wizard")
      .setDesc(
        "Pick a destination IMA notebook for each folder in your vault. " +
          "Folders you don't configure won't be synced."
      )
      .addButton((b) =>
        b
          .setButtonText("Open wizard")
          .setCta()
          .onClick(() => {
            new FolderMappingWizardModal(this.app, this.plugin, {
              onFinish: () => this.display(),
            }).open();
          })
      );

    new Setting(containerEl)
      .setName("Include attachments")
      .setDesc(
        "Sync PNG/JPG/PDF/etc. alongside markdown notes. " +
          "Note: the OpenAPI channel currently ignores attachments."
      )
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.includeAttachments)
          .onChange(async (value) => {
            this.plugin.settings.includeAttachments = value;
            await this.plugin.saveSettings();
          })
      );

  }

  private renderDirection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Direction").setHeading();

    new Setting(containerEl)
      .setName("Sync direction")
      .setDesc(
        "Push: Obsidian → IMA only. " +
          "Pull: IMA → Obsidian only. " +
          "Bidirectional: both ways."
      )
      .addDropdown((dd) =>
        dd
          .addOption("push", "Push (Obsidian → IMA)")
          .addOption("pull", "Pull (IMA → Obsidian)")
          .addOption("bidirectional", "Bidirectional")
          .setValue(this.plugin.settings.direction)
          .onChange(async (value) => {
            this.plugin.settings.direction = value as SyncDirection;
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }

  /**
   * Auto sync block — surfaces the trigger setting on the main page so users
   * can see at a glance whether the plugin is running in the background.
   * A hint below the dropdown clarifies that manual sync is always available,
   * which answers the common "do I still need to press the buttons?" question.
   */
  private renderAutoSync(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Trigger").setHeading();

    new Setting(containerEl)
      .setName("Mode")
      .setDesc(
        "Off: nothing happens until you press a button below. " +
          "On file save: push every note as soon as you save it. " +
          "Every N minutes: sync periodically in the background."
      )
      .addDropdown((dd) =>
        dd
          .addOption("manual", "Off (manual only)")
          .addOption("on-save", "On file save (push only)")
          .addOption("interval", "Every N minutes")
          .setValue(this.plugin.settings.trigger)
          .onChange(async (value) => {
            this.plugin.settings.trigger = value as SyncTrigger;
            await this.plugin.saveSettings();
            this.plugin.rescheduleTimers();
            this.display();
          })
      );

    if (this.plugin.settings.trigger === "interval") {
      new Setting(containerEl)
        .setName("Interval (minutes)")
        .setDesc("How often to run an auto sync in the background.")
        .addSlider((s) =>
          s
            .setLimits(5, 240, 5)
            .setValue(this.plugin.settings.intervalMinutes)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.intervalMinutes = value;
              await this.plugin.saveSettings();
              this.plugin.rescheduleTimers();
            })
        );
    }

    // Soft hint so users don't wonder "if auto is on, do I still need to press
    // the buttons below?" — the answer is 'no, but you can'.
    if (this.plugin.settings.trigger !== "manual") {
      containerEl.createEl("div", {
        text: "Auto sync is on. You can still run a manual sync below anytime.",
        cls: "ima-sync-hint",
      });
    }
  }

  private renderActions(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Manual sync").setHeading();

    const last = this.plugin.settings.lastSyncAt;
    const lastPull = this.plugin.settings.lastPullAt;
    new Setting(containerEl)
      .setName("Last push")
      .setDesc(last ? new Date(last).toLocaleString() : "Never");
    new Setting(containerEl)
      .setName("Last pull")
      .setDesc(lastPull ? new Date(lastPull).toLocaleString() : "Never");

    new Setting(containerEl)
      .setName("Push to IMA")
      .setDesc("Send local notes to IMA now.")
      .addButton((b) =>
        b
          .setButtonText("Push")
          .setCta()
          .onClick(async () => {
            await this.plugin.runPushCommand();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Pull from IMA")
      .setDesc("Fetch notes from IMA now.")
      .addButton((b) =>
        b.setButtonText("Pull").onClick(async () => {
          await this.plugin.runPullCommand();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Two-way sync")
      .setDesc("Reconcile both sides in one go.")
      .addButton((b) =>
        b.setButtonText("Sync").onClick(async () => {
          await this.plugin.runBidirectionalCommand();
          this.display();
        })
      );
  }

  // =====================================================================
  //                         Advanced (collapsed)
  // =====================================================================

  private renderAdvanced(containerEl: HTMLElement): void {
    const details = containerEl.createEl("details", { cls: "ima-sync-advanced" });
    const summary = details.createEl("summary", {
      text: "Advanced options",
      cls: "ima-sync-advanced-summary",
    });
    // Keep a local reference so existing behaviour (focusing / screen reader)
    // isn't affected. The actual visual styling now lives in styles.css.
    void summary;

    const body = details.createDiv();

    // ---- OpenAPI: on-change strategy ----
    new Setting(body).setName("OpenAPI (advanced)").setHeading();

    new Setting(body)
      .setName("On-change strategy")
      .setDesc(
        "IMA notes cannot be updated in place. " +
          "Recreate: create a brand-new note each time the local content changes (recommended). " +
          "Skip: keep only the first synced version and ignore later local edits."
      )
      .addDropdown((dd) =>
        dd
          .addOption("recreate", "Create a new note each time (recommended)")
          .addOption("skip", "Skip (sync once only)")
          .setValue(this.plugin.settings.onChangeStrategy)
          .onChange(async (value) => {
            this.plugin.settings.onChangeStrategy = value as OnChangeStrategy;
            await this.plugin.saveSettings();
          })
      );

    // ---- Pull options ----
    if (this.plugin.settings.direction !== "push") {
      new Setting(body).setName("Pull options").setHeading();

      new Setting(body)
        .setName("Pull target folder")
        .setDesc("IMA notes will be written into this folder in the vault.")
        .addText((t) =>
          t
            .setPlaceholder("IMA")
            .setValue(this.plugin.settings.pullTargetFolder)
            .onChange(async (value) => {
              this.plugin.settings.pullTargetFolder = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(body)
        .setName("Mirror notebooks as subfolders")
        .setDesc("When enabled, each IMA notebook becomes a subfolder.")
        .addToggle((tg) =>
          tg
            .setValue(this.plugin.settings.pullMirrorNotebookFolders)
            .onChange(async (value) => {
              this.plugin.settings.pullMirrorNotebookFolders = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(body)
        .setName("Only pull these notebooks")
        .setDesc("Comma-separated folder_id list. Leave empty to pull all.")
        .addText((t) =>
          t
            .setPlaceholder("fld_xxx, fld_yyy")
            .setValue(this.plugin.settings.pullIncludeNotebookIds.join(", "))
            .onChange(async (value) => {
              this.plugin.settings.pullIncludeNotebookIds = splitList(value);
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.direction === "bidirectional") {
      new Setting(body)
        .setName("Conflict strategy")
        .setDesc(
          "How to resolve when both sides have changed a note. " +
            "Note: pull currently only retrieves plain text, which may differ " +
            "from the local Markdown source."
        )
        .addDropdown((dd) =>
          dd
            .addOption("newest-wins", "Newest wins (default)")
            .addOption("local-wins", "Local wins (keep Obsidian)")
            .addOption("remote-wins", "Remote wins (keep IMA)")
            .addOption("keep-both", "Keep both (writes a .conflict file)")
            .addOption("skip", "Skip on conflict")
            .setValue(this.plugin.settings.conflictStrategy)
            .onChange(async (value) => {
              this.plugin.settings.conflictStrategy = value as ConflictStrategy;
              await this.plugin.saveSettings();
            })
        );
    }

    // ---- Conversion ----
    new Setting(body).setName("Conversion").setHeading();

    new Setting(body).setName("Wiki link handling").addDropdown((dd) =>
      dd
        .addOption("plain-text", "Convert to plain text")
        .addOption("markdown-link", "Convert to Markdown links")
        .addOption("keep", "Keep as-is")
        .setValue(this.plugin.settings.wikiLinkStrategy)
        .onChange(async (value) => {
          this.plugin.settings.wikiLinkStrategy = value as WikiLinkStrategy;
          await this.plugin.saveSettings();
        })
    );

    new Setting(body)
      .setName("Strip frontmatter")
      .setDesc(
        "Remove YAML frontmatter before sending to IMA. " +
          "Enabling this also disables the post-sync writeback of ima_notebook."
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.stripFrontmatter).onChange(async (value) => {
          this.plugin.settings.stripFrontmatter = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(body)
      .setName("Max note size (MB)")
      .setDesc("Content larger than this will be truncated to stay below the IMA 210009 limit.")
      .addSlider((s) =>
        s
          .setLimits(1, 20, 1)
          .setValue(Math.round(this.plugin.settings.maxNoteBytes / 1024 / 1024))
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxNoteBytes = value * 1024 * 1024;
            await this.plugin.saveSettings();
          })
      );

    // ---- Danger zone ----
    new Setting(body).setName("Danger zone").setHeading();

    new Setting(body)
      .setName("Reset local sync state")
      .setDesc(
        "After reset, the next push re-uploads every file — which may create duplicates in IMA."
      )
      .addButton((b) =>
        b
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.fileStates = {};
            this.plugin.settings.remoteIndex = {};
            this.plugin.settings.lastSyncAt = 0;
            this.plugin.settings.lastPullAt = 0;
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }

  // =====================================================================
  //                             Helpers
  // =====================================================================

  private buildClient(): ImaApiClient | null {
    const s = this.plugin.settings;
    if (!s.clientId || !s.apiKey) {
      new Notice("Please configure Client ID and API key first", 5000);
      return null;
    }
    return new ImaApiClient({
      clientId: s.clientId,
      apiKey: s.apiKey,
    });
  }

  private async testConnection(): Promise<void> {
    const client = this.buildClient();
    if (!client) return;
    try {
      const res = await client.listNotebook({ cursor: "0", limit: 5 });
      const count = res.note_folder_infos?.length ?? 0;
      new Notice(`Connected successfully, ${count} notebook(s) visible`, 5000);
    } catch (e) {
      new Notice(`Connection failed — ${formatError(e)}`, 5000);
    }
  }

}

function splitList(v: string): string[] {
  return v
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatError(e: unknown): string {
  if (e instanceof ImaApiError) return `${e.apiMsg} (code=${e.code})`;
  if (e instanceof Error) return e.message;
  return String(e);
}
