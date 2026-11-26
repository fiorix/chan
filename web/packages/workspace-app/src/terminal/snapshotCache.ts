/// The terminal scrollback snapshots older builds kept in localStorage.
///
/// Those builds wrote one ANSI dump of a terminal's screen per session under
/// `chan:term-snapshot:<sessionId>` at page hide and primed a reattach from
/// it. Nothing reads or writes them now: a reattach paints from the server's
/// replay ring. An entry can still sit in a user's store for days, and one a
/// control terminal wrote holds the devserver token, so the app removes every
/// one at load.

const SNAPSHOT_KEY_PREFIX = "chan:term-snapshot:";

/// Removes every `chan:term-snapshot:` entry from localStorage and touches no
/// other key. The keys are collected first and removed after, since removing
/// during a `localStorage.key(i)` walk shifts the indices and skips entries.
/// A missing store, or one that throws, leaves the load alone: a walk that
/// throws removes what it collected, and a key that fails to go does not stop
/// the others.
export function sweepTerminalSnapshots(): void {
  const keys: string[] = [];
  try {
    if (typeof localStorage === "undefined") return;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SNAPSHOT_KEY_PREFIX)) keys.push(key);
    }
  } catch {
    // Remove what the walk collected.
  }
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      // The next load sweeps again.
    }
  }
}
