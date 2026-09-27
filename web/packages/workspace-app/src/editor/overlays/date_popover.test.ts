// @vitest-environment jsdom
//
// The date popover is one per page: a second open, whether a click on the
// same pill, a click on another pill, or an open with no click (the keyboard
// commands), leaves one calendar on screen, and the keys go to that one.

import { afterEach, describe, expect, test } from "vitest";
import { formatDate } from "../dateFormats";
import { openDatePopover } from "./date_popover";

const FORMAT = "iso";
const handles: Array<{ dismiss: () => void }> = [];
const commits: Array<{ open: number; text: string }> = [];
let opens = 0;

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dismiss();
  commits.length = 0;
  opens = 0;
  document.body.replaceChildren();
});

/// Open a popover under `anchor` and record, by the open's sequence number,
/// every commit it makes.
function open(anchor: HTMLElement, date: Date): void {
  const seq = ++opens;
  handles.push(
    openDatePopover({
      anchor,
      initialDate: date,
      initialFormatId: FORMAT,
      onCommit: (text) => commits.push({ open: seq, text }),
      onDismiss: () => {},
    }),
  );
}

/// A pill that opens the popover on a primary mousedown, as the date widget
/// does.
function pill(date: Date): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-md-date-pill";
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    open(el, date);
  });
  document.body.append(el);
  return el;
}

function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
}

function press(key: string): void {
  const at = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  at.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/// The popover wires its listeners and focuses its day cell in a zero-delay
/// timeout.
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const popovers = () => document.querySelectorAll<HTMLElement>(".md-date-popover");

const MARCH_10 = new Date(2026, 2, 10);
const JULY_20 = new Date(2026, 6, 20);

type SecondOpen = (first: HTMLElement) => void;
const SECOND_OPENS: Array<[string, SecondOpen]> = [
  ["a second click on the same pill", (first) => click(first)],
  ["a click on another pill", () => click(pill(JULY_20))],
  ["an open with no click, as the keyboard commands do", () => open(pill(JULY_20), JULY_20)],
];

describe("one date popover at a time", () => {
  test.each(SECOND_OPENS)("after %s one popover is on screen and one Escape closes it", async (_, second) => {
    const first = pill(MARCH_10);
    click(first);
    await macrotask();
    second(first);
    await macrotask();

    expect(popovers().length).toBe(1);
    press("Escape");
    expect(popovers().length).toBe(0);
  });

  test.each(SECOND_OPENS)("after %s Enter commits the date of the calendar that is showing", async (_, second) => {
    const first = pill(MARCH_10);
    click(first);
    await macrotask();
    second(first);
    await macrotask();

    press("ArrowRight");
    // The popover appended last paints on top: it is the calendar the user
    // sees and steers.
    const showing = [...popovers()].at(-1)!;
    const day = showing.querySelector<HTMLElement>(".md-date-day-selected")!;
    const shown = formatDate(new Date(Number(day.dataset.ts)), FORMAT);
    press("Enter");

    expect(commits).toEqual([{ open: opens, text: shown }]);
    expect(popovers().length).toBe(0);
  });
});
