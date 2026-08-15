// Self-managed surface (a bridgeless local devserver / PWA): registry mutation
// is allowed and the launcher opens its own browser windows, but there is no
// desktop bridge. So the local create controls show, window rows carry an OPEN
// action plus a bridgeless leader-gated Eye toggle (not the desktop Focus
// bridge), and remote-devserver dialing (connect/disconnect,
// devserver terminal, Add devserver) is hidden. New-window controls gate on
// per-tenant leadership. Desktop parity is in Library.test.ts, readonly in
// LibraryReadOnly.test.ts.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, unmount } from "svelte";
import Library from "./Library.svelte";
import { library, loadLibrary, stopWatching } from "../state/library.svelte";

// Force the self-managed (devserver) surface: mutate the registry + self-manage
// windows, but no desktop bridge.
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

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function mountList(): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Library, { target });
}

function labels(): string[] {
  return [...(target?.querySelectorAll("button[aria-label]") ?? [])].map(
    (b) => b.getAttribute("aria-label") ?? "",
  );
}

function newWindowButton(name: string): HTMLButtonElement | null {
  return target?.querySelector(`button[aria-label="New window of ${name}"]`) ?? null;
}

beforeEach(async () => {
  const { resetMockRemoteWorkspaces } = await import("../api/mock");
  resetMockRemoteWorkspaces();
  await loadLibrary();
});

afterEach(() => {
  if (app) unmount(app);
  stopWatching();
  target?.remove();
  target = null;
  app = null;
  library.leaders = {};
});

describe("Library self-managed surface", () => {
  it("shows local create controls but hides remote-devserver dialing", () => {
    mountList();
    const l = labels();
    // Local registry create controls are present.
    expect(l.some((x) => x === "New local terminal")).toBe(true);
    expect(l.some((x) => x === "New local workspace")).toBe(true);
    // Remote-devserver dialing is bridge-only, so it is gone.
    expect(l.some((x) => x.startsWith("New terminal on"))).toBe(false);
    expect(l.some((x) => x.startsWith("Connect ") || x.startsWith("Disconnect "))).toBe(false);
    expect(
      [...target!.querySelectorAll("button")].some((b) => b.textContent?.includes("Add devserver")),
    ).toBe(false);
  });

  it("window rows carry OPEN plus the bridgeless Eye toggle, not the desktop Focus bridge", () => {
    mountList();
    expect(target!.querySelector('[aria-label="Open window"]')).not.toBeNull();
    // No desktop bridge: the native Focus action never shows.
    expect(target!.querySelector('[aria-label="Focus window"]')).toBeNull();
    // The bridgeless SHOW/HIDE Eye toggle (the /visibility web op) IS present
    // (visible windows show "Hide window", hidden ones "Show window").
    const eye =
      target!.querySelector('[aria-label="Hide window"]') ??
      target!.querySelector('[aria-label="Show window"]');
    expect(eye).not.toBeNull();
  });

  it("enables New window on a running workspace when the tenant is leaderless", () => {
    library.leaders = {};
    mountList();
    // ws-1 ("notes", running, prefix "ws-1") is leaderless -> New window is enabled.
    const btn = newWindowButton("notes");
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(false);
  });

  it("disables New window when another surface leads the workspace's tenant", () => {
    // ws-1's tenant is led by a window this launcher does not hold a handle for.
    library.leaders = { "ws-1": "w-foreign-leader" };
    mountList();
    const btn = newWindowButton("notes");
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
  });
});
