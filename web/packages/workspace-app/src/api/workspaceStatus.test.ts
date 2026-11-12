import type { ComputersWorkspaceCondition } from "@chan/web-shared/computers-deck";
import { describe, expect, it } from "vitest";
import { workspaceCondition, type ScopedWorkspaceStatus } from "./workspaceStatus";

// Typed against the whole union, so a status added to the wire without an
// answer here fails the build; the case below pins what each answer IS.
const CONDITION: Record<ScopedWorkspaceStatus, ComputersWorkspaceCondition> = {
  stopped: "idle",
  starting: "busy",
  running: "ready",
  locked: "foreign",
  closing: "busy",
  removing: "busy",
  error: "failed",
  unavailable: "degraded",
};

describe("workspaceCondition", () => {
  it("answers for every status the library serializes", () => {
    for (const [status, condition] of Object.entries(CONDITION)) {
      expect(workspaceCondition(status as ScopedWorkspaceStatus), status).toBe(condition);
    }
  });

  it("reads a mount that is up but cannot read its root as degraded, never as ready", () => {
    // Only a serving mount is ready: the library refuses a new window over
    // any other, so a row that read ready there would offer a refusal.
    expect(workspaceCondition("unavailable")).toBe("degraded");
    expect(workspaceCondition("running")).toBe("ready");
  });
});
