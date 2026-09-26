// @vitest-environment jsdom
//
// A right-click on a node of the JSON viewer copies the node's path and says
// so in the status line, through the app's one UI copy: native on the
// desktop, the Clipboard API in a browser, and a report when neither can
// write.

import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import JsonNode from "./JsonNode.svelte";
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
