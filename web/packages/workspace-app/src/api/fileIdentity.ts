// A file's identity on the wire and its form inside the client.
//
// The server names a file by its root, its path under that root and, for a
// draft, the id of the draft's lifetime. The client keys everything on one
// path string, so a draft's identity travels inside that string in a form no
// file system can hold: a leading U+0000, the encoded id, a colon, then the
// server's draft path. A workspace path is itself. The first component of a
// draft's client path is therefore the draft's own directory.
//
// The marked form is an in-memory key. It is built and parsed here alone, and
// it is never sent, stored or shown: a request carries `fileIdentityOf`, a
// saved layout `persistedPath`, a storage key `storageKeyPart`, and anything
// a person reads `displayPath` or `showMarked`.
//
// A leaf module: no imports, so the api layer and the state modules can both
// use it.

export type FileRoot = "workspace" | "draft";

export interface FileIdentity {
  root: FileRoot;
  path: string;
  draft_id?: string;
}

/// A path as a saved layout holds it. A draft's is the server's path with the
/// lifetime id beside it, never the marked string.
export interface PersistedPath {
  p: string;
  d?: string;
}

const MARK = String.fromCharCode(0);
const DISPLAY_ROOT = "Drafts";
// The mark and the encoded id that follows it, with the colon that ends a
// whole prefix. An encoded id holds none of the characters excluded here.
const MARKED_PREFIX = new RegExp(`${MARK}[^:/ ${MARK}]*(:?)`, "g");

export function isDraftClientPath(path: string): boolean {
  return path.charCodeAt(0) === 0;
}

/// The client path of a draft file. `path` is the server's draft path
/// (`untitled/draft.md`); the id is encoded so it holds no `/` and no `:`.
export function draftClientPath(identity: { path: string; draft_id: string }): string {
  return `${MARK}${encodeURIComponent(identity.draft_id)}:${identity.path}`;
}

/// The client path of any identity the server answers.
export function clientPathOf(identity: FileIdentity): string {
  if (identity.root !== "draft") return identity.path;
  if (!identity.draft_id) throw new Error("a draft identity without its draft_id has no client path");
  return draftClientPath({ path: identity.path, draft_id: identity.draft_id });
}

/// The identity a request carries for `path`. Throws on a marked string that
/// is not a whole draft path, so a damaged one is never sent as a guess.
export function fileIdentityOf(path: string): FileIdentity {
  if (!isDraftClientPath(path)) return { root: "workspace", path };
  const colon = path.indexOf(":");
  const rest = colon < 0 ? "" : path.slice(colon + 1);
  if (colon < 2 || rest === "" || rest.includes(MARK)) {
    throw new Error("malformed draft path");
  }
  let draftId: string;
  try {
    draftId = decodeURIComponent(path.slice(1, colon));
  } catch {
    throw new Error("malformed draft path");
  }
  return { root: "draft", path: rest, draft_id: draftId };
}

/// The draft directory a draft client path sits in (its first component),
/// or null for a workspace path.
export function draftDirOf(path: string): string | null {
  if (!isDraftClientPath(path)) return null;
  const slash = path.indexOf("/");
  return slash < 0 ? path : path.slice(0, slash);
}

/// Whether two client paths are files of one draft lifetime.
export function inSameDraft(a: string, b: string): boolean {
  const dir = draftDirOf(a);
  return dir !== null && dir === draftDirOf(b);
}

/// The path as a person reads it: a draft under `Drafts/`, a workspace path
/// as it is. Not a path anything can be opened by.
export function displayPath(path: string): string {
  if (!isDraftClientPath(path)) return path;
  const colon = path.indexOf(":");
  return colon < 0 ? DISPLAY_ROOT : `${DISPLAY_ROOT}/${path.slice(colon + 1)}`;
}

/// Rewrite every marked form inside a sentence to its display form, so a
/// message that interpolates a path can show neither the mark nor an id.
export function showMarked(text: string): string {
  if (!text.includes(MARK)) return text;
  return text.replace(MARKED_PREFIX, (_match, colon: string) =>
    colon ? `${DISPLAY_ROOT}/` : DISPLAY_ROOT,
  );
}

/// The form a saved layout or a payload for another window holds. A marked
/// string that is not a whole draft path is saved as no path at all.
export function persistedPath(path: string): PersistedPath {
  if (!isDraftClientPath(path)) return { p: path };
  try {
    const identity = fileIdentityOf(path);
    return { p: identity.path, d: identity.draft_id };
  } catch {
    return { p: "" };
  }
}

/// The client path a saved form restores to, or null when the saved path
/// itself holds the mark: a marked string enters the client from this module
/// alone, never from a saved or hand-written layout. A saved form is read
/// from outside the window (a hash a person can write, a payload from
/// another window), so a part that is not text restores to nothing too.
export function revivedPath(saved: PersistedPath): string | null {
  if (typeof saved.p !== "string") return null;
  if (saved.d != null && typeof saved.d !== "string") return null;
  if (saved.p.includes(MARK)) return null;
  if (!saved.d) return saved.p;
  return draftClientPath({ path: saved.p, draft_id: saved.d });
}

/// The part of a storage key that names `path`. A draft's part is built from
/// its identity and is kept under a prefix of its own by the caller, so no
/// key holds the mark and no workspace path can equal a draft's key.
export function storageKeyPart(path: string): { draft: boolean; part: string } {
  if (!isDraftClientPath(path)) return { draft: false, part: path };
  const saved = persistedPath(path);
  return { draft: true, part: `${encodeURIComponent(saved.d ?? "")}:${saved.p}` };
}
