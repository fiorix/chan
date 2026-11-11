import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import AllWindowsDeck from "../__tests__/AllWindowsDeck.svelte";
import { decks, resetDeck, showCard } from "../state/deck.svelte";
import { backend } from "../api/backend";
import type { DevserverEntry, TmuxConnectionEntry, WindowRecord } from "../api/library";
import { buildMachineTree } from "../lib/machineTree";

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

const windowRecord = (window_id: string, library_id = "local", over: Partial<WindowRecord> = {}): WindowRecord => ({
  window_id, library_id, kind: "terminal", ordinal: 1, title: "", prefix: "", token: "",
  workspace_path: null, persisted: true, connected: true, control: false, active_transfer: false,
  ...over,
});
const windows = [
  windowRecord("local-shown"),
  windowRecord("local-hidden", "local", { ordinal: 2, hidden: true }),
  windowRecord("remote-hidden", "remote", { hidden: true, connected: false, kind: "workspace", workspace_path: "/srv/notes" }),
  windowRecord("pending", "pending", { control: true }),
];
const remote = { id: "lima", library_id: "remote", label: "lima" } as DevserverEntry;
let app: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

function render(active = true) {
  target = document.createElement("div");
  document.body.append(target);
  resetDeck();
  app = mount(AllWindowsDeck, { target, props: {
    tree: buildMachineTree([remote, { ...remote, id: "alias" }], [], [...windows, windows[0]]),
  } });
  if (!active) showCard("computers", "other");
  flushSync();
  return [...target.querySelectorAll<HTMLLIElement>("li")];
}

async function press(key: string, on: EventTarget = document.activeElement ?? document.body, modifiers = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  on.dispatchEvent(event);
  flushSync();
  await tick();
  return event;
}

afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  target?.remove();
  Reflect.deleteProperty(window, "__CHAN_LAUNCHER_WINDOW__");
  vi.restoreAllMocks();
});

describe("All windows", () => {
  it.each([
    [{ windowId: "local-shown", libraryId: "local" }, "local-shown"],
    [{ windowId: "remote-hidden", libraryId: "remote" }, "remote-hidden"],
    [{ windowId: "pending", libraryId: null }, "pending"],
  ])("marks the native host window for %j", (host, id) => {
    Object.defineProperty(window, "__CHAN_LAUNCHER_WINDOW__", { value: host, configurable: true });
    const rows = render();
    expect(rows.filter((row) => row.querySelector(".current-window")).map((row) => row.dataset.windowId)).toEqual([id]);
    expect(target.querySelector('[aria-current="true"] .current-window')?.textContent).toBe("This window");
  });

  it("does not mark a same-id window in another library", () => {
    Object.defineProperty(window, "__CHAN_LAUNCHER_WINDOW__", {
      value: { windowId: "local-shown", libraryId: "remote" }, configurable: true,
    });
    render();
    expect(target.querySelector(".current-window")).toBeNull();
  });

  it("does not invent a host for a standalone browser launcher", () => {
    render();
    expect(target.querySelector(".current-window")).toBeNull();
  });

  it("includes shown, hidden, disconnected and unassociated windows exactly once with machine context", () => {
    const rows = render();
    expect(rows.map((row) => row.dataset.windowId)).toEqual(windows.map((w) => w.window_id));
    expect(rows.map((row) => row.querySelector(".row-sub")?.textContent)).toEqual([
      "local · Shown", "local · Hidden", "lima / notes · Hidden", "Connecting · Shown",
    ]);
    expect(target.querySelectorAll('[aria-label="Focus window"]')).toHaveLength(4);
    expect(target.querySelectorAll('[aria-label="Show window"]')).toHaveLength(2);
    expect(target.querySelectorAll('[aria-label="Hide window"]')).toHaveLength(2);
  });

  it("names this machine local ahead of a workspace, as the window's title does", () => {
    target = document.createElement("div");
    document.body.append(target);
    resetDeck();
    app = mount(AllWindowsDeck, { target, props: {
      tree: buildMachineTree([remote], [], [
        windowRecord("local-ws", "local", { kind: "workspace", workspace_path: "/Users/hacker/src/chan" }),
        windowRecord("remote-ws", "remote", { kind: "workspace", workspace_path: "/home/lima/chan" }),
      ]),
    } });
    flushSync();
    expect([...target.querySelectorAll("li .row-sub")].map((sub) => sub.textContent)).toEqual([
      "local / chan · Shown", "lima / chan · Shown",
    ]);
  });

  it("leaves out a tmux connection's buried control terminal and lists its windows", () => {
    const tmuxEntry = (connection: string, library_id: string, name: string): TmuxConnectionEntry => ({
      connection, library_id, origin: { program: "tmux", command: "tmux -CC", local: true }, version: "3.5a",
      session: { id: `$${name}`, name }, windows: [], window_cap: 8, errors: [], control_window: `${connection}-control`,
    });
    // A control terminal is minted hidden with both marks; a tmux window
    // carries the connection's mark alone.
    const marked = (connection: string, control: boolean): Partial<WindowRecord> => ({
      control, hidden: control, persisted: false, ordinal: control ? 0 : 1, tmux: { connection, control },
    });
    target = document.createElement("div");
    document.body.append(target);
    resetDeck();
    app = mount(AllWindowsDeck, { target, props: {
      tree: buildMachineTree([remote], [], [
        windowRecord("local-shown"),
        windowRecord("tm-1-control", "local", marked("tm-1", true)),
        windowRecord("tm-1-w1", "local", marked("tm-1", false)),
        windowRecord("tm-2-control", "remote", marked("tm-2", true)),
        windowRecord("tm-2-w1", "remote", marked("tm-2", false)),
      ], [tmuxEntry("tm-1", "local", "main"), tmuxEntry("tm-2", "remote", "work")]),
    } });
    flushSync();
    const rows = [...target.querySelectorAll<HTMLLIElement>("li")];
    expect(rows.map((row) => row.dataset.windowId)).toEqual(["local-shown", "tm-1-w1", "tm-2-w1"]);
    expect(rows.map((row) => row.querySelector(".row-sub")?.textContent)).toEqual([
      "local · Shown", "tmux -CC on this machine (main) · Shown", "tmux -CC on lima (work) · Shown",
    ]);
    expect(target.querySelector(".all-windows .count")?.textContent).toBe("3");
    expect(target.querySelector(".row-buried")).toBeNull();
  });

  it("moves and clamps selection without focusing a native window; Enter focuses the selected row", async () => {
    const open = vi.spyOn(backend, "openWindow").mockResolvedValue(undefined);
    const rows = render();
    await press("ArrowDown", document.body);
    expect(document.activeElement).toBe(rows[0]);
    await press("ArrowUp");
    expect(document.activeElement).toBe(rows[0]);
    for (let i = 0; i < 5; i++) await press("ArrowDown");
    expect(document.activeElement).toBe(rows[3]);
    await press("ArrowUp");
    expect(document.activeElement).toBe(rows[2]);
    expect(open).not.toHaveBeenCalled();
    await press("Enter");
    expect(open).toHaveBeenCalledExactlyOnceWith("remote-hidden");
  });

  it("routes show, hide and focus through the existing window actions", async () => {
    const open = vi.spyOn(backend, "openWindow").mockResolvedValue(undefined);
    const hide = vi.spyOn(backend, "hideWindow").mockResolvedValue(undefined);
    const rows = render();
    rows[0].querySelector<HTMLButtonElement>('[aria-label="Hide window"]')!.click();
    rows[1].querySelector<HTMLButtonElement>('[aria-label="Show window"]')!.click();
    rows[2].querySelector<HTMLButtonElement>('[aria-label="Focus window"]')!.click();
    await tick();
    expect(hide).toHaveBeenCalledExactlyOnceWith("local-shown");
    expect(open.mock.calls).toEqual([["local-hidden"], ["remote-hidden"]]);
  });

  it("leaves editing fields, button Enter, modifiers and other UI alone", async () => {
    const rows = render();
    rows[0].querySelector<HTMLButtonElement>('button[title="Add or edit window text"]')!.click();
    flushSync();
    await tick();
    const input = rows[0].querySelector("input")!;
    expect((await press("ArrowDown", input)).defaultPrevented).toBe(false);
    expect((await press("ArrowRight", input)).defaultPrevented).toBe(false);
    expect((await press("ArrowLeft", input)).defaultPrevented).toBe(false);
    expect((await press("ArrowDown", rows[0], { metaKey: true })).defaultPrevented).toBe(false);
    expect((await press("ArrowRight", rows[0], { metaKey: true })).defaultPrevented).toBe(false);
    const focus = rows[1].querySelector("button")!;
    expect((await press("Enter", focus)).defaultPrevented).toBe(false);
    expect((await press("ArrowDown", target)).defaultPrevented).toBe(false);
  });

  it("ignores keys while another carousel card is active", async () => {
    const rows = render(false);
    expect((await press("ArrowDown", document.body)).defaultPrevented).toBe(false);
    expect((await press("ArrowRight", rows[0])).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("navigates control-terminal actions and skips disabled controls without activating them", async () => {
    const open = vi.spyOn(backend, "openWindow").mockResolvedValue(undefined);
    const rows = render();
    const control = rows[3];
    control.focus();
    await press("ArrowRight");
    expect(document.activeElement).toBe(control.querySelector('[aria-label="Focus window"]'));
    await press("ArrowRight");
    expect(document.activeElement).toBe(control.querySelector('[aria-label="Hide window"]'));
    await press("ArrowRight");
    expect(decks.computers.activeKey).toBe("other");
    showCard("computers", "all-windows");
    flushSync();
    control.querySelector<HTMLButtonElement>('[aria-label="Hide window"]')!.focus();
    control.querySelector<HTMLButtonElement>('[aria-label="Focus window"]')!.disabled = true;
    await press("ArrowLeft");
    expect(decks.computers.activeKey).toBe("other");
    expect(open).not.toHaveBeenCalled();
  });
});
