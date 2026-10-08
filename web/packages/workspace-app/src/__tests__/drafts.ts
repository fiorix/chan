// A draft's path as a workspace window holds it, for tests that need a tab,
// a prompt or a request to be a draft's. Built by the identity module, so a
// test never spells the marked form itself.

import { draftClientPath, fileIdentityOf, isDraftClientPath } from "../api/fileIdentity";
import type { FileWriteResponse } from "../api/types";
import type { MockDraft, MockFileEntry } from "../demo/data";
import { demoDrafts } from "../demo/install";
import type { MockWorkspaceStore } from "../demo/store";

/// The client path of a file of the draft `name`: its primary by default.
/// The lifetime id is derived from the name unless one is given, so two
/// calls for one name are files of one lifetime.
export function draftPath(name = "untitled", leaf = "draft.md", draftId = `life-${name}`): string {
  return draftClientPath({ path: `${name}/${leaf}`, draft_id: draftId });
}

/// The draft `name` as demo data seeds it, with the lifetime id `draftPath`
/// gives the same name: `files` is text content by file name inside it.
export function draftSeed(name: string, files: Record<string, string>): MockDraft {
  return { name, draft_id: `life-${name}`, files };
}

/// Write `content` where the installed demo server keeps `path`: a draft's
/// file in its draft store, the draft's lifetime live, any other file in the
/// workspace store `disk`.
export function writeDemoFile(disk: MockWorkspaceStore, path: string, content: string): FileWriteResponse {
  return isDraftClientPath(path) ? demoDrafts().adopt(fileIdentityOf(path), content) : disk.write(path, content);
}

/// The file the installed demo server holds for `path`, in whichever store
/// keeps it.
export function demoFile(disk: MockWorkspaceStore, path: string): MockFileEntry | undefined {
  return isDraftClientPath(path) ? demoDrafts().store.get(fileIdentityOf(path).path) : disk.get(path);
}

/// The server's path of a draft's client path, or null for a path that is
/// not a draft's: what a test matches a draft the server named against.
export function draftServerPath(path: string): string | null {
  return isDraftClientPath(path) ? fileIdentityOf(path).path : null;
}
