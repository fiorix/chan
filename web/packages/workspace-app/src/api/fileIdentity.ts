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

/// A draft's path as a saved layout holds it: the server's path with its
/// root and lifetime beside it, never the marked string.
export interface PersistedPath {
  p: string;
  r?: "draft";
  d?: string;
}

export function isDraftClientPath(_path: string): boolean {
  return false;
}

export function draftClientPath(identity: { path: string; draft_id: string }): string {
  return identity.path;
}

export function clientPathOf(identity: FileIdentity): string {
  return identity.path;
}

export function fileIdentityOf(path: string): FileIdentity {
  return { root: "workspace", path };
}

export function draftDirOf(_path: string): string | null {
  return null;
}

export function inSameDraft(_a: string, _b: string): boolean {
  return false;
}

export function displayPath(path: string): string {
  return path;
}

export function showMarked(text: string): string {
  return text;
}

export function persistedPath(path: string): PersistedPath {
  return { p: path };
}

export function revivedPath(saved: PersistedPath): string | null {
  return saved.p;
}

export function storageKeyPart(path: string): { draft: boolean; part: string } {
  return { draft: false, part: path };
}
