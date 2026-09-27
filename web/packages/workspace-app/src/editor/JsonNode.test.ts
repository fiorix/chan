// @vitest-environment jsdom
//
// A right-click on a node of the JSON viewer copies the node's path and says
// so in the status line, through the app's one UI copy: native on the
// desktop, the Clipboard API in a browser, and a report when neither can
// write.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import JsonNode from "./JsonNode.svelte";
import JsonPretty from "./JsonPretty.svelte";
import { setNotifyHandler } from "../state/notify.svelte";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

let mounted: ReturnType<typeof mount> | null = null;
let notes: string[] = [];

beforeEach(() => {
  notes = [];
  setNotifyHandler((msg) => notes.push(msg));
});

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
  delete (window as W).__TAURI_INTERNALS__;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

function rightClickRoot(): void {
  mounted = mount(JsonNode, { target: document.body, props: { value: { a: 1 }, path: "$" } });
  const node = document.querySelector<HTMLElement>(".node");
  if (!node) throw new Error("no JSON node rendered");
  node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

describe("a right-click on a JSON node", () => {
  test("copies its path in a browser", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    rightClickRoot();

    await vi.waitFor(() => expect(notes).toEqual(["Copied $"]));
    expect(writeText).toHaveBeenCalledWith("$");
  });

  test("copies its path through the native clipboard on the desktop", async () => {
    const invoke = vi.fn(async () => undefined);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });

    rightClickRoot();

    await vi.waitFor(() => expect(notes).toEqual(["Copied $"]));
    expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "$" });
  });

  test("says the clipboard is unavailable in a browser without the Clipboard API", async () => {
    rightClickRoot();

    await vi.waitFor(() => expect(notes).toEqual(["Copy failed: Clipboard unavailable"]));
  });
});

describe("JSON tree limits", () => {
  test("renders a buffer of exactly one MiB", () => {
    const value = `"${"a".repeat(1024 * 1024 - 2)}"`;
    mounted = mount(JsonPretty, { target: document.body, props: { value } });
    expect(document.querySelectorAll(".node")).toHaveLength(1);
    expect(document.querySelector(".string")?.textContent).toBe(value);
  });

  test("does not parse a buffer one byte over one MiB and directs the reader to Source", () => {
    const value = JSON.stringify("\u20ac".repeat((1024 * 1024 - 1) / 3));
    expect(new Blob([value]).size).toBe(1024 * 1024 + 1);
    const parse = vi.spyOn(JSON, "parse");
    try {
      mounted = mount(JsonPretty, { target: document.body, props: { value } });
      expect(document.body.textContent).toContain("too large for the tree");
      expect(document.body.textContent).toContain("Source");
      expect(document.querySelectorAll(".node")).toHaveLength(0);
      expect(parse).not.toHaveBeenCalledWith(value);
    } finally {
      parse.mockRestore();
    }
  });

  test.each([
    ["objects", { first: { second: { leaf: 1 } } }, "$.first.second", "$.first.second.leaf"],
    ["arrays", [[[1]]], "$[0][0]", "$[0][0][0]"],
  ])("collapses %s below the root's direct members", async (_kind, value, path, leaf) => {
    mounted = mount(JsonPretty, { target: document.body, props: { value: JSON.stringify(value) } });
    const node = [...document.querySelectorAll<HTMLElement>(".node")].find((n) => n.title === path)!;
    const toggle = node.querySelector<HTMLButtonElement>(":scope > .toggle")!;
    expect(toggle.getAttribute("aria-label")).toBe("Expand");
    expect([...document.querySelectorAll<HTMLElement>(".node")].some((n) => n.title === leaf)).toBe(false);
    toggle.click();
    await tick();
    expect([...document.querySelectorAll<HTMLElement>(".node")].some((n) => n.title === leaf)).toBe(true);
  });
});
