// @vitest-environment jsdom
//
// What the CSV table writes back to the tab's buffer. A cell opened and left
// without a change writes nothing, so a file nobody edited keeps its bytes
// (line endings, quoting, ragged rows); a real edit re-serializes the file.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import CsvTable from "./CsvTable.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.replaceChildren();
});

/// A table over `csv`, and a reader of the buffer it writes back.
function table(csv: string): { target: HTMLElement; buffer: () => string } {
  let value = csv;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(CsvTable, {
      target,
      props: {
        get value() {
          return value;
        },
        set value(next: string) {
          value = next;
        },
      },
    }),
  );
  return { target, buffer: () => value };
}

async function open(target: HTMLElement, at: string): Promise<HTMLInputElement> {
  target.querySelector<HTMLButtonElement>(`button[data-cell="${at}"]`)!.click();
  await tick();
  return target.querySelector<HTMLInputElement>("th input, td input")!;
}

function press(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/// Each file with the cell the test opens: the ragged row's is the blank
/// cell past its last field.
const FILES = [
  ["CRLF line endings", "name,count\r\nfigs,1\r\n", "1:1"],
  ["redundant quotes", '"name","count"\n"figs","1"\n', "1:1"],
  ["no trailing newline", "name,count\nfigs,1", "1:1"],
  ["a ragged row", "name,count,note\nfigs,1\n", "1:2"],
];

describe("a cell opened and left unchanged", () => {
  test.each(FILES)("writes nothing when it loses focus (%s)", async (_label, csv, cell) => {
    const { target, buffer } = table(csv);
    const input = await open(target, cell);
    input.dispatchEvent(new FocusEvent("blur"));
    await tick();
    expect(buffer()).toBe(csv);
  });

  test.each(FILES)("writes nothing on Enter (%s)", async (_label, csv, cell) => {
    const { target, buffer } = table(csv);
    const input = await open(target, cell);
    press(input, "Enter");
    await tick();
    expect(buffer()).toBe(csv);
  });
});

describe("a cell edited", () => {
  test("re-serializes the file with the new value", async () => {
    const { target, buffer } = table("name,count\r\nfigs,1\r\n");
    const input = await open(target, "1:0");
    input.value = "plums";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press(input, "Enter");
    await tick();
    expect(buffer()).toBe("name,count\nplums,1\n");
  });
});
