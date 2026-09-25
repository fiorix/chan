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
  function click(doc: string, text: string): MouseEvent {
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({ doc, extensions: [chanMarkdown(), externalLinkClickHandler()] }),
    });
    views.push(view);
    const pos = doc.indexOf(text) + 1;
    view.posAtCoords = () => pos;
    const link = view.contentDOM.appendChild(document.createElement("span"));
    link.className = "cm-md-link";
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
    link.dispatchEvent(event);
    return event;
  }

  test("opens a chan://graph link in the graph and never navigates out", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const event = click("see [g](chan://graph?s=workspace&d=2) here", "[g]");

    expect(openGraphFromLink).toHaveBeenCalledWith("chan://graph?s=workspace&d=2");
    expect(event.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  test("opens an external link in the browser, not the graph", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const event = click("see [x](https://example.com) here", "[x]");

    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    expect(openGraphFromLink).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  test("leaves a chan:// link the graph cannot open alone", () => {
    graphLinks.handled = false;
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const event = click("see [g](chan://graph?bad) here", "[g]");

    expect(openGraphFromLink).toHaveBeenCalledTimes(1);
    expect(open, "chan: is not an openable external scheme").not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
