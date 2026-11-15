// @vitest-environment jsdom

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import TerminalTab from "./TerminalTab.svelte";
import { WS_PING_MS, WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import { LINK_STALLED_MS } from "../api/linkProbe";
import { ui } from "../state/store.svelte";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { broadcastTerminalInput, sendPromptToTerminal } from "../state/tabs.svelte";
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

const links = vi.hoisted(() => ({ all: [] as unknown[] }));
vi.mock("./terminalLink.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./terminalLink.svelte")>();
  return {
    ...actual,
    createTerminalLink(...args: Parameters<typeof actual.createTerminalLink>) {
      const link = actual.createTerminalLink(...args);
      links.all.push(link);
      return link;
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
  links.all.splice(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pings(socket: TerminalSocket): number {
  return sentFrames(socket).filter((frame) => frame.type === "ping").length;
}

type TerminalLink = ReturnType<(typeof import("./terminalLink.svelte"))["createTerminalLink"]>;
function lastLink(): TerminalLink {
  const link = links.all.at(-1) as TerminalLink | undefined;
  if (!link) throw new Error("expected a terminal link");
  return link;
}

describe("terminal link in the tab", () => {
  test("times the heartbeat pong, probes silent input and removes its strip on the first frame without resizing", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    expect(target.querySelector("[data-terminal-stall-strip]")).toBeNull();
    expect(pings(socket)).toBe(1);
    await receive(socket, { type: "pong" });
    term.type("x");
    expect(sentFrames(socket).some((frame) => frame.type === "input" && frame.data === "x")).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(pings(socket)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(socket)).toBe(2);

    const fitCalls = xterm.fit.calls;
    const resizeFrames = sentFrames(socket).filter((frame) => frame.type === "resize");
    await vi.advanceTimersByTimeAsync(LINK_STALLED_MS);
    await tick();
    const strip = target.querySelector<HTMLElement>("[data-terminal-stall-strip]")!;
    expect(strip.textContent).toContain("No response for 4 s. Waiting for the connection.");
    expect(strip.parentElement?.classList.contains("terminal-main")).toBe(true);
    expect(xterm.fit.calls).toBe(fitCalls);
    expect(sentFrames(socket).filter((frame) => frame.type === "resize")).toEqual(resizeFrames);

    term.type("y");
    expect(sentFrames(socket).some((frame) => frame.type === "input" && frame.data === "y")).toBe(true);
    const announced = target.querySelector('[role="status"]');
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    expect(target.querySelector('[role="status"]')).toBe(announced);
    expect(strip.textContent).toContain("No response for 5 s.");

    await output(socket, "first output");
    await tick();
    expect(target.querySelector("[data-terminal-stall-strip]")).toBeNull();
  });

  test("binary PTY output cancels a pending input probe", async () => {
    const { term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    term.type("x");
    await vi.advanceTimersByTimeAsync(500);
    await output(socket, "answer");
    await vi.advanceTimersByTimeAsync(500);
    expect(pings(socket)).toBe(1);
  });

  test("hides the stalled strip under the window reconnecting cover", async () => {
    const { target } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    await vi.advanceTimersByTimeAsync(WS_PING_MS + LINK_STALLED_MS);
    await tick();
    expect(target.querySelector("[data-terminal-stall-strip]")).not.toBeNull();
    ui.disconnectBlocking = true;
    await tick();
    expect(target.querySelector("[data-terminal-stall-strip]")).toBeNull();
    ui.disconnectBlocking = false;
    await tick();
    expect(target.querySelector("[data-terminal-stall-strip]")).not.toBeNull();
  });

  test("an exited terminal never shows a stalled strip while its socket is still open", async () => {
    const { target } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    await receive(socket, { type: "exit", code: 0 });
    await vi.advanceTimersByTimeAsync(WS_PING_MS + LINK_STALLED_MS);
    await tick();
    expect(pings(socket)).toBe(2);
    expect(target.querySelector("[data-terminal-stall-strip]")).toBeNull();
  });

  test("a dropped socket clears its stall before a redial and the next socket needs its own pong", async () => {
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    await vi.advanceTimersByTimeAsync(WS_PING_MS + LINK_STALLED_MS);
    await tick();
    expect(target.querySelector("[data-terminal-stall-strip]")).not.toBeNull();
    socket.close();
    await tick();
    expect(target.querySelector("[data-terminal-stall-strip]")).toBeNull();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
    const redial = TerminalSocket.all.at(-1)!;
    expect(redial).not.toBe(socket);
    await attach(redial);
    expect(pings(redial)).toBe(1);
    await vi.advanceTimersByTimeAsync(LINK_STALLED_MS);
    expect(target.querySelector("[data-terminal-stall-strip]")).toBeNull();
    await receive(redial, { type: "pong" });
    term.type("x");
    await vi.advanceTimersByTimeAsync(1_000 + LINK_STALLED_MS);
    await tick();
    expect(target.querySelector("[data-terminal-stall-strip]")).not.toBeNull();
  });

  test("the control terminal sends neither an opening ping nor an input probe", async () => {
    ui.terminalControl = true;
    const { target, term } = await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    const opened = vi.spyOn(lastLink(), "opened");
    await attach(socket);
    expect(opened).not.toHaveBeenCalled();
    term.type("password");
    await vi.advanceTimersByTimeAsync(WS_PING_MS + LINK_STALLED_MS);
    expect(pings(socket)).toBe(0);
    expect(target.querySelector("[data-terminal-stall-strip]")).toBeNull();
  });

  test("a Rich Prompt submit arms the input probe", async () => {
    const tab = terminalTab();
    const { target } = await mountTerminal(TerminalTab, tab, { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    expect(sendPromptToTerminal(tab.id, "run it", "codex", "p-1")).toBe(true);
    expect(sentFrames(socket).some((frame) => frame.type === "prompt" && frame.data === "run it")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pings(socket)).toBe(2);
    await vi.advanceTimersByTimeAsync(LINK_STALLED_MS);
    await tick();
    expect(target.querySelector("[data-terminal-stall-strip]")).not.toBeNull();
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
    const { target } = await mountTerminal(TerminalTab, targetTab!, { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "pong" });
    broadcastTerminalInput(member!, "typed");
    expect(sentFrames(socket).some((frame) => frame.type === "input" && frame.data === "typed")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000 + LINK_STALLED_MS);
    await tick();
    expect(target.querySelector("[data-terminal-stall-strip]")).not.toBeNull();
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
    const reported = vi.spyOn(lastLink(), "pingSent");
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
    expect(lastLink().state.rttMs).toBe(0);
  });

  test("opens the probe for each socket after a redial", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const opened = vi.spyOn(lastLink(), "opened");
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
    const retired = vi.spyOn(lastLink(), "retired");
    socket.close();
    expect(retired).toHaveBeenCalledTimes(1);
  });

  test("retires the probe when an intentional restart closes the socket", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: true });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    const retired = vi.spyOn(lastLink(), "retired");
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    expect(confirmState.open).toBe(true);
    resolveConfirm(true);
    await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(2));
    expect(retired).toHaveBeenCalled();
  });

  test("disposes the terminal probe when the component unmounts", async () => {
    await mountTerminal(TerminalTab, terminalTab(), { focused: false });
    const dispose = vi.spyOn(lastLink(), "dispose");
    resetTerminals();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
