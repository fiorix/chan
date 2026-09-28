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

  test("closes a list item's fence at the item's content column", () => {
    const content = "# Setup\n- ```sh\n  make\n  ```\n# Usage\n```sh\n# a comment\n```\n# Last\n";
    expect(outlineRows(content)).toEqual(["Setup", "Usage", "Last"]);
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

  test("leaves out a comment line of leading YAML frontmatter, and keeps the body's lines", () => {
    const content = "---\ntitle: Plan\n# a YAML comment\n---\n# Body\n";
    expect(outlineRows(content)).toEqual(["Body"]);
    const target = document.createElement("div");
    document.body.appendChild(target);
    const selected: number[] = [];
    mounted.push(mount(OutlineBody, { target, props: { content, onSelect: (h: { line: number }) => selected.push(h.line) } }));
    flushSync();
    [...target.querySelectorAll<HTMLButtonElement>(".outline-list button")].at(-1)!.click();
    expect(selected, "the body heading keeps its source line").toEqual([4]);
  });

  test("reads an opening --- with no closer as a rule, so the heading below it stays", () => {
    expect(outlineRows("---\n# Title\ntext\n")).toEqual(["Title"]);
  });
});
