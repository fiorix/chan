import { isOpenableExternalUrl } from "../editor/external_links";

// What a link a terminal underlines points at, read from its real target:
// the URI an OSC 8 hyperlink carries as the program wrote it, or the URL the
// text matched. The text on the screen can name another place, and terminal
// output is not trusted, so the menu shows and acts on this.
//
// A target with a scheme other than `file:` is a web link, opened through the
// editor's external-open gate. A `file:` URI, an absolute path and a relative
// path are file links. `cs open` typed in the terminal's shell is the model:
// a relative path resolves against the shell's directory, and a `file:` URI
// is a path on the machine that wrote it, so one naming another host than the
// server's is refused rather than opened somewhere it does not live. Nothing
// is stripped from a path: the open path takes no line number, so a `:12` or
// `#L12` suffix stays part of the name.

export type TerminalLinkTarget =
  | {
      kind: "web";
      /// The target as written.
      url: string;
      /// Why the browser does not open it, or null when it does.
      refusal: string | null;
    }
  | {
      kind: "file";
      /// The path: a `file:` URI's decoded path, or the target as written.
      path: string;
      /// Whether `path` resolves against the shell's directory.
      relative: boolean;
      /// Why the editor does not open it, or null when it may.
      refusal: string | null;
    };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const DRIVE_PATH = /^[a-z]:[\\/]/i;

/// Classify a link's target. `serverHost` is the host name of the machine the
/// terminal runs on, when the app knows it; a `file:` URI with no host,
/// `localhost` or that name is a path on that machine.
export function classifyTerminalLink(target: string, serverHost: string | null): TerminalLinkTarget {
  const text = target.trim();
  if (DRIVE_PATH.test(text)) return { kind: "file", path: text, relative: false, refusal: null };
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === "file") return fileUri(text, serverHost);
  if (scheme) {
    return {
      kind: "web",
      url: text,
      refusal: isOpenableExternalUrl(text) ? null : `${scheme}: links do not open in a browser`,
    };
  }
  return { kind: "file", path: text, relative: !text.startsWith("/"), refusal: null };
}

/// The host of a `file:` URI that names another machine, or null for one on
/// the server's: no host or the server's own host name. `host` is a parsed
/// URL's, which a `file:` URL gives in lower case and as empty for
/// `localhost`.
function foreignFileHost(host: string, serverHost: string | null): string | null {
  if (host === "") return null;
  if (serverHost !== null && host === serverHost.toLowerCase()) return null;
  return host;
}

function fileUri(text: string, serverHost: string | null): TerminalLinkTarget {
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
  const foreign = foreignFileHost(url.hostname, serverHost);
  return {
    kind: "file",
    path,
    relative: false,
    refusal: foreign === null ? null : `on another host (${foreign})`,
  };
}

/// Whether a file link's host is one the app has to ask the server's name
/// for before it can tell this machine from another.
export function needsServerHost(target: string): boolean {
  const text = target.trim();
  if (SCHEME.exec(text)?.[1]?.toLowerCase() !== "file") return false;
  try {
    return new URL(text).hostname !== "";
  } catch {
    return false;
  }
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
