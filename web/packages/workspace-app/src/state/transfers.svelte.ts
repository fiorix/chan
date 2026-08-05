// The unified per-window file-transfer model: one source for the transfer
// bubble that `cs upload` / `cs download` surface. It replaces the split
// upload-status + desktop-download stores so a single bubble shows both kinds,
// bound to browser XHR or desktop-native progress and cancellation.
//
// Per-window + reload survival: the records (minus the live cancel/retry
// handles) plus the bubble's shown/hidden flag persist to sessionStorage keyed
// by sessionWindowId(), mirroring the layout-reload snapshot. A reload destroys
// the in-flight XHR, so on restore an "active" record becomes "interrupted" (a
// terminal state) rather than a frozen progress bar -- never a "42% forever" lie.
// A download can be retried from its persisted source; an upload cannot (the
// File bytes do not survive the reload), so it restores Dismiss-only.

import { sessionWindowId } from "../api/client";

export type TransferKind = "upload" | "download";

/// active: started by this window and not yet settled, whether the server is
/// running it or holding it. done/cancelled/failed: terminal, this session.
/// interrupted: was in flight when the window reloaded -- the XHR is gone.
///
/// There is no "queued" state here. Admission belongs to the server, and the
/// browser must not decide who may start; the server's view of a transfer
/// arrives separately in `queue` below.
export type TransferState =
  | "active"
  | "done"
  | "cancelled"
  | "failed"
  | "interrupted";

/// The server's admission state for one transfer, as reported over `/ws`.
///
/// Keeping this is not the browser deciding admission. A local record of "this
/// transfer exists and is in flight" is not an admission decision; computing
/// who may start is, and the browser no longer does that. This field only
/// mirrors what the server said.
///
/// `position` is a rank among the WAITING transfers of the same tenant, so
/// `position: 1` means "next among mine", never "next to run on this server":
/// dequeue order is FIFO across tenants, and a window can sit at 1 while
/// another tenant's work runs ahead. It is null while running, matching the
/// wire frame, which omits the field entirely rather than sending zero or null.
/// A rank is not monotonic: it can jump by more than one when a sibling of the
/// same tenant is cancelled, and it can rise again if a job is requeued.
export interface TransferQueue {
  state: "waiting" | "active";
  position: number | null;
}

export interface Transfer {
  id: string;
  kind: TransferKind;
  /// Display name: a single file's name, or "N files" for a multi-file upload.
  filename: string;
  /// 0..1 while a content-length is known; null for an indeterminate transfer.
  progress: number | null;
  state: TransferState;
  error: string | null;
  /// Download success: the saved path (shown in the done row). null otherwise.
  savedPath: string | null;
  /// A download's source, persisted so an interrupted download can be retried
  /// after a reload. null for uploads (the File cannot be persisted).
  source: { path: string; isDir: boolean } | null;
  /// Live abort handle, set only while active. NOT persisted.
  cancel: (() => void) | null;
  /// Live retry handle for an interrupted/failed download, reconstructed on
  /// restore from `source`. NOT persisted.
  retry: (() => void) | null;
  /// What the server last said about this transfer's admission, or null when
  /// the server has said nothing. Null is NOT "not queued": a caller that sends
  /// no tracking headers is admitted silently and never receives a frame, and
  /// the SPA's direct download anchors cannot send headers at all. Treat null
  /// as "unknown to us", never as "running" or as "not counted". NOT persisted:
  /// it describes a live server-side job that a reload has already abandoned.
  queue: TransferQueue | null;
}

interface TransfersState {
  items: Transfer[];
  /// The bubble's shown/hidden state (persisted, restored exactly).
  shown: boolean;
}

export const transfers = $state<TransfersState>({ items: [], shown: false });

const STORE_KEY = "chan.transfers";
const PROGRESS_INTERVAL_MS = 100;

/// The states a transfer cannot leave. Used by restore to decide, by exclusion,
/// which records a reload interrupted.
const TERMINAL_STATES: readonly TransferState[] = [
  "done",
  "cancelled",
  "failed",
  "interrupted",
];

function storeKey(): string {
  return `${STORE_KEY}:${sessionWindowId()}`;
}

/// The persisted shape: records without the live handles, plus shown/hidden.
interface PersistedTransfer {
  id: string;
  kind: TransferKind;
  filename: string;
  progress: number | null;
  state: TransferState;
  error: string | null;
  savedPath: string | null;
  source: { path: string; isDir: boolean } | null;
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    const payload = {
      items: transfers.items.map(
        (t): PersistedTransfer => ({
          id: t.id,
          kind: t.kind,
          filename: t.filename,
          progress: t.progress,
          state: t.state,
          error: t.error,
          savedPath: t.savedPath,
          source: t.source,
        }),
      ),
      shown: transfers.shown,
    };
    window.sessionStorage.setItem(storeKey(), JSON.stringify(payload));
  } catch {
    // sessionStorage unavailable / quota: the bubble degrades to in-memory.
  }
}

let nextId = 1;

/// Transfer ids are scoped by window, because they are the ONLY key an
/// admission frame can be matched on: the frame carries no path or filename,
/// and its `window_id` is caller-asserted, so it cannot be used to disambiguate
/// a collision. A bare per-window counter would hand every window the same
/// `xfer-1`, and any frame that reached this socket for someone else's
/// `xfer-1` would land on ours and show a stranger's rank. Scoping the id makes
/// that impossible to express rather than merely unlikely, so an unrelated
/// frame falls into the unknown-id path and is dropped.
///
/// This is misattribution hardening, not a security boundary: `/ws` already
/// sits behind the per-launch bearer, and anyone able to assert a window id
/// already holds it.
function transferId(): string {
  return `xfer-${sessionWindowId()}-${nextId++}`;
}

function find(id: string): Transfer | undefined {
  return transfers.items.find((t) => t.id === id);
}

function occupiesWindow(t: Transfer): boolean {
  return t.state === "active";
}

/// The count of in-flight transfers in THIS window -- the per-window
/// active-transfer signal the desktop close guard queries (over /ws). A window
/// with a non-zero count must not close silently.
export function activeTransferCount(): number {
  return transfers.items.filter(occupiesWindow).length;
}

/// The sink that pushes the active-transfer count to the server over the window
/// `/ws` ({"type":"transfers","active":<n>}). `store` registers it against the
/// watch socket; we call it whenever the count could change. null in tests / on
/// a surface with no watch socket.
let signalSink: ((active: number) => void) | null = null;

export function setTransferSignalSink(sink: ((active: number) => void) | null): void {
  signalSink = sink;
}

function emitSignal(): void {
  signalSink?.(activeTransferCount());
}

/// Start tracking a transfer; returns its id. It starts active because the
/// window has started it; whether the server runs it immediately or holds it is
/// the server's call and arrives later in `queue`. `source` lets an interrupted
/// download retry.
export function beginTransfer(opts: {
  kind: TransferKind;
  filename: string;
  cancel: (() => void) | null;
  source?: { path: string; isDir: boolean } | null;
}): string {
  const id = transferId();
  const state: TransferState = "active";
  const cancel = (): void => {
    opts.cancel?.();
    cancelTransfer(id);
  };
  transfers.items.push({
    id,
    kind: opts.kind,
    filename: opts.filename,
    progress: null,
    state,
    error: null,
    savedPath: null,
    source: opts.source ?? null,
    cancel,
    retry: null,
    queue: null,
  });
  persist();
  emitSignal();
  return id;
}

/// Whether a just-begun transfer should still be issued. It no longer waits
/// for anything: the server owns admission, so the request goes out immediately
/// and the server holds it if it must. What remains is the one race this
/// guarded all along, a transfer cancelled or dismissed between `beginTransfer`
/// and the request leaving, which callers already handle by bailing on false.
///
/// The name is kept because renaming it would mean editing call sites in files
/// this lane does not own.
export function waitForTransferSlot(id: string): Promise<boolean> {
  return Promise.resolve(find(id)?.state === "active");
}

/// Apply one server admission frame. Keyed by `transfer_id` alone: the frame
/// carries no path, filename, or content, so the label always comes from our
/// own record. An unknown id is dropped, which is what an untracked or
/// already-settled transfer looks like from here.
///
/// This deliberately does NOT check `window_id`, for two reasons that point the
/// same way. Routing to a single window is the server's job, so re-checking it
/// here would be client-side filtering dressed up as isolation. And the id is
/// caller-asserted and validated by nobody at either end: it is a routing key,
/// not an authorization claim, so a check here would read as an authority
/// boundary while buying none. The field is part of the wire shape and is
/// pinned by the tests; it is not an input to any decision made here.
export function applyTransferQueueFrame(frame: {
  transfer_id: string;
  state: "waiting" | "active";
  position?: number;
}): void {
  const transfer = find(frame.transfer_id);
  if (!transfer || transfer.state !== "active") return;
  transfer.queue = {
    state: frame.state,
    // Absent means running, and the contract sends no field at all rather than
    // zero or null. Anything non-numeric is treated as absent so a wire change
    // degrades to "no rank shown" instead of rendering 0 or NaN.
    position:
      frame.state === "waiting" && typeof frame.position === "number"
        ? frame.position
        : null,
  };
}

type PendingProgress = {
  value: number | null;
  timer: ReturnType<typeof setTimeout>;
};
const pendingProgress = new Map<string, PendingProgress>();
const lastProgressAt = new Map<string, number>();
let progressPersistTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleProgressPersist(): void {
  if (progressPersistTimer !== null) return;
  progressPersistTimer = setTimeout(() => {
    progressPersistTimer = null;
    persist();
  }, PROGRESS_INTERVAL_MS);
}

/// Diagnostic tick for the browser smoke's coalescing assertion: one
/// increment per applied progress render, so the check can bound the
/// rendered update count against the coalescing window. The app itself
/// never reads it.
function noteProgressApplied(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __chanTransferApplies?: number };
  w.__chanTransferApplies = (w.__chanTransferApplies ?? 0) + 1;
}

function applyProgress(id: string, progress: number | null): void {
  const transfer = find(id);
  if (!transfer || transfer.state !== "active") return;
  transfer.progress = progress;
  noteProgressApplied();
  lastProgressAt.set(id, Date.now());
  scheduleProgressPersist();
}

export function setTransferProgress(id: string, progress: number | null): void {
  const transfer = find(id);
  if (!transfer || transfer.state !== "active") return;
  const normalized =
    progress === null ? null : Math.min(1, Math.max(0, progress));
  const last = lastProgressAt.get(id);
  const elapsed = last === undefined ? PROGRESS_INTERVAL_MS : Date.now() - last;
  if (elapsed >= PROGRESS_INTERVAL_MS) {
    const pending = pendingProgress.get(id);
    if (pending) clearTimeout(pending.timer);
    pendingProgress.delete(id);
    applyProgress(id, normalized);
    return;
  }
  const existing = pendingProgress.get(id);
  if (existing) {
    existing.value = normalized;
    return;
  }
  const timer = setTimeout(() => {
    const pending = pendingProgress.get(id);
    pendingProgress.delete(id);
    if (pending) applyProgress(id, pending.value);
  }, PROGRESS_INTERVAL_MS - elapsed);
  pendingProgress.set(id, { value: normalized, timer });
}

function clearProgressScheduling(id: string): void {
  const pending = pendingProgress.get(id);
  if (pending) clearTimeout(pending.timer);
  pendingProgress.delete(id);
  lastProgressAt.delete(id);
}

export function finishTransfer(id: string, savedPath: string | null = null): void {
  const t = find(id);
  if (!t) return;
  clearProgressScheduling(id);
  t.state = "done";
  t.progress = 1;
  t.cancel = null;
  t.retry = null;
  t.savedPath = savedPath;
  t.queue = null;
  persist();
  emitSignal();
}

export function cancelTransfer(id: string): void {
  const t = find(id);
  if (!t) return;
  clearProgressScheduling(id);
  t.state = "cancelled";
  t.cancel = null;
  t.queue = null;
  persist();
  emitSignal();
}

export function failTransfer(
  id: string,
  error: string,
  retry: (() => void) | null = null,
): void {
  const t = find(id);
  if (!t) return;
  clearProgressScheduling(id);
  t.state = "failed";
  t.cancel = null;
  t.error = error;
  t.retry = retry;
  t.queue = null;
  persist();
  emitSignal();
}

/// Remove a terminal transfer row (the bubble's per-row dismiss).
export function dismissTransfer(id: string): void {
  const i = transfers.items.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [removed] = transfers.items.slice(i, i + 1);
  if (!removed) return;
  clearProgressScheduling(id);
  transfers.items.splice(i, 1);
  persist();
  emitSignal();
}

export function showTransfers(): void {
  transfers.shown = true;
  persist();
}

export function hideTransfers(): void {
  transfers.shown = false;
  persist();
}

export function toggleTransfers(): void {
  transfers.shown = !transfers.shown;
  persist();
}

/// Restore the persisted bubble on boot. Terminal states restore exactly; an
/// "active" record (its XHR died with the reload) restores as "interrupted".
/// `reconstructDownloadRetry` rebuilds the retry handle for an interrupted
/// download from its source (uploads get none -- the File is gone).
export function restoreTransfers(
  reconstructDownloadRetry: (source: { path: string; isDir: boolean }) => () => void,
): void {
  if (typeof window === "undefined") return;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(storeKey());
  } catch {
    return;
  }
  if (!raw) return;
  let parsed: { items?: PersistedTransfer[]; shown?: boolean };
  try {
    parsed = JSON.parse(raw) as { items?: PersistedTransfer[]; shown?: boolean };
  } catch {
    return;
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  transfers.items = items.map((p): Transfer => {
    // Anything that had not reached a terminal state when the window died is
    // interrupted, tested by exclusion rather than by listing the live states.
    // A persisted value this build no longer produces therefore restores as
    // interrupted instead of surviving as a state the union cannot express.
    const interrupted = !TERMINAL_STATES.includes(p.state);
    const state: TransferState = interrupted ? "interrupted" : p.state;
    const retry =
      (interrupted || p.state === "failed") && p.kind === "download" && p.source
        ? reconstructDownloadRetry(p.source)
        : null;
    return {
      id: p.id,
      kind: p.kind,
      filename: p.filename,
      // An interrupted transfer has no meaningful progress; drop the stale
      // fraction so the bar never shows a frozen mid-transfer value.
      progress: interrupted ? null : p.progress,
      state,
      error: p.error,
      savedPath: p.savedPath,
      source: p.source,
      cancel: null,
      retry,
      // A reload abandoned whatever the server was doing, so any rank we held
      // is stale by definition.
      queue: null,
    };
  });
  transfers.shown = parsed.shown === true;
  // After a reload every record is terminal/interrupted (count 0), but emit so
  // the server's per-socket count is correct from the first announce.
  emitSignal();
}

export function cancelAllTransfers(): void {
  for (const transfer of [...transfers.items]) {
    if (occupiesWindow(transfer)) transfer.cancel?.();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", cancelAllTransfers);
}
