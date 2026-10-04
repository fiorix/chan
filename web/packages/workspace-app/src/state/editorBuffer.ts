/// Editor hang-recovery via localStorage.
///
/// Persists unsaved editor content so a forced reload (the SPA hangs
/// and the user closes-and-reopens the window) doesn't lose unsaved
/// data. The mechanism:
///
///   * On every editor mutation (debounced ~500ms),
///     `queueBufferWrite(key, content, path)` stores
///     `{ content, updatedAt, path, sessionId }` under
///     `chan:editor-buffer:<key>`.
///   * On editor mount, `divergentBufferOrNull` compares any stored
///     buffer to the on-disk content and surfaces a restore banner
///     only when the buffer represents recoverable work.
///   * On save / clean transition / discard, `clearEditorBuffer(key)`
///     removes the entry.
///   * On app load, `pruneEditorBuffers()` evicts entries past the TTL
///     and total-size cap.
///
/// Buffers are keyed on the workspace root plus the file's workspace-
/// relative path, not the in-memory tab id: tab ids are regenerated on
/// every page load, so a path key is what survives the reload the
/// recovery exists for, and the root scopes it so two workspaces with a
/// same-relative-path file (e.g. README.md) do not share one buffer.
///
/// Restore eligibility turns on `sessionId`. Each page load gets a
/// fresh SESSION_ID; a buffer carries the id of the load that wrote
/// it. The user's own live edits remount the tab without reloading the
/// page, so their buffer always matches the current SESSION_ID and is
/// treated as live (no banner). Only a buffer left by a DIFFERENT load
/// (the crash-then-reload case) is offered for restore.
///
/// localStorage SSR-safety: every entry point gates on
/// `typeof localStorage !== "undefined"` so unit tests (vitest node
/// env) and SSR builds don't blow up; they return null / no-op when
/// storage is unavailable.
///
/// Two tabs open against the same path share a buffer key. That is
/// acceptable: same file, same unsaved-content semantic, and whoever
/// mounts first reads the banner.

import { workspace } from "./workspace.svelte";
import { isStorageAvailable } from "./storage";

const BUFFER_KEY_PREFIX = "chan:editor-buffer:";
/// 7-day TTL. Stale buffers from forgotten tabs evict on the next page
/// load so localStorage doesn't accumulate forever.
const MAX_BUFFER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/// 10MB total cap across all editor buffers. localStorage quota is
/// typically 5-10MB per origin; staying under the lower bound avoids
/// quota errors on busy tabs.
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/// Identity of the current page load. Regenerated on every reload,
/// which is exactly the boundary recovery cares about: a buffer whose
/// sessionId differs from this one was stranded by an earlier load.
export const SESSION_ID: string = newSessionId();

function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without Web Crypto. Uniqueness only has
  // to hold within one origin across reloads, which are far more than
  // a millisecond apart in practice.
  return `session-${Date.now()}`;
}

export interface EditorBuffer {
  /// Unsaved content as of the last debounced write.
  content: string;
  /// Wall-clock ms since epoch of the last write. Drives TTL eviction
  /// and the size cap's oldest-first order.
  updatedAt: number;
  /// Workspace-relative path of the tab when the buffer was written.
  /// Guards against restoring one file's content into a different
  /// file that happens to reuse the storage key.
  path: string;
  /// SESSION_ID of the page load that wrote this buffer. Separates the
  /// user's own live edits (same session) from content stranded by a
  /// crashed earlier load (different session).
  sessionId: string;
}

const STORAGE_PROBE_KEY = "__chan_editor_buffer_probe__";

/// Queued-write registry. Each `queueBufferWrite` call replaces the
/// pending write for that key; `flushPendingBufferWrites` (invoked from
/// a `beforeunload` / `pagehide` handler) drains it synchronously so a
/// force-reload keeps the last 500ms of edits.
///
/// The debounce lives here rather than in the FileEditorTab component
/// so the flush can run independently of Svelte's component teardown,
/// which `window.location.reload()` skips.
interface PendingWrite {
  content: string;
  path: string;
  timer: ReturnType<typeof setTimeout> | null;
}
const pendingWrites = new Map<string, PendingWrite>();

const QUEUED_WRITE_DEBOUNCE_MS = 500;

/// Schedule a debounced buffer write for `key`. Calling repeatedly for
/// the same key cancels the prior timer and reschedules with the
/// latest content. The callback writes via `writeEditorBuffer` so the
/// quota retry and SSR-safety behave identically to a direct call.
export function queueBufferWrite(
  key: string,
  content: string,
  path: string,
): void {
  const existing = pendingWrites.get(key);
  if (existing?.timer !== null && existing?.timer !== undefined) {
    clearTimeout(existing.timer);
  }
  const entry: PendingWrite = { content, path, timer: null };
  pendingWrites.set(key, entry);
  entry.timer = setTimeout(() => {
    writeEditorBuffer(key, entry.content, entry.path);
    pendingWrites.delete(key);
  }, QUEUED_WRITE_DEBOUNCE_MS);
}

/// Cancel any pending debounced write for `key`. Used on graceful tab
/// close (Cmd+W) and when the editor transitions back to clean state.
export function cancelPendingBufferWrite(key: string): void {
  const entry = pendingWrites.get(key);
  if (entry?.timer !== null && entry?.timer !== undefined) {
    clearTimeout(entry.timer);
  }
  pendingWrites.delete(key);
}

/// Synchronously flush every pending debounced write, for the
/// `beforeunload` / `pagehide` handlers so a force-reload persists
/// in-flight buffers before the page tears down. Returns the number of
/// entries flushed.
export function flushPendingBufferWrites(): number {
  let flushed = 0;
  for (const [key, entry] of pendingWrites) {
    if (entry.timer !== null) clearTimeout(entry.timer);
    writeEditorBuffer(key, entry.content, entry.path);
    flushed += 1;
  }
  pendingWrites.clear();
  return flushed;
}

export function bufferKey(key: string): string {
  // Namespace by the workspace root so two workspaces with a file at the
  // same relative path (e.g. README.md) do not collide on one recovery
  // buffer. When no workspace is mounted yet (boot / SSR / unit tests)
  // there is no editing in flight, so fall back to the un-namespaced key.
  const root = workspace.info?.root;
  return root
    ? `${BUFFER_KEY_PREFIX}${root}:${key}`
    : `${BUFFER_KEY_PREFIX}${key}`;
}

export function writeEditorBuffer(
  key: string,
  content: string,
  path: string,
): void {
  if (!isStorageAvailable(STORAGE_PROBE_KEY)) return;
  const entry: EditorBuffer = {
    content,
    updatedAt: Date.now(),
    path,
    sessionId: SESSION_ID,
  };
  try {
    localStorage.setItem(bufferKey(key), JSON.stringify(entry));
  } catch (e) {
    // Quota exceeded or other storage error. Prune-then-retry once;
    // throwing in the editor mutation path is worse than losing the
    // buffer, so give up silently if the retry also fails.
    pruneEditorBuffers();
    try {
      localStorage.setItem(bufferKey(key), JSON.stringify(entry));
    } catch {
      console.warn("[chan] editorBuffer: storage write failed", e);
    }
  }
}

export function readEditorBuffer(key: string): EditorBuffer | null {
  if (!isStorageAvailable(STORAGE_PROBE_KEY)) return null;
  const raw = localStorage.getItem(bufferKey(key));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EditorBuffer>;
    if (
      typeof parsed?.content !== "string" ||
      typeof parsed?.updatedAt !== "number" ||
      typeof parsed?.path !== "string" ||
      typeof parsed?.sessionId !== "string"
    ) {
      // Malformed or hand-edited entry. Clear it so the editor never
      // tries to restore garbage.
      localStorage.removeItem(bufferKey(key));
      return null;
    }
    return {
      content: parsed.content,
      updatedAt: parsed.updatedAt,
      path: parsed.path,
      sessionId: parsed.sessionId,
    };
  } catch {
    localStorage.removeItem(bufferKey(key));
    return null;
  }
}

export function clearEditorBuffer(key: string): void {
  if (!isStorageAvailable(STORAGE_PROBE_KEY)) return;
  localStorage.removeItem(bufferKey(key));
}

/// Eviction sweep. Runs at app load and on a quota-exceeded write
/// retry. Two passes:
///
///   1. TTL: drop entries older than MAX_BUFFER_AGE_MS.
///   2. Size cap: if remaining entries exceed MAX_BUFFER_BYTES total,
///      drop oldest-first until under the cap.
///
/// Returns the number of evicted entries (for tests and ops telemetry).
export function pruneEditorBuffers(): number {
  if (!isStorageAvailable(STORAGE_PROBE_KEY)) return 0;
  const now = Date.now();
  const entries: Array<{ key: string; updatedAt: number; bytes: number }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(BUFFER_KEY_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<EditorBuffer>;
      if (typeof parsed?.updatedAt !== "number") continue;
      entries.push({ key, updatedAt: parsed.updatedAt, bytes: raw.length });
    } catch {
      // Corrupt entry counts as immediately-evictable.
      entries.push({ key, updatedAt: 0, bytes: raw.length });
    }
  }
  let evicted = 0;
  // Pass 1: TTL.
  for (const e of entries) {
    if (now - e.updatedAt > MAX_BUFFER_AGE_MS) {
      localStorage.removeItem(e.key);
      evicted += 1;
    }
  }
  // Pass 2: size cap (oldest-first eviction).
  const remaining = entries.filter((e) => now - e.updatedAt <= MAX_BUFFER_AGE_MS);
  let totalBytes = remaining.reduce((sum, e) => sum + e.bytes, 0);
  if (totalBytes <= MAX_BUFFER_BYTES) return evicted;
  remaining.sort((a, b) => a.updatedAt - b.updatedAt);
  for (const e of remaining) {
    if (totalBytes <= MAX_BUFFER_BYTES) break;
    localStorage.removeItem(e.key);
    totalBytes -= e.bytes;
    evicted += 1;
  }
  return evicted;
}

/// Decide whether a stored buffer should surface the restore banner.
/// Returns the buffer only when it is recoverable work from an earlier
/// load; returns null otherwise, and clears an entry stored for another
/// path.
///
/// A buffer is offered only when ALL hold:
///   * its path matches the current tab (not stale wrong-file content),
///   * it came from a DIFFERENT page load (own-session edits are live,
///     already in the editor, never a recovery candidate),
///   * its content diverges from disk (nothing to recover otherwise).
///
/// A buffer is stale only once the file holds what it holds, so the
/// file's mtime is not compared with the buffer's stamp. A write after
/// the stamp need not carry the buffer's last change: a peer's edit, a
/// scene session's write at its last detach, and a save of older content
/// still on the wire all land after it, and the page's clock and the
/// file's may be two machines'.
export function divergentBufferOrNull(
  key: string,
  tabPath: string,
  diskContent: string,
): EditorBuffer | null {
  const buf = readEditorBuffer(key);
  if (!buf) return null;
  if (buf.path !== tabPath) {
    clearEditorBuffer(key);
    return null;
  }
  if (buf.sessionId === SESSION_ID) return null;
  if (buf.content === diskContent) return null;
  return buf;
}
