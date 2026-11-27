// @vitest-environment jsdom
//
// The OPEN row a link drop-down shows for a link's target as written. An
// openable external URL or a graph link always gets one; a workspace path
// gets one only where the host can open paths, resolved against the source
// file's directory or the workspace root without one; anything else gets
// none. The read-only drop-down shows that one row under a link with the
// editor's footer, opens it on Enter, Mod+Enter or a press on the row,
// closes on Escape or a press outside, and never takes the keyboard.

import { afterEach, describe, expect, test, vi } from "vitest";
vi.mock("../../state/store.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/store.svelte")>();
  return { ...actual, openGraphFromLink: vi.fn(() => true) };
});
import { openGraphFromLink } from "../../state/store.svelte";
import { openLinkBubble, openRowFor, type LinkBubbleOpts } from "./open_row";

const handles: Array<{ dismiss(): void }> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dismiss();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.mocked(openGraphFromLink).mockClear();
});

describe("openRowFor", () => {
  test.each(["https://chan.app/a?b=1", "http://chan.app", "mailto:a@example.com", "tel:+15551212", "HTTPS://CHAN.APP"])(
    "%s is an external row that opens as written, with or without a path opener",
    (url) => {
      const row = { kind: "Open", target: url, anchor: null, url, external: true };
      expect(openRowFor(url, "notes/here.md", true)).toEqual(row);
      expect(openRowFor(url, null, false)).toEqual(row);
    },
  );

  test("a graph link is an external row", () => {
    const url = "chan://graph?s=one";
    expect(openRowFor(url, "notes/here.md", false)).toEqual({ kind: "Open", target: url, anchor: null, url, external: true });
  });

  test.each([
    ["other.md#intro", "notes/here.md", "notes/other.md", "intro"],
    ["./other.md", "notes/here.md", "notes/other.md", null],
    ["../docs/a.md#b", "notes/here.md", "docs/a.md", "b"],
    ["/docs/a.md#b", "notes/here.md", "docs/a.md", "b"],
    ["My%20Photo.md", "notes/here.md", "notes/My Photo.md", null],
    ["notes/a.md", null, "notes/a.md", null],
    ["a.md#", null, "a.md", null],
  ])("the path %s written in %s opens %s at anchor %s", (url, fromPath, target, anchor) => {
    expect(openRowFor(url, fromPath, true)).toEqual({ kind: "Open", target, anchor, url, external: false });
  });

  test.each([
    ["../x.md", null],
    ["../../x.md", "notes/here.md"],
    ["#intro", "notes/here.md"],
    ["ftp://example.com/a.md", "notes/here.md"],
    ["callto:someone", null],
    ["javascript:alert(1)", null],
    ["", null],
  ])("%s written in %s opens nothing", (url, fromPath) => {
    expect(openRowFor(url, fromPath, true)).toBeNull();
  });

  test("a host that cannot open paths gets no row for a path", () => {
    expect(openRowFor("notes/a.md", null, false)).toBeNull();
    expect(openRowFor("other.md#intro", "notes/here.md", false)).toBeNull();
  });
});

/// Show the read-only drop-down under a link to `url`.
function show(url: string, over: Partial<LinkBubbleOpts> = {}) {
  const host = document.createElement("a");
  host.setAttribute("href", url);
  host.textContent = "the link";
  document.body.append(host);
  const onDismiss = vi.fn();
  const handle = openLinkBubble({ host, url, onDismiss, ...over });
  if (handle) handles.push(handle);
  const key = (key: string, init: KeyboardEventInit = {}) =>
    handle!.handleKey(new KeyboardEvent("keydown", { key, cancelable: true, ...init }));
  return { host, handle, onDismiss, key };
}

function shown(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".md-bubble");
}

function rows(): string[] {
  return [...document.querySelectorAll(".md-bubble-row")].map((row) => row.textContent ?? "");
}

function footer(): string | null {
  return document.querySelector(".md-bubble-status")?.textContent ?? null;
}

function press(target: Element): MouseEvent {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/// The shell starts listening for a press outside it one tick after it opens.
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the read-only drop-down", () => {
  test("shows one OPEN row with the URL as written, the editor's footer and look, and opens nothing yet", () => {
    const browser = vi.spyOn(window, "open").mockReturnValue(null);
    const url = "https://chan.app/a?b=1";
    show(url);

    expect(rows()).toEqual([`OPEN${url}`]);
    expect(footer()).toBe("↵ open");
    const row = document.querySelector(".md-bubble-row")!;
    expect(row.classList.contains("md-bubble-row-selected")).toBe(true);
    expect(row.classList.contains("md-bubble-row-external")).toBe(true);
    expect([...shown()!.classList]).toEqual(expect.arrayContaining(["md-bubble", "md-wiki-bubble", "cm-bubble"]));
    expect(browser).not.toHaveBeenCalled();
  });

  test("a path row shows the path as written with no copy button, and Enter hands it to the host", () => {
    const onOpenLink = vi.fn();
    const { key, onDismiss } = show("notes/a.md#top", { onOpenLink });
    expect(rows()).toEqual(["OPENnotes/a.md#top"]);
    expect(document.querySelector(".md-bubble-row .copy-btn")).toBeNull();
    expect(document.querySelector(".md-bubble-row-external")).toBeNull();

    expect(key("Enter")).toBe(true);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("notes/a.md", "top");
    expect(shown()).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test("Enter opens the URL once and closes the drop-down", () => {
    const browser = vi.spyOn(window, "open").mockReturnValue(null);
    const url = "https://chan.app";
    const { key, onDismiss } = show(url);

    expect(key("Enter")).toBe(true);
    expect(browser).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer");
    expect(shown()).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(key("Enter")).toBe(false);
    expect(browser).toHaveBeenCalledOnce();
  });

  test.each([{ metaKey: true }, { ctrlKey: true }])("Mod+Enter (%o) opens the URL once and closes the drop-down", (modifier) => {
    const browser = vi.spyOn(window, "open").mockReturnValue(null);
    const url = "mailto:a@example.com";
    const { key, onDismiss } = show(url);

    expect(key("Enter", modifier)).toBe(true);
    expect(browser).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer");
    expect(shown()).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test("a press on the row opens it once, keeps the keyboard where it is, and closes the drop-down", () => {
    const url = "chan://graph?s=one";
    const { onDismiss } = show(url);
    const event = press(document.querySelector(".md-bubble-row")!);

    expect(event.defaultPrevented).toBe(true);
    expect(openGraphFromLink).toHaveBeenCalledExactlyOnceWith(url);
    expect(shown()).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test("Escape closes it and opens nothing", () => {
    const browser = vi.spyOn(window, "open").mockReturnValue(null);
    const { key, onDismiss } = show("https://chan.app");

    expect(key("Escape")).toBe(true);
    expect(shown()).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(browser).not.toHaveBeenCalled();
    expect(key("Escape")).toBe(false);
  });

  test.each(["ArrowDown", "ArrowUp", "Tab", "a", "1"])("%s is left to the caller", (name) => {
    const browser = vi.spyOn(window, "open").mockReturnValue(null);
    const { key, onDismiss } = show("https://chan.app");

    expect(key(name)).toBe(false);
    expect(shown()).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  });

  test("the copy button copies the URL into the footer's report without opening or closing", async () => {
    const url = "https://chan.app";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const browser = vi.spyOn(window, "open").mockReturnValue(null);
    show(url);
    const copy = document.querySelector<HTMLButtonElement>(".md-bubble-row .copy-btn")!;
    expect(copy.querySelector("svg")).toBeTruthy();

    expect(press(copy).defaultPrevented).toBe(true);
    copy.click();
    await vi.waitFor(() => expect(footer()).toBe("Copied URL"));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(url);
    expect(browser).not.toHaveBeenCalled();
    expect(shown()).not.toBeNull();
  });

  test("a press outside closes it, and a press on the link keeps it", async () => {
    const { host, onDismiss } = show("https://chan.app");
    await nextTick();

    press(host);
    expect(shown()).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();

    press(document.body);
    expect(shown()).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test("dismiss closes it once", () => {
    const { handle, onDismiss } = show("https://chan.app");
    handle!.dismiss();
    handle!.dismiss();
    expect(shown()).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  test("never takes the keyboard", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    show("https://chan.app");
    expect(document.activeElement).toBe(button);
  });

  test.each([
    ["#intro", true],
    ["ftp://example.com/a.md", true],
    ["../x.md", true],
    ["notes/a.md", false],
  ])("a link to %s (path opener given: %s) opens no drop-down", (url, opensPaths) => {
    const { handle } = show(url, opensPaths ? { onOpenLink: vi.fn() } : {});
    expect(handle).toBeNull();
    expect(shown()).toBeNull();
  });

  test("a relative path resolves against the workspace root", () => {
    const onOpenLink = vi.fn();
    const { key } = show("./notes/../docs/a.md", { onOpenLink });
    key("Enter");
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("docs/a.md", null);
  });
});
