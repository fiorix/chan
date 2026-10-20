// @vitest-environment jsdom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

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


describe("slide thumbnails", () => {
  const content = '---\nchan:\n  kind: slides\n---\n# First\n\n<hr class="chan-page-break">\n\nA slide without a heading.\n';

  test("renders the current buffer, with a selectable heading-free slide", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const selected: number[] = [];
    mounted.push(mount(OutlineBody, { target, props: { content, caretLine: 8, onSelect: h => selected.push(h.line) } }));
    flushSync();
    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".slide-thumb")];
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.getAttribute("aria-current")).toBe("true");
    buttons[1]!.click();
    expect(selected).toEqual([7]);
    expect(target.querySelector(".slide-label, .slide-empty, .slide-heading-list")).toBeNull();
    await vi.waitFor(() => expect(buttons[1]!.querySelector(".slide-miniature")?.textContent).toContain("A slide without a heading."));
  });

  test("keeps keyboard navigation in slide order", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const selected: number[] = [];
    mounted.push(mount(OutlineBody, { target, props: { content, onSelect: h => selected.push(h.line) } }));
    flushSync();
    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".slide-thumb")];
    buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(selected).toEqual([7]);
    expect(document.activeElement).toBe(buttons[1]);
    buttons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(selected).toEqual([7, 4]);
    expect(document.activeElement).toBe(buttons[0]);
  });
});
