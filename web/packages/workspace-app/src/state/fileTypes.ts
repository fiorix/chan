// Path-based file-class predicates. Mirrors chan-workspace's
// `fs_ops::classify_ext` + basename fallback so the editor's "can I
// open this as text?" gate matches the server's `Workspace::read_text`
// gate. Keep the lists in lockstep with `chan-workspace/src/fs_ops.rs`;
// each phase that widens chan-workspace should also widen these sets so
// the editor and the workspace agree on what counts as text.
//
// Most surfaces in the app should rely on the server-provided wire
// `kind` (via `classifyEntry` in `./kinds.ts`); these path helpers
// only fire when we hold a bare path without a tree entry (graph
// ghost rows, link targets pointing at deleted files, drag-drop
// previews before the watcher has indexed the new path).
//
// Three sets:
//   - MARKDOWN_EXTENSIONS: .md / .txt. Markdown-class, editable +
//     BM25-searchable; maps to `FileClass::EditableText`. NOTE only
//     Markdown (.md) is a graph "document" (graphed + wikilinked, the
//     `document` wire kind); .txt is the `text` kind. classifyPath
//     reflects that split; `isMarkdown` stays .md/.txt because the
//     editor still renders both as markdown.
//   - TEXT_EXTENSIONS: source code, configs, shell, markup, data.
//     Maps to `FileClass::Text`. Editable through the UTF-8 gate
//     but not indexed (false positives like `#include` looking
//     like a `#tag` would pollute the graph).
//   - IMAGE_EXTENSIONS: raster + svg. Maps to `FileClass::Image`.
//
// Well-known no-extension files (Makefile, Dockerfile, LICENSE, ...)
// resolve via TEXT_BASENAMES after the extension check misses.
//
// Unknown extensions: the server maps these to the `pending` wire kind
// and resolves them to `text`/`binary` with a content sniff (valid
// UTF-8 + no NUL) the editor + workspace share. The frontend cannot
// read bytes here, so this path-only `classifyPath` stays conservative
// and returns `binary` for the unknown case; the authoritative
// text/binary answer always rides the server `kind`.

const MARKDOWN_EXTENSIONS = new Set(["md", "txt"]);

// Browser-native video containers the server streams with HTTP range
// support (`/api/fs` answers plain GETs on these with
// `Accept-Ranges` + 206). No transcode: a container whose codec the
// browser can't decode still classifies as video, `<video>` just
// reports it can't play.
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov"]);

// Browser-native audio containers. Audio stays in the path classifier's
// binary fallback; this standalone viewer predicate does not create a new
// file or wire kind.
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "aif", "aiff", "ogg"]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  // bmp is treated as image by the inspector but chan-workspace folds it
  // into Other; harmless drift since image preview is frontend-only.
  "bmp",
]);

// Mirrors chan-workspace `fs_ops::classify_ext`'s `FileClass::Text` arm.
// Add to both files together when widening.
const TEXT_EXTENSIONS = new Set([
  // Source code.
  "rs",
  "py",
  "pyi",
  "pyx",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "hxx",
  "m",
  "mm",
  "go",
  "java",
  "kt",
  "kts",
  "swift",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "rb",
  "php",
  "pl",
  "pm",
  "lua",
  "r",
  "scala",
  "sc",
  "clj",
  "cljs",
  "cljc",
  "ml",
  "mli",
  "hs",
  "lhs",
  "erl",
  "hrl",
  "ex",
  "exs",
  "dart",
  "nim",
  "zig",
  "vue",
  "svelte",
  "astro",
  "elm",
  "fs",
  "fsi",
  "fsx",
  "tcl",
  "awk",
  "asm",
  "vb",
  // Shell.
  "sh",
  "bash",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "ps1",
  "psm1",
  "psd1",
  // Config + data formats.
  "toml",
  "yaml",
  "yml",
  "json",
  "json5",
  "jsonl",
  "ndjson",
  "ini",
  "cfg",
  "conf",
  "properties",
  "env",
  "envrc",
  "lock",
  // Web.
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "xml",
  "xhtml",
  "xsl",
  "xslt",
  "rss",
  "atom",
  // Data.
  "csv",
  "tsv",
  "sql",
  "log",
  // Whiteboard scene. JSON on disk, so it rides the shared UTF-8 gate;
  // the editor opens it in canvas mode (isExcalidraw), source mode
  // exposes the raw scene JSON.
  "excalidraw",
  // Build.
  "mk",
  "mak",
  "cmake",
  "bzl",
  "ninja",
  "gradle",
  // Patches.
  "patch",
  "diff",
  // Markup.
  "rst",
  "adoc",
  "asciidoc",
  "org",
  "tex",
  "latex",
  "ltx",
  "bib",
  // Dotfiles (suffix after the leading dot).
  "gitignore",
  "gitattributes",
  "editorconfig",
  "npmrc",
  "nvmrc",
  "babelrc",
  "prettierrc",
  "eslintrc",
  "eslintignore",
  "dockerignore",
]);

// Well-known no-extension or all-caps filenames the editor should
// treat as text. Mirrors chan-workspace's `classify_basename`.
const TEXT_BASENAMES = new Set([
  "Makefile",
  "GNUmakefile",
  "BSDmakefile",
  "makefile",
  "Dockerfile",
  "Containerfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Justfile",
  "Vagrantfile",
  "Berksfile",
  "Brewfile",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "COPYRIGHT",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "README",
  "TODO",
  "NEWS",
  "CHANGELOG",
  "HISTORY",
  "INSTALL",
  "MANIFEST",
]);

function extOf(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return null;
  return path.slice(dot + 1).toLowerCase();
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/// Path-only kind classifier. Returns the editor-facing kind a path
/// would receive in the absence of a server-side `TreeEntry.kind`.
/// Used by `classifyFile` in `./kinds.ts` as the fallback branch.
/// PDFs fold into `media` here to match the server's
/// `project_kind` mapping (PDFs share the media chip + viewer
/// surface even though they ride a different DOM tag than images).
export function classifyPath(
  path: string,
): "document" | "text" | "media" | "binary" {
  const ext = extOf(path);
  if (ext !== null) {
    if (IMAGE_EXTENSIONS.has(ext) || ext === "pdf") return "media";
    // Only Markdown (.md) is a graph "document". .txt is editable +
    // searchable text but not a document node, so it rides the "text"
    // wire kind -- mirroring the server's project_kind and
    // chan-workspace's is_markdown_file. (.txt stays in
    // MARKDOWN_EXTENSIONS because the editor still renders it as
    // markdown via isMarkdown; that's a separate, editor-only concern.)
    if (ext === "md") return "document";
    if (MARKDOWN_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext)) return "text";
  }
  if (TEXT_BASENAMES.has(basenameOf(path))) return "text";
  return "binary";
}

/// True for any path the editor can round-trip through a UTF-8
/// buffer. Mirrors `chan_workspace::fs_ops::is_editable_text`:
/// markdown-class + source / config / shell text +
/// well-known basenames. Returns false for images, PDFs, archives,
/// audio, video, and unknown extensions.
export function isEditableText(path: string): boolean {
  const kind = classifyPath(path);
  return kind === "document" || kind === "text";
}

/// True for raster + svg images. Matches the set the editor's image
/// picker accepts and the graph's file-vs-image classifier. Note
/// the server projects both images and PDFs as `media` kind on the
/// wire; this helper stays image-only because the image-inspector
/// preview / zoom path is image-shaped (uses `<img>`, not `<embed>`).
export function isImage(path: string): boolean {
  if (classifyPath(path) !== "media") return false;
  // classifyPath returns "media" for both images and PDFs (server
  // groups them). Discriminate by extension here so PDFs don't end
  // up in image-only call sites.
  return !isPdf(path);
}

/// True for PDF files. Separate from `isImage` so PDF callers route
/// to the PDF viewer overlay instead of the image zoom overlay,
/// even though both share `media` kind on the wire.
export function isPdf(path: string): boolean {
  return extOf(path) === "pdf";
}

/// True for browser-native video files. Standalone predicate rather
/// than a `classifyPath` branch: the server still projects video as
/// the sniffed `binary` wire kind, and `classifyPath` mirrors the
/// server. Video-specific surfaces (inline preview, the fullscreen
/// viewer) key off this path check, exactly like `isImage` callers.
export function isVideo(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extOf(path) ?? "");
}

/// True for browser-native audio files. Like video, audio stays binary in
/// `classifyPath`; inspector and viewer surfaces opt in through this path
/// predicate without widening the server's file taxonomy.
export function isAudio(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extOf(path) ?? "");
}

/// True for markdown-class files (.md / .txt): the note-shaped text
/// files chan treats as prose documents rather than code or data.
export function isMarkdown(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extOf(path) ?? "");
}

/// True for JSON-class files. The editor tab opens these in
/// "pretty" mode by default (collapsible tree); source mode is the
/// fallback for edits. Same wire kind as any other text file
/// (`text`); the discriminator is per-path because we don't want a
/// separate `FileKind` for every renderable format.
export function isJson(path: string): boolean {
  const ext = extOf(path);
  return ext === "json" || ext === "json5";
}

/// True for tabular CSV / TSV files. The editor tab opens these in
/// "table" mode by default; source mode preserves the raw bytes
/// for users who want to wrangle the file by hand. Same wire kind
/// as any other text file (`text`).
export function isCsv(path: string): boolean {
  const ext = extOf(path);
  return ext === "csv" || ext === "tsv";
}

/// True for Excalidraw whiteboard scenes. The editor tab opens these
/// in "canvas" mode by default (the interactive board); source mode
/// exposes the raw scene JSON. Same wire kind as any other text file
/// (`text`) -- the scene is JSON on disk, so it rides the shared
/// UTF-8 gate and joins TEXT_EXTENSIONS in lockstep with the server.
export function isExcalidraw(path: string): boolean {
  return extOf(path) === "excalidraw";
}

/// Field delimiter for a tabular file. Feeds both the parser and
/// the on-save serializer so a round-trip preserves the source
/// shape. `.tsv` uses tab; `.csv` defaults to comma. A per-tab
/// override can layer on top of this fallback without changing the
/// common extension-based behavior.
export function csvDelimiter(path: string): string {
  return extOf(path) === "tsv" ? "\t" : ",";
}
