import type { VtTerminal } from "@chan/ghostty-web-ng/vt";

/// What a repaint of the visible rows needs from either backend. xterm.js
/// queues the row range through refresh(). ghostty-web has no refresh(): its
/// canvas renderer repaints only the rows the core marked dirty since the
/// last frame, so pixels the host dropped (a canvas backing store purged
/// while the window sat off-screen) stay gone until a full pass is forced
/// through the renderer itself, as its own resize does.
export type RefreshableTerminal = {
  rows: number;
  refresh?: (start: number, end: number) => void;
  renderer?: {
    render?(
      buffer: VtTerminal,
      forceAll?: boolean,
      viewportY?: number,
      scrollbackProvider?: unknown,
      scrollbarOpacity?: number,
    ): void;
  };
  wasmTerm?: VtTerminal;
  getViewportY?: () => number;
};

export function refreshTerminalRows(term: RefreshableTerminal | null): void {
  if (!term) return;
  if (term.refresh) {
    term.refresh(0, Math.max(0, term.rows - 1));
    return;
  }
  // The terminal is its own scrollback provider, as in ghostty-web's render
  // loop. A zero scrollbar opacity leaves the overlay scrollbar to that loop,
  // which paints it every frame while it is shown.
  const render = term.renderer?.render;
  if (typeof render === "function" && term.wasmTerm) {
    render.call(term.renderer, term.wasmTerm, true, term.getViewportY?.() ?? 0, term, 0);
  }
}

/// What a pending repaint waits on: the next animation frame, and the page's
/// fonts. Injectable so a test drives both without a browser.
export type RepaintSchedulerHost = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  fontsReady: () => Promise<unknown> | undefined;
};

export type RepaintScheduler = {
  /// Ask for a repaint on the next frame and once the fonts are ready.
  request(): void;
  /// Drop what is pending; a later request schedules again.
  cancel(): void;
};

/// A repaint that is pending at most once at a time. A hidden page gets no
/// animation frame, so every repaint asked for while its window is off-screen
/// waits for the frame in which the window comes back; each one is a full
/// pass over the terminal's cells, and WebKit shows the window's content only
/// after that frame commits. Asking again while one is pending therefore adds
/// nothing: the pending repaint already draws the terminal as it is then.
export function createRepaintScheduler(
  repaint: () => void,
  host: RepaintSchedulerHost = {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    fontsReady: () => document.fonts?.ready,
  },
): RepaintScheduler {
  let frame: number | null = null;
  // Bumped by cancel() so a fonts promise that settles later repaints nothing.
  let fontsWait = 0;
  let fontsPending = false;
  return {
    request() {
      if (frame === null) {
        // A host that runs the callback before returning (a test's
        // synchronous frame) has nothing pending once it returns; keeping
        // its handle would leave the frame path waiting on a frame that ran.
        let ran = false;
        const handle = host.requestFrame(() => {
          ran = true;
          frame = null;
          repaint();
        });
        if (!ran) frame = handle;
      }
      if (fontsPending) return;
      const ready = host.fontsReady();
      if (!ready) return;
      fontsPending = true;
      const wait = fontsWait;
      void ready.then(() => {
        if (wait !== fontsWait) return;
        fontsPending = false;
        repaint();
      });
    },
    cancel() {
      if (frame !== null) {
        host.cancelFrame(frame);
        frame = null;
      }
      fontsWait += 1;
      fontsPending = false;
    },
  };
}

/// Escape hatch for the desktop's renderer choice, read from
/// localStorage so trying it costs a devtools line rather than a rebuild.
/// `"1"` forces xterm.js's WebGL renderer on, `"0"` forces it off, anything
/// else defers to the capability in the served shell.
///
/// WHY a hatch exists at all: WebGL is the only xterm renderer that draws box
/// drawing and block elements to the cell edge, and it measures 100% where the
/// DOM renderer measures 96.0% / 95.2%. The hatch permits pixel readings in
/// both directions without making the SPA disagree with the desktop by default.
export const WEBGL_RENDERER_OVERRIDE_KEY = "chan:terminal-webgl";

/// The desktop computes WebKit's renderer capability before it builds any
/// webview. The serving tenant stamps that result into the shell so local and
/// remote windows make the same choice without probing the driver in the SPA.
export function webglRendererSignal(): boolean | null {
  if (typeof document === "undefined") return null;
  const raw = document
    .querySelector('meta[name="chan-webgl-renderer"]')
    ?.getAttribute("content")
    ?.trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function webglRendererOverride(): boolean | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(WEBGL_RENDERER_OVERRIDE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    // A storage-denied context has no override, which is the default.
    return null;
  }
}

export function shouldUseWebglRenderer(
  isDesktop: boolean,
  desktopRenderer: boolean | null,
  override: boolean | null = null,
): boolean {
  if (override !== null) return override;
  return !isDesktop || desktopRenderer === true;
}
