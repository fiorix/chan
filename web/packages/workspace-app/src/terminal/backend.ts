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
/// spawns coalesce. A compile failure stays cached for the page's life:
/// an engine without the wasm's required features cannot use this core.
/// So does the binding's refusal of the core (a libghostty-vt other than
/// the 1.x it drives, or one without search): the vendored file does not
/// change between spawns. Fetch failures retry at the next spawn. Callers
/// fall back to xterm.js for each terminal whose load fails.

import type { Ghostty, Terminal } from "ghostty-web";
import { GhosttyVt, type VtHost } from "./ghosttyVt";
import type { TerminalPreferences } from "../api/types";

export type TerminalBackend = "xterm" | "ghostty";

/// Everything TerminalTab needs to construct a ghostty terminal without
/// holding a static (bundle-eager) import of the library.
export type GhosttyKit = {
  /// A fresh WASM instance for ONE terminal; never share it (see the
  /// module comment).
  instantiate: (host?: VtHost) => Promise<Ghostty>;
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
    instantiate: async (host) => new GhosttyVt(await WebAssembly.instantiate(module, {}), host).asGhostty(),
  };
}

let kitPromise: Promise<GhosttyKit> | null = null;

/// Load the ghostty kit, fetching the library and compiling the wasm
/// asset on first use. Compile failures and a refused core stay cached;
/// failures fetching the library or wasm retry at the next spawn.
export function loadGhosttyKit(): Promise<GhosttyKit> {
  if (!kitPromise) {
    let permanent = false;
    const forever = (error: unknown): never => {
      permanent = true;
      throw error;
    };
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
      const bytes = await response.arrayBuffer();
      const module = await WebAssembly.compile(bytes).catch(forever);
      const kit = ghosttyKitFrom(module, mod);
      // The binding checks the core's version and features when it is
      // instantiated; one instance here surfaces that before any terminal
      // asks, and is dropped.
      await kit.instantiate().catch(forever);
      return kit;
    })();
    kitPromise.catch(() => {
      if (!permanent) kitPromise = null;
    });
  }
  return kitPromise;
}
