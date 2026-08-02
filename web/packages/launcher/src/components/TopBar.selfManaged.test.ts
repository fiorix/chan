// Bridgeless surfaces (devserver / readonly): the Gateways screen lives on the
// desktop surface only, so without a desktop bridge the title block stays the
// static Computers heading -- no flip toggle at all. `hasDesktopBridge` is a
// boot-time const, so it is pinned via a module mock for the whole file.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount } from "svelte";
import TopBar from "./TopBar.svelte";

// The self-managed (devserver) surface: mutable registry, no desktop bridge.
vi.mock("../state/capabilities", () => ({
  readOnly: false,
  canMutateRegistry: true,
  hasDesktopBridge: false,
  selfManagedWindows: true,
  hostOs: "linux",
}));

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

afterEach(() => {
  if (app) unmount(app);
  target?.remove();
  target = null;
  app = null;
});

describe("TopBar without a desktop bridge", () => {
  it("keeps the static Computers title: no flip toggle", () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(TopBar, { target });

    expect(target.querySelector("button.title-toggle")).toBeNull();
    expect(target.textContent).toContain("Computers");
    expect(target.textContent).toContain("This machine & devservers");
    // The select toggle is a mutation-surface control, not a bridge one.
    expect(target.querySelector("button.select")).not.toBeNull();
    expect(target.querySelector('[aria-label="Open command launcher"]')).not.toBeNull();
  });
});
