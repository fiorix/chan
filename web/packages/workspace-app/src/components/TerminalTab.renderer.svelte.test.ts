// @vitest-environment jsdom
//
// A terminal's renderer: the WebGL addon wherever the host supports it, and
// the repaints that keep its rows fresh across focus changes, host resumes
// and the ready frame. A TerminalTab is mounted over the stand-in xterm,
// whose WebGL addon and row refreshes are recorded; the desktop check is
// stubbed so each test picks the host.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({ desktop: false }));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/desktop")>()),
  isTauriDesktop: () => host.desktop,
}));

import TerminalTab from "./TerminalTab.svelte";
import { WEBGL_RENDERER_OVERRIDE_KEY } from "../terminal/renderer";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

beforeEach(() => {
  host.desktop = false;
  localStorage.removeItem(WEBGL_RENDERER_OVERRIDE_KEY);
  document.head.querySelector('meta[name="chan-webgl-renderer"]')?.remove();
});

afterEach(() => {
  resetTerminals();
  localStorage.removeItem(WEBGL_RENDERER_OVERRIDE_KEY);
  document.head.querySelector('meta[name="chan-webgl-renderer"]')?.remove();
  vi.restoreAllMocks();
});

async function mounted() {
  const [tab] = seatTerminals([terminalTab()]);
  const result = await mountTerminal(TerminalTab, tab!);
  return { ...result, socket: TerminalSocket.all.at(-1)! };
}

function serveRendererSignal(content: string): void {
  const meta = document.createElement("meta");
  meta.name = "chan-webgl-renderer";
  meta.content = content;
  document.head.append(meta);
}

describe("the WebGL renderer", () => {
  test("is loaded onto the terminal in a browser", async () => {
    const { term } = await mounted();
    expect(xterm.webgl).toHaveLength(1);
    expect(xterm.webgl[0]!.loadedInto).toBe(term);
  });

  test("on the desktop, is loaded only when the shell serves the WebGL signal", async () => {
    host.desktop = true;
    await mounted();
    expect(xterm.webgl, "an unclassified desktop stays on DOM").toHaveLength(0);
    resetTerminals();

    serveRendererSignal("1");
    await mounted();
    expect(xterm.webgl).toHaveLength(1);
  });

  test("a local override decides over the host", async () => {
    localStorage.setItem(WEBGL_RENDERER_OVERRIDE_KEY, "0");
    await mounted();
    expect(xterm.webgl).toHaveLength(0);
    resetTerminals();

    host.desktop = true;
    localStorage.setItem(WEBGL_RENDERER_OVERRIDE_KEY, "1");
    await mounted();
    expect(xterm.webgl).toHaveLength(1);
  });

  test("a lost context is disposed and the renderer made again, three times at most", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await mounted();
    for (let loss = 1; loss <= 4; loss += 1) {
      const current = xterm.webgl.at(-1)!;
      current.onContextLoss!();
      await tick();
      expect(current.disposed, `loss ${loss} disposes`).toBe(true);
    }
    expect(xterm.webgl, "the first renderer and three remakes").toHaveLength(4);
  });

  test("a renderer that cannot be made leaves the terminal mounted on DOM", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    xterm.webglThrows = true;
    const { term } = await mounted();
    expect(term.element).not.toBeNull();
    expect(xterm.webgl).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("falling back to DOM"))).toBe(true);
  });
});

describe("the repaints", () => {
  test("gaining and losing focus repaints every row", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const props = $state({ tab: tab!, paneId: TERMINAL_PANE, side: "a" as const, active: true, focused: false });
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(TerminalTab, { target, props });
    await vi.waitFor(() => expect(xterm.terminals).toHaveLength(1));
    const term = xterm.terminals[0]!;
    await new Promise((r) => setTimeout(r, 300));

    for (const focused of [true, false]) {
      term.refreshCalls.splice(0);
      props.focused = focused;
      flushSync();
      await tick();
      expect(term.refreshCalls, focused ? "on focus" : "on blur").toContainEqual([0, term.rows - 1]);
    }
    unmount(component);
  });

  test("a host resume repaints at once and again 50 and 250ms later", async () => {
    const { term } = await mounted();
    await new Promise((r) => setTimeout(r, 300));
    term.refreshCalls.splice(0);

    window.dispatchEvent(new Event("pageshow"));
    await tick();
    const atOnce = term.refreshCalls.length;
    expect(atOnce).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(term.refreshCalls.length).toBe(atOnce * 3);
  });

  test("the ready frame repaints", async () => {
    const { term, socket } = await mounted();
    await attach(socket);
    await new Promise((r) => setTimeout(r, 300));
    term.refreshCalls.splice(0);

    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await tick();
    expect(term.refreshCalls.length).toBeGreaterThan(0);
  });
});

describe("PTY output", () => {
  test("reaches xterm as bytes, so multi-byte glyphs arrive intact", async () => {
    const { term, socket } = await mounted();
    await attach(socket);
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await output(socket, "héllo ✓");

    const raw = term.writtenRaw.at(-1);
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(raw as Uint8Array)).toBe("héllo ✓");
  });
});
