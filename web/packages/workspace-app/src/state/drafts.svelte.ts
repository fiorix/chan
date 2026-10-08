// The workspace's drafts as the server lists them.
//
// A draft is kept outside the workspace, so nothing in the tree says which
// drafts exist: one request, `GET /api/drafts`, does. Its answer draws the
// Drafts group, and it is what decides whether a draft's lifetime is still
// there. The server answers a request on a draft "stale" both when the
// lifetime is gone and while a lifecycle on it is closing, and a lifecycle
// that fails reopens the same lifetime under the same id, so that answer
// alone does not say the draft is gone. The list does: a lifetime in flight
// stays listed.
//
// No tab state lives here. This module sits below the tab and store
// modules, which act on what it reports.

import type { DraftListEntry, WorkspaceWarning } from "../api/types";

export const drafts = $state<{
  /// The lifetimes the server listed, in its order.
  rows: DraftListEntry[];
  /// Damaged drafts, each a `broken_draft` warning.
  broken: WorkspaceWarning[];
  /// The draft store refused to open: this one warning stands for the rows.
  preflight: WorkspaceWarning | null;
  /// False until a list has been answered.
  loaded: boolean;
  /// Why the last request failed, or null. The rows are then the last
  /// answer's.
  error: string | null;
}>({ rows: [], broken: [], preflight: null, loaded: false, error: null });

/// Ask the server for the list.
export function refreshDrafts(): Promise<void> {
  return Promise.resolve();
}

/// Run `listener` after each answered list. Returns its removal.
export function onDraftsListed(_listener: () => void): () => void {
  return () => {};
}

/// Record a draft the server just made for this window.
export function noteDraftBorn(_path: string): void {}

/// Whether the list, as last answered, says the lifetime of `path` is gone.
export function draftGone(_path: string): boolean {
  return false;
}

/// A request on a draft's file was refused because the draft's lifetime is
/// gone: it was discarded or saved to the workspace, here or elsewhere.
export class DraftGoneError extends Error {
  constructor(readonly path: string) {
    super("This draft no longer exists");
    this.name = "DraftGoneError";
  }
}

/// Run a request on a draft's file, deciding a stale answer by the list.
export function decidingStale<T>(_path: string, request: () => Promise<T>): Promise<T> {
  return request();
}

/// Forget everything, for a test that starts from no list.
export function resetDraftsForTests(): void {
  drafts.rows = [];
  drafts.broken = [];
  drafts.preflight = null;
  drafts.loaded = false;
  drafts.error = null;
}
