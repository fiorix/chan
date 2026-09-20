// @vitest-environment jsdom
//
// Rich copy and the session bearer. Every workspace image src in the
// clipboard payload goes through `resolveImageSrc` -> `withTokenQuery`,
// which appends `?t=<bearer>`; `api/transport.ts` reads the bearer once at
// module load, so the seed below runs in a `vi.hoisted` block, before this
// file's imports are evaluated. The control test proves the seed took: a
// run with no bearer would pass every assertion here for the wrong reason.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const TOKEN = vi.hoisted(() => {
  const value = "bearer-abc123";
  sessionStorage.setItem("chan.token", value);
  return value;
});

const writeClipboardHtml = vi.fn().mockResolvedValue(undefined);
vi.mock("../api/desktop", () => ({
  isTauriDesktop: () => true,
  writeClipboardHtml: (html: string, alt: string) => writeClipboardHtml(html, alt),
}));

import { withTokenQuery } from "../api/client";
import {
  buildBaselineHtml,
  buildInlinedHtml,
  handleClipboardCopy,
  writeDocSelectionToClipboard,
  type ChanClipboardContext,
} from "./copy_html";

const ctx: ChanClipboardContext = {
  getCurrentPath: () => "notes/foo.md",
  getUploadDir: () => "notes",
  getWorkspaceRoot: () => "/ws",
};

/// Every `<img src>` in a payload, parsed against the page origin so the
/// query can be inspected as a query and not as a substring.
function imageSrcs(html: string): URL[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("img"))
    .map((img) => img.getAttribute("src") ?? "")
    .filter((src) => !src.startsWith("data:"))
    .map((src) => new URL(src, window.location.href));
}

/// The payload carries no bearer: not as the `t` query the token plumbing
/// appends to a network image src, and not anywhere else in the markup, the
/// `data-chan-markdown` attribute included. Asserting on at least one
/// network src keeps the check from passing over a payload that resolved no
/// image at all.
function expectTokenless(html: string): void {
  const urls = imageSrcs(html);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url.searchParams.has("t")).toBe(false);
  }
  expect(html).not.toContain(TOKEN);
}

/// A minimal copy event recording its setData calls.
function copyEvent(): ClipboardEvent & { store: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    preventDefault: vi.fn(),
    clipboardData: {
      setData: (type: string, val: string) => {
        store[type] = val;
      },
      getData: (type: string) => store[type] ?? "",
    },
    store,
  } as unknown as ClipboardEvent & { store: Record<string, string> };
}

beforeEach(() => {
  writeClipboardHtml.mockClear();
  // No network by default, so the async upgrade degrades to absolute URLs.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no net")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the fixture carries a session bearer", () => {
  test("withTokenQuery appends the seeded token", () => {
    const url = new URL(withTokenQuery("/api/fs/notes/a.png"), window.location.href);
    expect(url.searchParams.get("t")).toBe(TOKEN);
  });
});

describe("rich copy keeps the session bearer out of the clipboard", () => {
  test("the sync baseline resolves images without the token", () => {
    const html = buildBaselineHtml("![](./a.png#w=250)", "notes/foo.md", "/ws");
    expect(html).toContain("/api/fs/notes/a.png");
    expectTokenless(html);
  });

  test("a failed upgrade leaves the absolute URL without the token", async () => {
    const html = await buildInlinedHtml("![](./a.png)", "notes/foo.md", "/ws");
    expect(html).toContain("/api/fs/notes/a.png");
    expectTokenless(html);
  });

  test("an over-budget image keeps its absolute URL without the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => ({ size: 21 * 1024 * 1024 }) })),
    );
    const html = await buildInlinedHtml("![](./big.png)", "notes/foo.md", "/ws");
    expect(html).toContain("/api/fs/notes/big.png");
    expectTokenless(html);
  });

  test("the copy event's synchronous flavor carries no token", () => {
    const md = "text ![](./a.png#w=250) more";
    const view = new EditorView({
      state: EditorState.create({
        doc: md,
        selection: EditorSelection.range(0, md.length),
      }),
    });
    const ev = copyEvent();
    expect(handleClipboardCopy(view, ev, ctx, false)).toBe(true);
    expectTokenless(ev.store["text/html"]!);
    view.destroy();
  });

  test("the desktop clipboard bridge receives the same tokenless payload", async () => {
    await writeDocSelectionToClipboard("![](./a.png#w=1)", ctx);
    expect(writeClipboardHtml).toHaveBeenCalledTimes(1);
    const [html] = writeClipboardHtml.mock.calls[0]!;
    expectTokenless(html as string);
  });
});
