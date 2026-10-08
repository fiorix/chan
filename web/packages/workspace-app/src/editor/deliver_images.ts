// Rewrite a prompt draft's image refs into bare absolute on-disk paths for
// terminal delivery.
//
// The Rich Prompt editor stores a pasted image as `![](./image.png#w=N)`,
// relativized against the draft file so the editor preview renders it. That
// markdown stays in the composer (the user keeps seeing the image), but the
// receiving target reads a raw command line, where a leading `!` runs as a
// shell history expansion and a relative path only resolves when the cwd is
// the workspace root. So the DELIVERED text replaces each image ref with the
// bare ABSOLUTE on-disk path plus one trailing space: no `![]()` wrapper, no
// `#w=N` render hint, no alt text, cwd-independent. Refs inside fenced or
// inline code are left as written (they are content, not a pasted
// attachment).
//
// A file under the workspace root is at the root's path plus its own. A
// workspace's draft is kept outside the root, where only the server knows:
// its files are delivered by the paths the server gives for them, and a
// file it gives none for is left as written.

import { fenceLineTracker } from "./commands/fence";
import { parseImageSrc } from "./extensions/image";
import { decodePercent, normalizeHref } from "./links";
import { isDraftClientPath } from "../api/fileIdentity";
import { parentDir } from "../state/format";

/// What a rewrite resolves a ref against.
type Delivery = {
  /// The directory the refs are relative to.
  sourceDir: string;
  /// The absolute root that workspace paths hang off, without a trailing `/`.
  root: string;
  /// The server's absolute path of each draft file, by its client path.
  draftPaths: ReadonlyMap<string, string>;
  /// When set, collects the client path of every draft file a ref names.
  found?: Set<string>;
};

const NO_DRAFT_PATHS: ReadonlyMap<string, string> = new Map();

/// Replace each markdown image ref in `text` with the bare absolute on-disk
/// path of the file it points at, followed by a single space. `fromPath` is the
/// draft file the refs are relative to; `workspaceRoot` is the absolute root
/// workspace paths hang off; `draftPaths` holds the server's path of each file
/// of a workspace draft, by client path (see `resolveDraftImagePaths`).
/// External (`http`/`data`/`blob`) and unresolvable refs, refs to a draft file
/// with no path in `draftPaths`, and refs inside code, are left untouched.
export function rewriteImagePathsForDelivery(
  text: string,
  fromPath: string | null,
  workspaceRoot: string | null,
  draftPaths: ReadonlyMap<string, string> = NO_DRAFT_PATHS,
): string {
  if (!fromPath || !workspaceRoot || !text.includes("![")) return text;
  return rewriteText(text, {
    sourceDir: parentDir(fromPath),
    root: workspaceRoot.replace(/\/+$/, ""),
    draftPaths,
  });
}

/// The client paths of the workspace draft files that the image refs of
/// `text` name, each once, in the order met: the files whose paths a delivery
/// has to ask the server for. Empty when no ref names one.
export function draftImagesForDelivery(text: string, fromPath: string | null): string[] {
  if (!fromPath || !text.includes("![")) return [];
  const found = new Set<string>();
  rewriteText(text, { sourceDir: parentDir(fromPath), root: "", draftPaths: NO_DRAFT_PATHS, found });
  return [...found];
}

/// Ask the server, through `ask`, for the absolute paths of the draft files
/// `images`, and answer the ones it gave by client path. The server refuses
/// the whole request for one file it refuses, so after a refusal each file is
/// asked for alone, and a file refused then has no entry. Never rejects.
export async function resolveDraftImagePaths(
  images: string[],
  ask: (paths: string[]) => Promise<string[]>,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  if (images.length === 0) return paths;
  try {
    const answered = await ask(images);
    images.forEach((image, index) => {
      const path = answered[index];
      if (path) paths.set(image, path);
    });
  } catch {
    await Promise.all(
      images.map(async (image) => {
        try {
          const [path] = await ask([image]);
          if (path) paths.set(image, path);
        } catch {
          // Refused on its own too: its ref is delivered as written.
        }
      }),
    );
  }
  return paths;
}

function rewriteText(text: string, delivery: Delivery): string {
  // Skip fenced code blocks line by line; inside a fence nothing is rewritten.
  const fence = fenceLineTracker();
  return text
    .split("\n")
    .map((line) => (fence(line) === "text" ? rewriteLineOutsideCode(line, delivery) : line))
    .join("\n");
}

/// Rewrite image refs in a single non-fence line, skipping inline code spans
/// (matched backtick runs) so a ref shown as code is delivered verbatim.
function rewriteLineOutsideCode(line: string, delivery: Delivery): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let n = 0;
      while (line[i + n] === "`") n++;
      const close = findClosingRun(line, i + n, n);
      if (close >= 0) {
        out += line.slice(i, close + n); // inline code span, verbatim
        i = close + n;
        continue;
      }
      out += line.slice(i, i + n); // unbalanced backticks: literal text
      i += n;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== "`") j++;
    out += rewriteRefsInText(line.slice(i, j), delivery);
    i = j;
  }
  return out;
}

/// Index of the next run of exactly `n` backticks at or after `from`, or -1.
function findClosingRun(line: string, from: number, n: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] !== "`") continue;
    let run = 0;
    while (line[i + run] === "`") run++;
    if (run === n) return i;
    i += run - 1;
  }
  return -1;
}

/// Rewrite every image ref in a code-free text segment. Each `![alt](dest)` is
/// replaced by the resolved absolute path + one trailing space, collapsing any
/// horizontal whitespace that followed the ref so exactly one space separates it
/// from the next token.
function rewriteRefsInText(seg: string, delivery: Delivery): string {
  let out = "";
  let i = 0;
  while (i < seg.length) {
    if (seg[i] === "!" && seg[i + 1] === "[") {
      const parsed = parseImageAt(seg, i);
      if (parsed) {
        const abs = resolveAbsolute(parsed.dest, delivery);
        if (abs) {
          let k = parsed.end;
          while (seg[k] === " " || seg[k] === "\t") k++;
          out += `${abs} `;
          i = k;
          continue;
        }
        out += seg.slice(i, parsed.end); // external/unresolvable: keep verbatim
        i = parsed.end;
        continue;
      }
    }
    out += seg[i];
    i++;
  }
  return out;
}

/// Parse a markdown image ref starting at `s[start]` (`!`). Handles balanced
/// brackets in the alt, angle-bracketed destinations, balanced parens in the
/// destination, and an optional title. Returns the raw destination (fragment
/// kept for `parseImageSrc` to strip) and the index just past the closing `)`,
/// or null if `s` does not hold a complete ref there.
function parseImageAt(
  s: string,
  start: number,
): { dest: string; end: number } | null {
  let i = start + 2; // past "!["
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (depth !== 0 || s[i] !== "]") return null;
  i++; // past "]"
  if (s[i] !== "(") return null;
  i++; // past "("
  while (s[i] === " " || s[i] === "\t") i++;

  let dest = "";
  if (s[i] === "<") {
    i++;
    while (i < s.length && s[i] !== ">") {
      if (s[i] === "\\") {
        dest += s[i + 1] ?? "";
        i += 2;
        continue;
      }
      dest += s[i];
      i++;
    }
    if (s[i] !== ">") return null;
    i++; // past ">"
  } else {
    let pdepth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") {
        dest += s[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === " " || c === "\t") break; // whitespace begins a title
      if (c === "(") {
        pdepth++;
        dest += c;
        i++;
        continue;
      }
      if (c === ")") {
        if (pdepth === 0) break; // the ref's closing paren
        pdepth--;
        dest += c;
        i++;
        continue;
      }
      dest += c;
      i++;
    }
  }

  while (s[i] === " " || s[i] === "\t") i++;
  if (s[i] === '"' || s[i] === "'" || s[i] === "(") {
    const close = s[i] === "(" ? ")" : s[i];
    i++;
    while (i < s.length && s[i] !== close) {
      if (s[i] === "\\") {
        i += 2;
        continue;
      }
      i++;
    }
    if (s[i] !== close) return null;
    i++;
  }
  while (s[i] === " " || s[i] === "\t") i++;
  if (s[i] !== ")") return null;
  return { dest, end: i + 1 };
}

/// Resolve a raw image destination to its absolute on-disk path: under the
/// root for a workspace file, the server's path for a draft's file. Null for
/// an external (`http`/`data`/`blob`) or workspace-escaping ref, and for a
/// draft file the server gave no path for.
function resolveAbsolute(dest: string, delivery: Delivery): string | null {
  const { base } = parseImageSrc(dest); // drops the `#w=N` render hint
  if (!base || /^(https?:|data:|blob:)/i.test(base)) return null;
  const rooted = normalizeHref(decodePercent(base), delivery.sourceDir);
  if (rooted == null) return null;
  if (isDraftClientPath(rooted)) {
    delivery.found?.add(rooted);
    return delivery.draftPaths.get(rooted) ?? null;
  }
  return `${delivery.root}/${rooted}`;
}
