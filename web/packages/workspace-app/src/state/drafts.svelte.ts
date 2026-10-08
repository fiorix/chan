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

import { api } from "../api/client";
import { apiErrorCode } from "../api/errors";
import { fileIdentityOf, isDraftClientPath } from "../api/fileIdentity";
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

// Orders what this window knows of a draft against the list's requests: it
// moves when a request starts and when the server makes a draft for this
// window.
let clock = 0;
// The reading at which the request behind the current rows began.
let listedAt = 0;
// The lifetimes this window created, by id, with the reading at creation.
const bornAt = new Map<string, number>();

let current: Promise<void> | null = null;
let queued: Promise<void> | null = null;
const listeners = new Set<() => void>();

async function fetchList(): Promise<void> {
  const startedAt = ++clock;
  try {
    const list = await api.listDrafts();
    drafts.rows = list.drafts;
    drafts.broken = list.warnings.filter((warning) => warning.kind === "broken_draft");
    drafts.preflight =
      list.warnings.find((warning) => warning.kind === "draft_preflight_failed") ?? null;
    drafts.loaded = true;
    drafts.error = null;
    listedAt = startedAt;
  } catch (e) {
    drafts.error = e instanceof Error ? e.message : String(e);
    return;
  }
  for (const listener of [...listeners]) listener();
}

function start(): Promise<void> {
  const run: Promise<void> = fetchList().finally(() => {
    if (current === run) current = null;
  });
  current = run;
  return run;
}

/// Ask the server for the list. The promise resolves once a request that
/// began after this call has been answered, so what the caller reads next
/// is no older than its call: a request already in flight is followed by
/// one more, which every call made meanwhile shares. It never rejects; a
/// failed request leaves the rows as they were and sets `drafts.error`.
export function refreshDrafts(): Promise<void> {
  if (current === null) return start();
  if (queued === null) {
    queued = current.then(() => {
      queued = null;
      return start();
    });
  }
  return queued;
}

/// Run `listener` after each answered list. Returns its removal.
export function onDraftsListed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function lifetimeOf(path: string): string | null {
  if (!isDraftClientPath(path)) return null;
  try {
    return fileIdentityOf(path).draft_id ?? null;
  } catch {
    return null;
  }
}

/// Record a draft the server just made for this window. A list whose
/// request began before the draft existed does not have it, and must not
/// be read as saying it is gone.
export function noteDraftBorn(path: string): void {
  const id = lifetimeOf(path);
  if (id !== null) bornAt.set(id, ++clock);
}

/// Whether the list, as last answered, says the lifetime of `path` is gone:
/// it is a draft's path, a list has been answered whose request began after
/// this window learned of the draft, and no row of it is that lifetime.
export function draftGone(path: string): boolean {
  const id = lifetimeOf(path);
  if (id === null || !drafts.loaded) return false;
  if (drafts.rows.some((row) => row.draftId === id)) return false;
  return (bornAt.get(id) ?? 0) < listedAt;
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
/// The list is fetched again first. A lifetime it no longer has is gone, and
/// the request fails with `DraftGoneError`. A lifetime it still has is alive
/// (a lifecycle on it was closing), and the same request is made once more;
/// whatever that one answers is the answer. Any other failure, and any
/// request on a path that is not a draft's, passes through.
export async function decidingStale<T>(path: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    if (!isDraftClientPath(path) || apiErrorCode(e) !== "draft_stale") throw e;
    await refreshDrafts();
    if (draftGone(path)) throw new DraftGoneError(path);
    return await request();
  }
}

/// Forget everything, for a test that starts from no list.
export function resetDraftsForTests(): void {
  drafts.rows = [];
  drafts.broken = [];
  drafts.preflight = null;
  drafts.loaded = false;
  drafts.error = null;
  clock = 0;
  listedAt = 0;
  bornAt.clear();
  current = null;
  queued = null;
}
