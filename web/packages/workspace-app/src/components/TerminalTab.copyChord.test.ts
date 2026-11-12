// @vitest-environment jsdom
//
// A chord the user assigns to the terminal's Copy. The app's own key handler
// runs the command for it, and the terminal answers as it answers its
// built-in copy chord: the selection goes to the clipboard, and with nothing
// selected nothing does. The launcher's row for the same command still
// copies the scrollback then, as the menu's row does. The real App is
// mounted over the demo transport with the stand-in xterm, so the key takes
// the path a pressed chord takes.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/xterm")).webglAddonModule());

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { pressInPage } from "../__tests__/keys";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import { xterm, type FakeTerminal } from "../__tests__/xterm";
import { commandById } from "../state/commands";
import { assignOverride, hydrateOverrides } from "../state/keymapOverrides.svelte";
import { launcherPanel } from "../state/store.svelte";
import type { Tab } from "../state/tabs.svelte";

stubAppEnvironment();

const ASSIGNED = { key: "j", code: "KeyJ", ctrlKey: true, altKey: true } as const;
const SCROLLBACK = "line one\nline two";

const clipboard = { writeText: vi.fn(async (_text: string) => {}), readText: vi.fn(async () => "") };
Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

beforeEach(async () => {
  await mountApp();
});

afterEach(async () => {
  hydrateOverrides(null);
  launcherPanel.open = false;
  xterm.serialized = "";
  xterm.terminals.splice(0);
  clipboard.writeText.mockClear();
  await settle();
  await unmountApp();
});

/// Seat `tabs` in the window's one pane and return the terminal the first
/// of them mounted, with scrollback to copy.
async function seed(...tabs: Tab[]): Promise<FakeTerminal> {
  xterm.terminals.splice(0);
  resetLayout(tabs);
  await vi.waitFor(() => expect(xterm.terminals).toHaveLength(1));
  await settle();
  xterm.serialized = SCROLLBACK;
  return xterm.terminals[0]!;
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

function runCopy(): void {
  const command = commandById("terminal.copy");
  if (!command) throw new Error("no command terminal.copy");
  command.run();
}

describe("a chord assigned to the terminal's Copy", () => {
  test("copies the selection", async () => {
    const term = await seed(terminalTab({ id: "shell" }));
    assignOverride("terminal.copy", "Ctrl+Alt+J", "web");
    term.selection = "selected text";

    const { event } = pressInPage(ASSIGNED);

    expect(event.defaultPrevented, "the app took the key").toBe(true);
    await copied(["selected text"]);
  });

  test("does nothing with nothing selected, where the launcher's row copies the scrollback", async () => {
    const term = await seed(terminalTab({ id: "shell" }));
    assignOverride("terminal.copy", "Ctrl+Alt+J", "web");
    term.selection = "";

    const { event } = pressInPage(ASSIGNED);
    expect(event.defaultPrevented, "the app took the key").toBe(true);
    await idle();
    expect(written(), "the chord").toEqual([]);

    runCopy();
    await copied([SCROLLBACK]);
  });

  test("leaves the next run of the command a row's", async () => {
    const term = await seed(terminalTab({ id: "shell" }));
    assignOverride("terminal.copy", "Ctrl+Alt+J", "web");
    term.selection = "selected text";
    pressInPage(ASSIGNED);
    await copied(["selected text"]);

    term.selection = "";
    runCopy();
    await copied(["selected text", SCROLLBACK]);
  });

  test("is not the terminal's while another tab holds the pane", async () => {
    await seed(fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" }), terminalTab({ id: "shell" }));
    assignOverride("terminal.copy", "Ctrl+Alt+J", "web");
    xterm.terminals[0]!.selection = "selected text";

    const { event } = pressInPage(ASSIGNED);

    expect(event.defaultPrevented, "Copy is not offered on a file tab").toBe(false);
    await idle();
    expect(written()).toEqual([]);
  });
});
