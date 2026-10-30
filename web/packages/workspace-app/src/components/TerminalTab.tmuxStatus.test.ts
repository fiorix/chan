// @vitest-environment jsdom

import { tick } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../api/libraryWindows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/libraryWindows")>()),
  openLibraryWindowById: vi.fn(async (_bridge: unknown, windowId: string) => windowId !== "w-gone"),
}));

import TerminalTab from "./TerminalTab.svelte";
import { openLibraryWindowById } from "../api/libraryWindows";
import { installTerminalDom, mountTerminal, receive, resetTerminals, seatTerminals, sentFrames, terminalTab, TerminalSocket } from "../__tests__/terminalTab";
import type { TmuxStatus } from "../state/tmuxStatus";

installTerminalDom();
afterEach(() => { resetTerminals(); vi.clearAllMocks(); });

const CONNECTED: TmuxStatus = {
  revision: 3,
  connection: {
    version: "3.8",
    session: { id: "$0", name: "main" },
    windows: [
      { id: "@1", name: "shell", panes: 2, open: true, chan_window: "w-1" },
      { id: "@2", name: "", panes: 1, open: true },
      { id: "@9", name: "logs", panes: 1, open: false },
    ],
    window_cap: 8,
    errors: ["list-panes reply for @2: bad"],
  },
};
const ENDED: TmuxStatus = { revision: 4 };

async function mounted(status: TmuxStatus = { revision: 0 }) {
  const [tab] = seatTerminals([terminalTab({ title: "Control" })]);
  const view = await mountTerminal(TerminalTab, tab!, { focused: true, active: true });
  const socket = TerminalSocket.all.at(-1)!;
  socket.onopen?.();
  await receive(socket, { type: "session", id: "ctl", generation: 2, seq: 0, tmux_status: status });
  return { ...view, socket, tab: tab! };
}

function view(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".tmux-status");
}

function rowButton(windowId: string): HTMLButtonElement {
  const row = [...document.querySelectorAll<HTMLTableRowElement>(".tmux-status tbody tr")].find((r) => r.textContent?.includes(windowId))!;
  return row.querySelector("button")!;
}

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>(".tmux-status .ts-actions button")].find((b) => b.textContent?.trim() === label)!;
}

function requests(socket: TerminalSocket): unknown[] {
  return sentFrames(socket).filter((f) => f.type === "tmux-request").map(({ type: _type, ...rest }) => rest);
}

test("a session frame with a connection shows the view: version, session, windows and errors", async () => {
  const { tab } = await mounted(CONNECTED);
  expect(tab.tmuxStatus).toEqual(CONNECTED);
  const shown = view();
  expect(shown).not.toBeNull();
  expect(shown!.textContent).toContain("tmux 3.8");
  expect(shown!.textContent).toContain("main");
  expect(shown!.textContent).toContain("shell");
  expect(shown!.textContent).toContain("@2");
  expect(shown!.textContent).toContain("logs");
  expect(shown!.textContent).toContain("list-panes reply for @2: bad");
  expect(shown!.textContent).toContain("8 windows open at connect");
});

test("Open on a minted window opens its chan window; on one past the cap it asks the server and opens when minted", async () => {
  const { socket } = await mounted(CONNECTED);
  rowButton("@1").click();
  await tick();
  expect(openLibraryWindowById).toHaveBeenCalledWith(expect.anything(), "w-1");
  expect(requests(socket)).toEqual([]);
  rowButton("@9").click();
  await tick();
  expect(requests(socket)).toEqual([{ request: "open-window", window: "@9" }]);
  expect(view()!.textContent).toContain("Opening");
  const minted: TmuxStatus = {
    revision: 5,
    connection: {
      ...CONNECTED.connection!,
      windows: [CONNECTED.connection!.windows[0]!, CONNECTED.connection!.windows[1]!, { id: "@9", name: "logs", panes: 1, open: true, chan_window: "w-9" }],
    },
  };
  await receive(socket, { type: "tmux-status", id: "ctl", generation: 2, tmux_status: minted });
  await tick();
  expect(openLibraryWindowById).toHaveBeenLastCalledWith(expect.anything(), "w-9");
  expect(view()!.textContent).not.toContain("Opening");
});

test("a window the library no longer has is reported in the view", async () => {
  const gone: TmuxStatus = { revision: 3, connection: { ...CONNECTED.connection!, windows: [{ id: "@1", name: "shell", panes: 1, open: true, chan_window: "w-gone" }], errors: [] } };
  await mounted(gone);
  rowButton("@1").click();
  await vi.waitFor(() => expect(view()!.querySelector('[role="alert"]')?.textContent).toContain("no longer in the library"));
});

test("Detach sends its request; End asks first and sends on confirm", async () => {
  const { socket } = await mounted(CONNECTED);
  button("Detach").click();
  await tick();
  expect(requests(socket)).toEqual([{ request: "detach" }]);
  button("End").click();
  await tick();
  expect(requests(socket)).toHaveLength(1);
  expect(view()!.textContent).toContain("End the tmux server");
  button("Cancel").click();
  await tick();
  expect(requests(socket)).toHaveLength(1);
  button("End").click();
  await tick();
  button("End server").click();
  await tick();
  expect(requests(socket)).toEqual([{ request: "detach" }, { request: "end" }]);
});

test("the view holds the keyboard: arrows and digits choose a window, Enter opens it, d detaches, e asks and Enter ends", async () => {
  const { socket } = await mounted(CONNECTED);
  const shown = view()!;
  expect(document.activeElement, "the view takes the keyboard when the connection shows").toBe(shown);
  const key = (k: string) => {
    shown.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  };
  const selectedRow = () => shown.querySelector("tr.selected")?.textContent ?? "";
  expect(selectedRow()).toContain("@1");
  key("ArrowDown");
  key("ArrowDown");
  key("ArrowDown");
  await tick();
  expect(selectedRow(), "the choice stops at the last window").toContain("@9");
  key("Enter");
  await tick();
  expect(requests(socket)).toEqual([{ request: "open-window", window: "@9" }]);
  key("k");
  key("k");
  await tick();
  expect(selectedRow()).toContain("@1");
  key(" ");
  await tick();
  expect(openLibraryWindowById).toHaveBeenCalledWith(expect.anything(), "w-1");
  expect(openLibraryWindowById).toHaveBeenCalledTimes(1);
  key("1");
  await tick();
  expect(openLibraryWindowById).toHaveBeenCalledTimes(2);
  key("e");
  await tick();
  expect(shown.textContent).toContain("End the tmux server");
  key("Escape");
  await tick();
  expect(shown.textContent).not.toContain("End the tmux server");
  expect(requests(socket)).toHaveLength(1);
  key("d");
  await tick();
  expect(requests(socket)).toEqual([{ request: "open-window", window: "@9" }, { request: "detach" }]);
  key("e");
  key("Enter");
  await tick();
  expect(requests(socket).at(-1)).toEqual({ request: "end" });
  await receive(socket, { type: "tmux-status", id: "ctl", generation: 2, tmux_status: ENDED });
  await tick();
  expect(view()).toBeNull();
  expect(document.activeElement, "the keyboard leaves with the view").not.toBe(shown);
});

test("the view goes when the connection ends, and a stale or foreign frame is ignored", async () => {
  const { socket, tab } = await mounted();
  expect(view()).toBeNull();
  await receive(socket, { type: "tmux-status", id: "other", generation: 2, tmux_status: CONNECTED });
  await receive(socket, { type: "tmux-status", id: "ctl", generation: 1, tmux_status: CONNECTED });
  expect(view()).toBeNull();
  await receive(socket, { type: "tmux-status", id: "ctl", generation: 2, tmux_status: CONNECTED });
  expect(view()).not.toBeNull();
  await receive(socket, { type: "tmux-status", id: "ctl", generation: 2, tmux_status: { revision: 2, connection: { ...CONNECTED.connection!, version: "3.2" } } });
  expect(tab.tmuxStatus?.connection?.version).toBe("3.8");
  await receive(socket, { type: "tmux-status", id: "ctl", generation: 2, tmux_status: ENDED });
  expect(view()).toBeNull();
  // A new attachment's session frame is authoritative even at a lower revision.
  await receive(socket, { type: "session", id: "ctl", generation: 2, seq: 0, tmux_status: { revision: 1, connection: CONNECTED.connection } });
  expect(view()).not.toBeNull();
});

test("the session frame marks a tab that shows a tmux pane, and a fresh shell clears it", async () => {
  const { socket, tab } = await mounted();
  expect(tab.tmuxPane).toBeUndefined();
  await receive(socket, { type: "session", id: "pane-1", generation: 3, seq: 0, tmux_pane: { connection: 2, pane: "%7" } });
  expect(tab.tmuxPane).toEqual({ connection: 2, pane: "%7" });
  await receive(socket, { type: "session", id: "shell-2", generation: 4, seq: 0 });
  expect(tab.tmuxPane).toBeUndefined();
});
