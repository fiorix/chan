/// What a repaint of the visible rows needs from the terminal: the widget's
/// refresh(), a full pass. Its canvas renderer otherwise repaints only the
/// rows the core marked dirty since the last frame, so pixels the host
/// dropped (a canvas backing store purged while the window sat off-screen)
/// stay gone until a full pass is forced.
export type RefreshableTerminal = { refresh(): void };

export function refreshTerminalRows(term: RefreshableTerminal | null): void {
  term?.refresh();
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
