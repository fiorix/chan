// @vitest-environment jsdom
//
// Whether a terminal masks secrets is state on its tab; what hides them on
// the screen is the terminal's masker. Every way that state changes has to
// reach the masker: the launcher's row, a chord assigned to the command, the
// body menu's row, Privacy mode switched while the terminal runs, and a
// masker built after the state was already on. A real widget parses the
// secret, and the software canvas reads the mask painted over its cells.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import { privacy } from "@chan/web-shared/privacy";
import TerminalTab from "./TerminalTab.svelte";
import type { TerminalPreferences } from "../api/types";
import { terminalPreferences } from "../__tests__/standalone";
import { commandById, commandContext, commandTitle, type Command } from "../state/commands";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { __testSetStandalonePreferences, ui } from "../state/store.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import {
  attach,
  installTerminalDom,
  menuRow,
  openBodyMenu,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";

import type { Terminal } from "@chan/ghostty-web-ng";
import { ghosttyFixture, installSoftwareCanvas, mountGhosttyTerminal, openedGhostty } from "../__tests__/ghosttyTab";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";

installTerminalDom();

const MASKING = "app.terminal.secretMasking.toggle";

const SECRET_LINE = "API_TOKEN=hunter2";
const MASKED = [{ x: "API_TOKEN=".length, width: "hunter2".length }];
type Mask = { x: number; width: number };

let canvas: ReturnType<typeof installSoftwareCanvas>;
let refuseMaskPaint = false;

beforeEach(() => {
  canvas = installSoftwareCanvas();
  const fill = SoftwareCanvasContext.prototype.fillRect;
  vi.spyOn(SoftwareCanvasContext.prototype, "fillRect").mockImplementation(function (this: SoftwareCanvasContext, x, y, width, height) {
    if (this.fillStyle === "#6c6c70") {
      if (refuseMaskPaint) throw new Error("mask paint refused");
    }
    fill.call(this, x, y, width, height);
  });
});

/// Advance a real renderer frame and read the secret-mask color over the first row's cells.
function painted(term: Terminal): Mask[] {
  const context = canvas.context(term.element!);
  canvas.frame();
  const spans: Mask[] = [];
  for (let x = 0; x < term.cols; x++) {
    const pixel = context.pixelAt(x * 8 + 4, 9);
    if (pixel.r !== 108 || pixel.g !== 108 || pixel.b !== 112 || pixel.a !== 1) continue;
    const previous = spans.at(-1);
    if (previous && previous.x + previous.width === x) previous.width += 1;
    else spans.push({ x, width: 1 });
  }
  return spans;
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
  refuseMaskPaint = false;
  installTerminalDom();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/// A terminal attached to its session, its masking seeded from `prefs`.
async function running(prefs: Partial<TerminalPreferences> = { secret_masking: false }, tab?: TerminalTabState) {
  __testSetStandalonePreferences(terminalPreferences(prefs));
  const seated = tab ?? seatTerminals([terminalTab()])[0]!;
  const mounted = await mountGhosttyTerminal(TerminalTab, seated);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, SECRET_LINE);
  return { ...mounted, tab: seated, socket };
}

/// A width change, at which a masker that is on rescans the rows on screen.
/// A masker built on paints at its first scan, not at its construction.
function rescan(term: Terminal): void {
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
      expect(ghosttyFixture.terminals, "no terminal while the font loads").toHaveLength(0);
      expect(tab!.secretMasking, "seeded off").toBe(false);

      masking().run();
      fontLoaded([{}]);
      await vi.waitFor(() => expect(ghosttyFixture.terminals).toHaveLength(1));
      const term = ghosttyFixture.terminals[0]!;
      await attach(TerminalSocket.all.at(-1)!);
      await output(TerminalSocket.all.at(-1)!, SECRET_LINE);
      rescan(term);
      expect(painted(term)).toEqual(MASKED);
    } finally {
      unmount(component);
    }
  });
});

describe("a secret in an attach replay", () => {
  test("is masked in the frame that draws it, and stays masked once the replay ends", async () => {
    __testSetStandalonePreferences(terminalPreferences({ secret_masking: true }));
    const [tab] = seatTerminals([terminalTab({ terminalSessionId: "sess-1" })]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket, { id: "sess-1" });
    // A frame paints the empty screen first, so the replay's rows are read
    // again for their own bytes, not at the masker's first frame.
    expect(painted(term)).toEqual([]);

    await output(socket, SECRET_LINE);
    expect(painted(term), "while the replay is parsed").toEqual(MASKED);

    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    expect(painted(term), "once it ends").toEqual(MASKED);
  });
});

// A masker that fails leaves its mark on the tab, and masking stays off for
// that masker whatever asks for it. The mark is that masker's: a terminal
// built again over the same tab has a new one, which starts from the rule.
describe("a masker's failure", () => {
  async function failed() {
    privacy.enabled = true;
    privacy.mask_terminal_secrets = true;
    refuseMaskPaint = true;
    const mounted = await running();
    rescan(mounted.term);
    expect(mounted.tab.secretMaskingFailed, "the masker failed").toBe(true);
    expect(ui.status).toBe("Secret masking stopped working in this terminal");
    refuseMaskPaint = false;
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

  test("does not outlive it: the restarted terminal masks under Privacy mode", async () => {
    await failed();
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.restart" } }));
    expect(confirmState.open, "a terminal with a session asks before it restarts").toBe(true);
    resolveConfirm(true);
    await vi.waitFor(() => expect(ghosttyFixture.terminals).toHaveLength(2));
    const restarted = ghosttyFixture.terminals[1]!;
    await attach(TerminalSocket.all.at(-1)!);
    await output(TerminalSocket.all.at(-1)!, SECRET_LINE);

    rescan(restarted);
    expect(painted(restarted)).toEqual(MASKED);
  });

  // What a retry of a terminal that could not be drawn does: a new component,
  // and so a new masker, over the tab the first one marked.
  test("does not outlive it: the terminal drawn again over the same tab masks under Privacy mode", async () => {
    privacy.enabled = true;
    privacy.mask_terminal_secrets = true;
    refuseMaskPaint = true;
    __testSetStandalonePreferences(terminalPreferences({ secret_masking: false }));
    const [tab] = seatTerminals([terminalTab()]);
    const target = document.createElement("div");
    document.body.append(target);
    const first = mount(TerminalTab, {
      target,
      props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true },
    });
    await vi.waitFor(() => expect(ghosttyFixture.terminals).toHaveLength(1));
    await attach(TerminalSocket.all.at(-1)!);
    await output(TerminalSocket.all.at(-1)!, SECRET_LINE);
    rescan(await openedGhostty(target));
    expect(tab!.secretMaskingFailed, "the first masker failed").toBe(true);
    refuseMaskPaint = false;
    unmount(first);
    ghosttyFixture.terminals.splice(0);
    TerminalSocket.all.splice(0);

    const again = await mountGhosttyTerminal(TerminalTab, tab!);
    await attach(TerminalSocket.all.at(-1)!);
    await output(TerminalSocket.all.at(-1)!, SECRET_LINE);
    rescan(again.term);
    expect(painted(again.term)).toEqual(MASKED);
  });
});
