// @vitest-environment jsdom
//
// Launcher argument forwarding (item 8): a query like "Open notes/x.md"
// matches an acceptsArg command on its HEAD token and Enter forwards the
// remainder to run() VERBATIM (case and inner spaces preserved); a bare
// pick passes undefined (the command's dialog branch); commands without
// acceptsArg never head-token match. Plus the deck's return-focus capture
// that lets a command's dialog flow restore the pre-launcher focus.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Isolate from the real catalog registrations (install pulls every lane's
// action module); register a small known set instead.
vi.mock("../state/commands/install", () => ({}));

import CommandLauncher from "./CommandLauncher.svelte";
import {
  clearLauncherDraft,
  closeCommandLauncher,
  launcherPanel,
  openCommandLauncher,
} from "../state/store.svelte";
import { deckReturnFocus } from "@chan/web-shared/CommandDeck.svelte";
import { registerCommands } from "../state/commands";
import { resetLayout as harnessResetLayout } from "../__tests__/tabs";

Element.prototype.scrollIntoView = vi.fn();

const runOpen = vi.fn();
const runOther = vi.fn();

registerCommands([
  {
    id: "app.open.path",
    title: "Open",
    category: "Global",
    requirement: "any",
    available: () => true,
    acceptsArg: true,
    run: runOpen,
  },
  {
    id: "app.other.plain",
    title: "Other",
    category: "Global",
    requirement: "any",
    available: () => true,
    run: runOther,
  },
]);

const mounted: Array<Record<string, unknown>> = [];

function resetLayout(): void {
  harnessResetLayout([], { id: "launcher-arg-pane" });
}

/// Mount + open, then settle the open effect (which resets the highlight
/// and latches lastQuery) BEFORE any query is typed, so the query-change
/// branch of the highlight effect sees the real transition.
async function openLauncher(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(CommandLauncher, { target }) as Record<string, unknown>);
  openCommandLauncher();
  await tick();
  await tick();
  return target;
}

async function typeQuery(target: HTMLElement, query: string): Promise<void> {
  const input = target.querySelector<HTMLInputElement>(".deck-input");
  if (!input) throw new Error("command deck input is missing");
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: query }));
  await tick();
  await tick();
}

async function pressEnter(target: HTMLElement): Promise<void> {
  const dialog = target.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("command deck dialog is missing");
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await tick();
}

function resultTitles(target: HTMLElement): (string | null)[] {
  return [...target.querySelectorAll(".deck-result-title")].map((element) => element.textContent);
}

beforeEach(() => {
  resetLayout();
  sessionStorage.clear();
  closeCommandLauncher();
  clearLauncherDraft();
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  launcherPanel.open = false;
  launcherPanel.query = "";
  vi.clearAllMocks();
});

describe("launcher argument forwarding", () => {
  test("head-token match carries the verbatim remainder to run()", async () => {
    const target = await openLauncher();
    await typeQuery(target, "open notes/My File.md");
    // The full query matches nothing, but the head token "open" matches
    // the acceptsArg command, so it floats into Results with its arg.
    expect(resultTitles(target)).toEqual(["Open notes/My File.md"]);
    await pressEnter(target);
    expect(runOpen).toHaveBeenCalledExactlyOnceWith("notes/My File.md");
    expect(launcherPanel.open).toBe(false);
  });

  test("bare pick passes undefined (the dialog branch)", async () => {
    const target = await openLauncher();
    await typeQuery(target, "open");
    await pressEnter(target);
    expect(runOpen).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  test("a command without acceptsArg never head-token matches", async () => {
    const target = await openLauncher();
    await typeQuery(target, "other x.md");
    // "Other" must not float into Results on its head token; the row list
    // is empty (no full-query match either) and Enter runs nothing.
    expect(resultTitles(target)).toEqual([]);
    await pressEnter(target);
    expect(runOther).not.toHaveBeenCalled();
    expect(runOpen).not.toHaveBeenCalled();
  });

  test("remainder keeps inner whitespace verbatim", async () => {
    const target = await openLauncher();
    await typeQuery(target, "open a  b/c d.md");
    await pressEnter(target);
    expect(runOpen).toHaveBeenCalledExactlyOnceWith("a  b/c d.md");
  });
});

describe("deckReturnFocus capture", () => {
  test("opening the launcher captures the focused element for later restore", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await openLauncher();
    expect(deckReturnFocus()).toBe(input);
    input.remove();
  });
});
