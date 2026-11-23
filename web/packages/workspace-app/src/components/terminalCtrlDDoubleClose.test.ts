// @vitest-environment jsdom
//
// Ctrl+D on an exited terminal must close exactly that tab. TerminalTab is
// mounted on the shared fixture's widget, whose keydown listener sits on the
// element it was opened in: it calls chan's custom key handler and, on a
// truthy return, prevents the default and returns, without stopping
// propagation. The keystroke would then keep bubbling to the
// `.terminal-tab` root, whose `onkeydown` runs the same close a second time.
// A key reaches that listener from the element itself, which focus() takes,
// and from the widget's input textarea inside it, which a press on the
// canvas takes.

import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { layout, type LeafNode, type TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import {
  attach,
  installTerminalDom,
  receive,
  resetTerminals,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

afterEach(() => {
  resetTerminals();
});

/// Mount the pane's terminal tab beside a neighbour and drive it to
/// `status === "exited"`, the only state in which Ctrl+D is the
/// close-this-tab chord.
async function mountExitedTerminal() {
  const pane = resetLayout([terminalTab({ id: "term-exited" }), fileTab({ id: "file-neighbour", path: "notes/neighbour.md" })], {
    id: TERMINAL_PANE,
  });
  const tab = pane.tabs.find((t) => t.kind === "terminal") as TerminalTabState;
  const { target, term } = await mountGhosttyTerminal(TerminalTab, tab);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: "term-session" });
  await receive(socket, { type: "exit", code: 0 });
  await tick();
  return { target, term };
}

function ctrlD(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "d",
    code: "KeyD",
    keyCode: 68,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
}

/// Let the close pipeline settle: closeTabAsync awaits the confirm helper and
/// the terminal close sink before it splices, so the removal lands a few
/// microtasks after the keystroke.
async function settleCloses(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

function paneTabIds(): string[] {
  return (layout.nodes[TERMINAL_PANE] as LeafNode).tabs.map((t) => t.id);
}

describe("Ctrl+D on an exited terminal", () => {
  test("from the widget's input textarea: closes its own tab and leaves the neighbour", async () => {
    const { term } = await mountExitedTerminal();

    const textarea = term.element?.querySelector("textarea");
    expect(textarea, "the widget's input textarea").toBeInstanceOf(HTMLTextAreaElement);
    textarea!.dispatchEvent(ctrlD());
    await settleCloses();

    expect(paneTabIds()).toEqual(["file-neighbour"]);
  });

  // Control: with only one owner in the dispatch path the close runs once,
  // which is what makes a failure of the others a double dispatch rather
  // than a broken mount or a broken close.
  test("the component root alone closes exactly one tab", async () => {
    await mountExitedTerminal();

    const root = document.body.querySelector<HTMLElement>(".terminal-tab");
    expect(root).not.toBeNull();
    root!.dispatchEvent(ctrlD());
    await settleCloses();

    expect(paneTabIds()).toEqual(["file-neighbour"]);
  });

  test("ghostty: closes its own tab and leaves the neighbour", async () => {
    const { target, term } = await mountExitedTerminal();

    const host = target.querySelector<HTMLElement>(".terminal-host");
    expect(host, "the widget opened in the terminal host").toBe(term.element);
    host!.dispatchEvent(ctrlD());
    await settleCloses();

    expect(paneTabIds()).toEqual(["file-neighbour"]);
  });
});
