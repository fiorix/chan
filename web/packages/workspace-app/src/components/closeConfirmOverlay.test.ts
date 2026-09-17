import { describe, expect, test } from "vitest";
import overlay from "./CloseConfirmOverlay.svelte?raw";

// The desktop red-dot close prompt. Shaped like DisconnectOverlay but a
// DECISION, not a live wait: three actions, no spinner, stacked at 30002, with a
// destructive Close that is neither the default focus nor an Enter target.
describe("CloseConfirmOverlay", () => {
  test("offers exactly the three Hide / Close / Cancel actions", () => {
    expect(overlay).toMatch(/class="hide"[\s\S]{0,80}onclick=\{hide\}/);
    expect(overlay).toMatch(/class="close"[\s\S]{0,80}onclick=\{close\}/);
    expect(overlay).toMatch(/class="cancel"[\s\S]{0,80}onclick=\{cancel\}/);
    expect(overlay).toContain("> Hide <");
    expect(overlay).toContain("> Close <");
    expect(overlay).toContain("> Cancel <");
  });

  test("stacks at 30002, above reconnect (30000) and session-ended (30001)", () => {
    expect(overlay).toMatch(/z-index:\s*30002/);
  });

  test("is a decision, not a live wait: no spinner", () => {
    expect(overlay).not.toMatch(/class="spinner"/);
    expect(overlay).not.toMatch(/@keyframes/);
  });

  test("Hide buries via the IPC, Close discards + destroys the window", () => {
    expect(overlay).toMatch(/hideWindowFromCloseConfirm\(\)/);
    expect(overlay).toMatch(/discardWindowSession\(\{ reap: true \}\)/);
    expect(overlay).toMatch(/requestCloseWindow\(\)/);
  });

  test("Close carries the destructive --danger accent (not the default)", () => {
    expect(overlay).toMatch(/\.close:hover\s*\{[\s\S]{0,120}var\(--danger\)/);
  });

  test("Escape maps to Cancel and default focus lands on Cancel (no Enter-to-Close)", () => {
    expect(overlay).toMatch(/e\.key === "Escape"[\s\S]{0,80}cancel\(\)/);
    // Default focus parks on the Cancel button, never Close.
    expect(overlay).toMatch(/cancelBtn \?\? overlayEl\)\?\.focus\(\)/);
    // No default/autofocus on Close and no Enter handler that closes.
    expect(overlay).not.toMatch(/autofocus/);
  });

  test("resolves the shared close-confirm state on every action", () => {
    expect(overlay).toMatch(/resolveCloseConfirm\("hide"\)/);
    expect(overlay).toMatch(/resolveCloseConfirm\("close"\)/);
    expect(overlay).toMatch(/resolveCloseConfirm\("cancel"\)/);
  });
});
