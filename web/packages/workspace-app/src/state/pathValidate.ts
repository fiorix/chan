// Client-side path validation. Strict subset of what chan-workspace
// will accept: anything we say "ok" to here must round-trip
// successfully through the API. The reverse isn't required (the
// server is still the authority), but we want the modal to fail
// fast on inputs that are obviously going to be rejected so the
// user gets feedback before the round-trip.
//
// Rules mirror the cap-std-backed sandboxing in chan-workspace plus
// a few cross-platform niceties (Windows reserved names, trailing
// dot/space in segments) so a path that opens fine on macOS
// doesn't blow up when the same workspace is opened on Windows later.

import { basename, parentDir } from "./format";

export type PathCheck = { ok: true } | { ok: false; reason: string };

const MAX_SEGMENT = 255;
const MAX_TOTAL = 4096;

// Names Windows reserves regardless of extension. Listed lowercase;
// matched case-insensitively against the basename-without-extension.
const WIN_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/// What a name that holds a `\` is compared with: `source` is the path of
/// the entry a move or a rename is about, and `exists` answers whether an
/// entry is at a workspace path now.
export type HeldNames = {
  source?: string | null;
  exists?: (path: string) => boolean;
};

/// What `backslashReason` answers when it refuses.
export const BACKSLASH_REASON = "\\ cannot be added to a name";

/// What the path prompt says in its place where the `\` reads as a
/// separator (`backslashSeparates`).
export const BACKSLASH_SEPARATOR_REASON = `${BACKSLASH_REASON}; use / between directories`;

/// What `backslashClimbReason` answers when it refuses.
export const BACKSLASH_CLIMB_REASON = ".. cannot be used in a path that holds \\";

function backslashes(name: string): number {
  return name.split("\\").length - 1;
}

/// The rule for a `\` in a path a user typed or dropped: a name keeps a `\`
/// it holds and gains none. On a Unix server `\` is a character of a name,
/// while Windows reads it as a separator, so a name that holds one would not
/// open there. Returns the refusal, or null when every name passes.
///
/// A name passes when it is there already, since nothing is made: `exists`
/// knows it, or it is on the way to `source` too. So a move onto an entry
/// that exists passes, and its caller says that the name is taken. The last
/// name of a move also passes when it holds no more `\` than the source's
/// name.
export function backslashReason(path: string, held: HeldNames = {}): string | null {
  return refusedName(path, held) === null ? null : BACKSLASH_REASON;
}

/// Whether the `\` the rule refuses in `path` reads as a separator typed in
/// the place of a `/`: the text of the refused name before its first `\`,
/// with the path that leads to the name, is a directory by `isDir`. A `\`
/// that opens a name follows no such text. It is a hint for the sentence
/// shown and changes no verdict: `backslashReason` refuses the path either
/// way.
export function backslashSeparates(
  path: string,
  held: HeldNames,
  isDir: (path: string) => boolean,
): boolean {
  const refused = refusedName(path, held);
  if (refused === null) return false;
  const nameStart = refused.lastIndexOf("/") + 1;
  const at = refused.indexOf("\\", nameStart);
  return at > nameStart && isDir(refused.slice(0, at));
}

/// The path as far as the first name the rule refuses, that name included,
/// or null when every name passes.
function refusedName(path: string, held: HeldNames): string | null {
  if (!path.includes("\\")) return null;
  const names = path.replace(/\/+$/, "").split("/");
  const sourceNames = held.source ? held.source.split("/") : null;
  let acc = "";
  let onSource = sourceNames !== null;
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    acc = i === 0 ? name : `${acc}/${name}`;
    onSource = onSource && sourceNames![i] === name;
    if (!name.includes("\\")) continue;
    const kept =
      onSource ||
      held.exists?.(acc) === true ||
      (i === names.length - 1 &&
        sourceNames !== null &&
        backslashes(name) <= backslashes(sourceNames[sourceNames.length - 1]));
    if (!kept) return acc;
  }
  return null;
}

/// Whether `root`, a workspace root as its server spells it, is a Windows
/// path: one that opens with a drive (`C:`) or with `\\` (a share or a
/// verbatim prefix). A Unix root opens with `/`, so none reads as one.
function isWindowsRoot(root: string): boolean {
  return /^[A-Za-z]:/.test(root) || root.startsWith("\\\\");
}

/// The workspace path `backslashReason` is to judge for a typed or dropped
/// `target`, or null where the rule does not speak. `root` is the root the
/// window's paths sit under as its server spells it, and null when the
/// window has none.
///
/// The rule speaks only where a `\` can be part of a name. On a server whose
/// root is a Windows path `\` is a separator, so a `\` typed there makes no
/// name hold one, and the server reads the path.
///
/// It speaks only for a path the tree can answer for. An absolute target
/// under the root is taken as its relative path, and empty names and `.` are
/// dropped, as the server's path parser drops them. A target outside the
/// root, or one that climbs with `..`, is the server's to judge.
export function backslashRuleSubject(target: string, root: string | null): string | null {
  if (!target.includes("\\")) return null;
  if (root !== null && isWindowsRoot(root)) return null;
  let path = target;
  if (path.startsWith("/")) {
    if (root === null) return null;
    const base = root.replace(/\/+$/, "");
    if (!path.startsWith(`${base}/`)) return null;
    path = path.slice(base.length);
  }
  const names = path.split("/").filter((name) => name !== "" && name !== ".");
  return names.includes("..") ? null : names.join("/");
}

/// Why a typed `target` that holds both a `\` and a `..` name may not be
/// sent to a route that resolves the `..` and creates what is missing, or
/// null where it may. `root` is the root the window's paths sit under, as
/// `backslashRuleSubject` takes it.
///
/// `backslashRuleSubject` judges no path that climbs, since the tree cannot
/// say what such a path names, so through one the route could make a name
/// that holds a `\`. The refusal reads the text alone, wherever the path
/// sits: relative, under the root or outside it. It costs an entry whose
/// name holds a `\` its paths through a `..`; the path without one opens
/// it. On a server whose root is a Windows path `\` is a separator and
/// nothing is refused, as the rule refuses nothing there. A null root, as
/// before the window has learned its workspace's, is read as a Unix one, as
/// `backslashRuleSubject` reads it, so on a Windows server a path with both
/// separators and a `..` name is refused once more there.
export function backslashClimbReason(target: string, root: string | null): string | null {
  if (!target.includes("\\")) return null;
  if (root !== null && isWindowsRoot(root)) return null;
  return target.split("/").includes("..") ? BACKSLASH_CLIMB_REASON : null;
}

/// Validate a relative path that the user typed for create / move
/// / rename. Returns a structured result so the caller can show
/// the reason inline instead of a generic "invalid". `held` is what
/// `backslashReason` compares a name that holds a `\` with; without it
/// every `\` is refused. `root` is what `backslashRuleSubject` maps the
/// path against.
export function validatePath(
  raw: string,
  opts: { allowAbsolute?: boolean; allowTrailingSlash?: boolean; root?: string | null } & HeldNames = {},
): PathCheck {
  if (raw === "") return { ok: false, reason: "path is empty" };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "path is empty" };
  if (trimmed !== raw) {
    // Leading or trailing whitespace on the whole path. Cheap to
    // strip on submit, but we surface it rather than silently fix
    // it so the user notices the stray space.
    return { ok: false, reason: "leading or trailing whitespace" };
  }
  if (trimmed.length > MAX_TOTAL) {
    return { ok: false, reason: `path too long (>${MAX_TOTAL} chars)` };
  }
  if (trimmed.startsWith("/") && !opts.allowAbsolute) {
    return { ok: false, reason: "absolute paths are not allowed" };
  }
  // A trailing `/` normally means an unfinished basename and is
  // rejected with a name-prompt hint (file create, move/rename). But
  // when the caller is creating a directory (`allowTrailingSlash`),
  // `foo/` is the natural way to say "make the directory foo" - the
  // New File or Directory dialog's caption invites exactly that. In
  // that mode we strip one trailing slash and validate the remaining
  // path as the directory name. A bare "/" (or "" after stripping)
  // still has nothing to name, so it stays rejected.
  let pathForSegments = trimmed;
  if (trimmed.endsWith("/")) {
    if (!opts.allowTrailingSlash) {
      return { ok: false, reason: "path ends with /, type a name" };
    }
    const stripped = trimmed.replace(/\/+$/, "");
    if (stripped === "") {
      return { ok: false, reason: "path ends with /, type a name" };
    }
    pathForSegments = stripped;
  }
  if (/[\x00-\x1f]/.test(trimmed)) {
    return { ok: false, reason: "control characters are not allowed" };
  }
  const judged = backslashRuleSubject(pathForSegments, opts.root ?? null);
  const backslash = judged === null ? null : backslashReason(judged, opts);
  if (backslash) return { ok: false, reason: backslash };
  const segments = pathForSegments.startsWith("/")
    ? pathForSegments.slice(1).split("/")
    : pathForSegments.split("/");
  for (const seg of segments) {
    const segCheck = validateSegment(seg);
    if (!segCheck.ok) return segCheck;
  }
  return { ok: true };
}

function validateSegment(seg: string): PathCheck {
  if (seg === "") return { ok: false, reason: "empty path segment (//)" };
  if (seg === "." || seg === "..") {
    return { ok: false, reason: `'${seg}' segments are not allowed` };
  }
  if (seg.length > MAX_SEGMENT) {
    return { ok: false, reason: `segment too long (>${MAX_SEGMENT} chars)` };
  }
  if (seg !== seg.trim()) {
    return { ok: false, reason: `whitespace at edge of '${seg}'` };
  }
  // Trailing dot/space rejected by Windows; chan-workspace accepts them
  // on Unix today, but a workspace opened later on Windows would see the
  // names get silently mangled. Cheap to reject up front.
  if (seg.endsWith(".") || seg.endsWith(" ")) {
    return { ok: false, reason: `'${seg}' ends in '.' or space (Windows-hostile)` };
  }
  if (/[<>:"|?*]/.test(seg)) {
    return { ok: false, reason: `'${seg}' contains <, >, :, \", |, ?, or *` };
  }
  // Windows reserved basename. Strip the extension before the test
  // so `con.txt` is also caught, not just `con`.
  const dot = seg.lastIndexOf(".");
  const stem = dot > 0 ? seg.slice(0, dot) : seg;
  if (WIN_RESERVED.has(stem.toLowerCase())) {
    return { ok: false, reason: `'${stem}' is reserved on Windows` };
  }
  return { ok: true };
}

/// Split a path into [parent, basename]. Empty parent for top-level
/// paths. Mirrors the conventions used by tree.entries (no leading
/// slash, "/" as separator).
export function splitPath(path: string): { parent: string; base: string } {
  return { parent: parentDir(path), base: basename(path) };
}

/// Append `.md` to a relative path when the basename has no real
/// extension. "Real extension" = a `.` past position 0 with content
/// after it. So `note` → `note.md`, `sub/note` → `sub/note.md`,
/// `note.txt` stays, `note.` (trailing dot) → `note..md` is avoided
/// by stripping the trailing dot first. Hidden-style names like
/// `.gitignore` get `.md` tacked on intentionally: this is a notes
/// app, the user typed a name, not a Unix dotfile.
///
/// Lives here so the path-prompt modal can preview the auto-
/// extension live as the user types AND the fileOps caller can
/// re-apply it as a defensive layer (idempotent).
export function appendDefaultMd(path: string): string {
  const stripped = path.endsWith(".") ? path.slice(0, -1) : path;
  const dot = basename(stripped).lastIndexOf(".");
  if (dot <= 0) return `${stripped}.md`;
  return stripped;
}

/// Re-attach the original file's extension to a rename target when
/// the user dropped it during the prompt. A renamed `note.md` →
/// `humus` rounds back up to `humus.md`. If the user explicitly
/// chose a different extension (`humus.txt`) we leave it alone, and
/// if the original had no extension we don't invent one. Hidden-
/// style basenames (where the only `.` is at position 0) are
/// treated as extension-less so a leading-dot file doesn't claim
/// the rest of its name as the "extension". Mirrors
/// `appendDefaultMd`'s "real extension" predicate.
export function preserveExtension(oldPath: string, newPath: string): string {
  const oldBase = basename(oldPath);
  const oldDot = oldBase.lastIndexOf(".");
  if (oldDot <= 0) return newPath;
  const oldExt = oldBase.slice(oldDot);
  const newBase = basename(newPath);
  const newDot = newBase.lastIndexOf(".");
  if (newDot > 0) return newPath;
  return newPath + oldExt;
}

/// Default stem used by the new-file path prompt when it proposes
/// a placeholder filename inside a freshly-completed directory.
/// Kept as a constant so the helper that builds the proposed path
/// and any future UI hint can share one source of truth.
export const DEFAULT_NEW_FILENAME_STEM = "untitled";

/// Build the placeholder filename the new-file prompt suggests
/// after the user has Tab-completed a directory. `parent` is the
/// raw typed value at the moment of suggestion: empty for top-
/// level files, or a directory path that should end with `/` (a
/// missing trailing slash is tolerated so callers don't have to
/// pre-format). Always returns a path ending in `.md` - that's
/// the default chan-workspace considers editable text.
export function proposeDefaultFilename(parent: string): string {
  const prefix =
    parent === "" || parent.endsWith("/") ? parent : `${parent}/`;
  return `${prefix}${DEFAULT_NEW_FILENAME_STEM}.md`;
}
