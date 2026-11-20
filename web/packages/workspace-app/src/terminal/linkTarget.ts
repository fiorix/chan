import { isOpenableExternalUrl } from "../editor/external_links";

// What a link a terminal underlines points at, read from its real target:
// the URI an OSC 8 hyperlink carries as the program wrote it, or the URL the
// text matched. The text on the screen can name another place, and terminal
// output is not trusted, so the menu shows and acts on this.
//
// A target with a scheme other than `file:` is a web link, opened through the
// editor's external-open gate. A `file:` URI, an absolute path and a relative
// path are file links. `cs open` typed in the terminal's shell is the model:
// a relative path resolves against the shell's directory, a path starting
// `~/` names the home of the user the server runs as, and a `file:` URI
// is a path on the machine that wrote it, so one naming another host than the
// server's is refused rather than opened somewhere it does not live. Nothing
// is stripped from a bare path: the open path takes no line number, so a
// `:12` or `#L12` suffix stays part of its name. A `file:` URI's path is its
// URL path, without the query or fragment.

export type TerminalLinkTarget =
  | {
      kind: "web";
      /// The target as written.
      url: string;
      /// The host the URL names, as the browser reads it (the part after any
      /// `user@`), or null when it names none (`mailto:`, `tel:`).
      host: string | null;
      /// Why the browser does not open it, or null when it does.
      refusal: string | null;
    }
  | {
      kind: "file";
      /// The path: a `file:` URI's decoded path, or the target as written.
      path: string;
      /// Whether `path` resolves against the shell's directory. A path that
      /// starts `~/` does not: the open expands it against the server's home.
      relative: boolean;
      /// Why the editor does not open it, or null when it may.
      refusal: string | null;
    };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const DRIVE_PATH = /^[a-z]:[\\/]/i;

/// Classify a link's target. `serverHost` answers the host name of the
/// machine the terminal runs on, or null when the app does not know it; it
/// is asked only for a `file:` URI that names a host, since one with no host
/// (a URL reads `localhost` as none) is a path on that machine.
export async function classifyTerminalLink(
  target: string,
  serverHost: () => Promise<string | null>,
): Promise<TerminalLinkTarget> {
  const text = target.trim();
  if (DRIVE_PATH.test(text)) return { kind: "file", path: text, relative: false, refusal: null };
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === "file") return fileUri(text, serverHost);
  if (scheme) {
    return {
      kind: "web",
      url: text,
      host: urlHost(text),
      refusal: isOpenableExternalUrl(text) ? null : `${scheme}: links do not open in a browser`,
    };
  }
  return { kind: "file", path: text, relative: !text.startsWith("/") && !isHomePath(text), refusal: null };
}

function urlHost(text: string): string | null {
  try {
    return new URL(text).host || null;
  } catch {
    return null;
  }
}

/// Whether `path` names the home directory (`~` alone, or `~/` and a path
/// under it). `~user` names another user's home and is not one.
export function isHomePath(path: string): boolean {
  return path === "~" || path.startsWith("~/");
}

async function fileUri(text: string, serverHost: () => Promise<string | null>): Promise<TerminalLinkTarget> {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: "file", path: text, relative: false, refusal: "not a file link chan can read" };
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  // `file:///C:/x` names a drive path.
  if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
  // A `file:` URL's host is lower case, and empty for none or `localhost`.
  const host = url.hostname;
  const foreign = host !== "" && host !== (await serverHost())?.toLowerCase();
  return {
    kind: "file",
    path,
    relative: false,
    refusal: foreign ? `on another host (${host})` : null,
  };
}

/// `text` cut to at most `max` characters by an ellipsis in the middle, so
/// both ends show: a long path keeps its name, a long URL its start and its
/// end.
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}\u2026${text.slice(text.length - (keep - head))}`;
}

/// `path` resolved against the directory `cwd`, with `.` and `..` folded as
/// the shell's `cs open` would hand them on; an absolute path is folded and
/// kept. A Windows directory keeps its drive and takes either separator.
export function resolveTerminalPath(path: string, cwd: string): string {
  const windows = DRIVE_PATH.test(cwd) || DRIVE_PATH.test(path);
  const norm = (value: string) => (windows ? value.replace(/\\/g, "/") : value);
  const target = norm(path);
  const absolute = target.startsWith("/") || DRIVE_PATH.test(target);
  const joined = absolute ? target : `${norm(cwd).replace(/\/+$/, "")}/${target}`;
  const drive = /^[a-z]:/i.exec(joined)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of joined.slice(drive.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${drive}/${parts.join("/")}`;
}
