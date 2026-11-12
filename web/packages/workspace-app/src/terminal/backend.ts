/// Terminal backend selection + the ghostty lazy loader, backing
/// `terminal.ghostty = true`.
///
/// A ghostty terminal is ghostty-web's `Terminal` (renderer, input,
/// selection) over Ghostty's own release build of libghostty-vt, vendored
/// in the widget package's `vendor/ghostty-vt/` and bound to the shape
/// ghostty-web expects by the package's `vt/ghosttyVt.ts`. ghostty-web's
/// bundled wasm is not loaded.
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
/// The kit is cached behind a single promise so concurrent spawns
/// coalesce. A compile failure stays cached for the page's life: an engine
/// without the wasm's required features cannot use this core. So does the
/// binding's refusal of the core (a libghostty-vt other than the 1.x it
/// drives, or one without search): the vendored file does not change
/// between spawns. Fetch failures retry at the next spawn, and so does any
/// other failure of the instance that checks the core, such as a wasm
/// memory RangeError on a page short of memory. That retry instantiates
/// the module compiled before: fetching and compiling the 1.2MB again
/// cannot cure a failure of the instance. Callers fall back to xterm.js
/// for each terminal whose load fails.

import type { Ghostty, Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt, GhosttyVtRefusal, type VtHost } from "@chan/ghostty-web-ng/vt";
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
/// The kit over the compiled module, unchecked; set once the compile
/// succeeds and kept when the instance that checks the core fails.
let compiledKit: GhosttyKit | null = null;

/// Load the ghostty kit, fetching the library and compiling the wasm
/// asset on first use. Compile failures and a refused core stay cached;
/// any other failure, fetching the library or the wasm or making the
/// instance that checks the core, retries at the next spawn, from the
/// compiled module when the compile got that far.
export function loadGhosttyKit(): Promise<GhosttyKit> {
  if (!kitPromise) {
    let permanent = false;
    const forever = (error: unknown): never => {
      permanent = true;
      throw error;
    };
    kitPromise = (async () => {
      compiledKit ??= await compileGhosttyKit(forever);
      const kit = compiledKit;
      // The binding checks the core's version and features when it is
      // instantiated; one instance here surfaces that before any terminal
      // asks, and is dropped. Only the binding's refusal is the core's own.
      await kit.instantiate().catch((error: unknown) => {
        if (error instanceof GhosttyVtRefusal) forever(error);
        throw error;
      });
      return kit;
    })();
    kitPromise.catch(() => {
      if (!permanent) kitPromise = null;
    });
  }
  return kitPromise;
}

/// Fetches the library and the wasm asset and compiles the module; a
/// compile failure goes through `forever`.
async function compileGhosttyKit(forever: (error: unknown) => never): Promise<GhosttyKit> {
  const [mod, wasmUrl] = await Promise.all([
    import("@chan/ghostty-web-ng"),
    import("@chan/ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm?url"),
  ]);
  const response = await fetch(wasmUrl.default);
  if (!response.ok) {
    throw new Error(
      `fetching ${wasmUrl.default}: ${response.status} ${response.statusText}`,
    );
  }
  const bytes = await response.arrayBuffer();
  const module = await WebAssembly.compile(bytes).catch(forever);
  return ghosttyKitFrom(module, mod);
}
