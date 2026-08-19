// Workspace info singleton + draft-path helpers.
//
// This is a LEAF module with no eager side effects so both
// `store.svelte.ts` (which re-exports `workspace`) and `tabs.svelte.ts`
// can import it without triggering the store/tabs draft-promotion-sink
// init-order cycle (see the note in tabs.svelte.ts). Keep it dependency
// -light: only the `WorkspaceInfo` type, nothing that runs at import.

import type { WorkspaceInfo } from "../api/types";
import { windowCaps } from "./windowCaps";

export const workspace = $state<{ info: WorkspaceInfo | null }>({ info: null });

/// The standalone tenant's drafts directory as a wire path (e.g.
/// `home/user/.chan/Drafts`), set by `bootstrapStandalone` from
/// `GET /api/fs/context` before any layout or session restore runs so
/// restored draft tabs and rich-prompt bindings classify correctly.
/// `null` until then, and forever on a tenant that serves no drafts.
export const standaloneDrafts = $state<{ dir: string | null }>({ dir: null });

/// Single source of truth for the Drafts directory. In a workspace
/// window the backend surfaces `WorkspaceInfo.drafts_dir` (a real
/// in-workspace relpath, e.g. `.Drafts`) read-only on `/api/workspace`,
/// defaulting to `.Drafts` until the info round-trip lands. In a
/// standalone window it is the tenant's drafts wire path, and `null`
/// means the window has no drafts at all (which also stops a real
/// root-level `.Drafts` directory on the machine from being
/// misclassified). Never hardcode the literal anywhere; key all
/// draft-path logic off this accessor.
export function draftsDir(): string | null {
  if (windowCaps.workspace) {
    return workspace.info?.drafts_dir ?? ".Drafts";
  }
  return standaloneDrafts.dir;
}

/// A path is a draft path when it is the drafts dir itself or sits
/// under it. Drafts are real paths in each window's dialect
/// (`.Drafts/untitled/draft.md` in a workspace,
/// `home/user/.chan/Drafts/untitled/draft.md` in a standalone window).
export function isDraftPath(path: string): boolean {
  const dir = draftsDir();
  return dir !== null && (path === dir || path.startsWith(`${dir}/`));
}
