/// Terminal scrollback snapshot cache.
///
/// Persists a bounded SerializeAddon ANSI snapshot of a terminal's screen +
/// scrollback so a reload restores it INSTANTLY from localStorage and the
/// server only streams the delta since the cached byte cursor, instead of
/// retransmitting its whole replay ring. The mechanism:
///
///   * On pagehide (and tab teardown), `writeTerminalSnapshot` stores
///     `{ ansi, generation, lastSeq, cols, rows, updatedAt }` under
///     `chan:term-snapshot:<sessionId>`.
///   * On (re)attach, `readTerminalSnapshot` primes the fresh xterm from the
///     ANSI and the client sends `?since=<lastSeq>&generation=<generation>`;
///     the server honors the cursor only when the generation still matches.
///   * On app load, `pruneTerminalSnapshots` evicts entries past the TTL and
///     the total-size cap.
///
/// Keyed by the SERVER session id (the durable PTY handle), with the session
/// `generation` epoch INSIDE the value: a restart reuses the id but bumps the
/// generation and resets the ring, so a generation mismatch on reattach (or a
/// `missed_bytes > 0`) invalidates the snapshot and falls back to a full replay.
///
/// Bounded to coexist with the editor stores in the ~5-10MB per-origin WebView
/// budget (editor `chan:editor-buffer:` ~10MB + `chan:caret-index:` 256KB):
/// prefix `chan:term-snapshot:`, 512KB total (oldest-first eviction over its OWN
/// prefix only), ~128KB per snapshot, 3-day TTL. This is NOT a running raw-byte
/// cache -- exactly one snapshot is written per terminal per pagehide.
///
/// localStorage SSR-safety mirrors editorBuffer.ts: every entry point gates on
/// storage availability so unit tests (vitest node env) and SSR no-op.

const SNAPSHOT_KEY_PREFIX = "chan:term-snapshot:";
/// 3-day TTL. A snapshot older than this almost always fails the generation
/// guard on reattach anyway (the PTY moved on or the server restarted), so a
/// short TTL keeps the largest of the three localStorage stores lean.
const MAX_SNAPSHOT_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/// 512KB total across every terminal snapshot.
/// localStorage is ~5-10MB per origin; the editor stores own the bulk, so this
/// stays well under the remaining headroom.
const MAX_SNAPSHOT_TOTAL_BYTES = 512 * 1024;
/// ~128KB per snapshot. A bigger capture is dropped (the reattach takes the
/// full-replay fallback) rather than evicting several other terminals' caches.
export const MAX_ONE_SNAPSHOT_BYTES = 128 * 1024;
/// Scrollback lines captured into a snapshot. The visible screen plus a modest
/// tail is enough to "reload the screen correctly"; deeper history (beyond this
/// and beyond the 1 MiB server ring) is not restored. Kept small so the
/// serialized ANSI stays under MAX_ONE_SNAPSHOT_BYTES for a typical terminal.
export const SNAPSHOT_SCROLLBACK_LINES = 1000;

export interface TerminalSnapshot {
  /// SerializeAddon ANSI dump of the current screen + bounded scrollback.
  ansi: string;
  /// The session generation epoch this snapshot belongs to. The reattach sends
  /// it as `?generation=`; the server replays the delta only when it matches.
  generation: number;
  /// Server byte offset (`seq`) the client had consumed at capture. The
  /// reattach resumes from here via `?since=`.
  lastSeq: number;
  /// xterm geometry at capture. The snapshot is reused only when these still
  /// match the live terminal -- a serialized screen written into a different
  /// width reflows wrong (absolute cursor + hard-wrap baked at the old cols).
  cols: number;
  rows: number;
  /// Wall-clock ms of the write, for TTL + oldest-first eviction.
  updatedAt: number;
}

/// chan-server's locked DEVSERVER_TOKEN_MARKER wire string. A snapshot
/// carrying it is a devserver credential at rest, not a cache entry: the
/// control terminal's scrollback always contains this line (the desktop
/// re-scrapes it on every connect), and pre-guard builds snapshotted that
/// scrollback like any other terminal's. The envelopes carry no control
/// flag, so the marker is what identifies them; the sweep drops any such
/// entry unconditionally, which also covers a connect script run by hand
/// in a regular terminal.
export const DEVSERVER_TOKEN_MARKER = "CHAN_DEVSERVER_TOKEN=";

function snapshotKey(sessionId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${sessionId}`;
}

function isStorageAvailable(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const probe = "__chan_term_snapshot_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/// Persist a terminal's snapshot. A capture larger than the per-snapshot cap is
/// dropped (the reattach then takes the full-replay fallback) rather than
/// starving the other stores. On a quota error, prune-then-retry once, then
/// give up silently -- losing a snapshot only costs one un-optimized reload.
export function writeTerminalSnapshot(
  sessionId: string,
  snapshot: TerminalSnapshot,
): void {
  if (!isStorageAvailable() || !sessionId) return;
  if (snapshot.ansi.length > MAX_ONE_SNAPSHOT_BYTES) return;
  const raw = JSON.stringify(snapshot);
  try {
    localStorage.setItem(snapshotKey(sessionId), raw);
  } catch (e) {
    pruneTerminalSnapshots();
    try {
      localStorage.setItem(snapshotKey(sessionId), raw);
    } catch {
      console.warn("[chan] snapshotCache: storage write failed", e);
    }
  }
}

export function readTerminalSnapshot(
  sessionId: string,
): TerminalSnapshot | null {
  if (!isStorageAvailable() || !sessionId) return null;
  const raw = localStorage.getItem(snapshotKey(sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TerminalSnapshot>;
    if (
      typeof parsed?.ansi !== "string" ||
      typeof parsed?.generation !== "number" ||
      typeof parsed?.lastSeq !== "number" ||
      typeof parsed?.cols !== "number" ||
      typeof parsed?.rows !== "number" ||
      typeof parsed?.updatedAt !== "number"
    ) {
      localStorage.removeItem(snapshotKey(sessionId));
      return null;
    }
    return {
      ansi: parsed.ansi,
      generation: parsed.generation,
      lastSeq: parsed.lastSeq,
      cols: parsed.cols,
      rows: parsed.rows,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    localStorage.removeItem(snapshotKey(sessionId));
    return null;
  }
}

export function clearTerminalSnapshot(sessionId: string): void {
  if (!isStorageAvailable() || !sessionId) return;
  localStorage.removeItem(snapshotKey(sessionId));
}

/// Eviction sweep, run at app load and on a quota-exceeded write retry. Three
/// passes, touching ONLY `chan:term-snapshot:` keys (never the editor stores):
///
///   1. Credential: drop any entry containing the devserver token marker,
///      regardless of age (pre-guard control-terminal snapshots; see
///      DEVSERVER_TOKEN_MARKER above).
///   2. TTL: drop entries older than MAX_SNAPSHOT_AGE_MS.
///   3. Size cap: if the rest exceed MAX_SNAPSHOT_TOTAL_BYTES, drop oldest-first
///      until under the cap.
///
/// Returns the number of evicted entries.
export function pruneTerminalSnapshots(): number {
  if (!isStorageAvailable()) return 0;
  const now = Date.now();
  const entries: Array<{
    key: string;
    updatedAt: number;
    bytes: number;
    carriesToken: boolean;
  }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(SNAPSHOT_KEY_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    const carriesToken = raw.includes(DEVSERVER_TOKEN_MARKER);
    try {
      const parsed = JSON.parse(raw) as Partial<TerminalSnapshot>;
      if (typeof parsed?.updatedAt !== "number" && !carriesToken) continue;
      entries.push({
        key,
        updatedAt: typeof parsed?.updatedAt === "number" ? parsed.updatedAt : 0,
        bytes: raw.length,
        carriesToken,
      });
    } catch {
      entries.push({ key, updatedAt: 0, bytes: raw.length, carriesToken });
    }
  }
  let evicted = 0;
  for (const e of entries) {
    if (e.carriesToken || now - e.updatedAt > MAX_SNAPSHOT_AGE_MS) {
      localStorage.removeItem(e.key);
      evicted += 1;
    }
  }
  const remaining = entries.filter(
    (e) => !e.carriesToken && now - e.updatedAt <= MAX_SNAPSHOT_AGE_MS,
  );
  let totalBytes = remaining.reduce((sum, e) => sum + e.bytes, 0);
  if (totalBytes <= MAX_SNAPSHOT_TOTAL_BYTES) return evicted;
  remaining.sort((a, b) => a.updatedAt - b.updatedAt);
  for (const e of remaining) {
    if (totalBytes <= MAX_SNAPSHOT_TOTAL_BYTES) break;
    localStorage.removeItem(e.key);
    totalBytes -= e.bytes;
    evicted += 1;
  }
  return evicted;
}
