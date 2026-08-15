// Self-managed (bridgeless devserver/PWA) WindowRow: alongside OPEN, the row
// carries a leader-gated SHOW/HIDE Eye toggle wired to the bridgeless
// `/visibility` web op (setWindowVisibility). A follower tab sees it disabled.
// `selfManagedWindows` is a boot-time const, so it is pinned via a module mock.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import WindowRow from "./WindowRow.svelte";
import { library } from "../state/library.svelte";
import type { WindowRecord } from "../api/library";

vi.mock("../state/capabilities", () => ({
  readOnly: false,
  canMutateRegistry: true,
  hasDesktopBridge: false,
  selfManagedWindows: true,
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
    active_transfer: false,
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
  library.leaders = {};
});

describe("WindowRow self-managed actions", () => {
  it("renders OPEN plus a leader-allowed HIDE toggle when leaderless", () => {
    const el = render(win({ window_id: "w", library_id: "local" }));
    expect(el.querySelector('[aria-label="Open window"]')).not.toBeNull();
    const hide = el.querySelector('[aria-label="Hide window"]') as HTMLButtonElement | null;
    expect(hide).not.toBeNull();
    // Leaderless => the leader-only op is allowed.
    expect(hide!.disabled).toBe(false);
  });

  it("a hidden window shows the Show toggle", () => {
    const el = render(win({ window_id: "h", library_id: "local", hidden: true }));
    expect(el.querySelector('[aria-label="Show window"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Hide window"]')).toBeNull();
  });

  it("disables the toggle for a follower (the leader lives elsewhere)", () => {
    library.leaders = { p: "w-other-leader" };
    const el = render(win({ window_id: "w", library_id: "local" }));
    const hide = el.querySelector('[aria-label="Hide window"]') as HTMLButtonElement;
    expect(hide.disabled).toBe(true);
  });

  it("does not expose terminal caption editing to a follower", () => {
    library.leaders = { p: "w-other-leader" };
    const el = render(
      win({
        window_id: "w",
        library_id: "local",
        label: "shared text",
      }),
    );
    expect(el.textContent).toContain("Terminal Window 1 [shared text]");
    expect(el.querySelector('button[title="Add or edit window text"]')).toBeNull();
  });

  it("the toggle drives setWindowVisibility (the /visibility web op)", async () => {
    const { backend } = await import("../api/backend");
    const vis = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const el = render(win({ window_id: "w", library_id: "local" }));
    (el.querySelector('[aria-label="Hide window"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    // Hide a visible window; leaderless, so the acting claim is undefined.
    expect(vis).toHaveBeenCalledWith("w", true, undefined);
    vis.mockRestore();
  });
});
