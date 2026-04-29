import { ImaSyncSettings, WikiLinkStrategy } from "./types";
import { stripFrontmatter as stripFm, stripSyncMetadata } from "./utils";

/**
 * 将 Obsidian 专有语法转换为通用 Markdown，便于 IMA 识别。
 */
export class MarkdownTransformer {
  constructor(private settings: ImaSyncSettings) {}

  transform(content: string): string {
    // Always strip plugin-owned sync metadata first. These keys are our own
    // bookkeeping (ima_note_id / ima_last_sync / ...) — they must not leak
    // into IMA, and must not influence the change-detection hash, otherwise
    // writing them back after a push would trigger an endless re-sync loop.
    let out = stripSyncMetadata(content);
    if (this.settings.stripFrontmatter) {
      out = stripFm(out);
    }
    out = this.transformWikiLinks(out, this.settings.wikiLinkStrategy);
    out = this.transformEmbeds(out);
    out = this.transformCallouts(out);
    return out;
  }

  /** [[Page]] / [[Page|Alias]] / [[Page#Heading|Alias]] */
  private transformWikiLinks(content: string, strategy: WikiLinkStrategy): string {
    if (strategy === "keep") return content;
    return content.replace(/\[\[([^\]\n]+)\]\]/g, (_full, inner: string) => {
      const [targetPart, alias] = inner.split("|").map((s) => s.trim());
      const display = alias || targetPart.replace(/#.*$/, "");
      if (strategy === "plain-text") {
        return display;
      }
      // markdown-link：保留为 [display](target) 形式
      const url = encodeURI(targetPart);
      return `[${display}](${url})`;
    });
  }

  /** ![[file.png]] → ![](file.png) */
  private transformEmbeds(content: string): string {
    return content.replace(/!\[\[([^\]\n]+)\]\]/g, (_full, inner: string) => {
      const [targetPart, alias] = inner.split("|").map((s) => s.trim());
      const url = encodeURI(targetPart);
      return `![${alias || ""}](${url})`;
    });
  }

  /** Obsidian Callout `> [!note] title` → 普通引用块 */
  private transformCallouts(content: string): string {
    return content.replace(/^>\s*\[!([a-zA-Z]+)\]([+-]?)\s*(.*)$/gm, (_m, type: string, _fold, title: string) => {
      const label = title?.trim() || type;
      return `> **${label}**`;
    });
  }
}
