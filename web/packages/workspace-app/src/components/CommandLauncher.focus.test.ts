// @vitest-environment jsdom
//
// Where focus goes when the command launcher closes: back to the element it
// opened from after a dismissal, left where a command put it after a run,
// back to that element after a run that put it nowhere, and back to that
// element again when Open's path dialog, which outlives the launcher, is
// cancelled. And where it stays while the launcher is open: on the query,
// whatever a row that changes in place shows under it.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

const library = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock("../state/commands/install", () => ({}));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: vi.fn(async () => library.snapshot),
  loadScopedWindowLiveTerminals: vi.fn(),
  checkScopedWindowPage: vi.fn(async () => ({
    response: new Response("<html></html>"),
    readRefusal: async () => new Error("unexpected refusal"),
  })),
  runScopedLibraryAction: vi.fn(async () => undefined),
}));

import CommandLauncher from "./CommandLauncher.svelte";
import StandInSurface, { type SurfaceGrab } from "./CommandLauncher.testSurface.svelte";
import PathPromptModal from "./PathPromptModal.svelte";
import PromptModal from "./PromptModal.svelte";
import BubbleOverlay from "./BubbleOverlay.svelte";
import SearchPanel from "./SearchPanel.svelte";
import ScreensaverOverlay from "./ScreensaverOverlay.svelte";
import { demoWorkspaceInfo } from "../demo/data";
import { screensaver } from "../state/screensaver.svelte";
import { recordingContext2d } from "../__tests__/canvas";
import TerminalTab from "./TerminalTab.svelte";
import { LAUNCHER_SHOWN_ATTR } from "../state/keyboardOwner.svelte";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  receive,
  resetTerminals,
  seatTerminals,
  TerminalSocket,
} from "../__tests__/terminalTab";
import { xterm } from "../__tests__/xterm";
import { resetSurveysForTest, showSurvey } from "../state/survey.svelte";
import { allCommands, registerCommands } from "../state/commands";
import "../state/commands/global";

installTerminalDom();
import {
  clearLauncherDraft,
  closeCommandLauncher,
  launcherPanel,
  openCommandLauncher,
  overlayStack,
  pathPromptState,
  promptState,
  resolvePathPrompt,
  resolvePrompt,
  searchPanel,
  syncOverlayStack,
  uiPrompt,
  workspace,
} from "../state/store.svelte";
import {
  activePane,
  layout,
  moveTab,
  setActivePane,
  splitPane,
  tabFocusPulse,
  type LeafNode,
} from "../state/tabs.svelte";

Element.prototype.scrollIntoView = vi.fn();

/// Where the probe command puts focus, as a command that opens a surface does.
let probeTarget: HTMLInputElement | null = null;
const runProbe = vi.fn(() => probeTarget?.focus());
/// A command that flips a setting and moves focus nowhere, as the group
/// broadcast toggle does.
const runNothing = vi.fn();
/// A command whose surface takes focus only after an await inside its run.
const runLate = vi.fn(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  probeTarget?.focus();
});
/// A command whose surface takes focus after its run has returned.
const runAfter = vi.fn(() => {
  setTimeout(() => probeTarget?.focus(), 20);
});
/// A command that removes the element the launcher opened from, as a close of
/// that tab does.
const runDrop = vi.fn(() => origin.remove());
/// A command that asks a question in a prompt dialog, as Set terminal name
/// does; the dialog outlives the launcher.
const runPrompt = vi.fn(() => void uiPrompt("Name"));
/// A command that splits the pane, as Split right does: the run moves the
/// keyboard's home to a new empty pane while the deck closes.
const runSplit = vi.fn(() => {
  splitPane(activePane().id, "column");
});
/// A command whose run waits on something slow, as a Computers action waiting
/// for a window page does; the test releases it.
let held: { promise: Promise<void>; resolve: () => void } | null = null;
const runHeld = vi.fn(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  held = { promise, resolve };
  return promise;
});
/// A surface a row that changes in place shows under the launcher, and how
/// it takes the keyboard when shown.
let surface: { show: (how: SurfaceGrab) => void; hide: () => void; isShown: () => boolean } | null = null;
let surfaceGrab: SurfaceGrab = "sync";
/// A toggle that shows a surface which focuses itself, as Rich Prompt and
/// Source mode do. It reports its state, so the launcher stays open on it.
const runSurface = vi.fn(() => surface?.show(surfaceGrab));
registerCommands([
  {
    id: "test.focus.surface",
    title: "Stand-in prompt",
    category: "Global",
    scope: "window",
    requirement: "any",
    kind: "toggle",
    state: () => surface?.isShown() === true,
    available: () => true,
    run: runSurface,
  },
  {
    id: "test.focus.probe",
    title: "Probe focus",
    category: "Global",
    scope: "window",
    requirement: "any",
    available: () => true,
    run: runProbe,
  },
  {
    id: "test.focus.nothing",
    title: "Toggle nothing",
    category: "Global",
    scope: "window",
    requirement: "any",
    available: () => true,
    run: runNothing,
  },
  {
    id: "test.focus.late",
    title: "Late field",
    category: "Global",
    scope: "window",
    requirement: "any",
    available: () => true,
    run: runLate,
  },
  {
    id: "test.focus.after",
    title: "After field",
    category: "Global",
    scope: "window",
    requirement: "any",
    available: () => true,
    run: runAfter,
  },
  {
    id: "test.focus.drop",
    title: "Drop origin",
    category: "Global",
    scope: "window",
    requirement: "any",
    available: () => true,
    run: runDrop,
  },
  {
    id: "test.focus.prompt",
    title: "Ask name",
    category: "Global",
    scope: "window",
    requirement: "any",
    available: () => true,
    run: runPrompt,
  },
  {
    id: "test.focus.split",
    title: "Split right",
    category: "Global",
    scope: "window",
    requirement: "any",
    available: () => true,
    run: runSplit,
  },
  {
    id: "test.focus.held",
    title: "Wait on window",
    category: "Global",
    scope: "window",
    requirement: "any",
    available: () => true,
    run: runHeld,
  },
]);

const mounted: Array<Record<string, unknown>> = [];
let origin: HTMLButtonElement;

async function flush(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

/// Focus a control, then open the launcher from it the way the app does. The
/// prompt dialogs mount before the launcher, as they do in the app.
async function openFromOrigin(): Promise<HTMLElement> {
  origin = document.createElement("button");
  document.body.append(origin);
  origin.focus();
  const dialogs = document.createElement("div");
  document.body.append(dialogs);
  mounted.push(mount(PromptModal, { target: dialogs }) as Record<string, unknown>);
  mounted.push(mount(PathPromptModal, { target: dialogs }) as Record<string, unknown>);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
  openCommandLauncher();
  // The App keeps the overlays' stack in step with their open flags.
  syncOverlayStack();
  await flush();
  expect(document.activeElement, "the launcher takes focus").toBe(
    target.querySelector(".deck-input"),
  );
  return target;
}

function row(target: HTMLElement, title: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
    (candidate) => candidate.querySelector(".deck-result-title")?.textContent === title,
  );
  if (!found) {
    const visible = [...target.querySelectorAll(".deck-result-title")].map((n) => n.textContent);
    throw new Error(`missing row ${title}; visible: ${visible.join(", ")}`);
  }
  return found;
}

/// Run Open outside the launcher, as an assigned chord does, which raises
/// its path dialog, and cancel the dialog.
async function runOpenAndCancel(): Promise<void> {
  const open = allCommands().find((command) => command.id === "app.open.path");
  expect(open, "the Open command is registered").toBeDefined();
  open!.run();
  await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
  resolvePathPrompt(null);
  await flush();
}

async function press(target: HTMLElement, key: string): Promise<void> {
  (target.querySelector('[role="dialog"]') as HTMLElement).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true }),
  );
  await flush();
}

/// Type a command's title into the open launcher and run the selected row.
async function runFromLauncher(target: HTMLElement, title: string): Promise<void> {
  const input = target.querySelector(".deck-input") as HTMLInputElement;
  input.value = title;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: title }));
  await tick();
  const selected = target.querySelector('[role="option"][aria-selected="true"] .deck-result-title');
  expect(selected?.textContent, "the typed title is the selected row").toBe(title);
  await press(target, "Enter");
}

beforeEach(() => {
  library.snapshot = null;
  probeTarget = null;
  held = null;
  surface = null;
  document.documentElement.removeAttribute("data-launcher-shown");
  sessionStorage.clear();
  clearLauncherDraft();
  launcherPanel.open = false;
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  resetSurveysForTest();
  resetLayout();
  if (pathPromptState.open) resolvePathPrompt(null);
  if (promptState.open) resolvePrompt(null);
  document.body.innerHTML = "";
  launcherPanel.open = false;
  overlayStack.ids = [];
  resetTerminals();
  xterm.textareaFocus = false;
  vi.clearAllMocks();
});

describe("focus when the launcher closes", () => {
  test("Escape hands focus back to the element it opened from", async () => {
    const target = await openFromOrigin();
    await press(target, "Escape");
    expect(document.activeElement).toBe(origin);
  });

  test("a close from outside the deck hands focus back too", async () => {
    await openFromOrigin();
    closeCommandLauncher();
    await flush();
    expect(document.activeElement).toBe(origin);
  });

  test("running a command leaves focus where the command put it", async () => {
    probeTarget = document.createElement("input");
    document.body.append(probeTarget);
    const target = await openFromOrigin();
    await runFromLauncher(target, "Probe focus");
    expect(runProbe).toHaveBeenCalledOnce();
    expect(launcherPanel.open).toBe(false);
    expect(document.activeElement).toBe(probeTarget);
  });

  test("a command that takes no focus hands it back to the element the launcher opened from", async () => {
    const target = await openFromOrigin();
    await runFromLauncher(target, "Toggle nothing");
    expect(runNothing).toHaveBeenCalledOnce();
    expect(launcherPanel.open).toBe(false);
    expect(document.activeElement).toBe(origin);
  });

  test("a command whose surface takes focus after an await keeps that focus", async () => {
    probeTarget = document.createElement("input");
    document.body.append(probeTarget);
    const target = await openFromOrigin();
    await runFromLauncher(target, "Late field");
    expect(runLate).toHaveBeenCalledOnce();
    expect(launcherPanel.open).toBe(false);
    expect(document.activeElement, "nothing is restored while the run is in flight").toBe(document.body);
    await vi.waitFor(() => expect(document.activeElement).toBe(probeTarget));
    await flush();
    expect(document.activeElement).toBe(probeTarget);
  });

  test("a surface that takes focus after the run returned keeps it", async () => {
    probeTarget = document.createElement("input");
    document.body.append(probeTarget);
    const target = await openFromOrigin();
    await runFromLauncher(target, "After field");
    expect(runAfter).toHaveBeenCalledOnce();
    expect(document.activeElement, "the element the launcher opened from, until the surface shows").toBe(origin);
    await vi.waitFor(() => expect(document.activeElement).toBe(probeTarget));
  });

  test("a command that removes the element the launcher opened from pulses the active tab's focus", async () => {
    const target = await openFromOrigin();
    const pulses = tabFocusPulse.value;
    await runFromLauncher(target, "Drop origin");
    expect(runDrop).toHaveBeenCalledOnce();
    expect(origin.isConnected).toBe(false);
    expect(tabFocusPulse.value, "the pulse the tab components refocus on").toBe(pulses + 1);
  });

  test("a prompt a command asks hands focus back to the element the launcher opened from when it closes", async () => {
    const target = await openFromOrigin();
    await runFromLauncher(target, "Ask name");
    expect(runPrompt).toHaveBeenCalledOnce();
    expect(launcherPanel.open).toBe(false);
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement | null;
    expect(dialog, "the prompt is open").not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog!.querySelector("input")));
    await flush();
    expect(document.activeElement, "the restore leaves the prompt its focus").toBe(dialog!.querySelector("input"));
    dialog!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(promptState.open).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(origin));
  });

  test("a dialog opened from another control during a long run returns focus to that control", async () => {
    const target = await openFromOrigin();
    await runFromLauncher(target, "Wait on window");
    expect(runHeld).toHaveBeenCalledOnce();
    expect(launcherPanel.open).toBe(false);
    // The user clicks into another control while the run waits, and asks
    // something from there.
    const control = document.createElement("input");
    document.body.append(control);
    control.focus();
    void uiPrompt("Unrelated");
    await flush();
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement | null;
    expect(dialog, "the prompt is open").not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog!.querySelector("input")));
    dialog!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    await vi.waitFor(() => expect(document.activeElement, "the control the dialog came from").toBe(control));
    held!.resolve();
    await flush();
    expect(document.activeElement, "the released run finds focus held and leaves it").toBe(control);
    control.remove();
  });

  test("a run that settles while a modal temporarily leaves focus on the body moves no focus", async () => {
    const target = await openFromOrigin();
    await runFromLauncher(target, "Wait on window");
    void uiPrompt("Name");
    await flush();
    const field = document.querySelector<HTMLInputElement>('[role="dialog"][aria-modal="true"] input')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    field.blur();
    expect(document.activeElement).toBe(document.body);
    const pulses = tabFocusPulse.value;
    const focus = vi.spyOn(origin, "focus");

    held!.resolve();
    await flush();

    expect(promptState.open, "the modal still owns the keyboard").toBe(true);
    expect(focus, "the completed run does not restore its opener under the modal").not.toHaveBeenCalled();
    expect(tabFocusPulse.value).toBe(pulses);
  });

  test("a run that settles under the Computers launcher shown over the window moves no focus", async () => {
    const target = await openFromOrigin();
    const pulses = tabFocusPulse.value;
    const focus = vi.spyOn(origin, "focus");
    // chan-desktop sets this while its launcher window covers the page.
    document.documentElement.setAttribute("data-launcher-shown", "");
    await runFromLauncher(target, "Toggle nothing");
    expect(launcherPanel.open).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(tabFocusPulse.value).toBe(pulses);
    expect(document.activeElement).toBe(document.body);
  });

  test.each([
    { survey: true, removed: false },
    { survey: true, removed: true },
    { survey: false, removed: false },
    { survey: false, removed: true },
  ])("a settled run respects a terminal survey (survey $survey, removed origin $removed)", async ({ survey, removed }) => {
    const tab = terminalTab();
    resetLayout([tab]);
    const target = await openFromOrigin();
    const surveyTarget = document.createElement("div");
    document.body.append(surveyTarget);
    mounted.push(mount(BubbleOverlay, { target: surveyTarget, props: { tabId: tab.id } }) as Record<string, unknown>);
    await runFromLauncher(target, "Wait on window");
    expect(runHeld).toHaveBeenCalledOnce();
    expect(launcherPanel.open).toBe(false);
    if (survey) {
      showSurvey({ surveyId: "launcher-focus-survey", title: null, bodyMarkdown: "Choose an option", options: ["OK"] }, tab.id);
      await flush();
      const card = surveyTarget.querySelector<HTMLElement>(".survey-card")!;
      await vi.waitFor(() => expect(document.activeElement).toBe(card));
      // A temporarily unfocused survey still owns its terminal's modal slot.
      card.blur();
    }
    expect(document.activeElement).toBe(document.body);
    if (removed) origin.remove();
    const focus = vi.spyOn(origin, "focus");
    try {
      const pulses = tabFocusPulse.value;
      held!.resolve();
      await flush();
      expect(tabFocusPulse.value).toBe(pulses + (!survey && removed ? 1 : 0));
      if (!survey && !removed) {
        expect(focus).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(origin);
      } else {
        expect(focus).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
      }
    } finally {
      focus.mockRestore();
    }
  });

  test("a window action that closes the launcher after its success card hands focus back", async () => {
    library.snapshot = {
      library_id: "lib-local-test",
      windows: [
        {
          window_id: "w-notes",
          kind: "workspace",
          title: "notes",
          ordinal: 2,
          label: "notes",
          workspace_path: "/work/notes",
          connected: true,
          hidden: false,
          control: false,
          tmux: false,
          launch_path: "/api/library/command-capabilities/cap/windows/w-notes/launch",
        },
      ],
      workspaces: [],
    };
    // Hiding a window closes its popup, which the browser path acquires by name.
    vi.spyOn(window, "open").mockImplementation(
      () => ({ close: vi.fn(), focus: vi.fn(), closed: false, document: document.implementation.createHTMLDocument(), location: { href: "about:blank" } }) as unknown as Window,
    );
    const target = await openFromOrigin();
    (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
    await flush();
    // The window is the scope's first row; Right opens its page.
    const selected = target.querySelector('[role="option"][aria-selected="true"] .deck-result-title');
    expect(selected?.textContent).toBe("Window 2 [notes]");
    await press(target, "ArrowRight");
    row(target, "Hide window").click();
    await flush();
    expect(target.querySelector(".deck-operation"), "the success card").not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    expect(launcherPanel.open).toBe(false);
    // The hidden window is another one; this window's keyboard goes back
    // where it was.
    expect(document.activeElement).toBe(origin);
  });

  test("a cancelled Open from the launcher hands focus back to the element the launcher opened from", async () => {
    const target = await openFromOrigin();
    await runFromLauncher(target, "Open...");
    expect(launcherPanel.open).toBe(false);
    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement | null;
    expect(dialog, "the path dialog is open").not.toBeNull();
    await flush();
    expect(dialog!.contains(document.activeElement), "the restore leaves the dialog its focus").toBe(true);
    const focus = vi.spyOn(origin, "focus");

    resolvePathPrompt(null);
    await flush();
    await vi.waitFor(() => expect(document.activeElement).toBe(origin));
    // Handing focus back is not navigation: it must not scroll the page.
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  test("a cancelled Open run by a chord hands focus back to the control that held it", async () => {
    // The launcher was last opened from `origin` and dismissed; the chord
    // runs the command with no launcher open and focus on another control.
    const target = await openFromOrigin();
    await press(target, "Escape");
    expect(document.activeElement).toBe(origin);
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();

    await runOpenAndCancel();
    expect(document.activeElement, "focus returns to the chord's control, not the launcher's last opener").toBe(field);
  });

  test("a run that settles with the prompt open returns the keyboard to the prompt's field", async () => {
    // The deck opens from the prompt's field, as a chord would while the
    // prompt holds the keyboard; the run's return target is the modal heir.
    const dialogs = document.createElement("div");
    document.body.append(dialogs);
    mounted.push(mount(PromptModal, { target: dialogs }) as Record<string, unknown>);
    mounted.push(mount(PathPromptModal, { target: dialogs }) as Record<string, unknown>);
    void uiPrompt("Name");
    await flush();
    const field = document.querySelector<HTMLInputElement>('[role="dialog"][aria-modal="true"] input');
    expect(field, "the prompt shows its field").not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement, "the prompt takes the keyboard").toBe(field));
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
    openCommandLauncher();
    await flush();
    // Keys stay with the prompt while it shows, so the run goes through a
    // row click, the way a user reaches it under a dialog.
    const row = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
      (candidate) => candidate.querySelector(".deck-result-title")?.textContent === "Toggle nothing",
    );
    expect(row, "the deck lists the no-op command").toBeDefined();
    const focus = vi.spyOn(field!, "focus");
    try {
      row!.click();
      await flush();
      expect(runNothing, "the run executed").toHaveBeenCalled();
      expect(launcherPanel.open, "the run closes the deck").toBe(false);
      await vi.waitFor(() => expect(document.activeElement, "focus returns to the prompt's field").toBe(field));
      expect(focus, "the return hands the keyboard to the modal heir").toHaveBeenCalled();
    } finally {
      focus.mockRestore();
    }
  });

  test("a Split right run from the card leaves the keyboard on the body", async () => {
    const tab = terminalTab();
    resetLayout([tab]);
    // The run moves the card to the pane just left: the focused pane's
    // active terminal is no longer the card's, so the card arm declines
    // and the shared rule has nothing to return. Without the decline the
    // fall-through hands the card the keyboard.
    const surveyTarget = document.createElement("div");
    surveyTarget.className = "pane";
    surveyTarget.setAttribute("data-terminal-tab-id", tab.id);
    document.body.append(surveyTarget);
    try {
      mounted.push(mount(BubbleOverlay, { target: surveyTarget, props: { tabId: tab.id } }) as Record<string, unknown>);
      showSurvey({ surveyId: "launcher-focus-split", title: null, bodyMarkdown: "Choose", options: ["OK"] }, tab.id);
      await flush();
      const card = surveyTarget.querySelector<HTMLElement>(".survey-card");
      expect(card, "the survey shows its card").not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(card));
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      openCommandLauncher();
      await flush();
      expect(document.activeElement, "the launcher takes focus").toBe(target.querySelector(".deck-input"));
      // Keys stay with the survey while it shows, so the run goes through a
      // row click, the way a user reaches it under a survey.
      const row = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
        (candidate) => candidate.querySelector(".deck-result-title")?.textContent === "Split right",
      );
      expect(row, "the deck lists the split command").toBeDefined();
      const focus = vi.spyOn(card!, "focus");
      try {
        row!.click();
        await flush();
        expect(runSplit, "the run executed").toHaveBeenCalled();
        expect(launcherPanel.open, "the run closes the deck").toBe(false);
        await flush();
        expect(focus, "the return does not reach the pane just left").not.toHaveBeenCalled();
        await vi.waitFor(() => expect(document.activeElement, "the keyboard is left on the body").toBe(document.body));
      } finally {
        focus.mockRestore();
      }
    } finally {
      launcherPanel.open = false;
      overlayStack.ids = [];
      surveyTarget.remove();
    }
  });

  test("a run that settles with a window-wide survey up returns the keyboard to its card", async () => {
    // The heir is the window-wide survey's card, which has no focus repair
    // of its own, so only the return can hand it the keyboard back, and the
    // owner lets it: the card is inside the owner's root. It pins the
    // predicate, not a user path (the App refuses the launcher chord under
    // that survey).
    const surveyTarget = document.createElement("div");
    document.body.append(surveyTarget);
    try {
      mounted.push(mount(BubbleOverlay, { target: surveyTarget }) as Record<string, unknown>);
      showSurvey({ surveyId: "launcher-focus-window", title: null, bodyMarkdown: "Choose", options: ["OK"] }, null);
      await flush();
      const card = surveyTarget.querySelector<HTMLElement>(".survey-card");
      expect(card, "the window-wide survey shows its card").not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement, "the survey takes the keyboard").toBe(card));
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      openCommandLauncher();
      await flush();
      // Keys stay with the survey while it shows, so the run goes through a
      // row click, the way a user reaches it under a survey.
      const row = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
        (candidate) => candidate.querySelector(".deck-result-title")?.textContent === "Toggle nothing",
      );
      expect(row, "the deck lists the no-op command").toBeDefined();
      const focus = vi.spyOn(card!, "focus");
      try {
        row!.click();
        await flush();
        expect(runNothing, "the run executed").toHaveBeenCalled();
        expect(launcherPanel.open, "the run closes the deck").toBe(false);
        await vi.waitFor(() => expect(document.activeElement, "focus returns to the window-wide card").toBe(card));
        expect(focus, "the return hands the keyboard to the modal heir").toHaveBeenCalled();
      } finally {
        focus.mockRestore();
      }
    } finally {
      launcherPanel.open = false;
      overlayStack.ids = [];
      resetSurveysForTest();
      surveyTarget.remove();
    }
  });

  test("a run that settles with a survey card in an unfocused pane leaves it alone", async () => {
    const first = terminalTab({ id: "term-first" });
    const second = terminalTab({ id: "term-second" });
    resetLayout([first, second]);
    // The focused pane's own survey owns the keyboard; the card in the other
    // pane is not its terminal's card, so the return refuses it. Without the
    // terminal check the survey-card arm would hand it the keyboard. Paired
    // with the Split-right case above, which moves the card's pane out from
    // under it.
    const activeTarget = document.createElement("div");
    activeTarget.setAttribute("data-terminal-tab-id", first.id);
    document.body.append(activeTarget);
    const idleTarget = document.createElement("div");
    idleTarget.setAttribute("data-terminal-tab-id", second.id);
    document.body.append(idleTarget);
    try {
      mounted.push(mount(BubbleOverlay, { target: activeTarget, props: { tabId: first.id } }) as Record<string, unknown>);
      showSurvey({ surveyId: "launcher-focus-active", title: null, bodyMarkdown: "Choose", options: ["OK"] }, first.id);
      await flush();
      const active = activeTarget.querySelector<HTMLElement>(".survey-card");
      expect(active, "the active survey shows its card").not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(active));
      mounted.push(mount(BubbleOverlay, { target: idleTarget, props: { tabId: second.id } }) as Record<string, unknown>);
      showSurvey({ surveyId: "launcher-focus-idle", title: null, bodyMarkdown: "Choose", options: ["OK"] }, second.id);
      await flush();
      const card = idleTarget.querySelector<HTMLElement>(".survey-card");
      expect(card, "the idle survey shows its card").not.toBeNull();
      // The card moves to a pane of its own, which stays unfocused while the
      // first pane keeps the keyboard.
      const other = splitPane("pane-test", "column");
      expect(other, "the split opens another pane").not.toBeNull();
      moveTab("pane-test", second.id, other!);
      setActivePane("pane-test");
      await flush();
      const idlePane = layout.nodes[other!] as LeafNode;
      expect(idlePane.tabs.map((tab) => tab.id), "the card's tab moved to the other pane").toContain(second.id);
      // The idle card never takes the keyboard on arrival; the deck opens
      // from it the way a click would leave it there.
      card!.focus();
      await flush();
      expect(document.activeElement, "the idle card holds the keyboard").toBe(card);
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      openCommandLauncher();
      await flush();
      expect(document.activeElement, "the launcher takes focus").toBe(target.querySelector(".deck-input"));
      const row = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
        (candidate) => candidate.querySelector(".deck-result-title")?.textContent === "Toggle nothing",
      );
      expect(row, "the deck lists the no-op command").toBeDefined();
      row!.click();
      await flush();
      expect(runNothing, "the run executed").toHaveBeenCalled();
      expect(launcherPanel.open, "the run closes the deck").toBe(false);
      const focus = vi.spyOn(card!, "focus");
      try {
        await flush();
        expect(focus, "the return does not reach the inactive tab's card").not.toHaveBeenCalled();
        expect(document.activeElement, "the keyboard stays where the run left it").not.toBe(card);
      } finally {
        focus.mockRestore();
      }
    } finally {
      launcherPanel.open = false;
      overlayStack.ids = [];
      activeTarget.remove();
      idleTarget.remove();
    }
  });

  test("a dismissal whose opener is gone hands the keyboard to the focused terminal", async () => {
    xterm.textareaFocus = true;
    const [tab] = seatTerminals([terminalTab({ title: "meeting" })]);
    const { target: termTarget } = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    const target = await openFromOrigin();
    // The opener leaves the document, as a closed dock does, before the
    // deck is dismissed.
    origin.remove();
    await press(target, "Escape");
    expect(launcherPanel.open, "Escape dismisses the deck").toBe(false);
    const textarea = termTarget.querySelector<HTMLElement>("textarea");
    expect(textarea, "the terminal opened its input").not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement, "the terminal takes the keyboard").toBe(textarea));
  });

  test("a dismissal with no heir under a modal takes nothing", async () => {
    await openFromOrigin();
    const pulses = tabFocusPulse.value;
    origin.remove();
    void uiPrompt("Name");
    await flush();
    // Escape belongs to the modal while it shows, so the dismissal goes
    // through the direct close, which runs the same close effect.
    closeCommandLauncher();
    await flush();
    expect(launcherPanel.open, "the close dismisses the deck").toBe(false);
    expect(tabFocusPulse.value, "the modal keeps the keyboard; no fallback pulse").toBe(pulses);
  });
});

describe("the keyboard while the launcher is open", () => {
  const WHEN: Record<SurfaceGrab, string> = {
    sync: "as the row runs",
    microtask: "in a microtask",
    tick: "after a tick",
    timer: "on a zero-delay timer",
    mount: "as it mounts",
  };

  const field = (): Element | null => document.querySelector(".stand-in-surface");

  function mountSurface(how: SurfaceGrab): void {
    const host = document.createElement("div");
    document.body.append(host);
    const component = mount(StandInSurface, { target: host });
    mounted.push(component as Record<string, unknown>);
    surface = component as unknown as NonNullable<typeof surface>;
    surfaceGrab = how;
  }

  /// Send one keydown to the element that holds the keyboard, as a key press
  /// does.
  async function pressFocused(key: string): Promise<void> {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    await flush();
  }

  for (const how of ["sync", "microtask", "tick", "timer", "mount"] as const) {
    test(`a row that shows a surface which takes focus ${WHEN[how]} leaves the keyboard on the query`, async () => {
      mountSurface(how);
      const target = await openFromOrigin();
      const query = target.querySelector(".deck-input");
      await runFromLauncher(target, "Stand-in prompt");
      expect(runSurface).toHaveBeenCalledOnce();
      expect(launcherPanel.open, "the row changes in place").toBe(true);
      expect(field(), "the surface shows under the launcher").not.toBeNull();
      expect(document.activeElement, "the query keeps the keyboard").toBe(query);

      await pressFocused("Enter");
      expect(runSurface, "the next Enter is the launcher's").toHaveBeenCalledTimes(2);
      await pressFocused("Escape");
      expect(launcherPanel.open, "and so is Escape").toBe(false);
      expect(document.activeElement, "the close hands the keyboard to what the row showed").toBe(field());
    });
  }

  test("the close hands the keyboard back to the element the launcher opened from when the surface is gone", async () => {
    mountSurface("sync");
    const target = await openFromOrigin();
    await runFromLauncher(target, "Stand-in prompt");
    surface!.hide();
    await flush();
    await pressFocused("Escape");
    expect(launcherPanel.open).toBe(false);
    expect(document.activeElement).toBe(origin);
  });

  test("a later command that closes the launcher and takes no focus hands the keyboard to the surface", async () => {
    mountSurface("microtask");
    const target = await openFromOrigin();
    await runFromLauncher(target, "Stand-in prompt");
    await runFromLauncher(target, "Toggle nothing");
    expect(runNothing).toHaveBeenCalledOnce();
    expect(launcherPanel.open).toBe(false);
    expect(document.activeElement).toBe(field());
  });

  test("a surface that shows under the Computers launcher over the window keeps the focus it took", async () => {
    mountSurface("sync");
    const target = await openFromOrigin();
    // chan-desktop sets this while its launcher window covers the page: a
    // focus change the page makes then would take the keyboard from it.
    document.documentElement.setAttribute("data-launcher-shown", "");
    await runFromLauncher(target, "Stand-in prompt");
    expect(document.activeElement).toBe(field());
  });
});

describe("the launcher's return under another overlay", () => {
  // jsdom has no ResizeObserver; the search panel's hits effect needs the
  // stub the terminal tests install with their DOM helper.
  const realResizeObserver = globalThis.ResizeObserver;
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
  });
  test("a run that opens nothing returns the keyboard to the Search input", async () => {
    const searchTarget = document.createElement("div");
    document.body.append(searchTarget);
    try {
      mounted.push(mount(SearchPanel, { target: searchTarget }) as Record<string, unknown>);
      searchPanel.open = true;
      overlayStack.ids = ["search"];
      await flush();
      const input = searchTarget.querySelector<HTMLElement>(".search .head input");
      expect(input, "the search panel shows its input").not.toBeNull();
      input!.focus();
      await flush();
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      launcherPanel.open = true;
      overlayStack.ids = ["search", "launcher"];
      await flush();
      await runFromLauncher(target, "Toggle nothing");
      expect(launcherPanel.open, "the run closes the deck").toBe(false);
      expect(document.activeElement, "focus returns to the Search input").toBe(input);
    } finally {
      searchPanel.open = false;
      launcherPanel.open = false;
      overlayStack.ids = [];
      searchTarget.remove();
    }
  });

  test("Search opened over the open deck keeps the keyboard, and the deck takes it back as Search closes", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
    launcherPanel.open = true;
    overlayStack.ids = ["launcher"];
    await flush();
    const deckInput = target.querySelector<HTMLElement>(".deck-input");
    expect(document.activeElement, "the deck holds the keyboard").toBe(deckInput);
    const searchTarget = document.createElement("div");
    document.body.append(searchTarget);
    try {
      mounted.push(mount(SearchPanel, { target: searchTarget }) as Record<string, unknown>);
      searchPanel.open = true;
      overlayStack.ids = ["launcher", "search"];
      await flush();
      const input = searchTarget.querySelector<HTMLElement>(".search .head input");
      expect(input, "the search panel shows its input").not.toBeNull();
      input!.focus();
      await flush();
      expect(document.activeElement, "Search, the top overlay, keeps the keyboard").toBe(input);
      searchPanel.open = false;
      overlayStack.ids = ["launcher"];
      await flush();
      expect(document.activeElement, "the deck once Search closes").toBe(deckInput);
    } finally {
      searchPanel.open = false;
      launcherPanel.open = false;
      overlayStack.ids = [];
      searchTarget.remove();
    }
  });

  test("a run that settles with Search on top under a modal leaves the Search input alone", async () => {
    const searchTarget = document.createElement("div");
    document.body.append(searchTarget);
    try {
      mounted.push(mount(SearchPanel, { target: searchTarget }) as Record<string, unknown>);
      searchPanel.open = true;
      overlayStack.ids = ["search"];
      await flush();
      const input = searchTarget.querySelector<HTMLElement>(".search .head input");
      expect(input, "the search panel shows its input").not.toBeNull();
      input!.focus();
      await flush();
      const dialogs = document.createElement("div");
      document.body.append(dialogs);
      mounted.push(mount(PromptModal, { target: dialogs }) as Record<string, unknown>);
      mounted.push(mount(PathPromptModal, { target: dialogs }) as Record<string, unknown>);
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      launcherPanel.open = true;
      overlayStack.ids = ["search", "launcher"];
      await flush();
      await runFromLauncher(target, "Wait on window");
      expect(launcherPanel.open, "the run closes the deck").toBe(false);
      void uiPrompt("Name");
      await flush();
      const field = document.querySelector<HTMLInputElement>('[role="dialog"][aria-modal="true"] input')!;
      await vi.waitFor(() => expect(document.activeElement).toBe(field));
      field.blur();
      expect(document.activeElement).toBe(document.body);
      const focus = vi.spyOn(input!, "focus");
      try {
        held!.resolve();
        await flush();
        expect(promptState.open, "the modal still owns the keyboard").toBe(true);
        expect(focus, "the completed run does not return into Search under the modal").not.toHaveBeenCalled();
      } finally {
        focus.mockRestore();
      }
    } finally {
      searchPanel.open = false;
      launcherPanel.open = false;
      overlayStack.ids = [];
      searchTarget.remove();
    }
  });

  test("a run that opens nothing returns the keyboard to the survey card", async () => {
    const tab = terminalTab();
    resetLayout([tab]);
    // The product mounts the per-terminal overlay inside its terminal, whose
    // root carries the tab id the focus-return's ownership check reads.
    const surveyTarget = document.createElement("div");
    surveyTarget.setAttribute("data-terminal-tab-id", tab.id);
    document.body.append(surveyTarget);
    try {
      mounted.push(mount(BubbleOverlay, { target: surveyTarget, props: { tabId: tab.id } }) as Record<string, unknown>);
      showSurvey({ surveyId: "launcher-focus-card", title: null, bodyMarkdown: "Choose", options: ["OK"] }, tab.id);
      await flush();
      const card = surveyTarget.querySelector<HTMLElement>(".survey-card");
      expect(card, "the survey shows its card").not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(card));
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      openCommandLauncher();
      await flush();
      expect(document.activeElement, "the launcher takes focus").toBe(target.querySelector(".deck-input"));
      // Keys stay with the survey while it shows, so the run goes through
      // a row click, the way a user reaches it under a survey.
      const row = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
        (candidate) => candidate.querySelector(".deck-result-title")?.textContent === "Toggle nothing",
      );
      expect(row, "the deck lists the no-op command").toBeDefined();
      row!.click();
      await flush();
      expect(runNothing, "the run executed").toHaveBeenCalled();
      expect(launcherPanel.open, "the run closes the deck").toBe(false);
      expect(document.activeElement, "focus returns to the survey card").toBe(card);
    } finally {
      launcherPanel.open = false;
      overlayStack.ids = [];
      surveyTarget.remove();
    }
  });

  test("a run that opens nothing returns the keyboard to the survey card in a one-pane window", async () => {
    const tab = terminalTab();
    resetLayout([tab]);
    // A sole pane renders no `focused` class, so the return cannot read one:
    // it reads the card's terminal against the active terminal instead. The
    // wrapper carries the tab id the way the terminal's root does.
    const surveyTarget = document.createElement("div");
    surveyTarget.className = "pane";
    surveyTarget.setAttribute("data-terminal-tab-id", tab.id);
    document.body.append(surveyTarget);
    try {
      mounted.push(mount(BubbleOverlay, { target: surveyTarget, props: { tabId: tab.id } }) as Record<string, unknown>);
      showSurvey({ surveyId: "launcher-focus-sole", title: null, bodyMarkdown: "Choose", options: ["OK"] }, tab.id);
      await flush();
      const card = surveyTarget.querySelector<HTMLElement>(".survey-card");
      expect(card, "the survey shows its card").not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(card));
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      openCommandLauncher();
      await flush();
      expect(document.activeElement, "the launcher takes focus").toBe(target.querySelector(".deck-input"));
      // Keys stay with the survey while it shows, so the run goes through
      // a row click, the way a user reaches it under a survey.
      const row = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
        (candidate) => candidate.querySelector(".deck-result-title")?.textContent === "Toggle nothing",
      );
      expect(row, "the deck lists the no-op command").toBeDefined();
      row!.click();
      await flush();
      expect(runNothing, "the run executed").toHaveBeenCalled();
      expect(launcherPanel.open, "the run closes the deck").toBe(false);
      expect(document.activeElement, "focus returns to the survey card").toBe(card);
    } finally {
      launcherPanel.open = false;
      overlayStack.ids = [];
      surveyTarget.remove();
    }
  });

  test("a run that settles with a window-wide survey up leaves the terminal card alone", async () => {
    const tab = terminalTab();
    resetLayout([tab]);
    const surveyTarget = document.createElement("div");
    document.body.append(surveyTarget);
    const wideTarget = document.createElement("div");
    document.body.append(wideTarget);
    try {
      mounted.push(mount(BubbleOverlay, { target: surveyTarget, props: { tabId: tab.id } }) as Record<string, unknown>);
      showSurvey({ surveyId: "launcher-focus-card", title: null, bodyMarkdown: "Choose", options: ["OK"] }, tab.id);
      await flush();
      const card = surveyTarget.querySelector<HTMLElement>(".survey-card");
      expect(card, "the survey shows its card").not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(card));
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      openCommandLauncher();
      await flush();
      expect(document.activeElement, "the launcher takes focus").toBe(target.querySelector(".deck-input"));
      // Keys stay with the survey while it shows, so the run goes through
      // a row click, the way a user reaches it under a survey.
      const row = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].find(
        (candidate) => candidate.querySelector(".deck-result-title")?.textContent === "Wait on window",
      );
      expect(row, "the deck lists the held command").toBeDefined();
      row!.click();
      await flush();
      expect(held, "the run started").not.toBeNull();
      // A window-wide survey shows while the run is still out; the pane
      // gives up the keyboard to the window.
      mounted.push(mount(BubbleOverlay, { target: wideTarget }) as Record<string, unknown>);
      showSurvey({ surveyId: "launcher-focus-window", title: null, bodyMarkdown: "Choose", options: ["OK"] }, null);
      await flush();
      const wide = wideTarget.querySelector<HTMLElement>(".survey-card");
      expect(wide, "the window-wide survey shows its card").not.toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(wide));
      wide!.blur();
      expect(document.activeElement).toBe(document.body);
      const focus = vi.spyOn(card!, "focus");
      try {
        held!.resolve();
        await flush();
        expect(launcherPanel.open, "the run closes the deck").toBe(false);
        expect(focus, "the completed run does not return into the terminal card").not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
      } finally {
        focus.mockRestore();
      }
    } finally {
      launcherPanel.open = false;
      overlayStack.ids = [];
      surveyTarget.remove();
      wideTarget.remove();
    }
  });

  test("a run that settles with Search on top leaves a pane-level dialog button alone", async () => {
    const searchTarget = document.createElement("div");
    document.body.append(searchTarget);
    const card = document.createElement("div");
    card.setAttribute("role", "dialog");
    const button = document.createElement("button");
    button.textContent = "stand-in";
    card.append(button);
    document.body.append(card);
    const focus = vi.spyOn(button, "focus");
    try {
      mounted.push(mount(SearchPanel, { target: searchTarget }) as Record<string, unknown>);
      searchPanel.open = true;
      overlayStack.ids = ["search"];
      await flush();
      button.focus();
      await flush();
      focus.mockClear();
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      launcherPanel.open = true;
      overlayStack.ids = ["search", "launcher"];
      await flush();
      await runFromLauncher(target, "Toggle nothing");
      expect(launcherPanel.open, "the run closes the deck").toBe(false);
      expect(focus, "the completed run does not return into a pane-level dialog").not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.body);
    } finally {
      focus.mockRestore();
      searchPanel.open = false;
      launcherPanel.open = false;
      overlayStack.ids = [];
      searchTarget.remove();
      card.remove();
    }
  });

  test("a run that settles while the Computers launcher is shown moves no focus", async () => {
    const searchTarget = document.createElement("div");
    document.body.append(searchTarget);
    try {
      mounted.push(mount(SearchPanel, { target: searchTarget }) as Record<string, unknown>);
      searchPanel.open = true;
      overlayStack.ids = ["search"];
      await flush();
      const input = searchTarget.querySelector<HTMLElement>(".search .head input");
      expect(input, "the search panel shows its input").not.toBeNull();
      input!.focus();
      await flush();
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
      launcherPanel.open = true;
      overlayStack.ids = ["search", "launcher"];
      await flush();
      document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
      await flush();
      await runFromLauncher(target, "Toggle nothing");
      expect(launcherPanel.open, "the run closes the deck").toBe(false);
      expect(document.activeElement, "focus stays on the body while the launcher covers the window").toBe(document.body);
    } finally {
      document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
      searchPanel.open = false;
      launcherPanel.open = false;
      overlayStack.ids = [];
      searchTarget.remove();
    }
  });
});

describe("the deck under the screen lock", () => {
  beforeEach(() => {
    // The lock's rain draws on a canvas and asks about reduced motion and fonts.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      recordingContext2d().ctx as unknown as RenderingContext,
    );
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    Object.defineProperty(document, "fonts", { configurable: true, value: { load: vi.fn(async () => []) } });
    workspace.info = demoWorkspaceInfo({
      metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
      files: [],
    });
    Object.assign(screensaver, { enabled: true, timeout_secs: 300, theme: "plain", pin_set: true, locked: false, loaded: true });
  });

  afterEach(() => {
    screensaver.locked = false;
    workspace.info = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("the lock coming up over the open deck keeps its PIN field's keyboard, and Enter runs no row", async () => {
    const target = await openFromOrigin();
    const input = target.querySelector(".deck-input") as HTMLInputElement;
    input.value = "Toggle nothing";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "Toggle nothing" }));
    await tick();
    const lockTarget = document.createElement("div");
    document.body.append(lockTarget);
    mounted.push(mount(ScreensaverOverlay, { target: lockTarget }) as Record<string, unknown>);
    screensaver.locked = true;
    await flush();
    const backdrop = document.querySelector<HTMLElement>(".screensaver-backdrop")!;
    expect(document.activeElement, "the lock takes the keyboard from the deck").toBe(backdrop);
    backdrop.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    await flush();
    const pin = backdrop.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(document.activeElement, "the woken card's PIN field").toBe(pin);
    pin.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();
    expect(runNothing, "a key typed under the lock ran the deck's row").not.toHaveBeenCalled();
    expect(document.activeElement, "the PIN field keeps the keyboard").toBe(pin);
  });
});
