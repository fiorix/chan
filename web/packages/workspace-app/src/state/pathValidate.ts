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

/// Validate a relative path that the user typed for create / move
/// / rename. Returns a structured result so the caller can show
/// the reason inline instead of a generic "invalid".
export function validatePath(
  raw: string,
  opts: { allowAbsolute?: boolean; allowTrailingSlash?: boolean } = {},
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
  // On a Unix server `\` is a character of a name, but Windows reads it
  // as a separator, so a name that holds one would not open there. It is
  // refused with the other characters Windows does not allow in a name.
  if (trimmed.includes("\\")) {
    return { ok: false, reason: "\\ is not allowed in a name" };
  }
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
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { parent: "", base: path };
  return { parent: path.slice(0, slash), base: path.slice(slash + 1) };
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
  const slash = stripped.lastIndexOf("/");
  const basename = slash >= 0 ? stripped.slice(slash + 1) : stripped;
  const dot = basename.lastIndexOf(".");
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
  const oldBase = basenameOf(oldPath);
  const oldDot = oldBase.lastIndexOf(".");
  if (oldDot <= 0) return newPath;
  const oldExt = oldBase.slice(oldDot);
  const newBase = basenameOf(newPath);
  const newDot = newBase.lastIndexOf(".");
  if (newDot > 0) return newPath;
  return newPath + oldExt;
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
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
