// @vitest-environment jsdom
//
// Where focus goes when the command launcher closes: back to the element it
// opened from after a dismissal, left where a command put it after a run, and
// back to that element again when Open's path dialog, which outlives the
// launcher, is cancelled.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../state/commands/install", () => ({}));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: vi.fn(async () => null),
  loadScopedWindowLiveTerminals: vi.fn(),
  runScopedLibraryAction: vi.fn(),
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

const runProbe = vi.fn();
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

async function press(target: HTMLElement, key: string): Promise<void> {
  (target.querySelector('[role="dialog"]') as HTMLElement).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true }),
  );
  await flush();
}

beforeEach(() => {
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

  test("running a command leaves focus off the element it opened from", async () => {
    const target = await openFromOrigin();
    const input = target.querySelector(".deck-input") as HTMLInputElement;
    input.value = "probe focus";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "probe focus" }));
    await tick();
    await press(target, "Enter");
    expect(runProbe).toHaveBeenCalledOnce();
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

    const open = allCommands().find((command) => command.id === "app.open.path");
    expect(open, "the Open command is registered").toBeDefined();
    open!.run();
    await vi.waitFor(() => expect(pathPromptState.open).toBe(true));
    resolvePathPrompt(null);
    await flush();
    expect(document.activeElement).toBe(origin);
  });
});
