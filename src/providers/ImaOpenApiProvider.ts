import {
  DeleteResult,
  RemoteContent,
  RemoteItem,
  SyncPayload,
  SyncProvider,
  SyncResult,
} from "./SyncProvider";
import { ImaSyncSettings } from "../types";
import { ImaApiClient, ImaApiError, ImaNoteMeta } from "./ImaApiClient";
import { logWarn } from "../logger";

/**
 * 腾讯 IMA OpenAPI 同步通道。
 *
 * 注意：IMA 笔记 API **没有原地更新能力**（只有 import_doc / append_doc），
 * 所以：
 *  - 首次同步 → 调用 import_doc 创建新笔记，保存返回的 note_id
 *  - 内容发生变化 → 根据 settings.onChangeStrategy 决定：
 *      - skip：保持原状，什么都不做（推荐：IMA 里永远只有一篇）
 *      - recreate：调用 import_doc 重新建一篇，旧笔记保留在 IMA 中
 *
 * Pull 方向（双向同步用）：
 *  - listRemote：调用 list_note 把用户所有/指定笔记本的笔记列表拉下来
 *  - fetchRemote：调用 get_doc_content(PLAINTEXT) 拿到笔记正文
 *
 *  ⚠️ IMA 文档明确说明 get_doc_content 的 `target_content_format=1(MARKDOWN)` **不支持**，
 *  所以 pull 回来的内容是纯文本，不是原始 markdown。这个 Provider 会在 fetchRemote 的返回值里
 *  用 `format: "plaintext"` 标记出来，上层 SyncEngine 会在文件名处加上 ".ima.md" 后缀并写入 frontmatter 标记。
 */
export class ImaOpenApiProvider implements SyncProvider {
  readonly name = "ImaOpenAPI";
  readonly supportsPull = true;

  private client: ImaApiClient;

  constructor(private settings: ImaSyncSettings) {
    this.client = new ImaApiClient({
      clientId: settings.clientId,
      apiKey: settings.apiKey,
    });
  }

  precheck(): Promise<void> {
    if (!this.settings.clientId) {
      return Promise.reject(new Error("Client ID is not configured"));
    }
    if (!this.settings.apiKey) {
      return Promise.reject(new Error("API key is not configured"));
    }
    return Promise.resolve();
  }

  async upsert(payload: SyncPayload): Promise<SyncResult> {
    if (payload.file.extension.toLowerCase() !== "md") {
      return { success: true };
    }

    try {
      const title = payload.file.basename;
      const safeContent = this.prepareContent(title, payload.content);

      // per-file 映射来自 SyncEngine（基于 FolderMappingManager.resolve()）。
      // 如果为空则传空串，由 IMA 账号默认笔记本兜底。
      const folderId = payload.folderId ?? "";
      const folderName = payload.folderName ?? "";

      if (payload.remoteId) {
        return await this.handleUpdate(
          payload.remoteId,
          safeContent,
          folderId,
          folderName,
          title,
          payload.remoteVersion ?? 0
        );
      }
      return await this.handleCreate(safeContent, folderId, folderName);
    } catch (e) {
      const msg = e instanceof ImaApiError ? `${e.apiMsg} (code=${e.code})` : (e as Error).message;
      return { success: false, error: msg };
    }
  }

  remove(_relativePath: string, _remoteId?: string): Promise<DeleteResult> {
    return Promise.resolve({
      success: false,
      error: "IMA does not support deletions via API — please delete the note inside the IMA app instead",
    });
  }

  // ========================= Pull 方向 =========================

  async listRemote(): Promise<RemoteItem[]> {
    await this.precheck();

    const notebookIds = this.settings.pullIncludeNotebookIds.filter(Boolean);
    const metas: ImaNoteMeta[] = [];

    if (notebookIds.length === 0) {
      // 全部笔记
      metas.push(...(await this.client.listAllNotes({})));
    } else {
      for (const folderId of notebookIds) {
        try {
          metas.push(...(await this.client.listAllNotes({ folder_id: folderId })));
        } catch (e) {
          logWarn(`list_note for folder ${folderId} failed:`, e);
        }
      }
    }

    // 去重（按 note_id）
    const seen = new Set<string>();
    const items: RemoteItem[] = [];
    for (const m of metas) {
      if (!m.note_id || seen.has(m.note_id)) continue;
      seen.add(m.note_id);
      items.push({
        remoteId: m.note_id,
        title: m.title || "(untitled)",
        modifyTime: m.modify_time,
        groupName: m.note_ext_info?.folder_name,
        extra: { folder_id: m.note_ext_info?.folder_id },
      });
    }
    return items;
  }

  async fetchRemote(item: RemoteItem): Promise<RemoteContent> {
    // IMA 目前只支持 PLAINTEXT / JSON，不支持 MARKDOWN
    const res = await this.client.getDocContent({ note_id: item.remoteId, format: 0 });
    return {
      content: res.content ?? "",
      format: "plaintext",
      modifyTime: item.modifyTime,
    };
  }

  // ========================= 内部 =========================

  private prepareContent(title: string, content: string): string {
    let body = content.trimStart();
    if (!body.startsWith("#")) {
      body = `# ${title}\n\n${body}`;
    }

    const max = this.settings.maxNoteBytes;
    if (max > 0) {
      const buf = new TextEncoder().encode(body);
      if (buf.byteLength > max) {
        const truncated = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, max));
        body = truncated + "\n\n> Content exceeds the per-note size limit and has been truncated.";
      }
    }
    return body;
  }

  private async handleCreate(
    content: string,
    folderId: string,
    folderName: string
  ): Promise<SyncResult> {
    const note = await this.client.importDoc({
      content,
      folder_id: folderId || undefined,
      folder_name: folderName || undefined,
    });

    return { success: true, remoteId: note.note_id };
  }

  private async handleUpdate(
    noteId: string,
    content: string,
    folderId: string,
    folderName: string,
    title: string,
    currentVersion: number
  ): Promise<SyncResult> {
    const strategy = this.settings.onChangeStrategy;

    if (strategy === "skip") {
      return { success: true, remoteId: noteId };
    }

    // "recreate": IMA has no in-place update.
    // 把旧笔记 rename 为 "标题 v1 / v2 / ..."，版本号单调递增，
    // 方便用户在 IMA 里按版本识别和清理。
    // rename 失败不阻断流程（旧笔记可能已被手动删除）。
    const nextVersion = currentVersion + 1;
    try {
      await this.client.renameNote({
        note_id: noteId,
        title: `${title} v${currentVersion === 0 ? 1 : currentVersion}`,
      });
    } catch (e) {
      logWarn(`rename old note ${noteId} failed (ignored):`, e);
    }

    const result = await this.handleCreate(content, folderId, folderName);
    return { ...result, remoteVersion: nextVersion };
  }
}
