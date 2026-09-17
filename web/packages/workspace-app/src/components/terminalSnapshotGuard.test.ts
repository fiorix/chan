import { describe, expect, test } from "vitest";
import terminalTab from "./TerminalTab.svelte?raw";

// The control terminal must never write a scrollback snapshot: its PTY output
// carries the CHAN_DEVSERVER_TOKEN= marker the desktop re-scrapes, and a
// localStorage copy would keep that credential on disk until the token next
// rotates. The RULE lives in state/windowMode.windowModeAllowsSnapshot
// (unit-tested there); these pins
// assert TerminalTab actually consults it, in the source-pin shape of
// confirmCloseDispatch.test.ts. Red mutation: delete the guard call from
// captureSnapshot.
describe("control terminals write no scrollback snapshot", () => {
  test("captureSnapshot consults windowModeAllowsSnapshot before writing", () => {
    const body = terminalTab
      .split("function captureSnapshot()")
      .at(1)
      ?.split("function ")
      .at(0);
    expect(body).toBeTruthy();
    expect(body).toContain(
      "windowModeAllowsSnapshot({ terminalControl: ui.terminalControl })",
    );
    // The guard must run BEFORE the write, not after it.
    const guardAt = body?.indexOf("windowModeAllowsSnapshot") ?? -1;
    const writeAt = body?.indexOf("writeTerminalSnapshot") ?? -1;
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(guardAt);
  });

  test("the guard is the shared windowMode rule, not a local re-derivation", () => {
    expect(terminalTab).toContain(
      'import { windowModeAllowsSnapshot } from "../state/windowMode";',
    );
  });

  test("a control window clears its own persisted snapshot on attach and teardown", () => {
    // The $effect that removes pre-guard leftovers for this session: gated on
    // ui.terminalControl, clears now and again in its cleanup.
    const effect = terminalTab
      .split("if (!ui.terminalControl || !sessionId) return;")
      .at(1)
      ?.split("$effect")
      .at(0);
    expect(effect).toBeTruthy();
    expect(effect).toContain("clearTerminalSnapshot(sessionId);");
    expect(effect).toContain("return () => clearTerminalSnapshot(sessionId);");
  });
});
