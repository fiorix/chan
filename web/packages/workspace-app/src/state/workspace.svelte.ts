// Workspace info singleton + draft-path helpers.
//
// This is a LEAF module with no eager side effects so both
// `store.svelte.ts` (which re-exports `workspace`) and `tabs.svelte.ts`
// can import it without triggering the store/tabs draft-promotion-sink
// init-order cycle (see the note in tabs.svelte.ts). Keep it dependency
// -light: the `WorkspaceInfo` type and other leaf modules, nothing that
// runs at import.

import { isDraftClientPath } from "../api/fileIdentity";
import type { WorkspaceInfo } from "../api/types";
import { windowCaps } from "./windowCaps";

export const workspace = $state<{ info: WorkspaceInfo | null }>({ info: null });

/// The standalone tenant's drafts directory as a wire path (e.g.
/// `home/user/.chan/Drafts`), set by `bootstrapStandalone` from
/// `GET /api/fs/context` before any layout or session restore runs so
/// restored draft tabs and rich-prompt bindings classify correctly.
/// `null` until then, and forever on a tenant that serves no drafts.
export const standaloneDrafts = $state<{ dir: string | null }>({ dir: null });

/// The directory that holds the window's drafts, when one of its
/// directories does. A workspace window has none: its drafts are kept
/// outside the workspace, so this is `null` there and a folder named
/// `.Drafts` is an ordinary folder. In a standalone window it is the
/// tenant's drafts wire path, and `null` means the window has no drafts at
/// all (which also stops a real root-level `.Drafts` directory on the
/// machine from being misclassified). Never hardcode the literal anywhere.
export function draftsDir(): string | null {
  return windowCaps.workspace ? null : standaloneDrafts.dir;
}

/// Whether `path` names a draft's file. Key all draft-path logic off this.
/// A workspace window's draft reaches the client as a marked path carrying
/// its lifetime id (see `api/fileIdentity`), so the mark decides. A
/// standalone window's drafts are real paths: the drafts directory itself
/// and whatever sits under it
/// (`home/user/.chan/Drafts/untitled/draft.md`).
export function isDraftPath(path: string): boolean {
  if (windowCaps.workspace) return isDraftClientPath(path);
  const dir = standaloneDrafts.dir;
  return dir !== null && (path === dir || path.startsWith(`${dir}/`));
}
