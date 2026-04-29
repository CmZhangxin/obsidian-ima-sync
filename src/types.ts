/**
 * IMA Sync 插件的类型定义与常量
 */

/** 同步触发方式 */
export type SyncTrigger = "manual" | "on-save" | "interval";

/** Wiki 链接处理策略 */
export type WikiLinkStrategy = "keep" | "plain-text" | "markdown-link";

/** 同步方向 */
export type SyncDirection = "push" | "pull" | "bidirectional";

/** 双向同步的冲突解决策略 */
export type ConflictStrategy =
  | "local-wins"
  | "remote-wins"
  | "newest-wins"
  | "keep-both"
  | "skip";

/**
 * 文件夹 → IMA 笔记本 映射模式
 *  - smart        智能映射（推荐）：首次同步弹向导，没配的文件夹一律跳过
 *  - default-only 所有笔记交给 IMA 账号默认笔记本（不传 folderId/folderName）
 */
export type FolderMappingMode = "smart" | "default-only";

/**
 * 单条文件夹 → IMA 笔记本 的映射规则。
 *  - localPrefix：vault 内相对路径前缀，"" 表示匹配 vault 根目录
 *  - folderId：目标 IMA 笔记本的 folder_id（优先于 folderName）
 *  - folderName：目标 IMA 笔记本名称（用于 UI 展示 & folderId 失效时的兜底）
 *  - sync：是否参与同步。false 表示该文件夹下的所有笔记都会被跳过。
 *         缺省视为 true（老数据兼容）。
 */
export interface FolderMapping {
  localPrefix: string;
  folderId: string;
  folderName: string;
  sync?: boolean;
}

/**
 * 当一篇笔记内容发生变化时的策略。
 *
 * IMA 笔记 API 不支持原地更新，我们只能在这两种之间选择：
 *  - skip：保持 IMA 上的首个版本不变，忽略本地后续改动
 *  - recreate：另建一篇新笔记（title 带时间戳后缀），旧笔记保留在 IMA
 *
 * 之前还提供过 "append"（把新内容追加到原笔记末尾），但这种方式无法获知
 * 远端已有内容与本地的 diff，只能把整篇再追加一遍，直接导致 IMA 上出现
 * 重复正文。综合考虑已下线，升级后老配置会被迁移到 "recreate"。
 */
export type OnChangeStrategy = "skip" | "recreate";

/** 插件设置 */
export interface ImaSyncSettings {
  /** ========== OpenAPI 配置 ========== */
  clientId: string;
  apiKey: string;

  /** ========== 文件夹 → 笔记本 映射 ========== */
  /** 映射模式 */
  folderMappingMode: FolderMappingMode;
  /** 按本地路径前缀匹配的映射表（越长的 prefix 越优先） */
  folderMappings: FolderMapping[];
  /** 是否已完成过一次首次同步向导 */
  hasCompletedWizard: boolean;

  /** ========== 同步范围 ========== */
  /** 同步方向：push=仅推；pull=仅拉；bidirectional=双向 */
  direction: SyncDirection;
  /** 双向同步的冲突解决策略 */
  conflictStrategy: ConflictStrategy;
  /** pull 到 vault 的目标文件夹（相对路径）。留空则放在 vault 根目录 */
  pullTargetFolder: string;
  /** pull 时是否把每个笔记本映射为一个子目录 */
  pullMirrorNotebookFolders: boolean;
  /** pull 仅拉取指定笔记本（folder_id 列表）；空则拉取全部 */
  pullIncludeNotebookIds: string[];

  /** ========== 触发方式 ========== */
  trigger: SyncTrigger;
  intervalMinutes: number;

  /** ========== 格式转换 ========== */
  wikiLinkStrategy: WikiLinkStrategy;
  stripFrontmatter: boolean;
  includeAttachments: boolean;

  onChangeStrategy: OnChangeStrategy;
  maxNoteBytes: number;

  /** ========== 运行状态 ========== */
  lastSyncAt: number;
  lastPullAt: number;
  fileStates: Record<string, FileSyncState>;
  remoteIndex: Record<string, RemoteIndexEntry>;
}

/** 远端索引项，用于双向同步的冲突判断 */
export interface RemoteIndexEntry {
  /** 对应的 vault 相对路径（如果已在本地） */
  relativePath?: string;
  /** 远端最后已知的 modify_time（ms） */
  remoteMtime: number;
  /** 远端标题 */
  title: string;
  /** 远端所在笔记本名 */
  groupName?: string;
  /** 最近一次 pull/push 时间 */
  syncedAt: number;
}

/** 单个文件的同步状态 */
export interface FileSyncState {
  mtime: number;
  /**
   * 通用哈希字段。
   *
   * 历史上这个字段既被 push 路径（transformer.transform(本地 md) 的 hash）
   * 又被 pull 路径（IMA 返回的纯文本 hash）覆盖写入，直接导致："pull 之后
   * 再 push" 永远都判定为"变了"，进而触发 recreate，重复创建远端笔记。
   *
   * 现在 push 决策**只看 `pushHash`**，`hash` 字段仅作老数据兼容保留；
   * pull 路径改写 `pullHash`，互不污染。
   */
  hash: string;
  /**
   * 上一次成功 push 时，transformer.transform(本地原文) 的 hash。
   *
   * 只有当 `pushHash` 存在且不等于"当前本地 transform 后的 hash"时，
   * 才认为笔记真的被用户改过 → 触发 recreate 推送。否则一律 skip，
   * 避免每次保存/双向同步都在 IMA 上刷出重复笔记。
   *
   * 老数据没这个字段时会被视为"从未 push 过"，逻辑上降级为首次 push
   * 路径，由 syncSingleFile 决定是否安全复用已有 remoteId。
   */
  pushHash?: string;
  /** 上一次 pull 回来的内容 hash（仅用于双向同步时比较本地是否有编辑）。 */
  pullHash?: string;
  remoteId?: string;
  /** 已推送到 IMA 的版本号，每次 recreate +1，用于 rename 旧笔记为 "标题 v1/v2/..." */
  remoteVersion?: number;
  syncedAt: number;
  /** 最近一次 push/pull 成功时远端的 modify_time（ms），用于检测远端变更 */
  lastKnownRemoteMtime?: number;
}

/** 默认设置 */
export const DEFAULT_SETTINGS: ImaSyncSettings = {
  clientId: "",
  apiKey: "",
  folderMappingMode: "smart",
  folderMappings: [],
  hasCompletedWizard: false,
  direction: "push",
  conflictStrategy: "newest-wins",
  pullTargetFolder: "IMA",
  pullMirrorNotebookFolders: true,
  pullIncludeNotebookIds: [],
  trigger: "manual",
  intervalMinutes: 30,
  wikiLinkStrategy: "plain-text",
  stripFrontmatter: false,
  includeAttachments: true,
  onChangeStrategy: "recreate",
  maxNoteBytes: 5 * 1024 * 1024,
  lastSyncAt: 0,
  lastPullAt: 0,
  fileStates: {},
  remoteIndex: {},
};

export const DEFAULT_IMA_BASE_URL = "https://ima.qq.com";
