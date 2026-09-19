import { describe, expect, it } from "vitest";
import { scopedWorkspaceOpenable, type ScopedWorkspaceStatus } from "./workspaceStatus";

// Typed against the whole union, so a status added to the wire without an
// answer here fails the build; the case below pins what each answer IS.
const OPENABLE: Record<ScopedWorkspaceStatus, boolean> = {
  stopped: false,
  starting: false,
  running: true,
  locked: false,
  closing: false,
  removing: false,
  error: false,
  unavailable: false,
};

describe("scopedWorkspaceOpenable", () => {
  it("answers for every status the library serializes", () => {
    for (const [status, openable] of Object.entries(OPENABLE)) {
      expect(scopedWorkspaceOpenable(status as ScopedWorkspaceStatus)).toBe(openable);
    }
  });

  it("refuses a mount that is up but cannot read its root", () => {
    // The library answers the mint with 409 `workspace is not running` for
    // anything but a serving mount, so offering it would be offering a refusal.
    expect(scopedWorkspaceOpenable("unavailable")).toBe(false);
    expect(scopedWorkspaceOpenable("running")).toBe(true);
  });
});
