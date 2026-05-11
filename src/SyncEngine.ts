import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { ImaSyncSettings, FileSyncState } from "./types";
import { RemoteItem, SyncProvider } from "./providers/SyncProvider";
import { MarkdownTransformer } from "./transformer";
import { hashContent } from "./utils";
import { FolderMappingManager } from "./FolderMappingManager";
import { logDebug, logError, logWarn } from "./logger";

export interface SyncStats {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errors: Array<{ path: string; error: string }>;
  /** Top-level folders seen during this run that had no mapping rule (used for prompts). */
  unmappedFolders: string[];
}

export interface PullStats {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  conflicted: number;
  failed: number;
  errors: Array<{ remoteId: string; error: string }>;
}

type PullOutcome = "created" | "updated" | "skipped" | "conflicted" | "failed";

/**
 * Sync orchestrator:
 *  - {@link runFullSync}       push direction (Obsidian → IMA)
 *  - {@link runPull}           pull direction (IMA → Obsidian)
 *  - {@link runBidirectional}  both directions (pull first, then push)
 */
export class SyncEngine {
  private running = false;

  constructor(
    private readonly app: App,
    private readonly settings: ImaSyncSettings,
    /** Lazily resolve the provider list so hot-reconfiguring doesn't require re-wiring the engine. */
    private readonly getProviders: () => SyncProvider[],
    private readonly saveSettings: () => Promise<void>,
    /**
     * 在 frontmatter writeback 前后通知调用方，用于临时屏蔽 on-save 触发。
     * writeback 会修改文件内容，触发 vault "modify" 事件，如果 debounce 冷却期
     * 已过，会立即触发新一轮 push，recreate 策略下就会产生重复笔记。
     */
    private readonly onWritebackStart?: (path: string) => void,
    private readonly onWritebackEnd?: (path: string) => void
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------
  //                              Push
  // ---------------------------------------------------------------------

  async runFullSync(silent = false): Promise<SyncStats> {
    const stats: SyncStats = {
      total: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      unmappedFolders: [],
    };

    if (this.running) {
      if (!silent) new Notice("Another sync is already running");
      return stats;
    }
    this.running = true;

    try {
      try {
        for (const p of this.getProviders()) await p.precheck();
      } catch (e) {
        const msg = `Precheck failed: ${(e as Error).message}`;
        if (!silent) new Notice(msg);
        logError(msg);
        stats.errors.push({ path: "", error: (e as Error).message });
        return stats;
      }

      const files = this.collectCandidateFiles();
      stats.total = files.length;

      if (!silent) new Notice(`Pushing ${files.length} file(s) to IMA`);

      const transformer = new MarkdownTransformer(this.settings);
      const mappingManager = new FolderMappingManager(this.settings);
      const unmappedSet = new Set<string>();

      for (const file of files) {
        try {
          const result = await this.syncSingleFile(
            file,
            transformer,
            mappingManager,
            unmappedSet
          );
          if (result === "skipped") stats.skipped++;
          else if (result === "ok") stats.succeeded++;
          else {
            stats.failed++;
            stats.errors.push({ path: file.path, error: result });
          }
        } catch (e) {
          stats.failed++;
          stats.errors.push({ path: file.path, error: (e as Error).message });
        }
      }

      stats.unmappedFolders = Array.from(unmappedSet).sort();
      this.settings.lastSyncAt = Date.now();
      await this.saveSettings();

      const summary = `Push complete: ${stats.succeeded} ok / ${stats.skipped} skipped / ${stats.failed} failed`;
      if (!silent) new Notice(summary);
      logDebug(summary, stats);

      // Friendly error surfacing: missing notebook.
      this.surfaceFolderNotExistErrors(stats, silent);
      return stats;
    } finally {
      this.running = false;
    }
  }

  async syncFile(file: TFile): Promise<void> {
    if (!this.shouldSync(file)) return;
    const transformer = new MarkdownTransformer(this.settings);
    const mappingManager = new FolderMappingManager(this.settings);
    try {
      for (const p of this.getProviders()) await p.precheck();
      await this.syncSingleFile(file, transformer, mappingManager, new Set());
      await this.saveSettings();
    } catch (e) {
      logWarn("syncFile failed:", e);
    }
  }

  async removeFile(relativePath: string): Promise<void> {
    const state = this.settings.fileStates[relativePath];
    for (const p of this.getProviders()) {
      try {
        await p.remove(relativePath, state?.remoteId);
      } catch (e) {
        logWarn(`remove via ${p.name} failed:`, e);
      }
    }
    if (state?.remoteId) delete this.settings.remoteIndex[state.remoteId];
    delete this.settings.fileStates[relativePath];
    await this.saveSettings();
  }

  // ---------------------------------------------------------------------
  //                              Pull
  // ---------------------------------------------------------------------

  /** Pull notes from IMA back into the vault. Uses the first pull-capable provider. */
  async runPull(silent = false): Promise<PullStats> {
    const stats = this.emptyPullStats();

    if (this.running) {
      if (!silent) new Notice("Another sync is already running");
      return stats;
    }

    const puller = this.getProviders().find(
      (p) => p.supportsPull && typeof p.listRemote === "function" && typeof p.fetchRemote === "function"
    );
    if (!puller) {
      if (!silent) new Notice("Pull is not supported in the current sync mode");
      return stats;
    }

    this.running = true;
    try {
      try {
        await puller.precheck();
      } catch (e) {
        const msg = `Pull precheck failed: ${(e as Error).message}`;
        if (!silent) new Notice(msg);
        stats.errors.push({ remoteId: "", error: (e as Error).message });
        return stats;
      }

      let items: RemoteItem[] = [];
      try {
        items = await puller.listRemote!();
      } catch (e) {
        const msg = `Failed to list remote notes: ${(e as Error).message}`;
        if (!silent) new Notice(msg);
        stats.errors.push({ remoteId: "", error: (e as Error).message });
        return stats;
      }

      stats.total = items.length;
      // Progress indicator: a long-lived Notice that we update as items are processed
      const progressNotice = silent ? null : new Notice("", 0); // duration=0 means manual dismiss
      const updateProgress = (processed: number) => {
        if (!progressNotice) return;
        const pct = Math.round((processed / items.length) * 100);
        const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
        progressNotice.setMessage(
          `Pulling from IMA: ${processed}/${items.length}\n${bar} ${pct}%`
        );
      };
      updateProgress(0);

      const mappingManager = new FolderMappingManager(this.settings);
      const PULL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max
      const SAVE_INTERVAL = 10; // save settings every N items
      const startTime = Date.now();

      for (let i = 0; i < items.length; i++) {
        // Timeout breaker
        if (Date.now() - startTime > PULL_TIMEOUT_MS) {
          logWarn("Pull timeout after 5 minutes, stopping with partial results.");
          if (progressNotice) progressNotice.hide();
          if (!silent) new Notice("Pull timed out after 5 minutes. Partial results saved.");
          break;
        }

        const item = items[i];
        try {
          let outcome = await this.pullSingleItem(puller, item, mappingManager);
          // Retry once on failure (covers transient errors like missing parent dirs)
          if (outcome === "failed") {
            await this.delay(500);
            outcome = await this.pullSingleItem(puller, item, mappingManager);
          }
          stats[outcome] = stats[outcome] + 1;
          if (outcome === "failed") {
            stats.errors.push({ remoteId: item.remoteId, error: item.title ?? "unknown" });
          }
        } catch (e) {
          stats.failed++;
          stats.errors.push({ remoteId: item.remoteId, error: (e as Error).message });
        }

        updateProgress(i + 1);

        // Periodic save to avoid losing progress on crash
        if ((i + 1) % SAVE_INTERVAL === 0) {
          await this.saveSettings();
        }
      }

      // Dismiss progress notice
      if (progressNotice) progressNotice.hide();

      this.settings.lastPullAt = Date.now();
      await this.saveSettings();

      const summary =
        `Pull complete: ` +
        `${stats.created} created / ${stats.updated} updated / ` +
        `${stats.skipped} skipped / ${stats.conflicted} conflicted / ${stats.failed} failed`;
      if (!silent) {
        new Notice(summary);
        if (stats.failed > 0) {
          const failedTitles = stats.errors.map((e) => e.error).slice(0, 5).join(", ");
          new Notice(`Failed notes: ${failedTitles}${stats.errors.length > 5 ? "..." : ""}`, 8000);
        }
      }
      logDebug(summary, stats);

      return stats;
    } finally {
      this.running = false;
    }
  }

  /** Sync both ways: pull first, then push. */
  async runBidirectional(silent = false): Promise<{ pull: PullStats; push: SyncStats }> {
    const pull = await this.runPull(silent);
    const push = await this.runFullSync(silent);
    return { pull, push };
  }

  // ---------------------------------------------------------------------
  //                              Push (internals)
  // ---------------------------------------------------------------------

  private collectCandidateFiles(): TFile[] {
    return this.app.vault.getFiles().filter((f) => this.shouldSync(f));
  }

  private shouldSync(file: TFile): boolean {
    const ext = file.extension.toLowerCase();
    const isMarkdown = ext === "md";
    const isAsset = ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"].includes(ext);

    if (!isMarkdown && !isAsset) return false;
    if (isAsset && !this.settings.includeAttachments) return false;

    // Folder-level include/exclude is fully expressed via folderMappings now
    // (rules with sync=false + the "Unlisted folders" global policy). The
    // actual skip decision is deferred to FolderMappingManager inside
    // syncSingleFile() so we can skip per-file based on the mapping table.
    return true;
  }

  private async syncSingleFile(
    file: TFile,
    transformer: MarkdownTransformer,
    mappingManager: FolderMappingManager,
    unmappedSet: Set<string>
  ): Promise<string> {
    if (this.settings.direction === "pull") return "skipped";

    const rel = file.path;
    const stateMap = this.settings.fileStates;
    const prev: FileSyncState | undefined = stateMap[rel];

    // Short-circuit on explicit "don't sync" rules BEFORE reading file contents
    // so excluded folders don't cost us any IO.
    if (mappingManager.isExplicitlySkipped(rel)) {
      return "skipped";
    }

    let hash: string;
    let transformed: string;
    let rawContent = "";

    if (file.extension.toLowerCase() === "md") {
      rawContent = await this.app.vault.cachedRead(file);
      transformed = transformer.transform(rawContent);
      hash = hashContent(transformed);
      // The ONLY authoritative "has this changed since we last pushed?" signal
      // is `pushHash`. `prev.hash` used to get overwritten by pull results
      // (see recordPullState), which meant a pulled-then-pushed note would
      // always look "changed" and spawn a duplicate in IMA on every sync.
      //
      // Back-compat: old data.json entries only have `hash`. If pushHash is
      // missing we fall back to `hash` **only when remoteId is also absent**
      // (i.e. this is a genuinely fresh record, not a pulled one).
      const pushBaseline = prev?.pushHash ?? (prev && !prev.remoteId ? prev.hash : undefined);
      if (pushBaseline === hash) return "skipped";
    } else {
      hash = `bin:${file.stat.size}:${file.stat.mtime}`;
      const pushBaseline = prev?.pushHash ?? (prev && !prev.remoteId ? prev.hash : undefined);
      if (pushBaseline === hash) return "skipped";
      transformed = "";
    }

    // Safety net: if we have a remoteId **but no pushHash**, that means the
    // note came from a pull (or from an older plugin version). Blindly
    // pushing it now would trigger "recreate" → handleCreate → duplicate.
    // Instead: mint a pushHash from the current content and skip this run.
    // Next time the user actually edits the note, the new hash will differ
    // and we'll push it properly.
    if (prev && prev.remoteId && !prev.pushHash && file.extension.toLowerCase() === "md") {
      stateMap[rel] = {
        ...prev,
        pushHash: hash,
        hash,
        syncedAt: Date.now(),
      };
      return "skipped";
    }

    // Resolve the destination notebook for this file.
    const target = mappingManager.resolve(file, rawContent);
    if (target.skip) {
      // Unlisted folders with the "skip" policy land here — silently skipped.
      return "skipped";
    }
    if (target.unmappedPrefix !== undefined) {
      unmappedSet.add(target.unmappedPrefix);
    }

    // Bidirectional: if remote has newer changes we haven't observed locally,
    // delegate to the conflict policy.
    if (
      this.settings.direction === "bidirectional" &&
      prev?.remoteId &&
      prev.lastKnownRemoteMtime !== undefined
    ) {
      const remoteMeta = this.settings.remoteIndex[prev.remoteId];
      const remoteChanged = !!(
        remoteMeta &&
        remoteMeta.remoteMtime &&
        remoteMeta.remoteMtime > prev.lastKnownRemoteMtime
      );
      if (remoteChanged) {
        const decision = this.resolvePushConflict();
        if (decision === "skip") return "skipped";
        if (decision === "keep-both") {
          await this.writeConflictCopy(rel, transformed);
          return "skipped";
        }
        // fall-through: overwrite remote
      }
    }

    let lastError = "";
    let lastRemoteId = prev?.remoteId;
    let lastRemoteVersion = prev?.remoteVersion;
    let anyOk = false;

    for (const p of this.getProviders()) {
      const r = await p.upsert({
        relativePath: rel,
        name: file.name,
        content: transformed,
        remoteId: prev?.remoteId,
        file,
        folderId: target.folderId || undefined,
        folderName: target.folderName || undefined,
        remoteVersion: prev?.remoteVersion,
      });
      if (r.success) {
        anyOk = true;
        if (r.remoteId) lastRemoteId = r.remoteId;
        if (r.remoteVersion !== undefined) lastRemoteVersion = r.remoteVersion;
      } else {
        lastError = r.error ?? "unknown error";
        logWarn(`provider ${p.name} failed for ${rel}:`, lastError);
      }
    }

    if (!anyOk) return lastError || "all providers failed";

    const now = Date.now();

    // recreate 策略下，provider 会忽略 remoteId 并新建一篇笔记，返回新的 remoteId。
    // 此时旧 remoteId 对应的 remoteIndex 条目必须清理掉：
    //   1. 防止 pull 时把旧笔记（IMA 里仍存在）认领为本文件，覆写 fileStates.remoteId
    //   2. 防止下次 push 拿着旧 remoteId 再次 recreate，形成无限循环
    const oldRemoteId = prev?.remoteId;
    if (oldRemoteId && lastRemoteId && oldRemoteId !== lastRemoteId) {
      delete this.settings.remoteIndex[oldRemoteId];
      logDebug(`recreate: cleaned up old remoteId ${oldRemoteId} → ${lastRemoteId} for ${rel}`);
    }

    stateMap[rel] = {
      mtime: file.stat.mtime,
      hash,
      // Pin pushHash to the content we just uploaded. This is the only value
      // the next push will compare against — unless the user actually edits
      // the note, the next run is guaranteed to short-circuit on "skipped"
      // above, so IMA never sees a duplicate.
      pushHash: hash,
      pullHash: stateMap[rel]?.pullHash,
      remoteId: lastRemoteId,
      remoteVersion: lastRemoteVersion,
      syncedAt: now,
      lastKnownRemoteMtime: now,
    };
    if (lastRemoteId) {
      this.settings.remoteIndex[lastRemoteId] = {
        relativePath: rel,
        remoteMtime: now,
        title: file.basename,
        groupName: target.folderName || undefined,
        syncedAt: now,
      };
    }

    // Write sync metadata back into the note's frontmatter so the user can
    // tell which IMA notebook each note ended up in, and we have a stable
    // identifier for the next sync. Skip this when the user explicitly asked
    // us to strip frontmatter.
    //
    // Important: the hash we stored in `stateMap[rel]` was computed over
    // transformer output, which — by design — excludes any `ima_*` keys
    // (see `stripSyncMetadata` in utils.ts). That means the writeback below
    // *cannot* shift the hash on the next run, so there's no feedback loop
    // and no need to recompute the hash after this step.
    //
    // Obsidian guideline: prefer `fileManager.processFrontMatter()` over
    // read+modify — it's race-free against the editor buffer and handles
    // YAML serialization for us.
    if (
      file.extension.toLowerCase() === "md" &&
      !this.settings.stripFrontmatter
    ) {
      // 通知调用方屏蔽该文件的 on-save 触发，避免 writeback 引发二次 push。
      this.onWritebackStart?.(rel);
      try {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          if (lastRemoteId) fm.ima_note_id = lastRemoteId;
          if (target.folderName) fm.ima_notebook = target.folderName;
          fm.ima_last_sync = new Date(now).toISOString();
        });
      } catch (e) {
        logWarn("frontmatter writeback failed:", e);
      } finally {
        // 延迟解除屏蔽，确保 processFrontMatter 触发的 modify 事件已被消费。
        // 200ms 足够 Obsidian 内部事件循环处理完毕，同时远小于 debounce 窗口。
        activeWindow.setTimeout(() => this.onWritebackEnd?.(rel), 200);
      }
    }

    return "ok";
  }

  /**
   * Surface "notebook no longer exists" errors (IMA 210035 / FOLDER_NOT_EXIST)
   * as an explicit Notice, so the user knows to fix their mapping instead of
   * seeing a silent failure.
   */
  private surfaceFolderNotExistErrors(stats: SyncStats, silent: boolean): void {
    if (silent) return;
    const hits = stats.errors.filter((e) =>
      /FOLDER_NOT_EXIST|210035/i.test(e.error)
    );
    if (hits.length === 0) return;
    new Notice(
      `${hits.length} note(s) failed because their target notebook no longer exists. ` +
        "Open the mapping wizard to reassign them, or recreate the notebook in the IMA app.",
      5000
    );
  }

  private resolvePushConflict(): "overwrite" | "skip" | "keep-both" {
    switch (this.settings.conflictStrategy) {
      case "local-wins":
        return "overwrite";
      case "remote-wins":
        return "skip";
      case "skip":
        return "skip";
      case "keep-both":
        return "keep-both";
      case "newest-wins":
      default:
        return "overwrite";
    }
  }

  private async writeConflictCopy(relativePath: string, content: string): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const base = relativePath.replace(/\.md$/i, "");
    const dest = normalizePath(`${base}.conflict-${ts}.md`);
    try {
      await this.app.vault.create(dest, content);
    } catch (e) {
      logWarn("failed to write conflict copy:", e);
    }
  }

  // ---------------------------------------------------------------------
  //                              Pull (internals)
  // ---------------------------------------------------------------------

  private async pullSingleItem(provider: SyncProvider, item: RemoteItem, mappingManager?: FolderMappingManager): Promise<PullOutcome> {
    const knownEntry = this.settings.remoteIndex[item.remoteId];
    let existingFile: TFile | null = null;

    if (knownEntry?.relativePath) {
      const f = this.app.vault.getAbstractFileByPath(knownEntry.relativePath);
      if (f instanceof TFile) existingFile = f;
    }

    if (!existingFile) {
      return this.pullCreate(provider, item, mappingManager);
    }

    const localState = this.settings.fileStates[existingFile.path];
    // Compute the local hash the same way push does: run it through the
    // transformer so `ima_*` frontmatter metadata the plugin wrote is
    // excluded. Otherwise the first pull after a push would always flag
    // the file as "locally changed" purely because we wrote ima_last_sync
    // into its frontmatter.
    //
    // Comparison target is `pushHash` (the hash we recorded the last time we
    // pushed this exact file). Using the generic `hash` field would mix in
    // the plaintext-hash we stored on the previous pull, which is a totally
    // different kind of string and would always compare as "changed".
    const transformer = new MarkdownTransformer(this.settings);
    const localRaw = await this.app.vault.cachedRead(existingFile);
    const currentLocalHash = hashContent(transformer.transform(localRaw));
    const lastPushed = localState?.pushHash ?? localState?.hash;
    const localChanged = !!localState && lastPushed !== undefined && lastPushed !== currentLocalHash;
    const remoteChanged =
      item.modifyTime !== undefined &&
      (localState?.lastKnownRemoteMtime === undefined ||
        item.modifyTime > localState.lastKnownRemoteMtime);

    if (!remoteChanged) return "skipped";

    if (localChanged && remoteChanged) {
      const decision = this.resolvePullConflict(localState?.mtime, item.modifyTime);
      if (decision === "skip") return "conflicted";
      if (decision === "keep-local") return "skipped";
      if (decision === "keep-both") {
        const rc = await provider.fetchRemote!(item);
        const body = this.wrapPulledContent(item, rc);
        await this.writeConflictCopy(existingFile.path, body);
        return "conflicted";
      }
      // remote-wins → fall through
    }

    const rc = await provider.fetchRemote!(item);
    const body = this.wrapPulledContent(item, rc);
    // Obsidian >=1.4: vault.process() atomically replaces file contents and
    // is race-free against editor buffer writes. Preferred over vault.modify().
    await this.app.vault.process(existingFile, () => body);
    this.recordPullState(existingFile.path, item, body);
    return "updated";
  }

  private async pullCreate(provider: SyncProvider, item: RemoteItem, mappingManager?: FolderMappingManager): Promise<PullOutcome> {
    try {
      const rc = await provider.fetchRemote!(item);
      const body = this.wrapPulledContent(item, rc);
      const rel = this.buildPullTargetPath(item, mappingManager);
      await this.ensureFolder(rel);
      const file = await this.app.vault.create(rel, body);
      this.recordPullState(file.path, item, body);
      return "created";
    } catch (e) {
      logWarn("pullCreate failed:", e);
      return "failed";
    }
  }

  private resolvePullConflict(
    localMtime?: number,
    remoteMtime?: number
  ): "keep-local" | "overwrite" | "keep-both" | "skip" {
    switch (this.settings.conflictStrategy) {
      case "local-wins":
        return "keep-local";
      case "remote-wins":
        return "overwrite";
      case "skip":
        return "skip";
      case "keep-both":
        return "keep-both";
      case "newest-wins":
      default:
        return (remoteMtime ?? 0) > (localMtime ?? 0) ? "overwrite" : "keep-local";
    }
  }

  /** Wrap pulled content with frontmatter so origin is discoverable. */
  private wrapPulledContent(
    item: RemoteItem,
    rc: { content: string; format: string }
  ): string {
    const meta = [
      "---",
      `ima_note_id: ${item.remoteId}`,
      `ima_notebook: ${item.groupName ?? ""}`,
      `ima_modify_time: ${item.modifyTime ?? ""}`,
      `ima_content_format: ${rc.format}`,
      "---",
      "",
    ].join("\n");
    const head = rc.content.trimStart().startsWith("#") ? "" : `# ${item.title}\n\n`;
    return meta + head + rc.content;
  }

  private buildPullTargetPath(item: RemoteItem, mappingManager?: FolderMappingManager): string {
    const sanitize = (s: string): string =>
      s.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+$/g, "").slice(0, 120) || "untitled";

    const parts: string[] = [];

    // 优先：通过 folderMappings 反查本地目录（与 Push 方向共用同一套配置）
    const folderId = (item.extra as Record<string, string> | undefined)?.folder_id;
    const localPrefix = mappingManager?.resolveLocalPrefix(folderId, item.groupName) ?? null;

    if (localPrefix !== null) {
      // 找到映射：直接写入对应的本地目录，不再额外建笔记本子目录
      if (localPrefix) parts.push(localPrefix);
    } else {
      // 未找到映射（笔记本未配置）：降级到 pullTargetFolder 兜底
      const root = this.settings.pullTargetFolder.trim();
      if (root) parts.push(root);
      // 兜底模式下仍支持按笔记本名建子目录
      if (this.settings.pullMirrorNotebookFolders && item.groupName) {
        parts.push(sanitize(item.groupName));
      }
    }

    parts.push(sanitize(item.title) + ".md");
    let candidate = normalizePath(parts.join("/"));

    if (this.app.vault.getAbstractFileByPath(candidate)) {
      const base = candidate.replace(/\.md$/, "");
      candidate = `${base} (${item.remoteId.slice(-6)}).md`;
    }
    return candidate;
  }

  private async ensureFolder(relPath: string): Promise<void> {
    const parts = relPath.split("/").slice(0, -1); // all directory segments
    if (parts.length === 0) return;

    // Build each level and create if missing
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // ignore "already exists" races
        }
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => activeWindow.setTimeout(resolve, ms));
  }

  private recordPullState(relativePath: string, item: RemoteItem, content: string): void {
    const hash = hashContent(content);
    const now = Date.now();
    // CRITICAL: never touch pushHash here. A pulled note's body comes back as
    // plaintext (IMA's MARKDOWN format isn't supported), so its hash has no
    // relationship to the transformer's output. Letting it leak into pushHash
    // would make the next push misclassify the note as "changed" and spawn a
    // duplicate in IMA. We keep whatever pushHash the previous push recorded
    // (if any), and stash the pulled-content hash in the dedicated pullHash
    // field purely for conflict-detection bookkeeping.
    const prev = this.settings.fileStates[relativePath];
    this.settings.fileStates[relativePath] = {
      mtime: now,
      hash,
      pushHash: prev?.pushHash,
      pullHash: hash,
      remoteId: item.remoteId,
      syncedAt: now,
      lastKnownRemoteMtime: item.modifyTime ?? now,
    };
    this.settings.remoteIndex[item.remoteId] = {
      relativePath,
      remoteMtime: item.modifyTime ?? now,
      title: item.title,
      groupName: item.groupName,
      syncedAt: now,
    };
  }

  private emptyPullStats(): PullStats {
    return {
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      conflicted: 0,
      failed: 0,
      errors: [],
    };
  }
}
