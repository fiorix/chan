// SPA-global file-drop guard: the no-takeover guarantee.
//
// The guard must act ONLY on OS file drags (dataTransfer.types
// includes "Files") -- in-page HTML5 drags (tab moves, tree moves,
// image-atom moves) must pass through with their dropEffect semantics
// untouched -- and inside allowlisted zones it must leave the drop
// for the zone's own handlers while the bubble-phase net still
// cancels anything left unhandled.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import * as desktop from "../api/desktop";
import {
  droppedFileUris,
  escapePosixPath,
  inFileDropZone,
  installFileDropGuard,
  isDesktopFileDrop,
  isDesktopUriDrag,
  isOsFileDrag,
  shellEscapePaths,
} from "./fileDropGuard";

/// jsdom has no DragEvent constructor; a plain Event with a stubbed
/// dataTransfer mirrors what the guard reads (types, dropEffect).
function dragEvent(
  type: "dragover" | "drop",
  types: string[],
): Event & { dataTransfer: { types: string[]; dropEffect: string } } {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", {
    value: { types, dropEffect: "" },
  });
  return e as Event & { dataTransfer: { types: string[]; dropEffect: string } };
}

let dispose: () => void;
let zone: HTMLDivElement;
let cmZone: HTMLDivElement;
let outside: HTMLDivElement;

beforeEach(() => {
  dispose = installFileDropGuard(window);
  zone = document.createElement("div");
  zone.setAttribute("data-file-drop-zone", "");
  cmZone = document.createElement("div");
  cmZone.className = "cm-editor";
  outside = document.createElement("div");
  document.body.append(zone, cmZone, outside);
});

afterEach(() => {
  dispose();
  zone.remove();
  cmZone.remove();
  outside.remove();
  vi.restoreAllMocks();
});

describe("Files-type discriminator", () => {
  test("dragover with types ['text/plain'] is NOT prevented (in-page DnD untouched)", () => {
    const e = dragEvent("dragover", ["text/plain"]);
    outside.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(e.dataTransfer.dropEffect).toBe("");
  });

  test("drop with types ['text/plain'] is NOT prevented", () => {
    const e = dragEvent("drop", ["text/plain"]);
    outside.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  test("isOsFileDrag reads the Files type, missing dataTransfer is false", () => {
    expect(isOsFileDrag(dragEvent("drop", ["Files"]) as unknown as DragEvent)).toBe(true);
    expect(
      isOsFileDrag(dragEvent("drop", ["text/uri-list"]) as unknown as DragEvent),
    ).toBe(false);
    expect(isOsFileDrag(new Event("drop") as DragEvent)).toBe(false);
  });
});

describe("outside allowlisted zones", () => {
  test("Files dragover is prevented and the cursor reads not-allowed", () => {
    const e = dragEvent("dragover", ["Files"]);
    outside.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(e.dataTransfer.dropEffect).toBe("none");
  });

  test("Files drop is prevented (no webview navigation)", () => {
    const e = dragEvent("drop", ["Files"]);
    outside.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("inside allowlisted zones", () => {
  test("Files dragover is still cancelled but keeps the browser drop cursor", () => {
    const e = dragEvent("dragover", ["Files"]);
    zone.dispatchEvent(e);
    // Cancelling dragover is what allows the drop to fire at all;
    // the zone's effect is left to the browser / zone handler.
    expect(e.defaultPrevented).toBe(true);
    expect(e.dataTransfer.dropEffect).toBe("");
  });

  test("the guard's capture phase leaves the drop to the zone handler", () => {
    let preventedWhenZoneSawIt: boolean | null = null;
    const zoneHandler = (e: Event) => {
      preventedWhenZoneSawIt = e.defaultPrevented;
    };
    zone.addEventListener("drop", zoneHandler);
    const e = dragEvent("drop", ["Files"]);
    zone.dispatchEvent(e);
    zone.removeEventListener("drop", zoneHandler);
    // The zone handler saw an uncancelled event (it owns the drop)...
    expect(preventedWhenZoneSawIt).toBe(false);
    // ...and the bubble-phase net cancelled whatever it left.
    expect(e.defaultPrevented).toBe(true);
  });

  test(".cm-editor counts as a zone (editable CodeMirror owns its drops)", () => {
    let preventedWhenSeen: boolean | null = null;
    const handler = (e: Event) => {
      preventedWhenSeen = e.defaultPrevented;
    };
    cmZone.addEventListener("drop", handler);
    const e = dragEvent("drop", ["Files"]);
    cmZone.dispatchEvent(e);
    cmZone.removeEventListener("drop", handler);
    expect(preventedWhenSeen).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  test("inFileDropZone matches nested targets", () => {
    const inner = document.createElement("span");
    zone.append(inner);
    expect(inFileDropZone(inner)).toBe(true);
    expect(inFileDropZone(outside)).toBe(false);
    expect(inFileDropZone(null)).toBe(false);
  });
});

// WebKitGTK hands a file dragged in from another application as its URI:
// `text/uri-list` (and `text/html`), no Files.
const WEBKITGTK_FILE = ["text/uri-list", "text/html"];

describe("the desktop's text/uri-list shape", () => {
  beforeEach(() => {
    vi.spyOn(desktop, "isTauriDesktop").mockReturnValue(true);
  });

  test("outside the zones its dragover shows not-allowed and its drop never navigates", () => {
    const over = dragEvent("dragover", WEBKITGTK_FILE);
    outside.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("none");
    const drop = dragEvent("drop", WEBKITGTK_FILE);
    outside.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  test("inside a zone the drop is the zone's, and the net cancels what it leaves", () => {
    const over = dragEvent("dragover", WEBKITGTK_FILE);
    cmZone.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("");
    let preventedWhenSeen: boolean | null = null;
    const handler = (e: Event) => {
      preventedWhenSeen = e.defaultPrevented;
    };
    cmZone.addEventListener("drop", handler);
    const drop = dragEvent("drop", WEBKITGTK_FILE);
    cmZone.dispatchEvent(drop);
    cmZone.removeEventListener("drop", handler);
    expect(preventedWhenSeen).toBe(false);
    expect(drop.defaultPrevented).toBe(true);
  });

  test("a drag this document started is left alone until it ends", () => {
    outside.dispatchEvent(new Event("dragstart", { bubbles: true }));
    const over = dragEvent("dragover", WEBKITGTK_FILE);
    outside.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe("");
    const drop = dragEvent("drop", WEBKITGTK_FILE);
    outside.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);

    outside.dispatchEvent(new Event("dragend", { bubbles: true }));
    const next = dragEvent("dragover", WEBKITGTK_FILE);
    outside.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(true);
  });

  test("a page drag whose source never sees its dragend ends with its drop", async () => {
    outside.dispatchEvent(new Event("dragstart", { bubbles: true }));
    outside.dispatchEvent(dragEvent("drop", WEBKITGTK_FILE));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = dragEvent("dragover", WEBKITGTK_FILE);
    outside.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(true);
  });

  test("a text drag is untouched", () => {
    const over = dragEvent("dragover", ["text/plain"]);
    outside.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
  });

  test("in a browser the shape is a link like any other and is untouched", () => {
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(false);
    const over = dragEvent("dragover", WEBKITGTK_FILE);
    outside.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    expect(isDesktopUriDrag(over as unknown as DragEvent)).toBe(false);
  });
});

describe("isDesktopFileDrop", () => {
  const transfer = (types: string[], uriList = "") =>
    ({ types, getData: (type: string) => (type === "text/uri-list" ? uriList : "") }) as unknown as DataTransfer;

  beforeEach(() => {
    vi.spyOn(desktop, "isTauriDesktop").mockReturnValue(true);
  });

  test.each([
    ["WebKitGTK's file drop, its list kept from the page", WEBKITGTK_FILE, "", true],
    ["a drop naming file URIs", WEBKITGTK_FILE, "file:///tmp/a.png", true],
    ["a link from a browser", WEBKITGTK_FILE, "https://example.com/a.png", false],
    ["a drop carrying Files", ["Files", "text/uri-list"], "", false],
    ["a text drop", ["text/plain"], "", false],
  ])("%s", (_name, types, list, expected) => {
    expect(isDesktopFileDrop(transfer(types, list))).toBe(expected);
  });

  test("is never a drag this document started, nor one in a browser", () => {
    outside.dispatchEvent(new Event("dragstart", { bubbles: true }));
    expect(isDesktopFileDrop(transfer(WEBKITGTK_FILE))).toBe(false);
    outside.dispatchEvent(new Event("dragend", { bubbles: true }));
    expect(isDesktopFileDrop(transfer(WEBKITGTK_FILE))).toBe(true);
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(false);
    expect(isDesktopFileDrop(transfer(WEBKITGTK_FILE))).toBe(false);
    expect(isDesktopFileDrop(null)).toBe(false);
  });
});

describe("droppedFileUris", () => {
  const withList = (list: string) => ({ getData: (type: string) => type === "text/uri-list" ? list : "" }) as unknown as DataTransfer;

  test("keeps file URIs in order and leaves comments and other schemes out", () => {
    expect(droppedFileUris(withList(
      "# a comment\r\nfile:///tmp/a%20b.png\r\nhttps://example.com/c.png\r\nFILE:///tmp/d.png\n\n",
    ))).toEqual(["file:///tmp/a%20b.png", "FILE:///tmp/d.png"]);
  });

  test("is empty without a list", () => {
    expect(droppedFileUris(withList(""))).toEqual([]);
    expect(droppedFileUris(null)).toEqual([]);
  });
});

describe("terminal path-print escaping", () => {
  test("plain path single-quoted", () => {
    expect(escapePosixPath("/tmp/a.png")).toBe("'/tmp/a.png'");
  });

  test("embedded single quote escapes as close-escape-reopen", () => {
    expect(escapePosixPath("/tmp/it's here.png")).toBe("'/tmp/it'\\''s here.png'");
  });

  test("multiple paths space-separated with a single trailing space", () => {
    expect(shellEscapePaths(["/a b.txt", "/c.md"])).toBe("'/a b.txt' '/c.md' ");
  });

  test("no paths produce an empty string (silent no-op)", () => {
    expect(shellEscapePaths([])).toBe("");
  });
});
