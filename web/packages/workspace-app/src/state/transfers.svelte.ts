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

/// queued: waiting for this window's kind-specific concurrency slot.
/// active: in flight. done/cancelled/failed: terminal, this session.
/// interrupted: was in flight when the window reloaded -- the XHR is gone.
export type TransferState =
  | "queued"
  | "active"
  | "done"
  | "cancelled"
  | "failed"
  | "interrupted";

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
}

interface TransfersState {
  items: Transfer[];
  /// The bubble's shown/hidden state (persisted, restored exactly).
  shown: boolean;
}

export const transfers = $state<TransfersState>({ items: [], shown: false });

const STORE_KEY = "chan.transfers";
const MAX_ACTIVE_DOWNLOADS = 2;
const MAX_ACTIVE_UPLOADS = 1;
const PROGRESS_INTERVAL_MS = 100;

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
function transferId(): string {
  return `xfer-${nextId++}`;
}

function find(id: string): Transfer | undefined {
  return transfers.items.find((t) => t.id === id);
}

function occupiesWindow(t: Transfer): boolean {
  return t.state === "queued" || t.state === "active";
}

function activeOfKind(kind: TransferKind): number {
  return transfers.items.filter((t) => t.kind === kind && t.state === "active").length;
}

function hasSlot(kind: TransferKind): boolean {
  const limit = kind === "download" ? MAX_ACTIVE_DOWNLOADS : MAX_ACTIVE_UPLOADS;
  return activeOfKind(kind) < limit;
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

/// Start tracking a transfer; returns its id. It starts active when its
/// kind-specific window has capacity, otherwise remains visibly queued until
/// an older peer settles. `source` lets an interrupted download retry.
export function beginTransfer(opts: {
  kind: TransferKind;
  filename: string;
  cancel: (() => void) | null;
  source?: { path: string; isDir: boolean } | null;
}): string {
  const id = transferId();
  const state: TransferState = hasSlot(opts.kind) ? "active" : "queued";
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
  });
  persist();
  emitSignal();
  return id;
}

const slotWaiters = new Map<string, (started: boolean) => void>();

function resolveSlotWaiter(id: string, started: boolean): void {
  const resolve = slotWaiters.get(id);
  slotWaiters.delete(id);
  resolve?.(started);
}

export function waitForTransferSlot(id: string): Promise<boolean> {
  const transfer = find(id);
  if (!transfer) return Promise.resolve(false);
  if (transfer.state === "active") return Promise.resolve(true);
  if (transfer.state !== "queued") return Promise.resolve(false);
  return new Promise<boolean>((resolve) => slotWaiters.set(id, resolve)).then(
    (started) => started && find(id)?.state === "active",
  );
}

function drainQueue(kind: TransferKind): void {
  let changed = false;
  while (hasSlot(kind)) {
    const next = transfers.items.find(
      (transfer) => transfer.kind === kind && transfer.state === "queued",
    );
    if (!next) break;
    next.state = "active";
    resolveSlotWaiter(next.id, true);
    changed = true;
  }
  if (changed) {
    persist();
    emitSignal();
  }
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
  const kind = t.kind;
  clearProgressScheduling(id);
  t.state = "done";
  t.progress = 1;
  t.cancel = null;
  t.retry = null;
  t.savedPath = savedPath;
  persist();
  emitSignal();
  drainQueue(kind);
}

export function cancelTransfer(id: string): void {
  const t = find(id);
  if (!t) return;
  const kind = t.kind;
  clearProgressScheduling(id);
  resolveSlotWaiter(id, false);
  t.state = "cancelled";
  t.cancel = null;
  persist();
  emitSignal();
  drainQueue(kind);
}

export function failTransfer(
  id: string,
  error: string,
  retry: (() => void) | null = null,
): void {
  const t = find(id);
  if (!t) return;
  const kind = t.kind;
  clearProgressScheduling(id);
  resolveSlotWaiter(id, false);
  t.state = "failed";
  t.cancel = null;
  t.error = error;
  t.retry = retry;
  persist();
  emitSignal();
  drainQueue(kind);
}

/// Remove a terminal transfer row (the bubble's per-row dismiss).
export function dismissTransfer(id: string): void {
  const i = transfers.items.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [removed] = transfers.items.slice(i, i + 1);
  if (!removed) return;
  clearProgressScheduling(id);
  resolveSlotWaiter(id, false);
  transfers.items.splice(i, 1);
  persist();
  emitSignal();
  drainQueue(removed.kind);
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
    const interrupted = p.state === "active" || p.state === "queued";
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
