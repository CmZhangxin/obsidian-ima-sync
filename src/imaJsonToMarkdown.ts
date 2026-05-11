/**
 * Converts IMA's JSON document format (Slate.js-style block array) to Markdown.
 *
 * IMA get_doc_content with format=2 returns a JSON array of blocks:
 *   [{ type: "h1"|"h2"|"h3"|"p"|"blockquote"|"code_block"|"ul"|"ol"|"li"|"hr"|"image"|...,
 *      children: [{ text: "...", bold?: true, italic?: true, code?: true, strikethrough?: true, underline?: true, link?: { url: "..." } }],
 *      id: "..." }]
 */

interface InlineNode {
  text?: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  link?: { url: string };
  children?: InlineNode[];
  type?: string;
  url?: string;
  alt?: string;
}

interface BlockNode {
  type: string;
  children?: InlineNode[];
  id?: string;
  url?: string;
  alt?: string;
  language?: string;
  level?: number;
  checked?: boolean;
}

/**
 * Convert an IMA JSON content string to Markdown.
 * Returns the original string unchanged if parsing fails.
 */
export function imaJsonToMarkdown(jsonStr: string): string {
  let blocks: BlockNode[];
  try {
    blocks = JSON.parse(jsonStr);
  } catch {
    return jsonStr; // Not valid JSON, return as-is
  }

  if (!Array.isArray(blocks)) return jsonStr;

  const lines: string[] = [];

  // Skip the first h1 block — it duplicates the note title (which becomes the filename)
  let skippedFirstH1 = false;
  for (const block of blocks) {
    if (!skippedFirstH1 && block.type === "h1") {
      skippedFirstH1 = true;
      continue;
    }
    lines.push(convertBlock(block));
  }

  // Collapse 3+ consecutive empty lines into 2
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function convertBlock(block: BlockNode): string {
  const type = block.type ?? "p";
  const text = renderInlineChildren(block.children ?? []);

  switch (type) {
    case "h1":
      return `# ${text}\n`;
    case "h2":
      return `## ${text}\n`;
    case "h3":
      return `### ${text}\n`;
    case "h4":
      return `#### ${text}\n`;
    case "h5":
      return `##### ${text}\n`;
    case "h6":
      return `###### ${text}\n`;
    case "p":
    case "paragraph":
      return `${text}\n`;
    case "blockquote":
    case "quote":
      return text.split("\n").map((l) => `> ${l}`).join("\n") + "\n";
    case "code_block":
    case "code":
      return "```" + (block.language ?? "") + "\n" + getPlainText(block.children ?? []) + "\n```\n";
    case "ul":
    case "bulleted_list":
      return renderList(block.children ?? [], "- ");
    case "ol":
    case "numbered_list":
      return renderList(block.children ?? [], "1. ");
    case "li":
    case "list_item":
    case "list-item": {
      const prefix = block.checked === true ? "- [x] " : block.checked === false ? "- [ ] " : "- ";
      return `${prefix}${text}\n`;
    }
    case "hr":
    case "divider":
      return "---\n";
    case "image":
    case "img":
      return `![${block.alt ?? ""}](${block.url ?? ""})\n`;
    default:
      // Unknown block type: render as paragraph
      return text ? `${text}\n` : "\n";
  }
}

function renderList(items: InlineNode[], prefix: string): string {
  const lines: string[] = [];
  let i = 1;
  for (const item of items) {
    const itemBlock = item as unknown as BlockNode;
    const text = renderInlineChildren(itemBlock.children ?? []);
    const actualPrefix = prefix === "1. " ? `${i}. ` : prefix;
    lines.push(`${actualPrefix}${text}`);
    i++;
  }
  return lines.join("\n") + "\n";
}

function renderInlineChildren(nodes: InlineNode[]): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: InlineNode): string {
  // Nested block inside inline (e.g., list items with children blocks)
  if (node.type && node.children) {
    const block = node as unknown as BlockNode;
    return convertBlock(block).trimEnd();
  }

  let text = node.text ?? "";
  if (!text && node.children) {
    text = renderInlineChildren(node.children);
  }
  if (!text) return "";

  // Apply inline formatting
  if (node.code) text = "`" + text + "`";
  if (node.bold) text = `**${text}**`;
  if (node.italic) text = `*${text}*`;
  if (node.strikethrough) text = `~~${text}~~`;
  // Only wrap in link if URL is non-empty
  if (node.link?.url) text = `[${text}](${node.link.url})`;

  return text;
}

function getPlainText(nodes: InlineNode[]): string {
  return nodes.map((n) => n.text ?? "").join("");
}
