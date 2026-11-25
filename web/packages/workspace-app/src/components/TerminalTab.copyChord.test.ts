// @vitest-environment jsdom
//
// A chord the user assigns to the terminal's Copy. The app's own key handler
// runs the command for it, and the terminal answers as it answers its
// built-in copy chord: the selection goes to the clipboard, and with nothing
// selected nothing does. The menu's row and the launcher's row for the same
// command still copy the scrollback then. The real App is mounted over the
// demo transport with the shared Ghostty widget, so the key takes the path a
// pressed chord takes.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { pressInPage } from "../__tests__/keys";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import type { Terminal } from "@chan/ghostty-web-ng";
import { ghosttyFixture, openedGhostty } from "../__tests__/ghosttyTab";
import { commandById, commandTitle } from "../state/commands";
import { assignOverride, hydrateOverrides } from "../state/keymapOverrides.svelte";
import { launcherPanel } from "../state/store.svelte";
import type { Tab } from "../state/tabs.svelte";

stubAppEnvironment();

const ASSIGNED = { key: "j", code: "KeyJ", ctrlKey: true, altKey: true } as const;
const SCROLLBACK = "selected text\nline two";

const clipboard = { writeText: vi.fn(async (_text: string) => {}), readText: vi.fn(async () => "") };
Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

beforeEach(async () => {
  await mountApp();
});

afterEach(async () => {
  hydrateOverrides(null);
  launcherPanel.open = false;
  ghosttyFixture.terminals.splice(0);
  clipboard.writeText.mockClear();
  await settle();
  await unmountApp();
});

/// Seat `tabs` in the window's one pane and return the terminal the first
/// of them mounted, with scrollback to copy.
async function seed(...tabs: Tab[]): Promise<Terminal> {
  ghosttyFixture.terminals.splice(0);
  resetLayout(tabs);
  await vi.waitFor(() => expect(ghosttyFixture.terminals).toHaveLength(1));
  await settle();
  const term = await openedGhostty();
  term.write("\x1b[2J\x1b[H" + SCROLLBACK.replaceAll("\n", "\r\n"));
  return term;
}

/// Every text written to the clipboard so far.
function written(): string[] {
  return clipboard.writeText.mock.calls.map(([text]) => text);
}

/// Wait until the clipboard has been written exactly these texts.
async function copied(texts: string[]): Promise<void> {
  await vi.waitFor(() => expect(written()).toEqual(texts));
}

/// Give a copy that was asked for the turns it takes to reach the
/// clipboard, for a case that expects none.
async function idle(): Promise<void> {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/// Run Copy as a launcher row does: with nothing said of how.
function runCopy(): void {
  const command = commandById("terminal.copy");
  if (!command) throw new Error("no command terminal.copy");
  command.run();
}

/// Choose Copy in the terminal's right-click menu.
async function chooseMenuCopy(): Promise<void> {
  document
    .querySelector(".terminal-tab")!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await settle();
  const row = [...document.querySelectorAll<HTMLButtonElement>("button.mbtn")].find(
    (button) => button.querySelector(".mbtn-label")?.textContent?.trim() === commandTitle("terminal.copy"),
  );
  if (!row) throw new Error("no Copy row in the terminal's menu");
  row.click();
}

describe("a chord assigned to the terminal's Copy", () => {
  test("copies the selection", async () => {
    const term = await seed(terminalTab({ id: "shell" }));
    assignOverride("terminal.copy", "Ctrl+Alt+J", "web");
    term.select(0, 0, "selected text".length);
    expect(term.getSelection()).toBe("selected text");

    const { event } = pressInPage(ASSIGNED);

    expect(event.defaultPrevented, "the app took the key").toBe(true);
    await copied(["selected text"]);
  });

  test("does nothing with nothing selected, where the menu's row and the launcher's row copy the scrollback", async () => {
    const term = await seed(terminalTab({ id: "shell" }));
    assignOverride("terminal.copy", "Ctrl+Alt+J", "web");
    term.clearSelection();

    const { event } = pressInPage(ASSIGNED);
    expect(event.defaultPrevented, "the app took the key").toBe(true);
    await idle();
    expect(written(), "the chord").toEqual([]);

    await chooseMenuCopy();
    await copied([SCROLLBACK]);

    runCopy();
    await copied([SCROLLBACK, SCROLLBACK]);
  });

  test("leaves the next run of the command a row's", async () => {
    const term = await seed(terminalTab({ id: "shell" }));
    assignOverride("terminal.copy", "Ctrl+Alt+J", "web");
    term.select(0, 0, "selected text".length);
    expect(term.getSelection()).toBe("selected text");
    pressInPage(ASSIGNED);
    await copied(["selected text"]);

    term.clearSelection();
    runCopy();
    await copied(["selected text", SCROLLBACK]);
  });

  test("is not the terminal's while another tab holds the pane", async () => {
    const term = await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }), terminalTab({ id: "shell" }));
    assignOverride("terminal.copy", "Ctrl+Alt+J", "web");
    term.select(0, 0, "selected text".length);
    expect(term.getSelection()).toBe("selected text");

    const { event } = pressInPage(ASSIGNED);

    expect(event.defaultPrevented, "Copy is not offered on a file tab").toBe(false);
    await idle();
    expect(written()).toEqual([]);
  });
});
