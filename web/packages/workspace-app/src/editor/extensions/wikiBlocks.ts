// Markdown "block" parser for the wiki-link bubble's `^` mode.
//
// A block here is a runnable target for `[[note#^id]]` style links:
// paragraphs, list items, and blockquote lines that the user can
// pick to link to a specific point in the document. Headings are
// excluded (they have heading anchors and live in `#` mode).
//
// Why parse client-side: chan-workspace has no `block` concept and the
// HTTP file body is plain markdown. Block detection here is line-
// based and intentionally simple; if/when chan-workspace grows a server-
// side block index we can swap this out without touching the bubble.

import { fenceLineTracker } from "../commands/fence";

const BLOCK_ID_RE = /\^([A-Za-z0-9-]{4,})\s*$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;

export interface ParsedBlock {
  /// Block text joined by `\n`. The first line is what the bubble
  /// renders in the result list.
  text: string;
  /// 0-based index into the source file's `\n`-split line array
  /// where this block starts.
  startLine: number;
  /// 0-based index of the LAST line of the block (inclusive). A
  /// block-id append goes onto this line.
  endLine: number;
  /// Existing `^id` anchor at the end of the block, if any. When
  /// present the link can use this directly, no file write.
  existingAnchor: string | null;
}

/// Split markdown `text` into linkable blocks. Blocks are runs of
/// non-blank lines separated by blank lines, with code-fenced
/// regions and heading lines skipped.
export function parseBlocks(text: string): ParsedBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ParsedBlock[] = [];
  const fence = fenceLineTracker();
  let buf: { startLine: number; lines: string[] } | null = null;

  const flush = (endLine: number): void => {
    if (!buf || buf.lines.length === 0) {
      buf = null;
      return;
    }
    const blockText = buf.lines.join("\n");
    const last = buf.lines[buf.lines.length - 1] ?? "";
    const m = last.match(BLOCK_ID_RE);
    blocks.push({
      text: blockText,
      startLine: buf.startLine,
      endLine,
      existingAnchor: m ? `^${m[1]}` : null,
    });
    buf = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kind = fence(line);
    if (kind === "fence") {
      flush(i - 1);
      continue;
    }
    if (kind === "code") {
      // Lines inside a code fence are not linkable blocks.
      continue;
    }
    if (line.trim() === "") {
      flush(i - 1);
      continue;
    }
    if (HEADING_RE.test(line)) {
      // Headings end any open block but are not blocks themselves;
      // they belong to `#` mode.
      flush(i - 1);
      continue;
    }
    if (!buf) buf = { startLine: i, lines: [] };
    buf.lines.push(line);
  }
  flush(lines.length - 1);
  return blocks;
}

/// Generate a fresh `^id` (without the `^`) using base36 randomness.
/// 7 chars = 36^7 ~= 78 billion ids, plenty for a single document.
export function makeBlockId(): string {
  // Math.random alone is fine here: collisions inside one file are
  // checked against `existingAnchor` on accept; cross-file collisions
  // do not matter because anchors are scoped to a file.
  const a = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  const b = Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .padStart(3, "0");
  return `${a}${b}`;
}

/// Append a ` ^id` marker to the end of `block`'s last line in
/// `originalText`. Returns the rewritten file content. The caller
/// is responsible for the CAS write back to disk.
export function insertBlockAnchor(
  originalText: string,
  block: ParsedBlock,
  id: string,
): string {
  const lines = originalText.split(/\r?\n/);
  const last = lines[block.endLine] ?? "";
  // If the block already has a trailing `^id` we should not be
  // here (caller checks `existingAnchor`), but be defensive.
  if (BLOCK_ID_RE.test(last)) return originalText;
  const sep = last.endsWith(" ") ? "" : " ";
  lines[block.endLine] = `${last}${sep}^${id}`;
  return lines.join("\n");
}

/// Case-insensitive substring filter over parsed blocks. Returns
/// at most `limit` matches in document order.
export function filterBlocks(
  blocks: ParsedBlock[],
  query: string,
  limit: number,
): ParsedBlock[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return blocks.slice(0, limit);
  const out: ParsedBlock[] = [];
  for (const b of blocks) {
    if (b.text.toLowerCase().includes(needle)) {
      out.push(b);
      if (out.length >= limit) break;
    }
  }
  return out;
}
