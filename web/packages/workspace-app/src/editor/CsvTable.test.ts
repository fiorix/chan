// @vitest-environment jsdom
//
// Every cell of the CSV table is a button, so a keyboard user can reach it
// and open its edit; the edit's input takes focus when it opens, and focus
// comes back to the cell's button when Enter commits or Escape cancels.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import CsvTable from "./CsvTable.svelte";

const CSV = "name,count\nfigs,1\n";
const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.replaceChildren();
});

function table(readonly = false): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(CsvTable, { target, props: { value: CSV, readonly } }));
  return target;
}

/// The button of the cell at `row:col`, the header being row 0.
function cellButton(target: HTMLElement, at: string): HTMLButtonElement | null {
  return target.querySelector<HTMLButtonElement>(`button[data-cell="${at}"]`);
}

function press(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("a CSV cell by keyboard", () => {
  test("every cell holds a button", () => {
    const target = table();
    const cells = [...target.querySelectorAll("th, td")];
    expect(cells.map((cell) => cell.querySelector(":scope > button") !== null)).toEqual([true, true, true, true]);
  });

  test("a cell's button opens its edit with focus in the input", async () => {
    const target = table();
    const button = cellButton(target, "1:0");
    expect(button, "the cell holds a button").toBeInstanceOf(HTMLButtonElement);
    button!.click();
    await tick();

    const input = target.querySelector<HTMLInputElement>("td input");
    expect({ editing: input?.value, focused: document.activeElement === input }).toEqual({ editing: "figs", focused: true });
  });

  test("Enter commits the edit and gives focus back to the cell", async () => {
    const target = table();
    const button = cellButton(target, "1:0");
    expect(button, "the cell holds a button").toBeInstanceOf(HTMLButtonElement);
    button!.click();
    await tick();
    const input = target.querySelector<HTMLInputElement>("td input")!;
    input.value = "plums";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press(input, "Enter");
    await tick();
    await tick();

    const after = cellButton(target, "1:0");
    expect({ text: after?.textContent?.trim(), focused: document.activeElement === after }).toEqual({
      text: "plums", focused: true,
    });
  });

  test("Escape cancels the edit and gives focus back to the cell", async () => {
    const target = table();
    const button = cellButton(target, "0:1");
    expect(button, "the cell holds a button").toBeInstanceOf(HTMLButtonElement);
    button!.click();
    await tick();
    const input = target.querySelector<HTMLInputElement>("th input")!;
    input.value = "total";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press(input, "Escape");
    await tick();
    await tick();

    const after = cellButton(target, "0:1");
    expect({ text: after?.textContent?.trim(), focused: document.activeElement === after }).toEqual({
      text: "count", focused: true,
    });
  });

  test("a read-only table's buttons are disabled", () => {
    const target = table(true);
    const buttons = [...target.querySelectorAll<HTMLButtonElement>("th > button, td > button")];
    expect({ count: buttons.length, disabled: buttons.every((b) => b.disabled) }).toEqual({ count: 4, disabled: true });
  });
});
