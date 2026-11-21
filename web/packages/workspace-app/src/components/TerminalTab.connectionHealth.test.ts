// @vitest-environment jsdom

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import TerminalTab from "./TerminalTab.svelte";
import TerminalTabTestHarness from "./TerminalTabTestHarness.svelte";
import { WS_PING_MS, WS_PROBE_DEADLINE_MS, WS_READ_DEADLINE_MS, WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import { TERMINAL_INPUT_PROBE_MS, TERMINAL_INPUT_NOTICE_MS, TERMINAL_INPUT_NOTICE_MIN_MS } from "./terminalConnectionHealth.svelte";
import { ui } from "../state/store.svelte";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { broadcastTerminalInput, registerTerminalInputSink, sendPromptToTerminal } from "../state/tabs.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  TerminalSocket,
  terminalTab,
  xterm,
} from "../__tests__/terminalTab";

const connections = vi.hoisted(() => ({ all: [] as unknown[] }));
vi.mock("./terminalConnectionHealth.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./terminalConnectionHealth.svelte")>();
  return {
    ...actual,
    createTerminalConnectionHealth(...args: Parameters<typeof actual.createTerminalConnectionHealth>) {
      const connection = actual.createTerminalConnectionHealth(...args);
      connections.all.push(connection);
      return connection;
    },
  };
});
vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

installTerminalDom();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  TerminalSocket.connecting = false;
  ui.terminalControl = false;
  xterm.textareaFocus = true;
});

afterEach(() => {
  ui.disconnectBlocking = false;
  ui.terminalControl = false;
  resetTerminals();
  connections.all.splice(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pings(socket: TerminalSocket): number {
  return sentFrames(socket).filter((frame) => frame.type === "ping").length;
}

type TerminalConnectionHealth = ReturnType<(typeof import("./terminalConnectionHealth.svelte"))["createTerminalConnectionHealth"]>;
function lastConnection(): TerminalConnectionHealth {
  const connection = connections.all.at(-1) as TerminalConnectionHealth | undefined;
  if (!connection) throw new Error("expected a terminal connection");
  return connection;
}

describe("terminal connection in the tab", () => {
  test("a mouse report in flight when its socket closes owes no note", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "pong" });
    const before = pings(first);
    term.type("\x1b[<0;10;5M");
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_PROBE_MS + 1_000);
    expect(pings(first)).toBe(before);
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });
  test("a mouse report after a key leaves the key answered by the next pong", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "pong" });
    term.type("x");
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_PROBE_MS);
    expect(pings(first), "the key's ping left").toBe(2);
    term.type("\x1b[<0;10;5M");
    await receive(first, { type: "pong" });
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test.each(["server close", "read deadline"])("warns after unanswered input retires by %s", async (path) => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "pong" });
    term.type("x");
    if (path === "server close") first.close();
    else if (path === "read deadline") await vi.advanceTimersByTimeAsync(WS_READ_DEADLINE_MS + WS_PROBE_DEADLINE_MS);
    await tick();
    if (path === "server close") {
      expect(target.querySelector('[data-terminal-connection-pill]'), "no note while it reconnects").toBeNull();
    }
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    const next = TerminalSocket.all.at(-1)!;
    expect(next).not.toBe(first);
    await attach(next);
    await tick();
    const sentence = "Reconnected. Input typed while disconnected may not have been sent.";
    expect(target.querySelector('[data-terminal-connection-pill]')?.textContent?.trim()).toBe(sentence);
    expect(target.querySelector('[role="status"]')?.textContent).toBe(sentence);
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_NOTICE_MIN_MS);
    term.type("y");
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("a seeded tab with broadcast on sends nothing to the member", async () => {
    const [tab, member] = seatTerminals([
      terminalTab({ seedInput: "echo hi", broadcastEnabled: true }),
      terminalTab({ id: "term-2", broadcastEnabled: true }),
    ]);
    const received: Array<[string, boolean | undefined]> = [];
    const unregister = registerTerminalInputSink(member!.id, (data, binary) => received.push([data, binary]));
    try {
      await mountTerminal(TerminalTab, tab!, { focused: false });
      const first = TerminalSocket.all.at(-1)!;
      await attach(first);
      await output(first, "motd");
      await vi.advanceTimersByTimeAsync(200);
      expect(sentFrames(first).some((frame) => frame.type === "input")).toBe(true);
      expect(received).toEqual([]);
    } finally {
      unregister();
    }
  });

  test("an answered input and an idle socket retire without a warning", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "pong" });
    term.type("x");
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_PROBE_MS + 100);
    await receive(first, { type: "pong" });
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
    TerminalSocket.all.at(-1)!.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("an echoed key answered by a pong leaves no notice across a wake recycle", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "pong" });
    term.type("x");
    await output(first, "x");
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_PROBE_MS + 100);
    await receive(first, { type: "pong" });
    await vi.advanceTimersByTimeAsync(3900);
    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(2100 + WS_PROBE_DEADLINE_MS);
    await tick();
    const recycled = TerminalSocket.all.at(-1)!;
    expect(recycled).not.toBe(first);
    await attach(recycled);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("an echoed key answered by a pong leaves no notice across an unexpected close", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "pong" });
    term.type("x");
    await output(first, "x");
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_PROBE_MS + 100);
    await receive(first, { type: "pong" });
    await vi.advanceTimersByTimeAsync(3900);
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS + 1);
    expect(TerminalSocket.all.length).toBeGreaterThan(1);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("a wake over a healthy socket keeps it and shows no note", async () => {
    const { target } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "pong" });
    const dials = TerminalSocket.all.length;
    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(2100);
    await receive(first, { type: "pong" });
    await vi.advanceTimersByTimeAsync(WS_PROBE_DEADLINE_MS * 2);
    await tick();
    expect(TerminalSocket.all.length).toBe(dials);
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("a key typed during a wake's probe goes once to the replacement, with no note", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "pong" });
    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(2100);
    term.type("x");
    const typed = (socket: TerminalSocket) => sentFrames(socket).filter((frame) => frame.type === "input" && frame.data === "x");
    expect(typed(first), "held off the suspect socket").toEqual([]);
    await vi.advanceTimersByTimeAsync(WS_PROBE_DEADLINE_MS);
    const replacement = TerminalSocket.all.at(-1)!;
    expect(replacement).not.toBe(first);
    expect(typed(replacement), "not before the replacement has attached").toEqual([]);
    await attach(replacement);
    await tick();
    expect(typed(first)).toEqual([]);
    expect(typed(replacement)).toHaveLength(1);
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("a key sent before the wake was noticed still shows the note when the socket is replaced", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "pong" });
    term.type("x");
    expect(sentFrames(first).some((frame) => frame.type === "input" && frame.data === "x")).toBe(true);
    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(2100 + WS_PROBE_DEADLINE_MS);
    const replacement = TerminalSocket.all.at(-1)!;
    expect(replacement).not.toBe(first);
    await attach(replacement);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).not.toBeNull();
  });

  test("holds the reconnect warning under the cover then announces it once", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    term.type("x");
    first.close();
    ui.disconnectBlocking = true;
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
    const region = target.querySelector('[role="status"]');
    expect(region?.textContent).toBe("");
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_NOTICE_MS);
    ui.disconnectBlocking = false;
    await tick();
    expect(target.querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toBe("Reconnected. Input typed while disconnected may not have been sent.");
    expect(target.querySelector('[data-terminal-connection-pill]')).not.toBeNull();
  });

  test("keys refused while a read deadline's close is held warn on the next socket", async () => {
    // The desktop's embedded server takes no wake probe, so its read deadline
    // still closes the socket.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    onTestFinished(() => {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    first.holdClose = true;
    await attach(first);
    await receive(first, { type: "pong" });
    await vi.advanceTimersByTimeAsync(WS_READ_DEADLINE_MS + 1_000);
    await tick();
    expect(first.readyState).toBe(2);
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
    term.type("lost");
    expect(sentFrames(first).some((frame) => frame.type === "input" && frame.data === "lost")).toBe(false);
    first.finishClose();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')?.textContent?.trim()).toBe("Reconnected. Input typed while disconnected may not have been sent.");
  });
  test("input refused before the first socket opens creates no reconnection warning", async () => {
    TerminalSocket.connecting = true;
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    term.type("lost");
    expect(sentFrames(socket).some((frame) => frame.type === "input")).toBe(false);
    socket.open();
    await receive(socket, { type: "session", id: "sess-1", seq: 0, generation: 1, missed_bytes: 0, bytes_since_focus: 0 });
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("an automatic lead identity prompt refused on first connect creates no warning", async () => {
    TerminalSocket.connecting = true;
    const tab = terminalTab();
    const { target } = await mountTerminal(TerminalTab, tab, { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    expect(sendPromptToTerminal(tab.id, "identity", "codex")).toBe(false);
    await attach(first);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("an automatic lead identity retry after a disconnect creates no lost-input warning", async () => {
    const tab = terminalTab();
    const { target } = await mountTerminal(TerminalTab, tab, { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    first.close();
    expect(sendPromptToTerminal(tab.id, "identity", "codex")).toBe(false);
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("a sent lead identity prompt arms no probe and seeds no lost-input notice", async () => {
    const tab = terminalTab();
    const { target } = await mountTerminal(TerminalTab, tab, { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    const before = pings(first);
    expect(sendPromptToTerminal(tab.id, "identity", "codex")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(first)).toBe(before);
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("a refused Rich Prompt submit warns on the next socket", async () => {
    const tab = terminalTab();
    const { target } = await mountTerminal(TerminalTab, tab, { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    first.holdClose = true;
    first.close();
    expect(sendPromptToTerminal(tab.id, "lost", "codex", "p-1")).toBe(false);
    first.finishClose();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')?.textContent?.trim()).toBe("Reconnected. Input typed while disconnected may not have been sent.");
  });

  test("a refused broadcast input sink warns the receiving terminal on its next socket", async () => {
    const [member, targetTab] = seatTerminals([
      terminalTab({ id: "member", broadcastEnabled: true }),
      terminalTab({ id: "target", broadcastEnabled: true }),
    ]);
    const { target } = await mountTerminal(TerminalTab, targetTab!, { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    first.holdClose = true;
    first.close();
    broadcastTerminalInput(member!, "lost");
    first.finishClose();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')?.textContent?.trim()).toBe("Reconnected. Input typed while disconnected may not have been sent.");
  });

  test("an exited terminal carries no refused keys into Restart", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: true });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    await receive(first, { type: "exit", code: 0 });
    first.close();
    term.type("x");
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(2));
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });
  test("broadcast input on an exited terminal does not call inputRefused", async () => {
    const [member, targetTab] = seatTerminals([
      terminalTab({ id: "member", broadcastEnabled: true }),
      terminalTab({ id: "target", broadcastEnabled: true }),
    ]);
    await mountTerminal(TerminalTab, targetTab!, { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "exit", code: 0 });
    socket.close();
    const refused = vi.spyOn(lastConnection(), "inputRefused");
    broadcastTerminalInput(member!, "lost");
    expect(refused).not.toHaveBeenCalled();
  });

  test("Rich Prompt on an exited terminal does not call inputRefused", async () => {
    const tab = terminalTab();
    await mountTerminal(TerminalTab, tab, { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "exit", code: 0 });
    socket.close();
    const refused = vi.spyOn(lastConnection(), "inputRefused");
    expect(sendPromptToTerminal(tab.id, "lost", "codex", "p-1")).toBe(false);
    expect(refused).not.toHaveBeenCalled();
  });

  test("continued typing leaves a new lost-input warning visible for four seconds", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    term.type("lost");
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    const sentence = "Reconnected. Input typed while disconnected may not have been sent.";
    term.type("early");
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')?.textContent?.trim()).toBe(sentence);
    await vi.advanceTimersByTimeAsync(3_999);
    term.type("still early");
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')?.textContent?.trim()).toBe(sentence);
    await vi.advanceTimersByTimeAsync(1);
    term.type("next");
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("a refused mouse report creates no lost-input notice", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    first.holdClose = true;
    first.close();
    term.type("\x1b[<0;10;5M");
    first.finishClose();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("an inactive tab holds its reconnect notice until it is shown", async () => {
    const { target, term, component } = await mountTerminal(TerminalTabTestHarness, terminalTab(), { focused: false });
    const harness = component as { hide: () => void; show: () => void };
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    term.type("x");
    first.close();
    harness.hide();
    await tick();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_NOTICE_MS * 2);
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
    harness.show();
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_NOTICE_MS);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("the tab passes its find and inspector geometry to the pill", async () => {
    const tab = terminalTab({ inspectorOpen: true, inspectorWidth: 220 });
    const { target, term } = await mountTerminal(TerminalTab, tab);
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    term.type("x");
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    const pill = target.querySelector<HTMLElement>('[data-terminal-connection-pill]')!;
    expect(pill.style.right).toBe("249px");
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.find.open" } }));
    await tick();
    expect(target.querySelector(".terminal-find")).not.toBeNull();
    expect(pill.style.top).toBe("50px");
  });
  test("a connected notice expires at twelve seconds and refused input owes the next one", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    term.type("x");
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    const second = TerminalSocket.all.at(-1)!;
    await attach(second);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(TERMINAL_INPUT_NOTICE_MS);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
    second.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    const third = TerminalSocket.all.at(-1)!;
    await attach(third);
    lastConnection().inputRefused();
    third.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    const fourth = TerminalSocket.all.at(-1)!;
    await attach(fourth);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).not.toBeNull();
  });

  test("pings at open and again 1 s after a key", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    expect(target.querySelector("[data-terminal-connection-pill]")).toBeNull();
    expect(pings(socket)).toBe(1);
    await receive(socket, { type: "pong" });
    term.type("x");
    expect(sentFrames(socket).some((frame) => frame.type === "input" && frame.data === "x")).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(pings(socket)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(socket)).toBe(2);
    await vi.advanceTimersByTimeAsync(WS_PING_MS);
    await tick();
    expect(target.querySelector("[data-terminal-connection-pill]"), "an unanswered ping shows nothing").toBeNull();
  });

  test("the note moves no row: it neither fits the terminal nor sends a grid", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    term.type("x");
    first.close();
    ui.disconnectBlocking = true;
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    const second = TerminalSocket.all.at(-1)!;
    await attach(second);
    await tick();
    expect(target.querySelector("[data-terminal-connection-pill]"), "held under the cover").toBeNull();
    const fitCalls = xterm.fit.calls;
    const resizeFrames = sentFrames(second).filter((frame) => frame.type === "resize");
    ui.disconnectBlocking = false;
    await tick();
    const pill = target.querySelector<HTMLElement>("[data-terminal-connection-pill]")!;
    expect(pill.parentElement?.classList.contains("terminal-main")).toBe(true);
    expect(xterm.fit.calls).toBe(fitCalls);
    expect(sentFrames(second).filter((frame) => frame.type === "resize")).toEqual(resizeFrames);
  });
  test("binary PTY output does not cancel a pending input probe", async () => {
    const { term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    term.type("x");
    await vi.advanceTimersByTimeAsync(500);
    await output(socket, "answer");
    await vi.advanceTimersByTimeAsync(500);
    expect(pings(socket)).toBe(2);
  });

  test("the control terminal sends neither an opening ping nor an input probe", async () => {
    ui.terminalControl = true;
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    const opened = vi.spyOn(lastConnection(), "opened");
    await attach(socket);
    expect(opened).not.toHaveBeenCalled();
    term.type("password");
    await vi.advanceTimersByTimeAsync(WS_PING_MS + TERMINAL_INPUT_PROBE_MS);
    await tick();
    expect(pings(socket)).toBe(0);
    expect(TerminalSocket.all).toHaveLength(1);
    expect(target.querySelector("[data-terminal-connection-pill]")).toBeNull();
  });

  test("a Rich Prompt submit arms the input probe", async () => {
    const tab = terminalTab();
    await mountTerminal(TerminalTab, tab, { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    expect(sendPromptToTerminal(tab.id, "run it", "codex", "p-1")).toBe(true);
    expect(sentFrames(socket).some((frame) => frame.type === "prompt" && frame.data === "run it")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(2);
  });

  test("a generated terminal reply does not arm the input probe", async () => {
    const { term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    term.replyDuringWrite = "\x1b[1;1R";
    await output(socket, "\x1b[6n");
    expect(sentFrames(socket).some((frame) => frame.type === "input" && frame.data === "\x1b[1;1R")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(1);
  });

  test("a focus report does not arm the input probe", async () => {
    const { term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    term.type("\x1b[I");
    expect(sentFrames(socket).some((frame) => frame.type === "input" && frame.data === "\x1b[I")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(1);
  });

  test("a mouse report does not arm the input probe", async () => {
    const { term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    term.binary("\x1b[M !!");
    expect(sentFrames(socket).some((frame) => frame.type === "input" && frame.binary === true)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(1);
  });

  test("an SGR mouse report delivered through xterm data does not arm the input probe", async () => {
    const { term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    term.type("\x1b[<0;10;5M");
    expect(sentFrames(socket).some((frame) => frame.type === "input" && frame.data === "\x1b[<0;10;5M")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(1);
  });

  test("an automatic prompt seed does not arm the input probe", async () => {
    await mountTerminal(TerminalTab, terminalTab({ seedInput: "seed" }), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await output(socket, "prompt");
    await vi.advanceTimersByTimeAsync(150);
    expect(sentFrames(socket).some((frame) => frame.type === "input" && String(frame.data).includes("seed"))).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(1);
  });

  test("input sent through the terminal input sink arms the probe", async () => {
    const [member, targetTab] = seatTerminals([
      terminalTab({ id: "member", broadcastEnabled: true }),
      terminalTab({ id: "target", broadcastEnabled: true }),
    ]);
    await mountTerminal(TerminalTab, targetTab!, { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    broadcastTerminalInput(member!, "typed");
    expect(sentFrames(socket).some((frame) => frame.type === "input" && frame.data === "typed")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(2);
  });

  test("mouse reports sent through the terminal input sink do not arm the probe", async () => {
    const [member, targetTab] = seatTerminals([
      terminalTab({ id: "member", broadcastEnabled: true }),
      terminalTab({ id: "target", broadcastEnabled: true }),
    ]);
    await mountTerminal(TerminalTab, targetTab!, { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    broadcastTerminalInput(member!, "\x1b[M !!", true);
    broadcastTerminalInput(member!, "\x1b[<0;10;5M");
    expect(sentFrames(socket).filter((frame) => frame.type === "input")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(1);
  });

  test("reports the opening ping before the socket sends it", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    const reported = vi.spyOn(lastConnection(), "pingSent");
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (JSON.parse(data).type === "ping") {
        expect(reported).toHaveBeenCalledTimes(1);
        void socket.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
      }
      send(data);
    };
    await attach(socket);
    await tick();
    expect(pings(socket)).toBe(1);
  });

  test("opens the probe for each socket after a redial", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const opened = vi.spyOn(lastConnection(), "opened");
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    expect(opened).toHaveBeenCalledTimes(1);
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    await attach(TerminalSocket.all.at(-1)!);
    expect(opened).toHaveBeenCalledTimes(2);
  });

  test("retires the probe when an open socket closes", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    const retired = vi.spyOn(lastConnection(), "retired");
    socket.close();
    expect(retired).toHaveBeenCalledTimes(1);
  });

  test("retires the probe when an intentional restart closes the socket", async () => {
    const { target } = await mountTerminal(TerminalTab, terminalTab(), { focused: true });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    const retired = vi.spyOn(lastConnection(), "retired");
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    expect(confirmState.open).toBe(true);
    resolveConfirm(true);
    await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(2));
    expect(retired).toHaveBeenCalled();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("keys refused during a requested restart do not warn on the new shell", async () => {
    const { target } = await mountTerminal(TerminalTab, terminalTab(), { focused: true });
    await attach(TerminalSocket.all.at(-1)!);
    TerminalSocket.connecting = true;
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    expect(confirmState.open).toBe(true);
    resolveConfirm(true);
    await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(2));
    const second = TerminalSocket.all.at(-1)!;
    xterm.terminals.at(-1)!.type("before open");
    expect(sentFrames(second).some((frame) => frame.type === "input")).toBe(false);
    await attach(second);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("a requested restart discards a pending lost-input warning", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: true });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    term.type("unanswered");
    first.close();
    TerminalSocket.connecting = true;
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    expect(confirmState.open).toBe(true);
    resolveConfirm(true);
    await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(2));
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("a requested restart drops unanswered input from the old shell's notice accounting", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: true });
    const first = TerminalSocket.all.at(-1)!;
    await attach(first);
    term.type("unanswered");
    TerminalSocket.connecting = true;
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    expect(confirmState.open).toBe(true);
    resolveConfirm(true);
    await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(2));
    await attach(TerminalSocket.all.at(-1)!);
    await tick();
    expect(target.querySelector('[data-terminal-connection-pill]')).toBeNull();
  });

  test("disposes the terminal probe when the component unmounts", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const dispose = vi.spyOn(lastConnection(), "dispose");
    resetTerminals();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
