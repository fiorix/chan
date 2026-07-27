/// Terminal backend selection + the ghostty-web lazy loader, backing
/// `terminal.ghostty = true`.
///
/// WHY lazy: ghostty-web ships a ~420KB WASM build of Ghostty's VT
/// parser next to its JS. A static import would put that asset on the
/// critical path for every user when the toggle is off by default, so
/// both the library and the wasm URL load through dynamic imports and
/// only ever fetch when a terminal actually spawns with the ghostty
/// backend. Vite emits `ghostty-vt.wasm` as a hashed asset; the `?url`
/// import hands us its served path, which `Ghostty.load` fetches --
/// the library's own default `init()` resolves the wasm relative to
/// import.meta.url, which breaks once everything is bundled, so the
/// path is always given explicitly.
///
/// The kit's Ghostty instance is process-wide (all terminals share one
/// WASM instance, per ghostty-web's own guidance) and cached behind a
/// single promise so concurrent spawns coalesce. A rejected load is NOT
/// cached: the next spawn retries, and callers fall back to xterm.js
/// for the terminal that failed (fail-open, same philosophy as
/// MouseModeFilter).

import type { Ghostty, Terminal } from "ghostty-web";
import type { TerminalPreferences } from "../api/types";

export type TerminalBackend = "xterm" | "ghostty";

/// Everything TerminalTab needs to construct a ghostty terminal without
/// holding a static (bundle-eager) import of the library.
export type GhosttyKit = {
  ghostty: Ghostty;
  Terminal: typeof Terminal;
};

/// Backend for a newly spawned terminal. Spawn-time only, same contract
/// as scrollback / mouse_capture: read once at terminal start, so
/// flipping the setting later affects only newly opened terminals.
/// Absent field (older server) means xterm.js, today's behavior.
export function terminalBackendFromPrefs(
  prefs: TerminalPreferences | undefined,
): TerminalBackend {
  return (prefs?.ghostty ?? false) ? "ghostty" : "xterm";
}

let kitPromise: Promise<GhosttyKit> | null = null;

/// Load the shared ghostty kit, fetching the library and the wasm asset
/// on first use. Rejects if either can't be fetched or instantiated;
/// the rejection is not cached so a later spawn can retry after a
/// transient failure.
export function loadGhosttyKit(): Promise<GhosttyKit> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const [mod, wasmUrl] = await Promise.all([
        import("ghostty-web"),
        import("ghostty-web/ghostty-vt.wasm?url"),
      ]);
      const ghostty = await mod.Ghostty.load(wasmUrl.default);
      return { ghostty, Terminal: mod.Terminal };
    })();
    kitPromise.catch(() => {
      kitPromise = null;
    });
  }
  return kitPromise;
}
