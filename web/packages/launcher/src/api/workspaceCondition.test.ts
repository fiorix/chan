// The one place the launcher turns a wire status into a row's reading. The map
// below is typed against the whole union, so a status added to the wire without
// a decision here fails the build; these cases pin what each decision IS.

import { describe, expect, it } from "vitest";
import {
  unactionable,
  workspaceCondition,
  type WorkspaceCondition,
  type WorkspaceStatus,
} from "./library";

const EXPECTED: Record<WorkspaceStatus, WorkspaceCondition> = {
  stopped: "idle",
  starting: "busy",
  running: "ready",
  locked: "foreign",
  closing: "busy",
  removing: "busy",
  error: "failed",
  unavailable: "degraded",
  unknown: "unknown",
};

describe("workspaceCondition", () => {
  it("classifies every status the library serializes", () => {
    for (const [status, condition] of Object.entries(EXPECTED)) {
      expect(workspaceCondition(status as WorkspaceStatus)).toBe(condition);
    }
  });

  it("reads a mount whose root is not usable as degraded, neither ready nor failed", () => {
    // The row must not claim the workspace works and must not ask for a
    // lifecycle retry: the tenant is up, and only turning it off helps.
    expect(workspaceCondition("unavailable")).toBe("degraded");
    expect(workspaceCondition("unavailable")).not.toBe(workspaceCondition("running"));
    expect(workspaceCondition("unavailable")).not.toBe(workspaceCondition("error"));
  });

  it("reads an unreadable lock as unknown, neither foreign nor idle", () => {
    // The probe established neither that another process holds the mount nor
    // that none does, so the row must not say either.
    expect(workspaceCondition("unknown")).toBe("unknown");
    expect(workspaceCondition("unknown")).not.toBe(workspaceCondition("locked"));
    expect(workspaceCondition("unknown")).not.toBe(workspaceCondition("stopped"));
  });

  it("offers no lifecycle action on a foreign or an unknown lock alone", () => {
    const refused = (Object.keys(EXPECTED) as WorkspaceStatus[]).filter(unactionable);
    expect(refused.sort()).toEqual(["locked", "unknown"]);
  });

  it("keeps the busy set to the three transitional statuses", () => {
    const busy = (Object.keys(EXPECTED) as WorkspaceStatus[]).filter(
      (status) => workspaceCondition(status) === "busy",
    );
    expect(busy.sort()).toEqual(["closing", "removing", "starting"]);
  });
});
