import { describe, expect, test } from "vitest";
import tab from "./TerminalTab.svelte?raw";

// Source-shape guards for the ghostty backend wiring in TerminalTab.
// The loadGhosttyKit path is lazy by design (a static import would put
// the ~420KB wasm on every user's critical path) and the key-handler
// wrap is load-bearing: ghostty-web's custom-key-handler contract is
// INVERTED relative to xterm (true = handled vs false = skip), so an
// unwrapped handleTerminalKeyEvent would eat every keystroke.

describe("TerminalTab ghostty backend wiring", () => {
  test("backend reads from Preferences at spawn time with the lazy kit loader", () => {
    expect(tab).toMatch(
      /const terminalPrefs = currentPreferences\(\)\?\.terminal;[\s\S]*?backend = terminalBackendFromPrefs\(terminalPrefs\);/,
    );
    expect(tab).toMatch(/await loadGhosttyKit\(\)/);
    // A failed wasm load falls back to xterm.js, never breaks the spawn.
    expect(tab).toMatch(/falling back to xterm\.js/);
  });

  test("ghostty terminals construct from the kit, never a static import", () => {
    expect(tab).toMatch(/new ghosttyKit\.Terminal\(\{/);
    expect(tab).not.toMatch(/import \{[^}]*Terminal[^}]*\} from "ghostty-web"/);
  });

  test("ghostty uses chan's fitter without its reserved scrollbar gutter", () => {
    expect(tab).not.toMatch(/new ghosttyKit\.FitAddon\(\)/);
    expect(tab).toContain("proposeGhosttyDimensions(");
    expect(tab).toMatch(/ghosttyTerm\.resize\(proposed\.cols, proposed\.rows\)/);
  });

  test("ghostty adopts xterm's measured cell metrics after open", () => {
    expect(tab).toContain("measureXtermCellDimensions(");
    expect(tab).toContain("alignGhosttyRendererToXterm(");
    expect(tab.indexOf("term.open(host);")).toBeLessThan(
      tab.indexOf("alignGhosttyRendererToXterm("),
    );
  });

  test("ghostty installs xterm-style continuous box glyphs", () => {
    expect(tab).toContain("installGhosttyCustomGlyphs(renderer)");
    expect(tab).toContain("using font-rendered box glyphs");
  });

  test("ghostty's overlay scrollbar is painted onto the content it covers", () => {
    // Without this adapter ghostty's overlay clears and background-fills the
    // last columns of its own canvas, so the grid is sized to use them and
    // they render as a blank strip. Losing the install call reintroduces a
    // rendering defect that no other pin in this file would notice.
    expect(tab).toContain("installGhosttyOverlayScrollbar(renderer)");
    expect(tab).toContain("erases the last columns it covers");
  });

  test("the overlay's click region is gated after ghostty registers it", () => {
    // The gate replaces ghostty's own capture-phase mousedown listener, so it
    // is the sole claimant only once open() has registered that listener.
    // Installed any earlier it would leave the ungated one live, and a click
    // meant to place a selection in the columns this backend just made
    // readable would scroll-jump instead, with immediate propagation stopped
    // so nothing downstream could recover it.
    expect(tab).toContain("gateGhosttyScrollbarClicks(ghosttyTerm, host)");
    // Anchor both ends before comparing them: a missing needle indexes to -1,
    // which orders ahead of everything and would read as a pass.
    expect(tab).toContain("term.open(host);");
    expect(tab.indexOf("term.open(host);")).toBeLessThan(
      tab.indexOf("gateGhosttyScrollbarClicks("),
    );
    expect(tab).toContain("claims clicks while hidden");
    // The disposer is the only path back to ghostty's own listener behavior,
    // so teardown has to run it.
    expect(tab).toMatch(/ghosttyScrollbarClickGate\?\.\(\);/);
  });

  test("key handler is wrapped with INVERTED semantics on the ghostty branch", () => {
    expect(tab).toMatch(
      /term\.attachCustomKeyEventHandler\(\(e\) => !handleTerminalKeyEvent\(e\)\);/,
    );
  });

  test("host-owned chords stop before ghostty without suppressing the native default", () => {
    expect(tab).toMatch(
      /host\.addEventListener\("keydown", onGhosttyHostChord, true\);/,
    );
    expect(tab).toMatch(
      /host\?\.removeEventListener\("keydown", onGhosttyHostChord, true\);/,
    );
    const handler = tab.match(
      /function onGhosttyHostChord\(e: KeyboardEvent\): void \{[\s\S]*?\n  \}/,
    )?.[0];
    expect(handler).toBeDefined();
    expect(handler).toContain("e.stopPropagation()");
    expect(handler).not.toContain("preventDefault");
  });

  test("OSC 52 observer is fed on the write path (ghostty only)", () => {
    expect(tab).toMatch(/osc52Bridge = new Osc52Bridge\(\)/);
    expect(tab).toMatch(/osc52Bridge\?\.push\(bytes\);/);
  });

  test("xterm-only addons and hooks stay on the xterm branch", () => {
    expect(tab).toMatch(/if \(backend === "xterm"\) \{/);
    expect(tab).toMatch(/installShiftSelectionBypass\(term as Terminal\)/);
  });

  test("write-origin tracker uses the synchronous writer on the ghostty branch", () => {
    // ghostty-web defers write callbacks to rAF, which stalls in a
    // backgrounded/headless page and would wedge the replay-origin
    // suppression open (eating mouse reports + Alt+keys). The sync
    // wrapper is load-bearing; do not "simplify" it back to term.
    expect(tab).toMatch(/termWriter = \{\s*write: \(bytes, done\) => \{/);
    expect(tab).toMatch(/viewport\.write\(bytes\);\s*done\?\.\(\);/);
    expect(tab).toMatch(/ptyWrites\.write\(termWriter, bytes, origin,/);
  });

  test("every ghostty viewport mutation routes through the one controller", () => {
    expect(tab).toMatch(/new GhosttyViewportController\(ghosttyTerm, \{/);
    // The stateless write-restore helper is retired; the controller owns
    // write reconciliation and the calibrated macOS pixel-scroll claim.
    expect(tab).not.toContain("writeGhosttyPreservingScroll");
    expect(tab).toMatch(/return ghosttyViewport\?\.handleWheel\(e\) \?\? false;/);
    // Zero smooth-scroll duration retires ghostty-web's private animation
    // target so a write-side restore cannot be overridden by a stale one.
    expect(tab).toMatch(/smoothScrollDuration: 0,/);
  });

  test("secret masking reports unavailable without running xterm decorations", () => {
    expect(tab).toContain("Secret masking unavailable on ghostty backend");
    expect(tab).toMatch(/if \(backend !== "xterm"\)/);
  });

  test("Shift+Enter uses chan's LF fallback before Ghostty encodes it as Enter", () => {
    expect(tab).toMatch(
      /return handleGhosttyShiftEnter\(e, sendUserInput\);/,
    );
  });

  test("wheel reporting shim is attached on the ghostty branch", () => {
    // Upstream's capture-phase scroller stopPropagation()s the wheel
    // before its InputHandler can report it; the shim is the only SGR
    // wheel path under ghostty.
    expect(tab).toMatch(
      /term\.attachCustomWheelEventHandler\(handleGhosttyWheel\);/,
    );
    expect(tab).toMatch(/function handleGhosttyWheel\(e: WheelEvent\): boolean \{/);
  });
});
