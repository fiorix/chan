// @vitest-environment jsdom
//
// Where focus goes when the command launcher closes: back to the element it
// opened from after a dismissal, left where a command put it after a run,
// back to that element after a run that put it nowhere, and back to that
// element again when Open's path dialog, which outlives the launcher, is
// cancelled.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
import PromptModal from "./PromptModal.svelte";
import { allCommands, registerCommands } from "../state/commands";
import "../state/commands/global";
import {
  clearLauncherDraft,
  closeCommandLauncher,
  launcherPanel,
  openCommandLauncher,
  pathPromptState,
  promptState,
  resolvePathPrompt,
  resolvePrompt,
  uiPrompt,
} from "../state/store.svelte";
import { tabFocusPulse } from "../state/tabs.svelte";

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
/// A command whose run waits on something slow, as a Computers action waiting
/// for a window page does; the test releases it.
let held: { promise: Promise<void>; resolve: () => void } | null = null;
const runHeld = vi.fn(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  held = { promise, resolve };
  return promise;
});
registerCommands([
  {
    id: "test.focus.probe",
    title: "Probe focus",
    category: "Global",
    requirement: "any",
    available: () => true,
    run: runProbe,
  },
  {
    id: "test.focus.nothing",
    title: "Toggle nothing",
    category: "Global",
    requirement: "any",
    available: () => true,
    run: runNothing,
  },
  {
    id: "test.focus.late",
    title: "Late field",
    category: "Global",
    requirement: "any",
    available: () => true,
    run: runLate,
  },
  {
    id: "test.focus.after",
    title: "After field",
    category: "Global",
    requirement: "any",
    available: () => true,
    run: runAfter,
  },
  {
    id: "test.focus.drop",
    title: "Drop origin",
    category: "Global",
    requirement: "any",
    available: () => true,
    run: runDrop,
  },
  {
    id: "test.focus.prompt",
    title: "Ask name",
    category: "Global",
    requirement: "any",
    available: () => true,
    run: runPrompt,
  },
  {
    id: "test.focus.held",
    title: "Wait on window",
    category: "Global",
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
/// prompt dialog mounts before the launcher, as it does in the app.
async function openFromOrigin(): Promise<HTMLElement> {
  origin = document.createElement("button");
  document.body.append(origin);
  origin.focus();
  const dialogs = document.createElement("div");
  document.body.append(dialogs);
  mounted.push(mount(PromptModal, { target: dialogs }) as Record<string, unknown>);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
  openCommandLauncher();
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

/// Run Open with no path, which raises its path dialog, and cancel the dialog.
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
  document.documentElement.removeAttribute("data-launcher-shown");
  sessionStorage.clear();
  clearLauncherDraft();
  launcherPanel.open = false;
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  if (pathPromptState.open) resolvePathPrompt(null);
  if (promptState.open) resolvePrompt(null);
  document.body.innerHTML = "";
  launcherPanel.open = false;
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
    row(target, "Windows").click();
    await flush();
    row(target, "Window 2 [notes]").click();
    await flush();
    row(target, "Hide").click();
    await flush();
    expect(target.querySelector(".deck-operation"), "the success card").not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    expect(launcherPanel.open).toBe(false);
    // The hidden window is another one; this window's keyboard goes back
    // where it was.
    expect(document.activeElement).toBe(origin);
  });

  test("a cancelled Open hands focus back to the element the launcher opened from", async () => {
    await openFromOrigin();
    closeCommandLauncher();
    await flush();
    // Stands in for the path dialog's field, which holds focus until cancel.
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();

    await runOpenAndCancel();
    expect(document.activeElement).toBe(origin);
  });

  test("a cancelled Open hands focus back without scrolling the page", async () => {
    await openFromOrigin();
    closeCommandLauncher();
    await flush();
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const focus = vi.spyOn(origin, "focus");

    await runOpenAndCancel();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
});
