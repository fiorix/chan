// @vitest-environment jsdom
//
// Whether a terminal masks secrets is state on its tab; what hides them on
// the screen is the terminal's masker. Every way that state changes has to
// reach the masker: the launcher's row, a chord assigned to the command, the
// body menu's row, Privacy mode switched while the terminal runs, and a
// masker built after the state was already on. The stand-in xterm here holds
// one buffer line with a secret in it and keeps the decorations a masker
// registers, so each case reads the mask over the secret's cells, never the
// check a row draws.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import { privacy } from "@chan/web-shared/privacy";
import TerminalTab from "./TerminalTab.svelte";
import type { TerminalPreferences } from "../api/types";
import { terminalPreferences } from "../__tests__/standalone";
import { commandById, commandContext, commandTitle, type Command } from "../state/commands";
import { __testSetStandalonePreferences, ui } from "../state/store.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import {
  attach,
  FakeTerminal,
  installTerminalDom,
  menuRow,
  mountTerminal,
  openBodyMenu,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

const MASKING = "app.terminal.secretMasking.toggle";

/// The one line every stand-in terminal holds, and the cells of its value.
const SECRET_LINE = "API_TOKEN=hunter2";
const MASKED = [{ x: "API_TOKEN=".length, width: "hunter2".length }];

type Mask = { x: number; width: number };

/// The live decorations of each stand-in terminal.
const masks = new WeakMap<object, Set<Mask>>();

/// When set, a stand-in terminal registers no decoration, which a masker
/// reads as its own failure.
let refuseDecorations = false;

// What a masker reads and paints on, given to the stand-in xterm: a buffer
// of the one line, and markers and decorations that live until disposed.
const standIn = FakeTerminal.prototype as unknown as Record<string, unknown>;
Object.defineProperty(standIn, "buffer", {
  configurable: true,
  get(this: FakeTerminal) {
    const cols = this.cols;
    const text = SECRET_LINE.padEnd(cols, " ");
    const line = {
      isWrapped: false,
      translateToString: (_trimRight?: boolean, start = 0, end = cols) => text.slice(start, end),
      getCell: (x: number) =>
        x < cols ? { getWidth: () => 1, getChars: () => text[x]!.trim() } : undefined,
    };
    return {
      active: {
        type: "normal",
        baseY: 0,
        cursorY: 0,
        viewportY: 0,
        length: 1,
        getLine: (row: number) => (row === 0 ? line : undefined),
      },
    };
  },
});
standIn.registerMarker = function (offset = 0) {
  return {
    line: offset,
    isDisposed: false,
    dispose() {
      this.isDisposed = true;
    },
  };
};
standIn.registerDecoration = function (this: FakeTerminal, options: Mask & { marker: unknown }) {
  if (refuseDecorations) return undefined;
  const live = masks.get(this) ?? new Set<Mask>();
  masks.set(this, live);
  const mask = { x: options.x, width: options.width };
  const disposed: Array<() => void> = [];
  live.add(mask);
  return {
    marker: options.marker,
    isDisposed: false,
    onDispose(listener: () => void) {
      disposed.push(listener);
    },
    onRender() {},
    dispose() {
      if (this.isDisposed) return;
      this.isDisposed = true;
      live.delete(mask);
      for (const listener of disposed) listener();
    },
  };
};

/// The masks painted on the terminal now.
function painted(term: FakeTerminal): Mask[] {
  return [...(masks.get(term) ?? [])];
}

function masking(): Command {
  const command = commandById(MASKING);
  if (!command) throw new Error(`no command ${MASKING}`);
  return command;
}

const startControl = ui.terminalControl;

afterEach(() => {
  resetTerminals();
  privacy.enabled = false;
  privacy.mask_terminal_secrets = false;
  __testSetStandalonePreferences(null);
  ui.terminalControl = startControl;
  refuseDecorations = false;
  installTerminalDom();
  vi.restoreAllMocks();
});

/// A terminal attached to its session, its masking seeded from `prefs`.
async function running(prefs: Partial<TerminalPreferences> = { secret_masking: false }, tab?: TerminalTabState) {
  __testSetStandalonePreferences(terminalPreferences(prefs));
  const seated = tab ?? seatTerminals([terminalTab()])[0]!;
  const mounted = await mountTerminal(TerminalTab, seated);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  return { ...mounted, tab: seated, socket };
}

/// A width change, at which a masker that is on rescans the rows on screen.
/// A masker built on paints at its first scan, not at its construction.
function rescan(term: FakeTerminal): void {
  term.resize(term.cols + 1, term.rows);
}

describe("a running terminal's masker follows its tab's masking", () => {
  test("from the launcher's row", async () => {
    const { term } = await running();
    expect(painted(term)).toEqual([]);

    // What the launcher's row runs.
    masking().run();
    await tick();
    expect(painted(term), "on").toEqual(MASKED);

    masking().run();
    await tick();
    expect(painted(term), "off again").toEqual([]);
  });

  test("from a chord assigned to the command", async () => {
    const { term } = await running();
    const command = masking();
    expect(command.available(commandContext()), "offered on the focused terminal").toBe(true);

    // What the page's key handler runs for a chord the user assigned.
    command.run(undefined, "chord");
    await tick();
    expect(painted(term), "on").toEqual(MASKED);

    command.run(undefined, "chord");
    await tick();
    expect(painted(term), "off again").toEqual([]);
  });

  test("from the body menu's row", async () => {
    const { term, target } = await running();
    await openBodyMenu(target);
    menuRow(commandTitle(MASKING)).click();
    await tick();
    expect(painted(term), "on").toEqual(MASKED);

    await openBodyMenu(target);
    menuRow(commandTitle(MASKING)).click();
    await tick();
    expect(painted(term), "off again").toEqual([]);
  });

  test("from Privacy mode switched on and off, over the terminal's own choice", async () => {
    const { term } = await running();
    privacy.enabled = true;
    await tick();
    expect(painted(term), "Privacy mode alone masks no terminal").toEqual([]);

    privacy.mask_terminal_secrets = true;
    await tick();
    expect(painted(term), "Privacy mode with its terminal option").toEqual(MASKED);

    privacy.enabled = false;
    await tick();
    expect(painted(term), "the terminal's own choice shows again").toEqual([]);
  });

  test("Privacy mode switched off leaves a terminal that chose masking masked", async () => {
    const { term } = await running({ secret_masking: true });
    rescan(term);
    expect(painted(term)).toEqual(MASKED);

    privacy.enabled = true;
    privacy.mask_terminal_secrets = true;
    await tick();
    privacy.enabled = false;
    await tick();
    expect(painted(term)).toEqual(MASKED);
  });
});

describe("a masker built after its tab's masking was already on", () => {
  test("is on from Privacy mode switched on before the terminal was drawn", async () => {
    privacy.enabled = true;
    privacy.mask_terminal_secrets = true;
    const { term } = await running();
    rescan(term);
    expect(painted(term)).toEqual(MASKED);

    privacy.mask_terminal_secrets = false;
    await tick();
    expect(painted(term), "and follows it off").toEqual([]);
  });

  test("is on from the command run while the terminal was still starting", async () => {
    // The terminal waits for its font before it builds its renderer and its
    // masker; the tab's masking is seeded before that wait.
    let fontLoaded: (faces: unknown[]) => void = () => {};
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: () => new Promise((resolve) => (fontLoaded = resolve)), ready: Promise.resolve() },
    });
    __testSetStandalonePreferences(terminalPreferences({ secret_masking: false, font: "source-code-pro" }));
    const [tab] = seatTerminals([terminalTab()]);
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(TerminalTab, {
      target,
      props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true },
    });
    try {
      await tick();
      await tick();
      expect(xterm.terminals, "no terminal while the font loads").toHaveLength(0);
      expect(tab!.secretMasking, "seeded off").toBe(false);

      masking().run();
      fontLoaded([{}]);
      await vi.waitFor(() => expect(xterm.terminals).toHaveLength(1));
      const term = xterm.terminals[0]!;
      await attach(TerminalSocket.all.at(-1)!);
      rescan(term);
      expect(painted(term)).toEqual(MASKED);
    } finally {
      unmount(component);
    }
  });
});

// A masker that fails leaves its mark on the tab, and masking stays off for
// that masker whatever asks for it.
describe("a masker's failure", () => {
  async function failed() {
    privacy.enabled = true;
    privacy.mask_terminal_secrets = true;
    refuseDecorations = true;
    const mounted = await running();
    rescan(mounted.term);
    expect(mounted.tab.secretMaskingFailed, "the masker failed").toBe(true);
    expect(ui.status).toBe("Secret masking stopped working in this terminal");
    refuseDecorations = false;
    return mounted;
  }

  test("holds masking off on that masker, Privacy mode included, until its toggle tries again", async () => {
    const { term, tab } = await failed();
    rescan(term);
    expect(painted(term)).toEqual([]);

    masking().run();
    await tick();
    expect([tab.secretMaskingFailed, painted(term)]).toEqual([false, MASKED]);
  });
});
