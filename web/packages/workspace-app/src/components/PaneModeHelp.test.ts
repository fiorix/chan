// @vitest-environment jsdom
//
// The Hybrid Nav help lists every binding by group, under the mode's name
// and the chord that enters it. A key that performs a catalog command is
// worded by that command's title; a key that exists only inside the mode
// keeps the help's own words. Each key-cap is a button that presses its key
// on the document, where App's Hybrid Nav handler takes it, so a click and a
// keystroke run the same switch.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { expectWords, type WordSource } from "../__tests__/menuWords";
import { assignOverride, clearOverride } from "../state/keymapOverrides.svelte";
import PaneModeHelp from "./PaneModeHelp.svelte";

let view: Record<string, unknown> | null = null;
let help: HTMLElement;

beforeEach(() => {
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(PaneModeHelp, { target });
  flushSync();
  help = target.querySelector<HTMLElement>('[role="dialog"]')!;
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  clearOverride("app.pane.mode");
});

// Why a key keeps the help's own words: the catalog has no command for it.
const DIRECTIONAL = "moves by direction between tiles, which only the mode's draft does";
const STAGED = "stages a tab in the mode's draft for Enter to open; the launcher's New rows open one at once";
const MODE = "ends or explains the mode itself";

/// Every row the help draws in a workspace window, by group, with where its
/// words come from.
const ROWS: Array<{ title: string; rows: WordSource[] }> = [
  {
    title: "Move",
    rows: [
      { own: "Move focus", because: DIRECTIONAL },
      { own: "Swap tile with neighbour", because: DIRECTIONAL },
    ],
  },
  {
    title: "Stage (Enter to commit, Esc to discard)",
    rows: [
      { own: "Stage terminal", because: STAGED },
      { own: "Stage file browser", because: STAGED },
      { own: "Stage graph", because: STAGED },
      { own: "Stage dashboard", because: STAGED },
      { own: "Stage new draft", because: STAGED },
      { own: "Stage Excalidraw", because: STAGED },
    ],
  },
  {
    title: "Split",
    rows: [{ command: "app.pane.splitRight" }, { command: "app.pane.splitDown" }],
  },
  {
    title: "Dock",
    rows: [{ command: "app.browser.toggleRightDock" }, { command: "app.browser.toggleLeftDock" }],
  },
  {
    title: "Resize",
    rows: [
      { command: "app.pane.dividerLeft" },
      { command: "app.pane.dividerRight" },
      { command: "app.pane.dividerUp" },
      { command: "app.pane.dividerDown" },
      { command: "app.pane.equalize" },
    ],
  },
  {
    title: "Commit",
    rows: [
      { own: "Commit draft", because: MODE },
      { own: "Discard draft", because: MODE },
      { own: "Toggle this help", because: MODE },
      { command: "app.pane.flip" },
    ],
  },
];

describe("the Hybrid Nav help", () => {
  test("is titled by the mode's command and the chord that enters it", () => {
    expect(help.getAttribute("aria-label")).toBe("Hybrid Nav help");
    expect(help.querySelector(".title")?.textContent).toBe("Hybrid Nav (Ctrl+.)");
  });

  test("shows the chord a user assigned to the mode", () => {
    assignOverride("app.pane.mode", "Mod+Shift+M");
    flushSync();
    expect(help.querySelector(".title")?.textContent).toBe("Hybrid Nav (Ctrl+Shift+M)");
  });

  test("words each key by its command, or by its own words where it has none", () => {
    const groups = [...help.querySelectorAll("section.group")];
    expect(groups.map((group) => group.querySelector("h4")!.textContent)).toEqual(
      ROWS.map((group) => group.title),
    );
    groups.forEach((group, index) => {
      const labels = [...group.querySelectorAll("dd")].map((row) => row.textContent ?? "");
      expectWords(labels, ROWS[index]!.rows);
    });
  });

  test("every row is sentence case, a product's name aside", () => {
    const rows = [...help.querySelectorAll("dd")].map((row) => row.textContent ?? "");
    expect(rows.length).toBeGreaterThan(20);
    for (const words of rows) {
      expect(words[0], words).toBe(words[0]!.toUpperCase());
      const rest = words.replace(/\bExcalidraw\b/g, "").slice(1);
      expect(rest, words).toBe(rest.toLowerCase());
    }
  });

  test("reads as the launcher does", () => {
    const rows = [...help.querySelectorAll("dd")].map((row) => row.textContent);
    for (const title of [
      "Split right", "Split down",
      "Right file browser dock", "Left file browser dock",
      "Move divider left", "Move divider right", "Move divider up", "Move divider down",
      "Equalize panes", "Flip pane",
    ]) {
      expect(rows, title).toContain(title);
    }
  });

  test("presses each cap's key on the document", () => {
    const pressed: string[] = [];
    const listen = vi.fn((event: KeyboardEvent) => pressed.push(event.key));
    document.addEventListener("keydown", listen);
    try {
      for (const cap of help.querySelectorAll<HTMLButtonElement>("button.kbd-button")) cap.click();
    } finally {
      document.removeEventListener("keydown", listen);
    }

    expect(pressed).toEqual([
      "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight",
      "w", "a", "s", "d",
      "t", "f", "g", "b", "n", "e",
      "/", "?",
      "<", ">",
      "[", "]", "-", "=", "0",
      "Enter", "Escape", "h", "Tab",
    ]);
  });

  test("names each cap by its action for assistive tech", () => {
    const caps = [...help.querySelectorAll<HTMLButtonElement>("button.kbd-button")];
    for (const [key, action] of [
      ["t", "Stage terminal"],
      ["f", "Stage file browser"],
      ["e", "Stage Excalidraw"],
      ["[", "Move divider left"],
      ["0", "Equalize panes"],
    ]) {
      const cap = caps.find((button) => button.textContent === key);
      expect(cap?.getAttribute("aria-label")).toBe(`${key}: ${action}`);
    }
  });
});
