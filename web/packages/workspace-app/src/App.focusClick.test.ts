import { describe, expect, test } from "vitest";
import app from "../App.svelte?raw";
import pane from "./Pane.svelte?raw";

// Pane-focus-click restore on click-to-focus (not Cmd+Tab). When the
// app is unfocused and the user clicks back, the first click also selects
// the pane under the cursor. A focus event without an adjacent mousedown
// (Cmd+Tab) must NOT change pane selection.

describe("pane data-pane-id attribute", () => {
  test("Pane root carries data-pane-id={pane.id} so the window-level mousedown handler can map a click target to a pane", () => {
    expect(pane).toMatch(/data-pane-id=\{pane\.id\}/);
  });
});

describe("window-level focus + mousedown wiring", () => {
  test("FOCUS_CLICK_WINDOW_MS constant defines the click/focus correlation window", () => {
    // 50ms aligns with the bug body's recommendation; small enough
    // to avoid false-positive click-to-focus assignments on idle
    // clicks that happen to land on a pane.
    expect(app).toMatch(/const FOCUS_CLICK_WINDOW_MS = 50;/);
  });

  test("focusRestoreAt timestamp stamped on window focus event", () => {
    expect(app).toMatch(
      /function onWindowFocus\(\): void \{[\s\S]*?focusRestoreAt = Date\.now\(\);/,
    );
  });

  test("mousedown handler walks the target's DOM ancestry for .pane[data-pane-id]", () => {
    expect(app).toMatch(
      /const paneEl = target\.closest<HTMLElement>\("\.pane\[data-pane-id\]"\);/,
    );
  });

  test("mousedown handler calls setActivePane with the resolved pane id", () => {
    expect(app).toMatch(/setActivePane\(paneId\);/);
  });

  test("mousedown handler short-circuits when the focus window has expired (Cmd+Tab path)", () => {
    // Cmd+Tab fires `focus` but no mousedown follows. When the user
    // later clicks a pane the gap exceeds FOCUS_CLICK_WINDOW_MS so
    // we treat it as a normal click and let Pane.svelte handle it.
    expect(app).toMatch(/if \(focusRestoreAt === 0\) return;/);
    expect(app).toMatch(
      /if \(Date\.now\(\) - focusRestoreAt > FOCUS_CLICK_WINDOW_MS\) \{[\s\S]*?focusRestoreAt = 0;[\s\S]*?return;/,
    );
  });

  test("focusRestoreAt resets to 0 after a matching click so subsequent clicks use Pane.svelte's handler", () => {
    // The timestamp must be cleared after the first matching mousedown
    // so a later long-idle click does not incorrectly match.
    expect(app).toMatch(
      /function onWindowMouseDown\(e: MouseEvent\): void \{[\s\S]*?focusRestoreAt = 0;[\s\S]*?const target = e\.target;/,
    );
  });

  test("mousedown listener uses capture phase to fire before per-pane handlers", () => {
    expect(app).toMatch(
      /window\.addEventListener\("mousedown", onWindowMouseDown, true\);/,
    );
  });

  test("listeners cleaned up onDestroy", () => {
    expect(app).toMatch(/window\.removeEventListener\("focus", onWindowFocus\);/);
    expect(app).toMatch(
      /window\.removeEventListener\("mousedown", onWindowMouseDown, true\);/,
    );
  });

  test("setActivePane imported from state/tabs.svelte", () => {
    expect(app).toMatch(/setActivePane,/);
  });
});
