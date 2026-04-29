import { TFile } from "obsidian";

/** 同步一个文件时传递给 Provider 的数据 */
export interface SyncPayload {
  /** vault 内相对路径，如 "notes/foo.md" */
  relativePath: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 已经转换后的内容（markdown 等） */
  content: string;
  /** 上次同步保存的远端文档 ID（如果有） */
  remoteId?: string;
  /** 原始 TFile 引用，供 Provider 按需使用（读附件、二进制等） */
  file: TFile;
  /** 目标 IMA 笔记本的 folder_id（由 FolderMappingManager 解析得到） */
  folderId?: string;
  /** 目标 IMA 笔记本名称（folder_id 为空时作为兜底） */
  folderName?: string;
  /** 本地已记录的版本号，传给 Provider 用于 rename 旧笔记 */
  remoteVersion?: number;
}

/** 同步结果 */
export interface SyncResult {
  /** 是否成功 */
  success: boolean;
  /** 本次成功后的远端 ID（若有） */
  remoteId?: string;
  /** recreate 后的新版本号（由 Provider 返回，SyncEngine 存入 fileStates） */
  remoteVersion?: number;
  /** 错误信息 */
  error?: string;
}

/** 删除结果 */
export interface DeleteResult {
  success: boolean;
  error?: string;
}

/** 远端条目元信息（用于 pull 方向） */
export interface RemoteItem {
  /** 远端唯一 ID（IMA: note_id） */
  remoteId: string;
  /** 远端标题 */
  title: string;
  /** 远端最后修改时间（ms），用于双向同步的冲突判断；可选 */
  modifyTime?: number;
  /** 远端所在的笔记本/分组名，方便映射到 vault 子目录 */
  groupName?: string;
  /** 其它元信息，透传到 fetchRemote */
  extra?: Record<string, unknown>;
}

/** pull 的远端内容 */
export interface RemoteContent {
  /** 最终要写入 vault 的 markdown/纯文本（某些 provider 只能拿到纯文本） */
  content: string;
  /** 内容格式提示：markdown | plaintext（上层据此决定是否额外转换） */
  format: "markdown" | "plaintext";
  /** 远端最后修改时间（ms），若 list 阶段未拿到可在此补齐 */
  modifyTime?: number;
}

/**
 * 同步通道的抽象接口。
 *  - ImaOpenApiProvider：通过官方 OpenAPI 写入/读取
 */
export interface SyncProvider {
  /** 可读名称，用于日志与 UI */
  readonly name: string;

  /** 此 provider 是否支持从远端回拉（决定双向同步是否在该通道生效） */
  readonly supportsPull: boolean;

  /** 同步前的一次性检查（凭证、目录可达性等） */
  precheck(): Promise<void>;

  /** 上传/更新一个笔记 */
  upsert(payload: SyncPayload): Promise<SyncResult>;

  /** 删除一个笔记（可选实现，不支持则返回 success:false 且标记 error） */
  remove(relativePath: string, remoteId?: string): Promise<DeleteResult>;

  /**
   * 列出远端所有条目（pull 方向使用）。
   * 不支持 pull 的 provider 可省略或返回空数组。
   */
  listRemote?(): Promise<RemoteItem[]>;

  /**
   * 按 RemoteItem 拉取远端内容。
   * 不支持 pull 的 provider 可省略或抛错。
   */
  fetchRemote?(item: RemoteItem): Promise<RemoteContent>;
}
