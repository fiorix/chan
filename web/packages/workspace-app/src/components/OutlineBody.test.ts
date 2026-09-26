// @vitest-environment jsdom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import OutlineBody from "./OutlineBody.svelte";

// OutlineBody, the file editor's outline inspector: the buffer's ATX headings
// in document order, with heading-looking lines inside fenced code left out.

const mounted: Array<Record<string, any>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
});

function outlineRows(content: string): string[] {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(OutlineBody, { target, props: { content, onSelect: () => {} } }));
  flushSync();
  return [...target.querySelectorAll(".outline-list button")].map((b) => b.textContent ?? "");
}

describe("OutlineBody", () => {
  test("lists the headings in document order", () => {
    expect(outlineRows("# One\ntext\n## Two\n")).toEqual(["One", "Two"]);
  });

  test("reads a tab-indented backtick run as indented code, not a fence", () => {
    expect(outlineRows("# A\n\n\t```\n\n# B\n")).toEqual(["A", "B"]);
  });

  test("leaves out a #-looking line inside a fence indented up to three spaces", () => {
    expect(outlineRows("# One\n  ```sh\n# a shell comment\n  ```\n## Two\n")).toEqual([
      "One",
      "Two",
    ]);
  });
});
