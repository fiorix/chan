// @vitest-environment jsdom
//
// Where focus goes when the command launcher closes: back to the element it
// opened from after a dismissal, left where a command put it after a run, and
// back to that element again when Open's path dialog, which outlives the
// launcher, is cancelled.

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
import { allCommands, registerCommands } from "../state/commands";
import "../state/commands/global";
import {
  clearLauncherDraft,
  closeCommandLauncher,
  launcherPanel,
  openCommandLauncher,
  pathPromptState,
  resolvePathPrompt,
} from "../state/store.svelte";

Element.prototype.scrollIntoView = vi.fn();

/// Where the probe command puts focus, as a command that opens a surface does.
let probeTarget: HTMLInputElement | null = null;
const runProbe = vi.fn(() => probeTarget?.focus());
registerCommands([
  {
    id: "test.focus.probe",
    title: "Probe focus",
    category: "Global",
    requirement: "any",
    available: () => true,
    run: runProbe,
  },
]);

const mounted: Array<Record<string, unknown>> = [];
let origin: HTMLButtonElement;

async function flush(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

/// Focus a control, then open the launcher from it the way the app does.
async function openFromOrigin(): Promise<HTMLElement> {
  origin = document.createElement("button");
  document.body.append(origin);
  origin.focus();
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

beforeEach(() => {
  library.snapshot = null;
  probeTarget = null;
  sessionStorage.clear();
  clearLauncherDraft();
  launcherPanel.open = false;
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  if (pathPromptState.open) resolvePathPrompt(null);
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
    const input = target.querySelector(".deck-input") as HTMLInputElement;
    input.value = "probe focus";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "probe focus" }));
    await tick();
    await press(target, "Enter");
    expect(runProbe).toHaveBeenCalledOnce();
    expect(launcherPanel.open).toBe(false);
    expect(document.activeElement).toBe(probeTarget);
  });

  test("a window action that closes the launcher after its success card leaves focus alone", async () => {
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
    expect(document.activeElement).not.toBe(origin);
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
