// iOS surface (single webview, no window management): the Library shows no
// terminal-creation controls -- no "New local terminal" on This Machine,
// no "New terminal on" devserver rows -- while workspaces and connections
// stay available. `isIOS` is a boot-time const, so it is pinned via a
// module mock for the whole file. The desktop surfaces are covered in
// Library.test.ts; the real user-agent sniff is proven on sim.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, unmount } from "svelte";
import Library from "./Library.svelte";
import { library, loadLibrary, stopWatching } from "../state/library.svelte";
import type { DevserverEntry } from "../api/library";

// Force the iOS surface for the whole file (hoisted before the imports):
// desktop bridge present (the installed loopback), iOS WebView.
vi.mock("../state/capabilities", () => ({
  readOnly: false,
  canMutateRegistry: true,
  hasDesktopBridge: true,
  selfManagedWindows: false,
  hostOs: "other",
  isIOS: true,
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
});

describe("Library on the iOS surface", () => {
  it("hides terminal creation but keeps workspaces and connections", () => {
    mountList();
    const l = labels();
    expect(l.some((x) => x === "New local terminal")).toBe(false);
    expect(l.some((x) => x.startsWith("New terminal on"))).toBe(false);
    expect(l.some((x) => x === "New local workspace")).toBe(true);
    expect(target!.textContent).toContain("box.example.com:8787");
  });

  it("hides the terminal button on a connected devserver too", () => {
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "connected" } : d),
    );
    mountList();
    expect(labels().some((x) => x.startsWith("New terminal on"))).toBe(false);
  });
});
