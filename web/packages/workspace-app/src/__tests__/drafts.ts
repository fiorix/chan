// A draft's path as a workspace window holds it, for tests that need a tab,
// a prompt or a request to be a draft's. Built by the identity module, so a
// test never spells the marked form itself.

import { draftClientPath, fileIdentityOf, isDraftClientPath } from "../api/fileIdentity";

/// The client path of a file of the draft `name`: its primary by default.
/// The lifetime id is derived from the name unless one is given, so two
/// calls for one name are files of one lifetime.
export function draftPath(name = "untitled", leaf = "draft.md", draftId = `life-${name}`): string {
  return draftClientPath({ path: `${name}/${leaf}`, draft_id: draftId });
}

/// The server's path of a draft's client path, or null for a path that is
/// not a draft's: what a test matches a draft the server named against.
export function draftServerPath(path: string): string | null {
  return isDraftClientPath(path) ? fileIdentityOf(path).path : null;
}
