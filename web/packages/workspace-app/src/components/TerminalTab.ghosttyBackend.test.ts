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
      /backend = terminalBackendFromPrefs\(workspace\.info\?\.preferences\?\.terminal\);/,
    );
    expect(tab).toMatch(/await loadGhosttyKit\(\)/);
    // A failed wasm load falls back to xterm.js, never breaks the spawn.
    expect(tab).toMatch(/falling back to xterm\.js/);
  });

  test("ghostty terminals construct from the kit, never a static import", () => {
    expect(tab).toMatch(/new ghosttyKit\.Terminal\(\{/);
    expect(tab).not.toMatch(/import \{[^}]*Terminal[^}]*\} from "ghostty-web"/);
  });

  test("key handler is wrapped with INVERTED semantics on the ghostty branch", () => {
    expect(tab).toMatch(
      /term\.attachCustomKeyEventHandler\(\(e\) => !handleTerminalKeyEvent\(e\)\);/,
    );
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
    expect(tab).toMatch(/ptyWrites\.write\(termWriter, bytes, origin\);/);
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
