/// Terminal backend selection + the ghostty lazy loader, backing
/// `terminal.ghostty = true`.
///
/// A ghostty terminal is ghostty-web's `Terminal` (renderer, input,
/// selection) over Ghostty's own release build of libghostty-vt, vendored
/// in `vendor/ghostty-vt/` and bound to the shape ghostty-web expects by
/// `ghosttyVt.ts`. ghostty-web's bundled wasm is not loaded.
///
/// WHY lazy: the wasm is about 1.2MB. A static import would put that
/// asset on the critical path for every user whose terminals run on
/// xterm.js, so the library and the wasm URL load through dynamic imports
/// and only ever fetch when a terminal actually spawns with the ghostty
/// backend. Vite emits `ghostty-vt.wasm` as a hashed asset; the `?url`
/// import hands us its served path, which the loader fetches and compiles
/// itself.
///
/// WHY one WASM instance per terminal: a wasm memory only grows, so on a
/// shared instance the scrollback of every terminal ever opened would stay
/// allocated for the life of the page. The module is compiled once and
/// cached; every terminal instantiates it into its own linear memory
/// (about 1.7MB with an empty terminal), which is released with the
/// terminal.
///
/// The compiled module is cached behind a single promise so concurrent
/// spawns coalesce. A rejected load is NOT cached: the next spawn
/// retries, and callers fall back to xterm.js for the terminal that
/// failed (fail-open, same philosophy as MouseModeFilter).

import type { Ghostty, Terminal } from "ghostty-web";
import { GhosttyVt } from "./ghosttyVt";
import type { TerminalPreferences } from "../api/types";

export type TerminalBackend = "xterm" | "ghostty";

/// Everything TerminalTab needs to construct a ghostty terminal without
/// holding a static (bundle-eager) import of the library.
export type GhosttyKit = {
  /// A fresh WASM instance for ONE terminal; never share it (see the
  /// module comment).
  instantiate: () => Promise<Ghostty>;
  Terminal: typeof Terminal;
};

/// Backend for a newly spawned terminal. Spawn-time only, same contract
/// as scrollback / mouse_capture: read once at terminal start, so
/// flipping the setting later affects only newly opened terminals.
/// The server stores the choice and defaults it to ghostty; an absent
/// field (a server older than the key) means xterm.js, which such a server
/// can still drive. Secret masking exists on both backends, so the window's
/// kind plays no part here.
export function terminalBackendFromPrefs(
  prefs: TerminalPreferences | undefined,
): TerminalBackend {
  return (prefs?.ghostty ?? false) ? "ghostty" : "xterm";
}

/// Build a kit over an already compiled ghostty-vt module. Split from
/// the loader so a test can hand it the vendored wasm read from disk.
export function ghosttyKitFrom(
  module: WebAssembly.Module,
  lib: { Terminal: typeof Terminal },
): GhosttyKit {
  return {
    Terminal: lib.Terminal,
    // The release build imports nothing from its host.
    instantiate: async () => new GhosttyVt(await WebAssembly.instantiate(module, {})).asGhostty(),
  };
}

let kitPromise: Promise<GhosttyKit> | null = null;

/// Load the ghostty kit, fetching the library and compiling the wasm
/// asset on first use. Rejects if either can't be fetched or compiled;
/// the rejection is not cached so a later spawn can retry after a
/// transient failure.
export function loadGhosttyKit(): Promise<GhosttyKit> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const [mod, wasmUrl] = await Promise.all([
        import("ghostty-web"),
        import("../../vendor/ghostty-vt/ghostty-vt.wasm?url"),
      ]);
      const response = await fetch(wasmUrl.default);
      if (!response.ok) {
        throw new Error(
          `fetching ${wasmUrl.default}: ${response.status} ${response.statusText}`,
        );
      }
      const module = await WebAssembly.compile(await response.arrayBuffer());
      return ghosttyKitFrom(module, mod);
    })();
    kitPromise.catch(() => {
      kitPromise = null;
    });
  }
  return kitPromise;
}
