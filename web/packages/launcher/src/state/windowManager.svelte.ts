// The launcher's client-side window manager: it owns the window.open handles for
// browser-minted workspace/terminal windows and reconciles them against the
// library watch feed.
//
// On a self-managed (devserver/PWA) surface the launcher is not a desktop bridge,
// so it opens windows as same-origin browser windows instead of driving native
// ones. It keys each handle by window_id (the feed's reconciliation key), mints
// via the widened createWindow with origin:"browser" (so the desktop watcher
// never grows a native twin), and on the feed's absence-only discard closes the
// matching handle. A reload wipes the handle map, so visible browser records
// without a local handle request a re-open click, connected or disconnected.
// Missing handles cannot prove a window is gone; those rows stay for an explicit
// Open or Close. A blocked popup leaves its record available by the same rule.
// A closed handle stays while its record reads connected, since another window
// may hold the socket. The first disconnected push discards it and its record.
// Open repairs a blank window or one whose own page is not held by its record,
// regardless of document type. A held nonblank page stays. Refusals close only a
// blank this gesture opened, never one an earlier wait left marked.
// The latest feed and the window's current page tag are read once the check
// answers, before the window is navigated.
//
// Inert under demoState.enabled: a marketing embed never spawns windows.

import { clearClonedSessionDeckDrafts } from "@chan/web-shared/command-deck";
import {
  isBlankWindow,
  isUnmarkedBlankWindow,
  navigateWindowWhenReady,
  type WindowConnection,
  type WindowPageCheck,
} from "@chan/web-shared/window-page";
import { pageHoldsWindow, readWindowHolder } from "@chan/web-shared/window-holder";
import { backend } from "../api/backend";
import { ApiError, type WindowKind, type WindowRecord, type WindowSet } from "../api/library";
import { windowUrl } from "../lib/windowUrl";
import { demoState } from "./demo.svelte";
import { clearWindowAttention, markWindowAttention } from "./windowAttention.svelte";

// window_id -> the browser handle, including a closed one kept until its record
// reads disconnected. Imperative (the reactive surface is windowAttention); a
// reload wipes it and the reconciler re-flags orphans.
const handles = new Map<string, Window>();
// window_ids from the last feed push, so the reconciler detects removals (the
// feed signals a discard by ABSENCE, never a tombstone).
let prevIds = new Set<string>();
// The records of the last feed push, read when a repair's page answers. Null
// until a push arrives.
let latestWindows: WindowRecord[] | null = null;
// window_id -> how many Opens of it are still deciding. A window closed under a
// pending Open is that Open's answer to give, as when another page's refusal
// closes a blank it follows, not a user's close for the reconciler to discard.
const pendingOpens = new Map<string, number>();

function servingOrigin(): string {
  return typeof location === "undefined" ? "" : location.origin;
}

function discardRecord(id: string): void {
  clearWindowAttention(id);
  void backend.discardWindow(id).catch(() => {});
}

function discardBrowserWindow(id: string): void {
  handles.get(id)?.close();
  handles.delete(id);
  discardRecord(id);
}

// The discard is awaited so that the sentence says whether the record went.
async function movedTabError(id: string): Promise<Error> {
  try {
    await backend.discardWindow(id);
    return new Error("The new window was not opened because its tab was taken to another page.");
  } catch {
    return new Error(
      "The new window was not opened because its tab was taken to another page, and its record could not be removed; close it from the list of windows.",
    );
  }
}

function handleState(id: string): "live" | "closed" | "none" {
  const h = handles.get(id);
  if (!h) return "none";
  if (!h.closed) return "live";
  return "closed";
}

// No feed yet cannot establish that the page is held, so repair continues.
function feedConnection(id: string, h: Window): WindowConnection {
  if (latestWindows === null) return "disconnected";
  const current = latestWindows.find((w) => w.window_id === id);
  if (!current) return "gone";
  return pageHoldsWindow(current, readWindowHolder(h)) ? "connected" : "disconnected";
}

const checkWindowPage: WindowPageCheck = async (url, signal) => {
  const response = await backend.checkWindowPage(url, signal);
  return {
    response,
    readRefusal: async () => new ApiError(
      response.status,
      await response.text().catch(() => response.statusText),
    ),
  };
};

/** Mint a browser window of the local library and open it in-app. Call this
 * DIRECTLY from a user gesture: it opens the blank window synchronously, before
 * the mint await, so the browser does not treat the later navigation as a popup.
 * A refused mint or page check closes the blank window, while it is still the
 * blank this gesture opened, and rethrows the error for the caller's banner. A
 * tab its user took to another page before the mint answered is left to them,
 * and its record is discarded. `actingWindowId` claims
 * the leader identity for the per-tenant mint gate. */
export async function mintWindow(
  kind: WindowKind,
  opts: { workspacePath?: string; actingWindowId?: string } = {},
): Promise<WindowRecord | null> {
  if (demoState.enabled) return null;
  const blank = servingOrigin() ? window.open("", "_blank") : null;
  clearClonedSessionDeckDrafts(blank);
  let rec: WindowRecord | undefined;
  try {
    rec = await backend.createWindow(kind, {
      workspacePath: opts.workspacePath,
      origin: "browser",
      actingWindowId: opts.actingWindowId,
    });
    if (blank) {
      // A tab its user closed before the answer cancels the mint. One whose
      // location reads anything but blank, or cannot be read, is a page its
      // user went to, and nothing here names, marks, navigates or closes it.
      if (blank.closed) {
        discardRecord(rec.window_id);
        return null;
      }
      if (!isBlankWindow(blank)) throw await movedTabError(rec.window_id);
      blank.name = rec.window_id;
      handles.set(rec.window_id, blank);
      const url = windowUrl(rec, servingOrigin());
      if (!(await navigateWindowWhenReady(blank, url, checkWindowPage)) || blank.closed) {
        if (handles.get(rec.window_id) === blank) discardBrowserWindow(rec.window_id);
        return null;
      }
    }
    // A blocked popup leaves its record available for a later Open gesture.
    clearWindowAttention(rec.window_id);
    return rec;
  } catch (e) {
    // Only the blank this gesture opened closes: its user may have taken the
    // tab elsewhere during the wait.
    if (blank && isUnmarkedBlankWindow(blank)) blank.close();
    if (rec && handles.get(rec.window_id) === blank) {
      handles.delete(rec.window_id);
      discardRecord(rec.window_id);
    }
    throw e;
  }
}

/** Open (or re-focus) an existing record's window in-app. The window is named by
 * window_id so a second click focuses the same same-origin window instead of
 * opening a duplicate. Used by the row's Open, by Focus, and by a browser
 * record's Show, which repair a window before changing its visibility. A popup
 * the browser blocks rejects, so the caller reports it. */
export async function openWindowRecord(
  record: WindowRecord,
  opts: { focus?: boolean } = {},
): Promise<Window | null> {
  if (demoState.enabled || !servingOrigin()) return null;
  const h = window.open("", record.window_id);
  if (!h) throw new Error("The browser blocked the Chan window");
  handles.set(record.window_id, h);
  clearWindowAttention(record.window_id);
  if (opts.focus !== false) h.focus?.();
  const blank = isBlankWindow(h);
  const opened = isUnmarkedBlankWindow(h);
  if (!blank && pageHoldsWindow(record, readWindowHolder(h))) return h;
  pendingOpens.set(record.window_id, (pendingOpens.get(record.window_id) ?? 0) + 1);
  try {
    const url = windowUrl(record, servingOrigin());
    const ready = await navigateWindowWhenReady(h, url, checkWindowPage, {
      ...opts,
      readConnection: () => feedConnection(record.window_id, h),
    });
    if (!ready || h.closed) {
      if (handles.get(record.window_id) === h) handles.delete(record.window_id);
      return null;
    }
    return h;
  } catch (e) {
    if (opened) h.close();
    if (handles.get(record.window_id) === h) handles.delete(record.window_id);
    throw e;
  } finally {
    const left = (pendingOpens.get(record.window_id) ?? 1) - 1;
    if (left > 0) pendingOpens.set(record.window_id, left);
    else pendingOpens.delete(record.window_id);
  }
}

/** Leader-side close/hide of a record from the launcher: run the bridgeless web
 * op (discard, or visibility=hidden) and close this launcher's local handle.
 * `actingWindowId` claims the leader identity for the per-tenant gate. */
export async function closeWindowRecord(
  record: WindowRecord,
  opts: { hide?: boolean; actingWindowId?: string } = {},
): Promise<void> {
  if (demoState.enabled) return;
  if (opts.hide) await backend.setWindowVisibility(record.window_id, true, opts.actingWindowId);
  else await backend.discardWindow(record.window_id, opts.actingWindowId);
  handles.get(record.window_id)?.close();
  handles.delete(record.window_id);
  clearWindowAttention(record.window_id);
}

/** Flip a window's server-persisted visibility from a self-managed launcher:
 * hide a visible window, un-hide a hidden one, keyed on the feed's `hidden`.
 * `actingWindowId` claims the leader identity for the per-tenant gate (the
 * server 403s a mismatching claim). This touches only the shared visibility
 * state and opens or closes no window; the eye's Show goes through
 * `setWindowShown`, which repairs a browser record's window first. */
export async function toggleWindowVisibility(
  record: WindowRecord,
  actingWindowId?: string,
): Promise<void> {
  if (demoState.enabled) return;
  await backend.setWindowVisibility(record.window_id, !(record.hidden ?? false), actingWindowId);
}

/** Reconcile the handle map against a feed snapshot. Closes handles whose record
 * left the feed (absence == discard), and flags a VISIBLE browser-origin record
 * this launcher holds no live handle for as an orphan (a reload lost the handle,
 * a peer surface minted it, or its window is gone and the record stays until
 * Close) so its row flashes for a re-open click. A closed browser handle stays
 * until its record reads disconnected, when both are discarded. A hidden or
 * native record is never flagged. A record an Open is still deciding is left
 * to that Open. */
export function reconcileWindows(set: WindowSet): void {
  if (demoState.enabled) return;
  latestWindows = set.windows;
  const currentIds = new Set(set.windows.map((w) => w.window_id));
  for (const id of prevIds) {
    if (!currentIds.has(id)) {
      handles.get(id)?.close();
      handles.delete(id);
      clearWindowAttention(id);
    }
  }
  for (const w of set.windows) {
    if (pendingOpens.has(w.window_id)) continue;
    const state = handleState(w.window_id);
    if (state === "live") {
      clearWindowAttention(w.window_id);
    } else if (w.origin === "browser" && state === "closed" && !w.connected) {
      discardBrowserWindow(w.window_id);
    } else if (w.origin === "browser" && !w.hidden) {
      markWindowAttention(w.window_id);
    } else {
      clearWindowAttention(w.window_id);
    }
  }
  prevIds = currentIds;
}

/** Whether this launcher holds a live handle for a window (its row is "open"
 * here, not an orphan). */
export function hasWindowHandle(id: string): boolean {
  return handleState(id) === "live";
}

/** Test/reset hook: drop all handles and the diff snapshot. */
export function resetWindowManager(): void {
  handles.clear();
  pendingOpens.clear();
  prevIds = new Set();
  latestWindows = null;
}
