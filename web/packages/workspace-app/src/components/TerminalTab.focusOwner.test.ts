// @vitest-environment jsdom
//
// The terminal's focus calls that run after a wait, and the hand-backs that
// run at once. A focus that waited (start() once the font and the core have
// loaded, a seeded prompt sent on the shell's first output, a clipboard read
// or write that landed) asks when it runs whether this is still the focused
// pane's active tab, whether its Rich Prompt or a surface outside the
// terminal took the keyboard meanwhile, and whether the keyboard's owner lets
// the terminal have it. Closing the inspector hands the keyboard to the owner
// when one holds it; Escape in the find bar and the body menu's launcher row
// focus the terminal once, and nothing takes the keyboard back later from
// the find bar or the launcher that took it. A TerminalTab is mounted on the
// real widget through the shared fixture, over the stand-in socket, with
// reactive props so a test can move the tab or the pane away mid-wait.

import { EditorView } from "@codemirror/view";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const clipboard = vi.hoisted(() => ({
  read: null as ((text: string) => void) | null,
  written: null as (() => void) | null,
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../terminal/ghosttyCompat", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyCompatModule(importOriginal));
// The clipboard round trips wait until the test lands them.
vi.mock("../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/desktop")>()),
  readClipboardText: vi.fn(
    () =>
      new Promise<string>((resolve) => {
        clipboard.read = resolve;
      }),
  ),
  writeClipboardText: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        clipboard.written = resolve;
      }),
  ),
}));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      read: vi.fn(async () => ({ content: "run the tests" })),
      write: vi.fn(async () => ({})),
    },
  };
});

import TerminalTab from "./TerminalTab.svelte";
import type { SurveySpec } from "../api/client";
import { commandTitle } from "../state/commands";
import { richPrompt, showRichPromptForTab } from "../state/richPrompt.svelte";
import { shortcutLabel } from "../state/shortcuts";
import { resetSurveysForTest, showSurvey } from "../state/survey.svelte";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { draftPath } from "../__tests__/drafts";
import { ghosttyHasFocus, openedGhostty } from "../__tests__/ghosttyTab";
import {
  attach,
  installTerminalDom,
  menuRow,
  openBodyMenu,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";
import { terminalStatusProps } from "../__tests__/terminalStatusProps.svelte";
import { installEditorDom } from "../__tests__/wysiwyg";

installTerminalDom();
installEditorDom();

const SURVEY: SurveySpec = { surveyId: "survey-focus", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] };
const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  // The composer's editor focuses and measures on animation frames; a frame
  // that runs at once would run it inside an update.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  resetTerminals();
  resetSurveysForTest();
  richPrompt.byTab = {};
  clipboard.read = null;
  clipboard.written = null;
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

type Props = ReturnType<typeof terminalStatusProps>;
type Mounted = { tab: TerminalTabState; target: HTMLElement; props: Props; host: HTMLElement };

/// Mount the seated tab with props a test can change, as the pane tree's
/// placement changes them: `focused` is the pane's focus on its active tab.
function mountTab(tab: TerminalTabState, place: { active: boolean; focused: boolean }): Mounted {
  const props = terminalStatusProps(tab);
  Object.assign(props, place);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(TerminalTab, { target, props }) as Record<string, unknown>);
  const host = target.querySelector<HTMLElement>(".terminal-host");
  if (!host) throw new Error("the terminal host did not render");
  return { tab, target, props, host };
}

/// Hold the bundled face's load; the answer lets it finish.
function holdFont(): () => void {
  let loaded!: (faces: FontFace[]) => void;
  vi.mocked(document.fonts.load).mockImplementationOnce(() => new Promise<FontFace[]>((resolve) => (loaded = resolve)));
  return () => loaded([{} as FontFace]);
}

/// Count the moves of the keyboard into the terminal's host or its input.
function countTakes(host: HTMLElement): () => number {
  let takes = 0;
  host.addEventListener("focusin", () => (takes += 1));
  return () => takes;
}

/// A field outside the terminal holding the keyboard, as the other tab's or
/// pane's surface the user moved to.
function fieldOutside(): HTMLInputElement {
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  return field;
}

/// A loaded terminal on its socket.
async function liveTab(
  place: { active: boolean; focused: boolean },
  fields: Partial<TerminalTabState> = {},
): Promise<Mounted & { socket: TerminalSocket }> {
  const [tab] = seatTerminals([terminalTab(fields)]);
  const live = mountTab(tab!, place);
  await openedGhostty(live.target);
  const socket = await vi.waitFor(() => {
    const found = TerminalSocket.all.at(-1);
    expect(found, "the terminal dials its socket").toBeDefined();
    return found!;
  });
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await settle();
  return { ...live, socket };
}

function inputs(socket: TerminalSocket): string[] {
  return sentFrames(socket)
    .filter((frame) => frame.type === "input")
    .map((frame) => String(frame.data));
}

describe("once the font and the core have loaded", () => {
  test("the focused pane's active terminal takes the keyboard", async () => {
    const release = holdFont();
    const [tab] = seatTerminals([terminalTab()]);
    const { target } = mountTab(tab!, { active: true, focused: true });
    await settle();
    release();
    const term = await openedGhostty(target);
    await settle();
    expect(ghosttyHasFocus(term), "the terminal has the keyboard").toBe(true);
  });

  test("a Rich Prompt shown while the terminal loads keeps the keyboard in its composer", async () => {
    const release = holdFont();
    const [tab] = seatTerminals([terminalTab({ richPromptDraftPath: draftPath("focus-owner") })]);
    showRichPromptForTab(tab!.id);
    const { target, host } = mountTab(tab!, { active: true, focused: true });
    const content = await vi.waitFor(() => {
      const el = target.querySelector<HTMLElement>(".rich-prompt .cm-content");
      expect(el, "the composer mounts").not.toBeNull();
      return el!;
    });
    const view = EditorView.findFromDOM(content)!;
    await vi.waitFor(() => expect(view.hasFocus, "the composer takes the keyboard as it mounts").toBe(true));
    const takes = countTakes(host);

    release();
    await openedGhostty(target);
    await settle();

    expect(takes(), "the terminal took the keyboard as its load ended").toBe(0);
    expect(view.hasFocus, "the composer keeps the keyboard").toBe(true);
  });

  test("a pane left while its terminal loads takes no keyboard when the load ends", async () => {
    const release = holdFont();
    const [tab] = seatTerminals([terminalTab()]);
    const { target, props, host } = mountTab(tab!, { active: true, focused: true });
    await settle();
    props.focused = false;
    const field = fieldOutside();
    const takes = countTakes(host);

    release();
    await openedGhostty(target);
    await settle();

    expect(takes(), "the terminal took the keyboard as its load ended").toBe(0);
    expect(document.activeElement, "the other pane keeps the keyboard").toBe(field);
  });
});

describe("a seeded prompt, sent on the shell's first output", () => {
  const SEED = "notes.md";

  async function seeded(place: { active: boolean; focused: boolean }, outside: boolean) {
    const live = await liveTab(place, { seedInput: SEED });
    const field = outside ? fieldOutside() : null;
    if (!outside) (document.activeElement as HTMLElement | null)?.blur();
    const takes = countTakes(live.host);
    await output(live.socket, "$ ");
    await vi.waitFor(() => expect(inputs(live.socket), "the seed is typed").toContain(` ${SEED}\x01`), { timeout: 2_000 });
    await settle();
    return { ...live, field, takes };
  }

  test("in the focused pane hands the terminal the keyboard", async () => {
    const { takes, host } = await seeded({ active: true, focused: true }, false);
    expect(takes(), "the terminal takes the keyboard after the seed").toBe(1);
    expect(host.contains(document.activeElement)).toBe(true);
  });

  test("in a pane without focus leaves the keyboard where it is", async () => {
    const { takes, field } = await seeded({ active: true, focused: false }, true);
    expect(takes(), "the terminal took the keyboard").toBe(0);
    expect(document.activeElement, "the focused pane keeps the keyboard").toBe(field);
  });

  test("leaves a field outside the terminal that took the keyboard meanwhile alone", async () => {
    const { takes, field } = await seeded({ active: true, focused: true }, true);
    expect(takes(), "the terminal took the keyboard").toBe(0);
    expect(document.activeElement, "the field keeps the keyboard").toBe(field);
  });
});

describe("a menu copy or paste that waits for the clipboard", () => {
  async function fromMenu(label: string) {
    const live = await liveTab({ active: true, focused: true });
    await output(live.socket, "hello from the shell\r\n");
    await settle();
    await openBodyMenu(live.target);
    // The press takes the keyboard to the row, which leaves with the menu,
    // so the keyboard is at large while the clipboard answers.
    const row = menuRow(commandTitle(label));
    row.focus();
    row.click();
    await settle();
    expect(live.host.contains(document.activeElement), "the terminal lost the keyboard to the menu").toBe(false);
    return { ...live, takes: countTakes(live.host) };
  }

  test("a paste that lands with the terminal still in front gives it the keyboard back", async () => {
    const { socket, takes, host } = await fromMenu("terminal.paste");
    expect(clipboard.read, "the paste reads the clipboard").not.toBeNull();
    clipboard.read!("echo pasted");
    await settle();
    expect(inputs(socket).join(""), "the text reaches the shell").toContain("echo pasted");
    expect(takes(), "the terminal takes the keyboard").toBe(1);
    expect(host.contains(document.activeElement)).toBe(true);
  });

  test("a paste that lands after a switch to another tab leaves the keyboard there", async () => {
    const { socket, props, takes } = await fromMenu("terminal.paste");
    props.active = false;
    props.focused = false;
    await settle();
    const field = fieldOutside();
    clipboard.read!("echo pasted");
    await settle();
    expect(inputs(socket).join(""), "the text still reaches the shell").toContain("echo pasted");
    expect(takes(), "the hidden terminal took the keyboard").toBe(0);
    expect(document.activeElement, "the other tab keeps the keyboard").toBe(field);
  });

  test("a copy that lands after the pane lost focus leaves the keyboard in the other pane", async () => {
    const { props, takes } = await fromMenu("terminal.copy");
    expect(clipboard.written, "the copy writes the clipboard").not.toBeNull();
    props.focused = false;
    await settle();
    const field = fieldOutside();
    clipboard.written!();
    await settle();
    expect(takes(), "the terminal took the keyboard").toBe(0);
    expect(document.activeElement, "the other pane keeps the keyboard").toBe(field);
  });
});

describe("closing the inspector", () => {
  async function withInspector() {
    const live = await liveTab({ active: true, focused: true });
    live.tab.inspectorOpen = true;
    await settle();
    const close = live.target.querySelector<HTMLButtonElement>("aside.inspector button.close");
    expect(close, "the inspector shows its close button").not.toBeNull();
    return { ...live, close: close! };
  }

  test("hands the terminal the keyboard", async () => {
    const { target, close } = await withInspector();
    const term = await openedGhostty(target);
    close.focus();
    close.click();
    await settle();
    expect(ghosttyHasFocus(term), "the terminal has the keyboard").toBe(true);
  });

  test("under a survey over the terminal hands the keyboard back to the survey's card", async () => {
    const { tab, target, close, host } = await withInspector();
    showSurvey(SURVEY, tab.id);
    await settle();
    const card = target.querySelector<HTMLElement>(".survey-card");
    expect(card, "the survey shows over the terminal").not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement, "the survey's card has the keyboard").toBe(card));
    const takes = countTakes(host);
    // The press on the close button takes the keyboard to it, as a click
    // does in Chrome and WebKitGTK.
    close.focus();
    close.click();
    await settle();
    expect(takes(), "the terminal took the keyboard from the survey").toBe(0);
    expect(document.activeElement, "the survey's card has the keyboard back").toBe(card);
  });
});

describe("hand-backs that focus once", () => {
  test("Escape in the find bar hands the terminal the keyboard, and the bar reopened at once keeps it", async () => {
    const { target } = await liveTab({ active: true, focused: true });
    const term = await openedGhostty(target);
    const openFind = () => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "terminal.find" } }));
    openFind();
    const input = await vi.waitFor(() => {
      const el = target.querySelector<HTMLInputElement>(".terminal-find input");
      expect(el, "the find bar opens").not.toBeNull();
      expect(document.activeElement, "the find input has the keyboard").toBe(el);
      return el!;
    });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(ghosttyHasFocus(term), "Escape hands the terminal the keyboard").toBe(true);

    openFind();
    const reopened = await vi.waitFor(() => {
      const el = target.querySelector<HTMLInputElement>(".terminal-find input");
      expect(el, "the find bar reopens").not.toBeNull();
      expect(document.activeElement, "the reopened input has the keyboard").toBe(el);
      return el!;
    });
    await settle();
    expect(document.activeElement, "nothing takes the keyboard back from the find bar").toBe(reopened);
  });

  test("the body menu's launcher row focuses the terminal for the launcher's return, and the launcher keeps the keyboard", async () => {
    const { target } = await liveTab({ active: true, focused: true });
    const term = await openedGhostty(target);
    const launcherInput = document.createElement("input");
    document.body.append(launcherInput);
    let terminalHeldAtOpen: boolean | null = null;
    const onCommand = (e: Event) => {
      if ((e as CustomEvent).detail?.name !== "app.launcher.toggle") return;
      // The launcher remembers the element holding the keyboard as its
      // return target, then takes the keyboard into its input.
      terminalHeldAtOpen = ghosttyHasFocus(term);
      launcherInput.focus();
    };
    window.addEventListener("chan:command", onCommand);
    try {
      await openBodyMenu(target);
      menuRow(shortcutLabel("app.launcher.toggle")).click();
      await settle();
    } finally {
      window.removeEventListener("chan:command", onCommand);
    }
    expect(terminalHeldAtOpen, "the terminal holds the keyboard as the launcher opens").toBe(true);
    expect(document.activeElement, "the launcher keeps the keyboard").toBe(launcherInput);
  });
});
