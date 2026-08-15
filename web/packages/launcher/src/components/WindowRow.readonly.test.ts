// Read-only (gateway) WindowRow: no actions, just the connection dot, but it
// mirrors the EYE state -- a hidden window shows a static EyeOff indicator
// beside the dot. `hasDesktopBridge` / `selfManagedWindows` are boot-time
// consts, pinned via a module mock.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount } from "svelte";
import WindowRow from "./WindowRow.svelte";
import type { WindowRecord } from "../api/library";

vi.mock("../state/capabilities", () => ({
  readOnly: true,
  canMutateRegistry: false,
  hasDesktopBridge: false,
  selfManagedWindows: false,
  hostOs: "linux",
}));

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

function win(
  over: Partial<WindowRecord> & Pick<WindowRecord, "window_id" | "library_id">,
): WindowRecord {
  return {
    kind: "terminal",
    title: "",
    ordinal: 1,
    workspace_path: null,
    prefix: "p",
    token: "",
    persisted: true,
    connected: true,
    control: false,
    ...over,
  };
}

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function render(w: WindowRecord): HTMLElement {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(WindowRow, { target, props: { w } });
  return target;
}

afterEach(() => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
});

describe("WindowRow read-only EYE indicator", () => {
  it("a visible window shows only the connection dot, no actions", () => {
    const el = render(win({ window_id: "w", library_id: "local" }));
    expect(el.querySelector(".dot")).not.toBeNull();
    expect(el.querySelector(".hidden-ind")).toBeNull();
    expect(el.querySelector("button")).toBeNull();
  });

  it("a hidden window shows the static EyeOff indicator beside the dot", () => {
    const el = render(win({ window_id: "h", library_id: "local", hidden: true }));
    expect(el.querySelector(".hidden-ind")).not.toBeNull();
    expect(el.querySelector(".dot")).not.toBeNull();
    // Still no action buttons on the read-only surface.
    expect(el.querySelector("button")).toBeNull();
  });
});
