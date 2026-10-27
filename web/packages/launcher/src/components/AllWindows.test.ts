import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import AllWindowsDeck from "../__tests__/AllWindowsDeck.svelte";
import { decks, resetDeck, showCard } from "../state/deck.svelte";
import { backend } from "../api/backend";
import type { DevserverEntry, WindowRecord } from "../api/library";
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
  vi.restoreAllMocks();
});

describe("All windows", () => {
  it("includes shown, hidden, disconnected and unassociated windows exactly once with machine context", () => {
    const rows = render();
    expect(rows.map((row) => row.dataset.windowId)).toEqual(windows.map((w) => w.window_id));
    expect(rows.map((row) => row.querySelector(".row-sub")?.textContent)).toEqual([
      "This machine · Shown", "This machine · Hidden", "lima / notes · Hidden", "Connecting · Shown",
    ]);
    expect(target.querySelectorAll('[aria-label="Focus window"]')).toHaveLength(4);
    expect(target.querySelectorAll('[aria-label="Show window"]')).toHaveLength(2);
    expect(target.querySelectorAll('[aria-label="Hide window"]')).toHaveLength(2);
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
