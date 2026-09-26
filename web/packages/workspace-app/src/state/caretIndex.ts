/// Persistent per-file caret index.
///
/// Remembers the last caret position (doc offsets) per file so reopening a
/// file -- via a wiki/mention link or a backlink -- lands the caret where you
/// left it instead of at document top. An explicit user open (File-Tree /
/// File-Browser / create / duplicate / `cs open`) deliberately overrides this
/// and lands at top (see OpenFileOptions.landAtTop).
///
/// Keyed on the workspace root plus the file's workspace-relative path, NOT
/// the in-memory tab id (tab ids are regenerated per load), mirroring
/// editorBuffer.ts. A distinct prefix and a small cap keep this from starving
/// the editor-buffer hang-recovery store within the WebView origin's
/// localStorage quota; the terminal-snapshot store caps separately again.
///
/// Best-effort: storage-unavailable, quota, or a missing/malformed entry all
/// fall back to top silently. No migration of older data.
///
/// localStorage SSR-safety: every entry point gates on
/// `typeof localStorage !== "undefined"` so unit tests (vitest node env) and
/// SSR builds no-op instead of throwing.

import { workspace } from "./workspace.svelte";

const CARET_INDEX_PREFIX = "chan:caret-index:";
/// 30-day TTL. Caret memory is worth keeping longer than the 7-day content
/// recovery buffer; a caret older than this is rarely still useful.
const MAX_CARET_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/// 256KB total cap (oldest-first eviction). Entries are tens of bytes, so this
/// holds thousands of files while staying a tiny fraction of the origin quota
/// -- it cannot starve the 10MB editor-buffer store.
const MAX_CARET_BYTES = 256 * 1024;
/// Coalesce caret writes: setTabCaret fires on every selection change (each
/// keystroke / arrow), so debounce to avoid thrashing storage.
const CARET_WRITE_DEBOUNCE_MS = 400;

export interface CaretIndexEntry {
  from: number;
  to: number;
  /// Wall-clock ms of the last write; drives TTL and oldest-first eviction.
  updatedAt: number;
  /// Workspace-relative path, guarding against landing one file's caret in
  /// another that reused the storage key.
  path: string;
}

function isStorageAvailable(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const probe = "__chan_caret_index_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/// The `prefix + root + ":"` namespace for the current workspace, or null when
/// no workspace is mounted yet (boot / SSR / tests). Scoping to the live root
/// keeps two workspaces with a same-relative-path file from sharing a caret
/// and keeps the bulk-ops (clear-under / rekey) confined to this workspace.
function caretKeyPrefix(): string | null {
  const root = workspace.info?.root;
  if (!root) return null;
  return `${CARET_INDEX_PREFIX}${root}:`;
}

function caretKey(path: string): string | null {
  const prefix = caretKeyPrefix();
  return prefix === null ? null : `${prefix}${path}`;
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

/// Amortized eviction. This store is far smaller than the origin quota, so a
/// quota-exceeded write (which triggers a prune) is rarely how it hits its own
/// cap; sweep every Nth write so the 256KB cap is enforced proactively without
/// an app-load hook.
const PRUNE_EVERY_WRITES = 50;
let writesSincePrune = 0;

/// Record (debounced) the caret position for `path`. Coalesces rapid
/// selection changes; the latest position wins. No-ops when no workspace is
/// mounted or storage is unavailable.
export function recordCaret(path: string, from: number, to: number): void {
  const key = caretKey(path);
  if (key === null || !isStorageAvailable()) return;
  const existing = pendingWrites.get(key);
  if (existing !== undefined) clearTimeout(existing);
  pendingWrites.set(
    key,
    setTimeout(() => {
      pendingWrites.delete(key);
      writeCaret(key, path, from, to);
    }, CARET_WRITE_DEBOUNCE_MS),
  );
}

function writeCaret(
  key: string,
  path: string,
  from: number,
  to: number,
): void {
  const entry: CaretIndexEntry = { from, to, updatedAt: Date.now(), path };
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch (e) {
    // Quota exceeded or other storage error. Prune-then-retry once; throwing
    // in the editor selection path is worse than losing a caret.
    pruneCaretIndex();
    writesSincePrune = 0;
    try {
      localStorage.setItem(key, JSON.stringify(entry));
    } catch {
      console.warn("[chan] caretIndex: storage write failed", e);
    }
    return;
  }
  if (++writesSincePrune >= PRUNE_EVERY_WRITES) {
    writesSincePrune = 0;
    pruneCaretIndex();
  }
}

/// Read a file's remembered caret, or null when there is none / storage is
/// unavailable / the entry is malformed or stored for a different path.
export function readCaret(path: string): { from: number; to: number } | null {
  const key = caretKey(path);
  if (key === null || !isStorageAvailable()) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CaretIndexEntry>;
    if (
      typeof parsed?.from !== "number" ||
      typeof parsed?.to !== "number" ||
      typeof parsed?.path !== "string" ||
      parsed.path !== path
    ) {
      localStorage.removeItem(key);
      return null;
    }
    return { from: parsed.from, to: parsed.to };
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

/// Cancel a pending debounced write for a storage key so a clear / rekey is
/// not immediately undone by an in-flight timer.
function cancelPending(key: string): void {
  const t = pendingWrites.get(key);
  if (t !== undefined) {
    clearTimeout(t);
    pendingWrites.delete(key);
  }
}

/// Drop the caret entry for `path` and everything beneath it. `path` alone
/// covers a single-file delete; the `${path}/` prefix covers a directory
/// delete, mirroring the `underDeleted` predicate in the store's
/// settleDeleted.
export function clearCaretsUnder(path: string): void {
  const prefix = caretKeyPrefix();
  if (prefix === null || !isStorageAvailable()) return;
  const dirPrefix = `${path}/`;
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const p = key.slice(prefix.length);
    if (p === path || p.startsWith(dirPrefix)) toRemove.push(key);
  }
  for (const key of toRemove) {
    cancelPending(key);
    localStorage.removeItem(key);
  }
}

/// Move caret entries from `from` to `to` on a rename / move, including
/// descendants for a directory move, so a renamed file keeps its caret and
/// does not orphan a stale entry. Best-effort: a collision at the destination
/// is overwritten by the moved value.
export function rekeyCaret(from: string, to: string): void {
  const prefix = caretKeyPrefix();
  if (prefix === null || !isStorageAvailable()) return;
  const dirPrefix = `${from}/`;
  const moves: Array<{ oldKey: string; newPath: string; raw: string }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const p = key.slice(prefix.length);
    let newPath: string | null = null;
    if (p === from) newPath = to;
    else if (p.startsWith(dirPrefix)) newPath = `${to}/${p.slice(dirPrefix.length)}`;
    if (newPath === null) continue;
    const raw = localStorage.getItem(key);
    if (raw) moves.push({ oldKey: key, newPath, raw });
  }
  for (const { oldKey, newPath, raw } of moves) {
    cancelPending(oldKey);
    localStorage.removeItem(oldKey);
    try {
      const parsed = JSON.parse(raw) as CaretIndexEntry;
      writeCaret(`${prefix}${newPath}`, newPath, parsed.from, parsed.to);
    } catch {
      // Drop a corrupt entry rather than carry it to the new key.
    }
  }
}

/// Eviction sweep over this store's prefix only (never touches the editor
/// buffer or terminal snapshot stores). Runs at app load and on a
/// quota-exceeded write retry. Two passes: TTL, then oldest-first size cap.
/// Returns the number of evicted entries.
export function pruneCaretIndex(): number {
  if (!isStorageAvailable()) return 0;
  const now = Date.now();
  const entries: Array<{ key: string; updatedAt: number; bytes: number }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(CARET_INDEX_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<CaretIndexEntry>;
      if (typeof parsed?.updatedAt !== "number") continue;
      entries.push({ key, updatedAt: parsed.updatedAt, bytes: raw.length });
    } catch {
      entries.push({ key, updatedAt: 0, bytes: raw.length });
    }
  }
  let evicted = 0;
  for (const e of entries) {
    if (now - e.updatedAt > MAX_CARET_AGE_MS) {
      localStorage.removeItem(e.key);
      evicted += 1;
    }
  }
  const remaining = entries.filter((e) => now - e.updatedAt <= MAX_CARET_AGE_MS);
  let totalBytes = remaining.reduce((sum, e) => sum + e.bytes, 0);
  if (totalBytes <= MAX_CARET_BYTES) return evicted;
  remaining.sort((a, b) => a.updatedAt - b.updatedAt);
  for (const e of remaining) {
    if (totalBytes <= MAX_CARET_BYTES) break;
    localStorage.removeItem(e.key);
    totalBytes -= e.bytes;
    evicted += 1;
  }
  return evicted;
}
