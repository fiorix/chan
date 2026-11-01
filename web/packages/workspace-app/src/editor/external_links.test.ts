import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "vitest";

const graphLinks = vi.hoisted(() => ({ handled: true }));

vi.mock("../state/store.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/store.svelte")>();
  return { ...actual, openGraphFromLink: vi.fn(() => graphLinks.handled) };
});

import {
  externalLinkClickHandler,
  externalUrlAtPos,
  isOpenableExternalUrl,
  linkUrlAtPos,
  openExternalUrl,
} from "./external_links";
import { chanMarkdown } from "./markdown/grammar";
import { setNotifyHandler } from "../state/notify.svelte";
import { openGraphFromLink } from "../state/store.svelte";
import { computeBubbleSpec } from "./bubbles/triggers";

function state(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [chanMarkdown()] });
}

describe("external link helpers", () => {
  test("recognizes only browser-openable external schemes", () => {
    expect(isOpenableExternalUrl("https://example.com")).toBe(true);
    expect(isOpenableExternalUrl("http://example.com")).toBe(true);
    expect(isOpenableExternalUrl("mailto:a@example.com")).toBe(true);
    expect(isOpenableExternalUrl("tel:+15551212")).toBe(true);
    expect(isOpenableExternalUrl("docs/readme.md")).toBe(false);
    expect(isOpenableExternalUrl("#local")).toBe(false);
    expect(isOpenableExternalUrl("javascript:alert(1)")).toBe(false);
  });

  test("finds markdown link and naked URL targets at document positions", () => {
    const linkDoc = "[Example](https://example.com) and https://chan.app";
    const linkState = state(linkDoc);

    expect(externalUrlAtPos(linkState, linkDoc.indexOf("Example") + 2)).toBe(
      "https://example.com",
    );
    expect(externalUrlAtPos(linkState, linkDoc.indexOf("chan.app"))).toBe(
      "https://chan.app",
    );
    expect(externalUrlAtPos(state("[Local](notes.md)"), 2)).toBeNull();
  });

  test("linkUrlAtPos returns the raw URL of any scheme (incl. chan://)", () => {
    // Graph links use the in-app chan:// scheme, which is NOT an openable
    // external scheme; linkUrlAtPos must still surface it so the click
    // handler can route it to the graph opener.
    const gDoc = "[g](chan://graph?s=foo&d=2)";
    expect(linkUrlAtPos(state(gDoc), gDoc.indexOf("g"))).toBe(
      "chan://graph?s=foo&d=2",
    );
    // A normal external link returns its raw URL too (unfiltered).
    const eDoc = "[x](https://example.com)";
    expect(linkUrlAtPos(state(eDoc), 1)).toBe("https://example.com");
    // An internal path returns its raw value (the openable filter lives
    // in externalUrlAtPos, not here).
    expect(linkUrlAtPos(state("[L](notes.md)"), 1)).toBe("notes.md");
    // Image URLs are not navigable links -> null.
    const imgDoc = "![a](pic.png)";
    expect(linkUrlAtPos(state(imgDoc), imgDoc.indexOf("a"))).toBeNull();
  });

  test("uses the Tauri opener bridge when available", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: { opener: { openUrl } },
    });

    await expect(openExternalUrl("https://example.com")).resolves.toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://example.com");

    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  });

  test("falls back to the Tauri invoke bridge when opener is unavailable", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke },
    });

    await expect(openExternalUrl("https://example.com")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
      url: "https://example.com",
    });

    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test("uses window.open outside Tauri", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await expect(openExternalUrl("https://example.com")).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("openExternalUrl no-default-browser fallback", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    setNotifyHandler((msg) => console.warn(msg));
  });

  test("surfaces a status message and copies URL when the Tauri opener throws", async () => {
    const openUrl = vi.fn().mockRejectedValue(new Error("no app found"));
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: { opener: { openUrl } },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const notifications: string[] = [];
    setNotifyHandler((msg) => notifications.push(msg));

    await expect(openExternalUrl("https://example.com")).resolves.toBe(false);

    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    expect(writeText).toHaveBeenCalledWith("https://example.com");
    expect(notifications).toEqual([
      "Couldn't open link in browser - URL copied to clipboard",
    ]);
  });

  test("falls back to including the raw URL when clipboard also fails", async () => {
    const openUrl = vi.fn().mockRejectedValue(new Error("opener denied"));
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: { opener: { openUrl } },
    });
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const notifications: string[] = [];
    setNotifyHandler((msg) => notifications.push(msg));

    await expect(openExternalUrl("https://example.com")).resolves.toBe(false);

    expect(notifications).toEqual([
      "Couldn't open link in browser - https://example.com",
    ]);
  });

  test("copies the URL natively where the webview has no Clipboard API", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "plugin:opener|open_url") throw new Error("no app found");
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { invoke },
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const notifications: string[] = [];
    setNotifyHandler((msg) => notifications.push(msg));

    await expect(openExternalUrl("https://example.com")).resolves.toBe(false);

    expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "https://example.com" });
    expect(notifications).toEqual([
      "Couldn't open link in browser - URL copied to clipboard",
    ]);
  });

  test("does not fall back to window.open inside the Tauri webview", async () => {
    const openUrl = vi.fn().mockRejectedValue(new Error("no app found"));
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: { opener: { openUrl } },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    setNotifyHandler(() => {});
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    open.mockClear();

    await openExternalUrl("https://example.com");

    expect(open).not.toHaveBeenCalled();
  });
});

describe("a click on a link in the editor", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    document.body.innerHTML = "";
    graphLinks.handled = true;
    vi.restoreAllMocks();
    vi.mocked(openGraphFromLink).mockClear();
  });

  /// Clicks the rendered link over `text` in `doc`. jsdom has no layout, so
  /// the view's hit test answers the link's position directly.
  function click(doc: string, text: string, init: MouseEventInit = {}) {
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({ doc, extensions: [chanMarkdown(), externalLinkClickHandler()] }),
    });
    views.push(view);
    const pos = doc.indexOf(text) + 1;
    view.posAtCoords = () => pos;
    const link = view.contentDOM.appendChild(document.createElement("span"));
    link.className = "cm-md-link";
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 1, clientY: 1, ...init });
    link.dispatchEvent(event);
    return { event, view };
  }

  test.each([
    ["[x](https://example.com)", "[x]", "https://example.com"],
    ["<https://example.com>", "example", "https://example.com"],
    ["https://example.com", "example", "https://example.com"],
    ["[m](mailto:a@example.com)", "[m]", "mailto:a@example.com"],
    ["[t](tel:+15551212)", "[t]", "tel:+15551212"],
    ["[g](chan://graph?s=workspace&d=2)", "[g]", "chan://graph?s=workspace&d=2"],
  ])("plain click on %s edits its target", (doc, label, url) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { event, view } = click(`see ${doc} here`, label);

    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf(url) + url.length);
    expect(computeBubbleSpec(view.state)).toMatchObject({ kind: "wiki", templateMode: "raw", query: url });
    expect(openGraphFromLink).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  test.each([{ ctrlKey: true }, { metaKey: true }])("modifier click opens an external link", (modifier) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { event, view } = click("see [x](https://example.com) here", "[x]", modifier);

    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    expect(openGraphFromLink).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection.main.head).toBe(0);
  });

  test.each([{ ctrlKey: true }, { metaKey: true }])("modifier click opens the graph link", (modifier) => {
    const { event } = click("see [g](chan://graph?s=one) here", "[g]", modifier);
    expect(openGraphFromLink).toHaveBeenCalledWith("chan://graph?s=one");
    expect(event.defaultPrevented).toBe(true);
  });

  test("a file link remains with the file-link handler", () => {
    const browser = vi.spyOn(window, "open").mockReturnValue(null);
    click("see [Notes](notes.md) here", "Notes");
    expect(browser).not.toHaveBeenCalled();
    expect(openGraphFromLink).not.toHaveBeenCalled();
  });

  test("leaves a chan:// link the graph cannot open alone on modifier click", () => {
    graphLinks.handled = false;
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    click("see [g](chan://graph?bad) here", "[g]", { ctrlKey: true });

    expect(openGraphFromLink).toHaveBeenCalledTimes(1);
    expect(open, "chan: is not an openable external scheme").not.toHaveBeenCalled();
  });
});
