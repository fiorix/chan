// Unified file + entity kind taxonomy. Single source of truth for
// chip labels, palette tokens, and tree icons across the file tree,
// inspector, search overlay, graph overlay, and tag inspector.
//
// Three families of kind:
//   - FileKind: things that exist as files in the workspace.
//   - EntityKind: graph-only entities (tokens extracted from
//     markdown bodies); no file backing.
//   - ContainerKind: the lone "folder" kind for directory rows.
//
// The server projects a `kind` discriminator on every regular file in
// `/api/files`. The path-only fallback below only runs for paths held
// outside the tree listing (graph ghost rows, broken-link targets). It
// mirrors chan-workspace's classifier via `classifyPath` so the editor
// and the workspace agree on what counts as text.

import { FileText, User, FileCode, Image, File, Hash, Calendar, Folder } from "lucide-svelte";

import type { TreeEntry } from "../api/types";
import { classifyPath } from "./fileTypes";

export type FileKind =
  | "document"
  | "contact"
  | "text"
  | "media"
  | "binary"
  // Unknown extension whose content hasn't been sniffed yet. The
  // server resolves this to "text"/"binary" for per-directory file-
  // browser listings; it only reaches the SPA from the recursive
  // whole-tree listing (image picker), so it renders neutrally.
  | "pending";
export type EntityKind = "tag" | "mention" | "date";
export type ContainerKind = "folder";
export type Kind = FileKind | EntityKind | ContainerKind;

/// Classify a tree entry. Folder entries return "folder"; otherwise
/// the server-provided `kind === "contact"` discriminator wins,
/// followed by image-by-extension, the editable-text gate, and
/// finally "binary" for everything that can't yet round-trip
/// through the editor (PDFs, archives, fonts, ...).
export function classifyEntry(entry: TreeEntry): Kind {
  if (entry.is_dir) return "folder";
  return classifyFile(entry.path, entry.kind);
}

/// Path + optional server kind hint. Useful when we hold the path
/// and the wire kind but not a full TreeEntry (graph nodes, search
/// rows). When `serverKind` is one of the wire values
/// (`document` | `contact` | `text` | `media` | `binary`) we trust
/// it directly; that's the path most callers take. The path-based
/// fallback (`classifyPath`) only runs when `serverKind` is absent
/// -- e.g. a graph ghost row whose target file isn't in the current
/// tree listing. It cannot distinguish a markdown-class .md (with
/// contact frontmatter) from a regular document, so callers that
/// need the contact distinction must come through the server.
export function classifyFile(
  path: string,
  serverKind?: TreeEntry["kind"],
): FileKind {
  if (serverKind) return serverKind;
  return classifyPath(path);
}

/// Extension buckets used by the graph canvas node fill, shared here
/// so the inspector kind bubble can match the node it represents.
///
/// Two taxonomies meet at a file node: the server projects a wire
/// `kind` (`document` | `text` | `media` | `binary` | `contact` |
/// `pending`) keyed off content class, while the graph canvas colours
/// by EXTENSION. Wire kind `text` spans both `.txt` (canvas orange,
/// the doc bucket) and source / config code (canvas royalblue), so a
/// token swap on `text` cannot match the canvas. Sharing this
/// extension bucketer is the only match-by-construction fix.
///
/// Mirrors `chan_workspace::FileClass` conceptually but routes Pdf
/// into `img` (media) and Other into `binary` so the SPA's five-bucket
/// split matches the colour split. `contact` comes from the indexer's
/// `node_kind: "contact"` discriminator, not the extension.
export type FileBucket = "doc" | "img" | "contact" | "source" | "binary";

const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf)$/i;
const MARKDOWN_EXT_RE = /\.(md|txt)$/i;
const SOURCE_EXT_RE =
  /\.(rs|py|ts|tsx|js|jsx|mjs|cjs|go|c|cc|cpp|cxx|h|hh|hpp|java|kt|swift|rb|php|cs|sh|bash|zsh|fish|pl|lua|toml|yaml|yml|json|jsonc|ini|conf|cfg|env|xml|html|htm|css|scss|sass|less|vue|svelte|sql|graphql|gql|proto|elm|ex|exs|erl|hs|lhs|ml|mli|fs|fsx|clj|cljs|cljc|edn|jl|nim|d|dart|zig|odin|v|vhd|vhdl|sv|verilog|asm|s|f|f90|f95|tex|R|r)$/i;

/// Classify a file path into its graph-canvas colour bucket. Media
/// wins first (an image with contact frontmatter still reads as
/// media), then the `contact` discriminator, then markdown (`.md` /
/// `.txt`), then recognised source / config text, else binary.
/// `nodeKind` is the indexer's `node_kind` hint (`"contact"` or
/// absent). Kept byte-identical to the graph canvas's former local
/// helper so the node fill and the inspector bubble stay in lockstep.
export function fileBucket(path: string, nodeKind?: "contact"): FileBucket {
  if (MEDIA_EXT_RE.test(path)) return "img";
  if (nodeKind === "contact") return "contact";
  if (MARKDOWN_EXT_RE.test(path)) return "doc";
  if (SOURCE_EXT_RE.test(path)) return "source";
  // Anything else (archives, executables, fonts, etc.) is binary.
  return "binary";
}

/// True for file kinds the editor opens as text: markdown documents,
/// contacts (markdown notes flagged `chan.kind: contact`), and plain
/// source / config / shell text. Gates the inspector's Open-vs-Download
/// pill and the File Browser's open-selection off the SERVER-provided
/// content kind. The per-directory listing content-sniffs an unknown
/// extension to `text` / `binary`, so an odd-suffix plaintext file lands
/// as `text` here and gets "Open" like the tree's double-click instead
/// of the extension-gated "Download". Media, binary, and the not-yet-
/// sniffed `pending` kind are not openable as text. Accepts the broad
/// `Kind` (what `classifyEntry` returns) so callers can pass it directly;
/// folder / tag / mention / date all fall through to false.
export function isOpenableTextKind(kind: Kind): boolean {
  return kind === "document" || kind === "text" || kind === "contact";
}

/// Human label used in kind chips. Lowercased; chip CSS handles
/// uppercasing so callers can compose strings with the label.
export function labelFor(kind: Kind): string {
  if (kind === "folder") return "directory";
  return kind;
}

/// CSS color variable for the chip background. Wraps the canonical
/// palette tokens defined in App.svelte; see web/packages/workspace-app/src/design.md for
/// the cross-surface mapping. `text` aliases `--g-doc` for now
/// because the two share the document hue family until we pick a
/// separate tone (the visual distinction is icon + label, not hue).
///
/// Kind palette:
///   document/text    -> orange  (--g-doc)
///   contact/mention  -> yellow  (--g-contact, defaulting to --warn-text)
///   media            -> purple  (--g-img)
///   tag              -> green   (--g-tag)
///   binary           -> grey    (--g-binary)
///   folder           -> grey    (--g-folder)
///   date             -> grey    (--text-secondary, low-emphasis neutral)
/// Flows through every surface (file tree, inspector, search, graph)
/// via this single switch instead of being hardcoded per component.
///
/// The contact/mention mapping reads the user-settable graph token
/// with a fallback: inside the graph surface a custom palette override
/// lands on the subtree and the chip follows it; everywhere else
/// `--g-contact` is the theme alias and the chip resolves to the
/// warning hue exactly as before the token existed.
export function colorVarFor(kind: Kind): string {
  switch (kind) {
    case "document":
    case "text":
      return "var(--g-doc)";
    case "contact":
    case "mention":
      return "var(--g-contact, var(--warn-text))";
    case "media":
      return "var(--g-img)";
    case "tag":
      return "var(--g-tag)";
    case "binary":
      return "var(--g-binary)";
    case "pending":
      // Low-emphasis neutral until the sniff resolves it.
      return "var(--text-secondary)";
    case "date":
      return "var(--text-secondary)";
    case "folder":
      return "var(--g-folder)";
  }
}

/// CSS colour var for a graph-canvas file bucket. Mirrors the canvas
/// paint switch (bucket -> theme slot) composed with `readTheme`
/// (theme slot -> CSS var): doc -> --g-doc, source -> --g-source,
/// img -> --g-img, binary -> --g-binary, contact -> --g-contact (which
/// falls back to --warn-text). This
/// is the bubble side of the node-fill parity; `state/kinds.test.ts`
/// asserts it stays equal to the canvas fill for every bucket.
export function colorVarForBucket(bucket: FileBucket): string {
  switch (bucket) {
    case "doc":
      return "var(--g-doc)";
    case "source":
      return "var(--g-source)";
    case "img":
      return "var(--g-img)";
    case "binary":
      return "var(--g-binary)";
    case "contact":
      return "var(--g-contact, var(--warn-text))";
  }
}

/// Concrete file wire kinds whose chip colour follows the extension
/// bucket. `pending` stays out: it keeps the neutral low-emphasis grey
/// (`colorVarFor`) until a content sniff resolves it to text / binary.
function isBucketedFileKind(kind: Kind): boolean {
  return (
    kind === "document" ||
    kind === "text" ||
    kind === "media" ||
    kind === "binary" ||
    kind === "contact"
  );
}

/// Chip background colour, extension-aware for file kinds. Given a
/// `path`, a concrete file kind routes through `fileBucket` so the
/// inspector bubble matches the graph node fill (a blue `.rs` source
/// node opens a blue source bubble instead of the wire kind's orange).
/// Non-file kinds (tag, mention, folder, date, pending) and pathless
/// callers fall back to `colorVarFor`, so every existing mount is
/// unchanged until it opts in by passing a path.
export function chipColorVar(kind: Kind, path?: string): string {
  if (path !== undefined && isBucketedFileKind(kind)) {
    return colorVarForBucket(
      fileBucket(path, kind === "contact" ? "contact" : undefined),
    );
  }
  return colorVarFor(kind);
}

/// Lucide icon component for the kind. Used by the file tree (one
/// glyph per row) and by future inspector / search row glyphs.
/// `Image` is the Lucide icon name; the import collides harmlessly
/// with the DOM Image constructor because consumers use the
/// imported binding.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function iconFor(kind: Kind): any {
  switch (kind) {
    case "document":
      return FileText;
    case "contact":
    case "mention":
      return User;
    case "text":
      return FileCode;
    case "media":
      return Image;
    case "binary":
    case "pending":
      // Generic file glyph; "pending" is transient and rarely shown.
      return File;
    case "tag":
      return Hash;
    case "date":
      return Calendar;
    case "folder":
      return Folder;
  }
}
