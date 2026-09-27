// The launcher's client-side window manager: it owns the window.open handles for
// browser-minted workspace/terminal windows and reconciles them against the
// library watch feed.
//
// On a self-managed (devserver/PWA) surface the launcher is not a desktop bridge,
// so it opens windows as same-origin browser windows instead of driving native
// ones. It keys each handle by window_id (the feed's reconciliation key), mints
// via the widened createWindow with origin:"browser" (so the desktop watcher
// never grows a native twin), and on the feed's absence-only discard closes the
// matching handle. A reload wipes the in-memory handle map, so the reconciler
// re-flags visible CONNECTED browser-origin records it holds no handle for (via
// windowAttention) so their rows flash for a re-open click. Disconnected
// browser-origin rows are stale browser tabs; the launcher discards them instead
// of keeping a permanent "open elsewhere" affordance.
//
// Inert under demoState.enabled: a marketing embed never spawns windows.

import { clearClonedSessionDeckDrafts } from "@chan/web-shared/command-deck";
import { backend } from "../api/backend";
import { ApiError, type WindowKind, type WindowRecord, type WindowSet } from "../api/library";
import { windowUrl } from "../lib/windowUrl";
import { demoState } from "./demo.svelte";
import { clearWindowAttention, markWindowAttention } from "./windowAttention.svelte";

// window_id -> the open browser window. Imperative (the reactive surface is
// windowAttention); a reload wipes it and the reconciler re-flags orphans.
const handles = new Map<string, Window>();
// window_ids from the last feed push, so the reconciler detects removals (the
// feed signals a discard by ABSENCE, never a tombstone).
let prevIds = new Set<string>();
// Disconnected browser-origin rows may be a transient /ws reconnect, so rows
// without a local closed handle get a short cancellation window before cleanup.
const DISCONNECTED_BROWSER_WINDOW_DISCARD_MS = 2500;
const pendingDiscards = new Set<string>();

function servingOrigin(): string {
  return typeof location === "undefined" ? "" : location.origin;
}

function discardBrowserWindow(id: string): void {
  pendingDiscards.delete(id);
  handles.get(id)?.close();
  handles.delete(id);
  clearWindowAttention(id);
  void backend.discardWindow(id).catch(() => {});
}

function scheduleBrowserWindowDiscard(id: string): void {
  if (pendingDiscards.has(id)) return;
  pendingDiscards.add(id);
  clearWindowAttention(id);
  const timer = setTimeout(() => {
    if (pendingDiscards.has(id)) discardBrowserWindow(id);
  }, DISCONNECTED_BROWSER_WINDOW_DISCARD_MS);
  (timer as { unref?: () => void }).unref?.();
}

function handleState(id: string): "live" | "closed" | "none" {
  const h = handles.get(id);
  if (!h) return "none";
  if (!h.closed) return "live";
  handles.delete(id);
  return "closed";
}

const WINDOW_PAGE_WAIT_MS = 60_000;
const WINDOW_CLOSED_POLL_MS = 100;
const waitingPages = new WeakMap<Window, Promise<boolean>>();
const navigatingDocuments = new WeakMap<Window, Document>();

function retryAfterMs(header: string | null): number {
  if (header === null || header.trim() === "") return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(WINDOW_PAGE_WAIT_MS, Math.max(1, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(WINDOW_PAGE_WAIT_MS, Math.max(1, date - Date.now())) : 1000;
}

function navigateWindowWhenReady(h: Window, url: string): Promise<boolean> {
  const waiting = waitingPages.get(h);
  if (waiting) return waiting;
  if (h.closed) return Promise.resolve(false);
  const page = h.document;
  page.body.textContent = "Waiting for the window to be ready...";
  const controller = new AbortController();
  let lastRefusal: Error = new Error("Timed out waiting for the window page");
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let closedPoll: ReturnType<typeof setInterval> | undefined;
  const stopped = new Promise<boolean>((resolve, reject) => {
    deadline = setTimeout(() => reject(lastRefusal), WINDOW_PAGE_WAIT_MS);
    closedPoll = setInterval(() => {
      if (h.closed) resolve(false);
    }, WINDOW_CLOSED_POLL_MS);
  });
  const check = async (): Promise<boolean> => {
    while (!h.closed && !controller.signal.aborted) {
      const response = await backend.checkWindowPage(url, controller.signal);
      if (h.closed || controller.signal.aborted) return false;
      if (response.ok) {
        await response.body?.cancel();
        return true;
      }
      const text = await response.text().catch(() => response.statusText);
      const refusal = new ApiError(response.status, text);
      if (response.status !== 503) throw refusal;
      lastRefusal = refusal;
      if (h.closed || controller.signal.aborted) return false;
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, retryAfterMs(response.headers.get("Retry-After")));
      });
    }
    return false;
  };
  // The deadline and close check also cover a fetch or response body that stalls.
  // One pending navigation owns a named window even when the user clicks twice.
  const pending = Promise.race([check(), stopped]).then((ready) => {
    if (!ready || h.closed) return false;
    h.location.href = url;
    navigatingDocuments.set(h, page);
    return true;
  }).finally(() => {
    clearTimeout(retryTimer);
    clearTimeout(deadline);
    clearInterval(closedPoll);
    controller.abort();
    waitingPages.delete(h);
  });
  waitingPages.set(h, pending);
  return pending;
}

/** Mint a browser window of the local library and open it in-app. Call this
 * DIRECTLY from a user gesture: it opens the blank window synchronously, before
 * the mint await, so the browser does not treat the later navigation as a popup.
 * A refused mint or page check closes the blank window and rethrows the error
 * for the caller's banner. `actingWindowId` claims
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
      blank.name = rec.window_id;
      handles.set(rec.window_id, blank);
      pendingDiscards.delete(rec.window_id);
      const url = windowUrl(rec, servingOrigin());
      if (!(await navigateWindowWhenReady(blank, url)) || blank.closed) {
        if (handles.get(rec.window_id) === blank) discardBrowserWindow(rec.window_id);
        return null;
      }
    }
    // A blocked popup leaves no handle; if the record never gets a /ws presence
    // the reconciler treats it like any other stale browser row and discards it.
    pendingDiscards.delete(rec.window_id);
    clearWindowAttention(rec.window_id);
    return rec;
  } catch (e) {
    blank?.close();
    if (rec && handles.get(rec.window_id) === blank) discardBrowserWindow(rec.window_id);
    throw e;
  }
}

/** Open (or re-focus) an existing record's window in-app. The window is named by
 * window_id so a second click focuses the same same-origin window instead of
 * opening a duplicate. Used by the follower open-click and orphan re-open. */
export async function openWindowRecord(record: WindowRecord): Promise<Window | null> {
  if (demoState.enabled || !servingOrigin()) return null;
  const h = window.open("", record.window_id);
  if (!h) return null;
  handles.set(record.window_id, h);
  pendingDiscards.delete(record.window_id);
  clearWindowAttention(record.window_id);
  h.focus?.();
  let blank: boolean;
  try {
    const page = h.document;
    // Location can still describe the old page until navigation commits.
    // A later refusal document on this window must remain retryable.
    if (navigatingDocuments.get(h) === page) return h;
    navigatingDocuments.delete(h);
    blank = h.location.href === "" || h.location.href === "about:blank" || page.contentType !== "text/html";
  } catch {
    // A window navigated to another origin still belongs to its user.
    return h;
  }
  if (!blank) return h;
  try {
    const url = windowUrl(record, servingOrigin());
    if (!(await navigateWindowWhenReady(h, url)) || h.closed) {
      if (handles.get(record.window_id) === h) handles.delete(record.window_id);
      return null;
    }
    return h;
  } catch (e) {
    h.close();
    if (handles.get(record.window_id) === h) handles.delete(record.window_id);
    throw e;
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
  pendingDiscards.delete(record.window_id);
  clearWindowAttention(record.window_id);
}

/** Flip a window's server-persisted visibility from a self-managed launcher (the
 * bridgeless Eye toggle): hide a visible window, un-hide a hidden one, keyed on
 * the feed's `hidden`. `actingWindowId` claims the leader identity for the
 * per-tenant gate (the server 403s a mismatching claim). This touches only the
 * shared visibility state; the local browser handle is the OPEN button's job, so
 * nothing here opens or closes it. */
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
 * or a peer surface minted it) so its row flashes for a re-open click. A hidden
 * or native record is never flagged. */
export function reconcileWindows(set: WindowSet): void {
  if (demoState.enabled) return;
  const currentIds = new Set(set.windows.map((w) => w.window_id));
  for (const id of prevIds) {
    if (!currentIds.has(id)) {
      handles.get(id)?.close();
      handles.delete(id);
      pendingDiscards.delete(id);
      clearWindowAttention(id);
    }
  }
  for (const w of set.windows) {
    const state = handleState(w.window_id);
    if (state === "live") {
      pendingDiscards.delete(w.window_id);
      clearWindowAttention(w.window_id);
    } else if (w.origin === "browser" && state === "closed") {
      discardBrowserWindow(w.window_id);
    } else if (w.origin === "browser" && !w.connected) {
      scheduleBrowserWindowDiscard(w.window_id);
    } else if (w.origin === "browser" && !w.hidden) {
      pendingDiscards.delete(w.window_id);
      markWindowAttention(w.window_id);
    } else {
      pendingDiscards.delete(w.window_id);
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
  prevIds = new Set();
  pendingDiscards.clear();
}
