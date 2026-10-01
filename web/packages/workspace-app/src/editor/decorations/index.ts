// Aggregator for all per-token handler registries.
//
// Three modules contribute a registry each, keyed by syntax node name:
//   - marks: Emphasis, StrongEmphasis, Strikethrough, InlineCode,
//     Link, URL, Autolink
//   - headings: ATXHeading1..6
//   - blocks: Blockquote, FencedCode, BulletList, OrderedList, Task,
//     Frontmatter
//
// chanDecorations() hands the merged registry to decorationWalker and
// returns its ViewPlugin extension; drop into the editor's extension
// array.

import type { Extension } from "@codemirror/state";
import { decorationWalker, type HandlerRegistry } from "./walker";
import { inlineMarkHandlers } from "./marks";
import { headingHandlers } from "./headings";
import { blockHandlers } from "./blocks";

const ALL_HANDLERS: HandlerRegistry = {
  ...inlineMarkHandlers,
  ...headingHandlers,
  ...blockHandlers,
};

export function chanDecorations(): Extension {
  return decorationWalker(ALL_HANDLERS);
}
