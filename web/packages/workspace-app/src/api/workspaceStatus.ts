// The workspace lifecycle vocabulary this window's library speaks, and the one
// question this SPA asks of it. Kept apart from the rest of the scoped library
// client so the answer carries no transport dependency: it is a pure function
// of the wire string, usable anywhere the deck renders.

/** Live mount lifecycle of a workspace in this window's library, as the library
 * serializes it. `unavailable` is a mount that is up while the directory under
 * its root cannot be read; `error` is a lifecycle operation that failed. Both
 * carry a reason in `ScopedLibraryWorkspace.error`. */
export type ScopedWorkspaceStatus =
  | "stopped"
  | "starting"
  | "running"
  | "locked"
  | "closing"
  | "removing"
  | "error"
  | "unavailable";

/** Whether a new window may be opened over this workspace. Only a mount that
 * serves can: the library refuses the mint for every other status, `unavailable`
 * included, since that tenant is up but cannot read its root. Total over the
 * union, so a new status has to decide this rather than inherit an answer.
 *
 * This SPA's deck neither shows workspace state nor turns a workspace on or
 * off, so this is the only question it asks about a status. */
export function scopedWorkspaceOpenable(status: ScopedWorkspaceStatus): boolean {
  switch (status) {
    case "running":
      return true;
    case "stopped":
    case "starting":
    case "locked":
    case "closing":
    case "removing":
    case "error":
    case "unavailable":
      return false;
  }
}
