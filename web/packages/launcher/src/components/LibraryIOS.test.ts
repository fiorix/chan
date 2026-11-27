// iOS surface (single webview, no local host): the Library hides the local
// "This machine" card and local-only terminal/workspace controls while
// keeping connected remote devserver terminals and remote workspace terminal
// windows enabled. `isIOS` is a boot-time const, so it is pinned via a module
// mock for the whole file.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, unmount, flushSync, tick } from "svelte";
import Library from "./Library.svelte";
import App from "../App.svelte";
import { backend } from "../api/backend";
import { resetDeck, showCard } from "../state/deck.svelte";
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
  flushSync();
}

function labels(): string[] {
  return [...(target?.querySelectorAll("button[aria-label]") ?? [])].map(
    (b) => b.getAttribute("aria-label") ?? "",
  );
}

function slotLabels(): string[] {
  return [...(target?.querySelectorAll<HTMLElement>(".slot") ?? [])].map(
    (s) => s.getAttribute("aria-label") ?? "",
  );
}

function frontSlotLabel(): string {
  return target?.querySelector(".slot[aria-current='true']")?.getAttribute("aria-label") ?? "";
}

function press(key: string, on: EventTarget = document.body): void {
  on.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  flushSync();
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
  flushSync();
  await tick();
}

beforeEach(async () => {
  resetDeck();
  library.error = null;
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
  vi.restoreAllMocks();
});

describe("Library on the iOS surface", () => {
  it("keeps the desktop shortcut legend off the iOS launcher", () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(App, { target, props: { animatedBackground: false } });
    flushSync();
    expect(target.querySelector(".launcher-surface.deck")).not.toBeNull();
    expect(target.querySelector(".key-bar")).toBeNull();
  });

  it("hides This machine and local-only controls while keeping remote devservers", () => {
    mountList();
    expect(target!.querySelector('.slot[data-key="local"]')).toBeNull();
    expect(slotLabels()).toEqual(["All windows, 1 of 3", "prod, 2 of 3", "Add devserver, 3 of 3"]);
    expect(slotLabels().some((x) => x.includes("This machine"))).toBe(false);
    const l = labels();
    expect(l.some((x) => x === "New local terminal")).toBe(false);
    expect(l.some((x) => x === "New local workspace")).toBe(false);
    expect(target!.textContent).toContain("box.example.com:8787");
  });

  it("renders and invokes + Terminal on a connected remote devserver", async () => {
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "connected" } : d),
    );
    mountList();
    const btn = target!.querySelector<HTMLButtonElement>('button[aria-label="New terminal on prod"]');
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(false);

    const spy = vi.spyOn(backend, "openDevserverTerminal");
    const beforeCount = library.windows.length;
    btn!.click();
    await settle();

    expect(spy).toHaveBeenCalledExactlyOnceWith("ds-1");
    expect(library.windows.length).toBe(beforeCount + 1);
    expect(library.windows.at(-1)).toMatchObject({
      library_id: "lib-7f3a9c21b40d8e65",
      kind: "terminal",
    });
  });

  it("omits + Terminal on a disconnected remote devserver while keeping Connect", () => {
    library.devservers = library.devservers.map(
      (d): DevserverEntry => (d.id === "ds-1" ? { ...d, status: "disconnected" } : d),
    );
    library.windows = library.windows.filter(
      (w) => !(w.library_id === "lib-7f3a9c21b40d8e65" && w.control),
    );
    mountList();
    expect(target!.querySelector('button[aria-label="New terminal on prod"]')).toBeNull();
    expect(target!.querySelector('button[aria-label="Connect prod"]')).not.toBeNull();
  });

  it("renders + Terminal window on remote workspaces and opens with start_terminal", async () => {
    mountList();
    const apiBtn = target!.querySelector<HTMLButtonElement>(
      'button[aria-label="New terminal window of api"]',
    );
    const docsBtn = target!.querySelector<HTMLButtonElement>(
      'button[aria-label="New terminal window of docs"]',
    );
    expect(apiBtn).not.toBeNull();
    expect(apiBtn!.disabled).toBe(false);
    expect(docsBtn).not.toBeNull();
    expect(docsBtn!.disabled).toBe(true);

    const spy = vi.spyOn(backend, "openDevserverWorkspace");
    const beforeCount = library.windows.length;
    apiBtn!.click();
    await settle();

    expect(spy).toHaveBeenCalledExactlyOnceWith("ds-1", "/srv/api", true);
    expect(library.windows.length).toBe(beforeCount + 1);
    expect(library.windows.at(-1)).toMatchObject({
      library_id: "lib-7f3a9c21b40d8e65",
      kind: "workspace",
      workspace_path: "/srv/api",
      start_terminal: true,
    });
  });

  it("renders All windows and Add devserver without This machine when zero devservers exist", async () => {
    library.devservers = [];
    library.workspaces = [];
    library.windows = [];
    showCard("computers", "local");
    mountList();

    expect(target!.querySelector('.slot[data-key="local"]')).toBeNull();
    expect(slotLabels()).toEqual(["All windows, 1 of 2", "Add devserver, 2 of 2"]);
    expect(frontSlotLabel()).toBe("All windows, 1 of 2");
    expect(target!.textContent).toContain("No windows yet. Open one from a machine card.");

    press("ArrowRight");
    await tick();
    expect(frontSlotLabel()).toBe("Add devserver, 2 of 2");
    expect(document.activeElement).toBe(target!.querySelector(".slot.active"));

    press("ArrowLeft");
    await tick();
    expect(frontSlotLabel()).toBe("All windows, 1 of 2");
    expect(document.activeElement).toBe(target!.querySelector(".slot.active"));
  });
});
