// The workspace lifecycle vocabulary this window's library speaks, and the one
// question this SPA asks of it. Kept apart from the rest of the scoped library
// client so the answer carries no transport dependency: it is a pure function
// of the wire string, usable anywhere the deck renders.

import type { ComputersWorkspaceCondition } from "@chan/web-shared/computers-deck";

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

/** How a workspace's mount reads in the Computers tree. Total over the union,
 * so a new status has to decide this rather than inherit an answer. */
export function workspaceCondition(status: ScopedWorkspaceStatus): ComputersWorkspaceCondition {
  switch (status) {
    case "stopped":
      return "idle";
    case "starting":
    case "closing":
    case "removing":
      return "busy";
    case "running":
      return "ready";
    case "locked":
      return "foreign";
    case "unavailable":
      return "degraded";
    case "error":
      return "failed";
  }
}
