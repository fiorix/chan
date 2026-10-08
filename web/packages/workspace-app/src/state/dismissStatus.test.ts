// @vitest-environment jsdom

// dismissStatus is the explicit-clear half of the persistent-status
// contract: the one-shot error setters have no lifecycle owner, so a
// persistent error would otherwise sit forever. Clearing must be safe for
// every kind, and a still-active workspace-warnings status must re-surface
// on the next info pass rather than staying gone.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import {
  dismissStatus,
  refreshWorkspace,
  setTransientStatus,
  ui,
} from "./store.svelte";
import type { WorkspaceInfo, WorkspaceWarning } from "../api/types";

beforeEach(() => {
  ui.status = null;
  ui.statusKind = null;
  ui.statusAction = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  ui.status = null;
  ui.statusKind = null;
  ui.statusAction = null;
});

describe("dismissStatus", () => {
  test("clears a persistent error status", () => {
    ui.status = "create failed: path is not editable text: foo.zzz";
    ui.statusKind = "persistent";
    dismissStatus();
    expect(ui.status).toBeNull();
    expect(ui.statusKind).toBeNull();
    expect(ui.statusAction).toBeNull();
  });

  test("clears a workspace-warnings typed action status", () => {
    ui.status = "Broken draft .Drafts/x: missing draft.md";
    ui.statusKind = "persistent";
    ui.statusAction = { kind: "workspace-warnings", label: ui.status };
    dismissStatus();
    expect(ui.status).toBeNull();
    expect(ui.statusAction).toBeNull();
  });

  test("cancels a pending transient timer so it cannot resurrect", () => {
    vi.useFakeTimers();
    setTransientStatus("Copied path");
    expect(ui.status).toBe("Copied path");
    dismissStatus();
    expect(ui.status).toBeNull();
    // The transient's own timer must not fire against stale state.
    vi.advanceTimersByTime(5000);
    expect(ui.status).toBeNull();
  });

  test("a still-active workspace warning re-surfaces after dismissal", async () => {
    const warning: WorkspaceWarning = {
      kind: "broken_draft",
      path: ".Drafts/dismiss-resurface-fixture",
      message: "missing draft.md",
    };
    const info = {
      root: "/ws",
      label: null,
      metadata_key: null,
      // applyServerPreferences no-ops on falsy preferences.
      preferences: null,
      warnings: [warning],
    } as unknown as WorkspaceInfo;
    vi.spyOn(api, "workspace").mockResolvedValue(info);

    await refreshWorkspace();
    expect(ui.status).toContain("dismiss-resurface-fixture");
    expect(ui.statusAction?.kind).toBe("workspace-warnings");

    dismissStatus();
    expect(ui.status).toBeNull();

    // The warning is still active (dismissStatus does not suppress it), so
    // the next info pass re-asserts it.
    await refreshWorkspace();
    expect(ui.status).toContain("dismiss-resurface-fixture");
    expect(ui.statusAction?.kind).toBe("workspace-warnings");
  });
});
