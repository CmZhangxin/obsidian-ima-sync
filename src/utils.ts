/**
 * 工具函数集合
 */

/** 简易 32 位 FNV-1a hash（避免引入额外依赖） */
export function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 移除 frontmatter */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/**
 * Remove plugin-owned `ima_*` keys from the frontmatter block while keeping
 * the rest of the block intact.
 *
 * Why this exists:
 *   The plugin writes sync metadata (`ima_note_id`, `ima_notebook`,
 *   `ima_last_sync`, ...) back into each note's frontmatter after a
 *   successful push. If those fields participated in the change-detection
 *   hash we'd get a self-triggering feedback loop — every push would mutate
 *   the frontmatter, which would shift the hash, which would make the next
 *   push think the note had changed, which would push again. Hilarity ensues
 *   (e.g. the `append` strategy would duplicate the note on every run).
 *
 *   Stripping these keys before hashing and before sending content to IMA
 *   breaks that loop: the hash is computed over "user content only", and the
 *   remote never sees our internal plumbing.
 *
 *   We leave any other user-authored keys in place so regular frontmatter
 *   (tags, aliases, custom metadata, ...) still round-trips normally.
 */
export function stripSyncMetadata(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return content;

  const body = match[1];
  const rest = content.slice(match[0].length);

  const kept = body
    .split("\n")
    .filter((line) => !/^ima_[A-Za-z0-9_]+\s*:/.test(line));

  // Frontmatter block is now empty — drop the fences entirely so we don't
  // leave behind a naked `---\n---` divider that would render as an HR in
  // the remote note.
  const hasRealContent = kept.some((l) => l.trim().length > 0);
  if (!hasRealContent) return rest;

  return `---\n${kept.join("\n")}\n---\n${rest.startsWith("\n") ? rest.slice(1) : rest}`;
}
