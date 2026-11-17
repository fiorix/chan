// @vitest-environment jsdom
//
// The Rich Prompt over a focused terminal takes the keyboard on its own: as
// its editor mounts, when a delivered or drained message empties it, when a
// recall gives its text back, on each tab-focus pulse, and when a submit held
// for its images' paths is sent. A modal dialog, a survey over the terminal
// and the Computers launcher own the keyboard (`refocusRefused`), and while
// one does none of those moves focus into the composer; once it lets go, the
// next pulse lands in the composer again. A TerminalTab is mounted over the
// stand-in xterm and socket, so the phases arrive as the server's frames.

import { EditorView } from "@codemirror/view";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
const draft = vi.hoisted(() => ({ content: "run the tests" }));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      read: vi.fn(async () => ({ content: draft.content })),
      write: vi.fn(async () => ({})),
    },
  };
});

import Pane from "./Pane.svelte";
import TerminalTab from "./TerminalTab.svelte";
import Terminals from "./Terminals.svelte";
import { api, type SurveySpec } from "../api/client";
import { closeConfirmState } from "../state/closeConfirm.svelte";
import { LAUNCHER_SHOWN_ATTR } from "../state/focusGuard.svelte";
import { richPrompt, showRichPromptForTab, toggleRichPromptSource } from "../state/richPrompt.svelte";
import { workspace } from "../state/store.svelte";
import { resetSurveysForTest, showSurvey } from "../state/survey.svelte";
import {
  bumpTabFocusPulse,
  layout,
  selectTabInPane,
  type LeafNode,
  type TerminalTab as TerminalTabState,
} from "../state/tabs.svelte";
import { closeTeamDialog, openTeamDialog } from "../state/teamDialog.svelte";
import { installEditorDom, press } from "../__tests__/wysiwyg";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  TERMINAL_PANE,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";
import { draftPath } from "../__tests__/drafts";

installTerminalDom();
installEditorDom();

const TEXT = "run the tests";
const SURVEY: SurveySpec = { surveyId: "survey-owner", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] };
// A workspace draft's text naming one of its images, and the path the server
// gives that image.
const IMAGE_TEXT = "see ![](shot.png)";
const ON_SERVER = "/home/me/.chan/workspaces/k/Drafts/owner/shot.png";
const workspaceInfo = workspace.info;
const mountedPanes: Array<Record<string, unknown>> = [];

beforeEach(() => {
  // The editors focus and measure on animation frames; a frame that runs at
  // once would run them inside an update.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

afterEach(() => {
  for (const component of mountedPanes.splice(0)) unmount(component);
  resetTerminals();
  draft.content = TEXT;
  workspace.info = workspaceInfo;
  richPrompt.byTab = {};
  resetSurveysForTest();
  closeTeamDialog();
  closeConfirmState.open = false;
  document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/// An element of the surface that owns the keyboard, focused.
function focusedField(): HTMLElement {
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  return field;
}

type Owner = {
  name: string;
  /// Hand the keyboard to this owner; answers the element holding it.
  take: (target: HTMLElement, tabId: string) => Promise<HTMLElement>;
  release: () => void;
};

const OWNERS: Owner[] = [
  {
    name: "a survey over the terminal",
    take: async (target, tabId) => {
      showSurvey(SURVEY, tabId);
      await settle();
      const card = target.querySelector<HTMLElement>(".survey-card");
      expect(card, "the survey shows over the terminal").not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement, "the survey's card has the keyboard").toBe(card));
      return card!;
    },
    release: () => resetSurveysForTest(),
  },
  {
    name: "a window-wide survey",
    take: async () => {
      const field = focusedField();
      showSurvey(SURVEY, null);
      await settle();
      return field;
    },
    release: () => resetSurveysForTest(),
  },
  {
    name: "the Team dialog",
    take: async (_target, tabId) => {
      const field = focusedField();
      openTeamDialog({ leadTabId: tabId, leadPaneId: TERMINAL_PANE });
      await settle();
      return field;
    },
    release: () => closeTeamDialog(),
  },
  {
    name: "the desktop close prompt",
    take: async () => {
      const field = focusedField();
      closeConfirmState.open = true;
      await settle();
      return field;
    },
    release: () => {
      closeConfirmState.open = false;
    },
  },
  {
    name: "the Computers launcher",
    take: async () => {
      const field = focusedField();
      document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
      await settle();
      return field;
    },
    release: () => document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR),
  },
];

type Composer = {
  tab: TerminalTabState;
  target: HTMLElement;
  socket: TerminalSocket;
  content: HTMLElement;
  view: EditorView;
};

/// A focused terminal on its socket, with no composer shown yet.
async function focusedTerminal(): Promise<Omit<Composer, "content" | "view">> {
  const [tab] = seatTerminals([terminalTab({ richPromptDraftPath: draftPath("owner") })]);
  const { target } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  return { tab: tab!, target, socket };
}

/// Show the terminal's composer and wait for its draft's text.
async function showComposer(terminal: Omit<Composer, "content" | "view">): Promise<Composer> {
  showRichPromptForTab(terminal.tab.id);
  const content = await vi.waitFor(() => {
    const el = terminal.target.querySelector<HTMLElement>(".rich-prompt .cm-content");
    expect(el).not.toBeNull();
    return el!;
  });
  const view = EditorView.findFromDOM(content)!;
  await vi.waitFor(() => expect(view.state.doc.toString()).toBe(draft.content));
  await settle();
  return { ...terminal, content, view };
}

/// A focused terminal whose composer opened with the keyboard.
async function openComposer(): Promise<Composer> {
  const composer = await showComposer(await focusedTerminal());
  expect(composer.view.hasFocus, "the composer opens with the keyboard").toBe(true);
  return composer;
}

type Phase = "delivered" | "drained" | "recalled";
const PHASES: Phase[] = ["delivered", "drained", "recalled"];

/// Submit the draft and have the server queue it. A drain or a recall
/// answers a cancellation, so for those ArrowUp asks for one first.
async function queue(composer: Composer, phase: Phase): Promise<string> {
  composer.socket.sent.splice(0);
  press(composer.content, "Enter", { ctrlKey: true });
  await settle();
  const id = sentFrames(composer.socket).find((f) => f.type === "prompt")?.id as string;
  expect(id, "the submit sent a prompt").toBeTruthy();
  await receive(composer.socket, { type: "prompt-ack", id, queued: true, depth: 1 });
  await settle();
  if (phase !== "delivered") {
    press(composer.content, "ArrowUp");
    await settle();
    expect(composer.tab.pendingPrompt?.phase).toBe("recalling");
  }
  return id;
}

async function land(composer: Composer, phase: Phase, id: string): Promise<void> {
  if (phase === "delivered") {
    await receive(composer.socket, { type: "prompt-delivered", id, depth: 0 });
  } else {
    await receive(composer.socket, { type: "prompt-cancelled", id, removed: phase === "recalled" });
  }
  await settle();
}

/// The text and caret each phase leaves, whoever holds the keyboard.
function expectPhaseResult(composer: Composer, phase: Phase): void {
  const text = phase === "recalled" ? TEXT : "";
  expect({
    text: composer.view.state.doc.toString(),
    caret: composer.view.state.selection.main.head,
    locked: composer.view.state.readOnly,
    pending: composer.tab.pendingPrompt,
  }).toEqual({ text, caret: text.length, locked: false, pending: undefined });
  if (phase === "drained") {
    expect(composer.target.querySelector(".rp-text")?.textContent).toBe("already sent");
  }
}

describe("a phase that lands while another surface owns the keyboard", () => {
  for (const owner of OWNERS) {
    test.each(PHASES)(`${owner.name}: %s leaves the keyboard with it`, async (phase) => {
      const composer = await openComposer();
      const id = await queue(composer, phase);
      const holder = await owner.take(composer.target, composer.tab.id);
      const focusAsks = vi.spyOn(EditorView.prototype, "focus");

      await land(composer, phase, id);

      expect(document.activeElement, "the owner keeps the keyboard").toBe(holder);
      expect(focusAsks, "the composer asks for no focus").not.toHaveBeenCalled();
      expectPhaseResult(composer, phase);
    });
  }

  // The control: with nothing owning the keyboard, each phase hands the
  // focused terminal's composer the keyboard, as it does without the guard.
  test.each(PHASES)("no owner: %s gives the composer the keyboard", async (phase) => {
    const composer = await openComposer();
    const id = await queue(composer, phase);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(composer.view.hasFocus).toBe(false);

    await land(composer, phase, id);

    expect(composer.view.hasFocus, "the composer takes the keyboard").toBe(true);
    expectPhaseResult(composer, phase);
  });
});

describe("a tab-focus pulse", () => {
  test.each(OWNERS.map((owner) => [owner.name, owner] as const))(
    "under %s leaves the composer without the keyboard, and the pulse after its release gives it",
    async (_name, owner) => {
      const composer = await openComposer();
      const holder = await owner.take(composer.target, composer.tab.id);
      const focusAsks = vi.spyOn(EditorView.prototype, "focus");

      bumpTabFocusPulse();
      await settle();

      expect(focusAsks, "the composer asks for no focus").not.toHaveBeenCalled();
      expect(composer.view.hasFocus, "the composer does not take the keyboard").toBe(false);

      owner.release();
      holder.blur();
      await settle();
      (document.activeElement as HTMLElement | null)?.blur();
      bumpTabFocusPulse();
      await settle();

      expect(composer.view.hasFocus, "the pulse after the release gives the composer the keyboard").toBe(true);
    },
  );
});

describe("a composer that opens", () => {
  test.each(OWNERS.map((owner) => [owner.name, owner] as const))(
    "under %s opens without the keyboard, and the pulse after its release gives it",
    async (_name, owner) => {
      const terminal = await focusedTerminal();
      const holder = await owner.take(terminal.target, terminal.tab.id);
      const focusAsks = vi.spyOn(EditorView.prototype, "focus");

      const composer = await showComposer(terminal);

      expect(document.activeElement, "the owner keeps the keyboard").toBe(holder);
      expect(focusAsks, "the composer asks for no focus").not.toHaveBeenCalled();

      owner.release();
      holder.blur();
      await settle();
      (document.activeElement as HTMLElement | null)?.blur();
      bumpTabFocusPulse();
      await settle();

      expect(composer.view.hasFocus, "the pulse after the release gives the composer the keyboard").toBe(true);
    },
  );
});

function prompts(socket: TerminalSocket): Array<Record<string, unknown>> {
  return sentFrames(socket).filter((f) => f.type === "prompt");
}

/// The texts of the prompts sent, without the trailing whitespace the
/// delivery leaves after an image's path.
function sentTexts(socket: TerminalSocket): string[] {
  return prompts(socket).map((f) => String(f.data).trimEnd());
}

/// Submit a draft naming one of its images: the composer asks the server
/// where the image is and holds the send until the answer, which the
/// returned function gives.
async function holdImageSubmit(composer: Composer): Promise<(paths: string[]) => void> {
  let answer!: (paths: string[]) => void;
  const ask = vi
    .spyOn(api, "draftTerminalPaths")
    .mockReturnValue(new Promise<string[]>((resolve) => { answer = resolve; }));
  composer.socket.sent.splice(0);
  press(composer.content, "Enter", { ctrlKey: true });
  await settle();
  expect(ask, "the submit asks where the image is").toHaveBeenCalledTimes(1);
  expect(prompts(composer.socket), "and sends nothing before the answer").toEqual([]);
  return answer;
}

describe("a submit held for its images' paths", () => {
  beforeEach(() => {
    workspace.info = { root: "/home/me/ws" } as typeof workspace.info;
    draft.content = IMAGE_TEXT;
  });

  test.each(OWNERS.map((owner) => [owner.name, owner] as const))(
    "sent once %s has taken the keyboard leaves the keyboard with it",
    async (_name, owner) => {
      const composer = await openComposer();
      const answer = await holdImageSubmit(composer);
      const holder = await owner.take(composer.target, composer.tab.id);
      const focusAsks = vi.spyOn(EditorView.prototype, "focus");

      answer([ON_SERVER]);
      await settle();

      expect(sentTexts(composer.socket), "the prompt is sent with the image's path").toEqual([`see ${ON_SERVER}`]);
      expect(document.activeElement, "the owner keeps the keyboard").toBe(holder);
      expect(focusAsks, "the composer asks for no focus").not.toHaveBeenCalled();
    },
  );

  test("sent after a switch to another tab leaves the composer of the tab left behind without the keyboard", async () => {
    const [first] = seatTerminals([
      terminalTab({ id: "term-left", richPromptDraftPath: draftPath("owner") }),
      terminalTab({ id: "term-next" }),
    ]);
    mountedPanes.push(mount(Terminals, { target: document.body.appendChild(document.createElement("div")) }));
    mountedPanes.push(
      mount(Pane, {
        target: document.body.appendChild(document.createElement("div")),
        props: { pane: layout.nodes[TERMINAL_PANE] as LeafNode },
      }),
    );
    const socket = await vi.waitFor(() => {
      const found = TerminalSocket.all.find((s) => s.url.includes(`tab_id=${first!.id}`));
      expect(found).toBeDefined();
      return found!;
    });
    await attach(socket);
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    const target = document.querySelector<HTMLElement>(`[data-terminal-tab-id="${first!.id}"]`)!;
    const composer = await showComposer({ tab: first!, target, socket });
    expect(composer.view.hasFocus, "the composer opens with the keyboard").toBe(true);
    const answer = await holdImageSubmit(composer);

    selectTabInPane(TERMINAL_PANE, "term-next");
    await settle();
    expect(composer.view.hasFocus, "the switch takes the keyboard from the composer").toBe(false);
    const focusAsks = vi.spyOn(EditorView.prototype, "focus");

    answer([ON_SERVER]);
    await settle();

    expect(sentTexts(socket), "the prompt is sent with the image's path").toEqual([`see ${ON_SERVER}`]);
    expect(composer.view.hasFocus, "the tab left behind does not take the keyboard").toBe(false);
    expect(focusAsks, "the composer asks for no focus").not.toHaveBeenCalled();
  });

  // The controls: a text-only submit sends at once, from the keymap or the
  // strip's button, and leaves the composer with the keyboard as before.
  test("a text-only submit from the keymap sends at once and the composer keeps the keyboard", async () => {
    draft.content = TEXT;
    const composer = await openComposer();
    const ask = vi.spyOn(api, "draftTerminalPaths");
    composer.socket.sent.splice(0);

    press(composer.content, "Enter", { ctrlKey: true });
    await settle();

    expect(ask, "a text naming no image asks nothing").not.toHaveBeenCalled();
    expect(sentTexts(composer.socket)).toEqual([TEXT]);
    expect(composer.view.hasFocus, "the composer keeps the keyboard").toBe(true);
  });

  test("a text-only submit from the strip's button gives the composer the keyboard", async () => {
    draft.content = TEXT;
    const composer = await openComposer();
    composer.socket.sent.splice(0);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(composer.view.hasFocus).toBe(false);

    composer.target.querySelector<HTMLButtonElement>(".rp-primary")!.click();
    await settle();

    expect(sentTexts(composer.socket)).toEqual([TEXT]);
    expect(composer.view.hasFocus, "the composer takes the keyboard").toBe(true);
  });
});

describe("the launcher mark regression (acceptance 2)", () => {
  test("a prompt delivered under the launcher, released, then a source swap mounts the editor with the keyboard", async () => {
    const composer = await openComposer();
    const id = await queue(composer, "delivered");
    const launcher = OWNERS.find((owner) => owner.name === "the Computers launcher")!;
    const holder = await launcher.take(composer.target, composer.tab.id);

    await land(composer, "delivered", id);

    // At the base the delivered phase is unguarded and takes the keyboard
    // here; the branch and the rule refuse it. Either way, the release and
    // the swap below decide this test.
    launcher.release();
    holder.blur();
    await settle();
    toggleRichPromptSource(composer.tab.id);
    await settle();

    const content = composer.target.querySelector<HTMLElement>(".rich-prompt .cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    expect(view, "the swap mounted a new editor").not.toBe(composer.view);
    expect(view.hasFocus, "the editor that mounts after the release has the keyboard").toBe(true);
  });
});

describe("a strip-button submit in an unfocused pane", () => {
  test("the composer takes the keyboard", async () => {
    const [tab] = seatTerminals([terminalTab({ richPromptDraftPath: draftPath("owner-unfocused") })]);
    const { target } = await mountTerminal(TerminalTab, tab!, { focused: false });
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    const composer = await showComposer({ tab: tab!, target, socket });
    expect(composer.view.hasFocus, "nothing is focused before the submit").toBe(false);
    socket.sent.splice(0);
    composer.target.querySelector<HTMLButtonElement>(".rp-primary")!.click();
    await settle();
    expect(sentFrames(socket).filter((frame) => frame.type === "prompt")).toHaveLength(1);
    expect(composer.view.hasFocus, "the strip submit focuses the composer").toBe(true);
  });
});

