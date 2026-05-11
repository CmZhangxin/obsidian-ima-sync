import { requestUrl, RequestUrlParam } from "obsidian";
import { DEFAULT_IMA_BASE_URL } from "../types";
import { logWarn } from "../logger";

/**
 * IMA OpenAPI 统一 HTTP 客户端。
 *
 * 规范参考：ima-skill/knowledge-base/references/api.md、ima-skill/notes/references/api.md
 *  - 所有请求都是 HTTP POST + JSON body
 *  - 鉴权头：ima-openapi-clientid / ima-openapi-apikey
 *  - 响应统一为 {code, msg, data}；code=0 成功
 */
export interface ImaApiClientOptions {
  baseUrl?: string;
  clientId: string;
  apiKey: string;
  /** 透传 skill-version 的上下文，便于后端观测；可选 */
  skillVersion?: string;
}

export class ImaApiError extends Error {
  constructor(public code: number, public apiMsg: string, public apiPath: string) {
    super(`IMA API ${apiPath} failed: code=${code}, msg=${apiMsg}`);
    this.name = "ImaApiError";
  }
}

/** IMA 笔记元信息（与 NoteBookInfo 对齐） */
export interface ImaNoteMeta {
  note_id: string;
  title: string;
  summary?: string;
  create_time?: number;
  modify_time?: number;
  cover_image?: string;
  note_ext_info?: {
    folder_id?: string;
    folder_name?: string;
  };
}

/** IMA 笔记本元信息 */
export interface ImaNotebookMeta {
  folder_id: string;
  name: string;
  create_time?: number;
  modify_time?: number;
  note_number?: number;
  parent_folder_id?: string;
  /** 0=USER_CREATE, 1=TOTAL, 2=UN_CATEGORIZED */
  folder_type?: number;
}

export class ImaApiClient {
  private baseUrl: string;
  private clientId: string;
  private apiKey: string;
  private skillVersion: string;

  constructor(opts: ImaApiClientOptions) {
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_IMA_BASE_URL).replace(/\/$/, "");
    this.clientId = opts.clientId;
    this.apiKey = opts.apiKey;
    this.skillVersion = opts.skillVersion || "ima-sync/0.1.0";
  }

  /** 基础 POST，含超时保护 + 限频退避重试 */
  async post<T = unknown>(apiPath: string, body: Record<string, unknown>): Promise<T> {
    const normalizedPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
    const url = `${this.baseUrl}${normalizedPath}`;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const req: RequestUrlParam = {
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ima-openapi-clientid": this.clientId,
          "ima-openapi-apikey": this.apiKey,
          "ima-openapi-ctx": `skill_version=${this.skillVersion}`,
        },
        body: JSON.stringify(body ?? {}),
        throw: false,
      };

      const resp = await requestUrl(req);

      // HTTP 层错误
      if (resp.status < 200 || resp.status >= 300) {
        // 429 或 5xx 可重试
        if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries - 1) {
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        throw new ImaApiError(
          resp.status,
          "HTTP " + resp.status + ": " + (resp.text || "").slice(0, 200),
          apiPath
        );
      }

      // 业务层错误
      let payload: { code?: number; msg?: string; data?: T } = {};
      try {
        payload = resp.json as typeof payload;
      } catch {
        throw new ImaApiError(-1, "Non-JSON response: " + (resp.text || "").slice(0, 200), apiPath);
      }

      if (typeof payload.code === "number" && payload.code !== 0) {
        // 限频错误 20002：退避重试
        if (payload.code === 20002 && attempt < maxRetries - 1) {
          logWarn("IMA rate limited (20002), backing off " + (attempt + 1) + "s...");
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        throw new ImaApiError(payload.code, payload.msg || "unknown error", apiPath);
      }

      return payload.data ?? ({} as T);
    }

    // Should not reach here, but TypeScript needs it
    throw new ImaApiError(-1, "max retries exceeded", apiPath);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ================== 笔记 API ==================

  /** 创建笔记 */
  async importDoc(params: {
    content: string;
    folder_id?: string;
    folder_name?: string;
  }): Promise<{ note_id: string }> {
    return this.post("/openapi/note/v1/import_doc", {
      content_format: 1, // MARKDOWN
      content: params.content,
      folder_id: params.folder_id || undefined,
      folder_name: params.folder_name || undefined,
    });
  }

  /** 追加笔记内容 */
  async appendDoc(params: { note_id: string; content: string }): Promise<{ note_id: string }> {
    return this.post("/openapi/note/v1/append_doc", {
      note_id: params.note_id,
      content_format: 1,
      content: params.content,
    });
  }

  /**
   * 获取笔记内容。
   * IMA 笔记 API 的 target_content_format 目前 **不支持 MARKDOWN**，
   * 默认返回纯文本（推荐）；JSON 格式可用于后续解析富文本。
   */
  async getDocContent(params: {
    note_id: string;
    /** 0=PLAINTEXT（默认/推荐），2=JSON */
    format?: 0 | 2;
  }): Promise<{ content: string }> {
    return this.post("/openapi/note/v1/get_doc_content", {
      note_id: params.note_id,
      target_content_format: params.format ?? 0,
    });
  }

  /**
   * 列出笔记（可分页；文档规定单次最多 20 条）。
   * folder_id 留空则拉取全部笔记。
   */
  async listNote(params: {
    folder_id?: string;
    cursor?: string;
    limit?: number;
    /** 0=MODIFY_TIME(默认) 1=CREATE_TIME 2=TITLE 3=SIZE */
    sort_type?: 0 | 1 | 2 | 3;
  }): Promise<{
    note_book_list?: ImaNoteMeta[];
    next_cursor?: string;
    is_end?: boolean;
  }> {
    return this.post("/openapi/note/v1/list_note", {
      folder_id: params.folder_id || undefined,
      cursor: params.cursor ?? "",
      limit: Math.min(Math.max(params.limit ?? 20, 1), 20),
      sort_type: params.sort_type ?? 0,
    });
  }

  /** 列出笔记本 */
  async listNotebook(params: {
    cursor?: string;
    limit?: number;
    version?: string;
  }): Promise<{
    note_folder_infos?: ImaNotebookMeta[];
    next_cursor?: string;
    is_end?: boolean;
    next_version?: string;
    need_update?: boolean;
  }> {
    return this.post("/openapi/note/v1/list_notebook", {
      cursor: params.cursor ?? "0",
      limit: Math.min(Math.max(params.limit ?? 20, 1), 20),
      version: params.version || undefined,
    });
  }

  /**
   * 重命名笔记标题（未文档化接口，已验证可用）。
   */
  async renameNote(params: { note_id: string; title: string }): Promise<void> {
    await this.post("/openapi/note/v1/rename_note", {
      note_id: params.note_id,
      title: params.title,
    });
  }

  // ================== 便捷分页封装 ==================

  /**
   * 全量拉取所有笔记（保证不遗漏）。
   *
   * IMA list_note 的 cursor 翻页已确认不可用（服务端不返回 next_cursor）。
   * 采用「按笔记本并行拉取」策略：
   *   1. listAllNotebooks 拉全部笔记本
   *   2. 对每个笔记本并行调 list_note(folder_id=xxx, limit=20)
   *   3. 合并去重
   *
   * 单个笔记本 > 20 条时打 warn（IMA API 硬限制，无法突破）。
   *
   * @param folder_id 可选：仅拉指定笔记本
   */
  async listAllNotes(params: {
    folder_id?: string;
    pageSize?: number;
    hardLimit?: number;
  }): Promise<ImaNoteMeta[]> {
    const hardLimit = params.hardLimit ?? 5000;
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 20);

    // 指定了某一个笔记本
    if (params.folder_id) {
      const res = await this.listNote({ folder_id: params.folder_id, limit: pageSize });
      return res.note_book_list ?? [];
    }

    // 全量模式：按笔记本拉取，并发度限制为 3（避免打爆 IMA 限频）
    const notebooks = await this.listAllNotebooks();
    const realNotebooks = notebooks.filter((nb) => nb.folder_type !== 1);

    const all: ImaNoteMeta[] = [];
    const concurrency = 3;

    for (let i = 0; i < realNotebooks.length; i += concurrency) {
      const batch = realNotebooks.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((nb) =>
          this.listNote({ folder_id: nb.folder_id, limit: pageSize }).then((res) => ({
            nb,
            list: res.note_book_list ?? [],
            isEnd: res.is_end,
          }))
        )
      );

      for (const r of results) {
        if (r.status === "rejected") {
          logWarn("list_note for a notebook failed:", r.reason);
          continue;
        }
        const { nb, list, isEnd } = r.value;
        all.push(...list);
        if (!isEnd && (nb.note_number ?? 0) > list.length) {
          logWarn(
            "Notebook", nb.name, "has ~" + String(nb.note_number) + " notes but only " + list.length + " fetched (IMA API limit)."
          );
        }
      }
    }

    const deduped = this.dedupeNotes(all);
    logWarn("listAllNotes: " + deduped.length + " unique notes from " + realNotebooks.length + " notebooks");
    return deduped.slice(0, hardLimit);
  }

  /** 按 note_id 去重 */
  private dedupeNotes(notes: ImaNoteMeta[]): ImaNoteMeta[] {
    const seen = new Set<string>();
    const result: ImaNoteMeta[] = [];
    for (const n of notes) {
      if (!n.note_id || seen.has(n.note_id)) continue;
      seen.add(n.note_id);
      result.push(n);
    }
    return result;
  }

  /** 把 listNotebook 的分页拉完。 */
  async listAllNotebooks(params: { pageSize?: number; hardLimit?: number } = {}): Promise<ImaNotebookMeta[]> {
    const all: ImaNotebookMeta[] = [];
    const hardLimit = params.hardLimit ?? 500;
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 20);
    let cursor = "0";
    let safety = 0;
    while (all.length < hardLimit) {
      const res = await this.listNotebook({ cursor, limit: pageSize });
      const list = res.note_folder_infos ?? [];
      all.push(...list);
      if (res.is_end || list.length === 0) break;
      if (!res.next_cursor || res.next_cursor === cursor) break;
      cursor = res.next_cursor;
      if (++safety > 50) break;
    }
    return all.slice(0, hardLimit);
  }
}