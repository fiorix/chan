import { describe, expect, test } from "vitest";
import global from "./global.ts?raw";

// The command-launcher Open refusal (binary target, workspace escape, no
// connected window) must land in a DISMISSABLE pill. A bare `ui.status =`
// leaves `statusKind` null: AppStatusBar only renders the dismiss control
// for `statusKind === "persistent"`, so a null-kind write has no dismiss
// affordance AND never auto-clears -- the error sticks on the workspace
// forever. The catch must set `statusKind = "persistent"` alongside the
// message (the house pattern for one-shot error pills).

describe("executeOpen refusal is a dismissable persistent pill", () => {
  test("catch pairs the open-failed message with statusKind = persistent", () => {
    expect(global).toMatch(
      /ui\.status = `open failed:[^`]*`;\s*ui\.statusKind = "persistent";/,
    );
  });

  test("pre-fix sticky shape gone (exactly one open-failed write, and it is not bare)", () => {
    const writes = global.match(/ui\.status = `open failed:/g) ?? [];
    expect(writes.length).toBe(1);
    // The lone write must be immediately followed by the persistent kind,
    // never left dangling into the end of the catch block.
    expect(global).not.toMatch(
      /ui\.status = `open failed:[^`]*`;\s*\}/,
    );
  });
});
