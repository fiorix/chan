/// Terminal backend selection + the ghostty-web lazy loader, backing
/// `terminal.ghostty = true`.
///
/// WHY lazy: ghostty-web ships a ~420KB WASM build of Ghostty's VT
/// parser next to its JS. A static import would put that asset on the
/// critical path for every user when the toggle is off by default, so
/// both the library and the wasm URL load through dynamic imports and
/// only ever fetch when a terminal actually spawns with the ghostty
/// backend. Vite emits `ghostty-vt.wasm` as a hashed asset; the `?url`
/// import hands us its served path, which the loader fetches and
/// compiles itself -- the library's own default `init()` resolves the
/// wasm relative to import.meta.url, which breaks once everything is
/// bundled.
///
/// WHY one WASM instance per terminal: the pinned ghostty-web build does
/// not zero the screen and scrollback pages it allocates, so on a shared
/// instance a new terminal gets a disposed terminal's memory back, and the
/// first resize to its real grid repaints the dead terminal's screen
/// (upstream coder/ghostty-web#142). The module is compiled once and
/// cached; every terminal instantiates it into its own linear memory
/// (about 1.2MB to start), which is released with the terminal. A
/// shared instance never shrinks either, so the cost is per live
/// terminal rather than per process.
///
/// The compiled module is cached behind a single promise so concurrent
/// spawns coalesce. A rejected load is NOT cached: the next spawn
/// retries, and callers fall back to xterm.js for the terminal that
/// failed (fail-open, same philosophy as MouseModeFilter).

import type { Ghostty, Terminal } from "ghostty-web";
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
/// the loader so a test can hand it the pinned wasm read from disk.
export function ghosttyKitFrom(
  module: WebAssembly.Module,
  lib: { Ghostty: typeof Ghostty; Terminal: typeof Terminal },
): GhosttyKit {
  return {
    Terminal: lib.Terminal,
    instantiate: async () => {
      let memory: WebAssembly.Memory | null = null;
      const instance = await WebAssembly.instantiate(module, {
        env: {
          // The module's one import, wired the way ghostty-web's own
          // loader wires it: a UTF-8 slice of this instance's memory.
          log: (ptr: number, len: number) => {
            if (!memory) return;
            console.log(
              "[ghostty-vt]",
              new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)),
            );
          },
        },
      });
      memory = instance.exports.memory as WebAssembly.Memory;
      return new lib.Ghostty(instance);
    },
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
        import("ghostty-web/ghostty-vt.wasm?url"),
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
