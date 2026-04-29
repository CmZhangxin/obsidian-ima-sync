import { TFile } from "obsidian";
import { FolderMapping, ImaSyncSettings } from "./types";

/**
 * Resolves a vault file (plus its frontmatter) to an IMA notebook target.
 *
 * Priority:
 *   1. Frontmatter `ima_folder_id`   (most precise, bypasses any mapping rule)
 *   2. Frontmatter `ima_notebook`    (matched by name)
 *   3. Folder mapping table, longest prefix wins
 *   4. Nothing matched → skip this file (no implicit default notebook)
 */
export interface ResolvedTarget {
  folderId: string;
  folderName: string;
  source:
    | "frontmatter-id"
    | "frontmatter-name"
    | "mapping"
    | "default"
    | "skip";
  /** If a file lives in a folder that no mapping rule covers, its top-level prefix is returned here. */
  unmappedPrefix?: string;
  /**
   * True when the file matches a rule with sync=false, or when the file's
   * folder isn't covered by any mapping rule at all. Callers are expected
   * to treat this as "don't push, don't count as failure".
   */
  skip?: boolean;
}

/**
 * Very small frontmatter reader — we only need two keys, so pulling in a full
 * YAML library would be overkill.
 */
export function readFrontmatterTargets(content: string): {
  imaFolderId?: string;
  imaNotebook?: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const block = match[1];

  const pick = (key: string): string | undefined => {
    const re = new RegExp("^" + key + "\\s*:\\s*(.+)$", "m");
    const m = block.match(re);
    if (!m) return undefined;
    const raw = m[1].trim().replace(/^['"]|['"]$/g, "").trim();
    return raw || undefined;
  };

  return {
    imaFolderId: pick("ima_folder_id"),
    imaNotebook: pick("ima_notebook"),
  };
}

export class FolderMappingManager {
  constructor(private readonly settings: ImaSyncSettings) {}

  /**
   * Resolve which IMA notebook a file should sync to.
   *  - content is optional; if provided we also try the frontmatter (highest priority).
   */
  resolve(file: TFile, content?: string): ResolvedTarget {
    // 1) frontmatter
    if (content) {
      const fm = readFrontmatterTargets(content);
      if (fm.imaFolderId) {
        const found = this.settings.folderMappings.find(
          (m) => m.folderId === fm.imaFolderId
        );
        return {
          folderId: fm.imaFolderId,
          folderName: found?.folderName ?? fm.imaNotebook ?? "",
          source: "frontmatter-id",
        };
      }
      if (fm.imaNotebook) {
        const found = this.settings.folderMappings.find(
          (m) => m.folderName === fm.imaNotebook
        );
        return {
          folderId: found?.folderId ?? "",
          folderName: fm.imaNotebook,
          source: "frontmatter-name",
        };
      }
    }

    // 2) default-only mode → hand off to IMA's account-default notebook
    //    (we deliberately pass empty folderId/folderName so the API picks
    //    whatever notebook the IMA account considers default).
    if (this.settings.folderMappingMode === "default-only") {
      return {
        folderId: "",
        folderName: "",
        source: "default",
      };
    }

    // 3) Smart mode — mapping table is the ONLY source of truth.
    //    Anything not covered by a rule is silently skipped.
    const hit = this.matchByPrefixPath(file.path);
    if (hit) {
      if (hit.sync === false) {
        return {
          folderId: "",
          folderName: "",
          source: "skip",
          skip: true,
        };
      }
      return {
        folderId: hit.folderId,
        folderName: hit.folderName,
        source: "mapping",
      };
    }
    return {
      folderId: "",
      folderName: "",
      source: "skip",
      skip: true,
      unmappedPrefix: this.topLevelFolderOf(file.path),
    };
  }

  /** Match the mapping table with a "longest prefix wins" strategy. */
  private matchByPrefixPath(relativePath: string): FolderMapping | null {
    const normalized = relativePath.replace(/\\/g, "/");
    let best: FolderMapping | null = null;
    let bestLen = -1;
    for (const m of this.settings.folderMappings) {
      const prefix = (m.localPrefix || "").replace(/\\/g, "/").replace(/\/$/, "");
      const isRootRule = prefix === "";
      const matched =
        isRootRule ||
        normalized === prefix ||
        normalized.startsWith(prefix + "/");
      if (!matched) continue;
      const len = prefix.length;
      if (len > bestLen) {
        best = m;
        bestLen = len;
      }
    }
    return best;
  }

  /**
   * Does this file fall under an explicit "don't sync" rule?
   * Used by the push engine to short-circuit before reading file content.
   */
  isExplicitlySkipped(relativePath: string): boolean {
    if (this.settings.folderMappingMode === "default-only") return false;
    const hit = this.matchByPrefixPath(relativePath);
    return !!hit && hit.sync === false;
  }

  /**
   * Return the top-level folder name for a vault-relative path.
   * Files that live directly in the vault root return "" (empty string).
   */
  topLevelFolderOf(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/");
    const idx = normalized.indexOf("/");
    if (idx < 0) return ""; // file is in the vault root
    return normalized.slice(0, idx);
  }
}
