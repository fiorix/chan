import { afterEach, describe, expect, test, vi } from "vitest";

// The bridge branches desktop-native vs navigator.clipboard; pin it to the
// desktop path so the tests exercise the representation logic without a
// jsdom navigator.clipboard.
vi.mock("./desktop", () => ({
  isTauriDesktop: vi.fn(() => true),
  readClipboardText: vi.fn(),
  readClipboardImage: vi.fn(),
  readClipboardHtml: vi.fn(),
  writeClipboardText: vi.fn(() => Promise.resolve()),
  writeClipboardImage: vi.fn(() => Promise.resolve()),
  writeClipboardHtml: vi.fn(() => Promise.resolve()),
}));

import {
  base64ToBytes,
  bytesToBase64,
  hintClipboardError,
  readClipboardPayload,
  writeClipboardPayload,
} from "./clipboard";
import * as desktop from "./desktop";

const enc = (s: string) => new TextEncoder().encode(s);

afterEach(() => vi.clearAllMocks());

describe("base64 round-trip", () => {
  test("bytesToBase64 / base64ToBytes are inverses over arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("writeClipboardPayload", () => {
  test("plain text writes through writeClipboardText", async () => {
    await writeClipboardPayload("text/plain;charset=utf-8", enc("hello"));
    expect(desktop.writeClipboardText).toHaveBeenCalledWith("hello");
  });

  test("html writes html plus a derived plain-text fallback", async () => {
    await writeClipboardPayload("text/html", enc("<p>hi <b>there</b></p>"));
    expect(desktop.writeClipboardHtml).toHaveBeenCalledWith("<p>hi <b>there</b></p>", "hi there");
  });

  test("png writes through the native image bridge", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await writeClipboardPayload("image/png", png);
    expect(desktop.writeClipboardImage).toHaveBeenCalledWith(png);
  });
});

describe("readClipboardPayload", () => {
  test("auto is image-first", async () => {
    vi.mocked(desktop.readClipboardImage).mockResolvedValue(new Uint8Array([1, 2, 3]));
    const payload = await readClipboardPayload("auto");
    expect(payload.mime).toBe("image/png");
    expect(Array.from(payload.bytes)).toEqual([1, 2, 3]);
    expect(desktop.readClipboardText).not.toHaveBeenCalled();
  });

  test("auto falls back to text when no image is present", async () => {
    vi.mocked(desktop.readClipboardImage).mockResolvedValue(null);
    vi.mocked(desktop.readClipboardText).mockResolvedValue("clipboard words");
    const payload = await readClipboardPayload("auto");
    expect(payload.mime).toBe("text/plain;charset=utf-8");
    expect(new TextDecoder().decode(payload.bytes)).toBe("clipboard words");
  });

  test("text prefer never reads the image", async () => {
    vi.mocked(desktop.readClipboardText).mockResolvedValue("just text");
    const payload = await readClipboardPayload("text");
    expect(payload.mime).toBe("text/plain;charset=utf-8");
    expect(desktop.readClipboardImage).not.toHaveBeenCalled();
  });

  test("an empty clipboard throws", async () => {
    vi.mocked(desktop.readClipboardImage).mockResolvedValue(null);
    vi.mocked(desktop.readClipboardText).mockResolvedValue("");
    await expect(readClipboardPayload("auto")).rejects.toThrow(/empty/);
  });

  test("an over-cap clipboard payload is refused (not base64'd)", async () => {
    // 32 MiB + 1 byte exceeds MAX_CLIPBOARD_BYTES -> reject before building a
    // giant base64 string that the reply route would 413.
    vi.mocked(desktop.readClipboardImage).mockResolvedValue(
      new Uint8Array(32 * 1024 * 1024 + 1),
    );
    await expect(readClipboardPayload("image")).rejects.toThrow(/too large/);
  });
});

/// A fake web clipboard item carrying one text representation.
function textItem(mime: string, text: string) {
  return {
    types: [mime],
    getType: async () => new Blob([text], { type: mime }),
  };
}

describe("web read path (single access)", () => {
  test("uses the actual clipboard image type, not a hardcoded png", async () => {
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(false);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const item = {
      types: ["image/jpeg"],
      getType: async () => new Blob([jpeg], { type: "image/jpeg" }),
    };
    Object.defineProperty(navigator, "clipboard", {
      value: { read: async () => [item] },
      configurable: true,
    });
    const payload = await readClipboardPayload("image");
    expect(payload.mime).toBe("image/jpeg");
  });

  test("auto derives the text fallback from ONE read() access", async () => {
    // prefer=auto with no image present must NOT issue a second permission-
    // gated access (readText): the text derives from the same read() items.
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(false);
    const read = vi.fn(async () => [textItem("text/plain", "clipboard words")]);
    const readText = vi.fn(async () => "clipboard words");
    Object.defineProperty(navigator, "clipboard", {
      value: { read, readText },
      configurable: true,
    });
    const payload = await readClipboardPayload("auto");
    expect(payload.mime).toBe("text/plain;charset=utf-8");
    expect(new TextDecoder().decode(payload.bytes)).toBe("clipboard words");
    expect(read).toHaveBeenCalledTimes(1);
    expect(readText).not.toHaveBeenCalled();
  });

  test("prefer=text is one readText access, never read()", async () => {
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(false);
    const read = vi.fn();
    const readText = vi.fn(async () => "just text");
    Object.defineProperty(navigator, "clipboard", {
      value: { read, readText },
      configurable: true,
    });
    const payload = await readClipboardPayload("text");
    expect(payload.mime).toBe("text/plain;charset=utf-8");
    expect(readText).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  test("prefer=html picks text/html off the single read()", async () => {
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(false);
    const read = vi.fn(async () => [textItem("text/html", "<p>hi</p>")]);
    Object.defineProperty(navigator, "clipboard", {
      value: { read },
      configurable: true,
    });
    const payload = await readClipboardPayload("html");
    expect(payload.mime).toBe("text/html");
    expect(new TextDecoder().decode(payload.bytes)).toBe("<p>hi</p>");
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("desktop ACL degradation", () => {
  test("a failed native read degrades to the web path", async () => {
    // A gateway-served desktop window whose ACL withholds the clipboard IPCs
    // must land on the same web read a plain browser uses, not surface the
    // opaque ACL string.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(true);
    vi.mocked(desktop.readClipboardImage).mockRejectedValue(
      new Error("Command read_clipboard_image not allowed by ACL"),
    );
    const read = vi.fn(async () => [textItem("text/plain", "web words")]);
    Object.defineProperty(navigator, "clipboard", {
      value: { read },
      configurable: true,
    });
    const payload = await readClipboardPayload("auto");
    expect(payload.mime).toBe("text/plain;charset=utf-8");
    expect(new TextDecoder().decode(payload.bytes)).toBe("web words");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("a failed native html write degrades to the web write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(true);
    vi.mocked(desktop.writeClipboardHtml).mockRejectedValue(
      new Error("Command write_clipboard_html not allowed by ACL"),
    );
    const write = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { write },
      configurable: true,
    });
    // jsdom has no ClipboardItem; a bag holding the blobs is all the web
    // write stub needs.
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public items: Record<string, Blob>) {}
      },
    );
    await writeClipboardPayload("text/html", enc("<p>hi</p>"));
    expect(desktop.writeClipboardHtml).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    warn.mockRestore();
  });
});

describe("hintClipboardError", () => {
  test("maps a permission denial to an actionable hint", () => {
    const err = new DOMException("Read permission denied.", "NotAllowedError");
    expect(hintClipboardError(err)).toMatch(/denied|permission/i);
  });

  test("passes through an unrelated message", () => {
    expect(hintClipboardError(new Error("boom"))).toBe("boom");
  });
});
