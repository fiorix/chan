// @vitest-environment jsdom
//
// The Hybrid Nav help lists every binding by group, under the title "Hybrid
// Nav (Cmd+.)". Each key-cap is a button that presses its key on the
// document, where App's Hybrid Nav handler takes it, so a click and a
// keystroke run the same switch. The one cap that stands for a modifier
// ("Shift + [ ] - =") is a plain label: a single click cannot hold Shift.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
});

describe("the Hybrid Nav help", () => {
  test("is titled Hybrid Nav with its chord", () => {
    expect(help.getAttribute("aria-label")).toBe("Hybrid Nav help");
    expect(help.querySelector(".title")?.textContent).toBe("Hybrid Nav (Cmd+.)");
  });

  test("lists the bindings by group", () => {
    const groups = [...help.querySelectorAll("section.group")].map((group) => ({
      title: group.querySelector("h4")!.textContent,
      rows: [...group.querySelectorAll("dd")].map((row) => row.textContent),
    }));

    expect(groups).toEqual([
      { title: "Move", rows: ["Move focus", "Swap tile with neighbour"] },
      {
        title: "Stage (Enter to commit, Esc to discard)",
        rows: [
          "Stage Terminal",
          "Stage File Browser",
          "Stage Graph",
          "Stage Dashboard",
          "Stage New Draft",
          "Stage Diagram",
        ],
      },
      { title: "Split", rows: ["Split right", "Split down"] },
      {
        title: "Dock",
        rows: ["Toggle right-side file browser dock", "Toggle left-side file browser dock"],
      },
      {
        title: "Resize",
        rows: ["Move divider left / right", "Move divider up / down", "Larger nudge", "Equalize siblings"],
      },
      { title: "Commit", rows: ["Commit draft", "Discard draft", "Toggle this help", "Flip side"] },
    ]);
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
      "t", "o", "g", "b", "n", "i",
      "/", "?",
      "<", ">",
      "[", "]", "-", "=", "0",
      "Enter", "Escape", "h", "Tab",
    ]);
  });

  test("names each cap by its action for assistive tech", () => {
    const cap = [...help.querySelectorAll<HTMLButtonElement>("button.kbd-button")].find(
      (button) => button.textContent === "t",
    )!;

    expect(cap.getAttribute("aria-label")).toBe("t: Stage Terminal");
  });

  test("shows the Shift nudge as a label, not a button", () => {
    const shift = [...help.querySelectorAll("dt kbd")].map((kbd) => kbd.textContent);

    expect(shift).toEqual(["Shift + [ ] - ="]);
  });
});
