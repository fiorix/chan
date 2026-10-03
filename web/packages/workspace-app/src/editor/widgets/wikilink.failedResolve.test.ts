// @vitest-environment jsdom
//
// A link pill keeps a kind only from an answer of the resolver: a match, or
// the route's own not-found. Any other failure leaves the pill unresolved,
// and a later scan asks again, no sooner than five seconds after the failure.
// The resolver is stubbed, and the clock the retry reads is the test's.

import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const resolveLink = vi.hoisted(() => vi.fn());

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...actual.api, resolveLink } };
});

import { ApiError } from "../../api/errors";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../../__tests__/wysiwyg";

installEditorDom();

const RETRY_FLOOR_MS = 5_000;

// The kind cache lives as long as the module, so each test links a target of
// its own.
let run = 0;
let clock = 1_000_000;

beforeEach(() => {
  run += 1;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
  unmountWysiwygs();
  document.body.innerHTML = "";
  resolveLink.mockReset();
  vi.restoreAllMocks();
});

function target(): string {
  return `notes/retry-${run}.md`;
}

async function mountLink(): Promise<{ view: EditorView; content: HTMLElement }> {
  const { view, content } = await mountWysiwyg({
    value: `see [x](retry-${run}.md)`,
    currentPath: "notes/a.md",
  });
  await settle(6);
  return { view, content };
}

/// A caret move outside the link, which makes the editor scan its pills again.
async function rescan(view: EditorView, at: number): Promise<void> {
  view.dispatch({ selection: { anchor: at } });
  await settle(6);
}

function kind(content: HTMLElement): string | undefined {
  return content.querySelector<HTMLElement>(".cm-md-wiki-pill")?.dataset.refkind;
}

function asked(): number {
  return resolveLink.mock.calls.filter(([asked]) => asked === target()).length;
}

const NO_ANSWER: Array<[string, unknown]> = [
  ["a 503", new ApiError(503, "service unavailable")],
  ["a refused bearer", new ApiError(401, "unauthorized")],
  ["a dropped connection", new TypeError("Failed to fetch")],
  ["a 404 that is not the route's", new ApiError(404, "Not Found")],
];

describe("a resolve that fails with no answer", () => {
  test.each(NO_ANSWER)("%s leaves the pill unresolved, and a later scan resolves it", async (_name, failure) => {
    resolveLink.mockRejectedValueOnce(failure);
    resolveLink.mockResolvedValue({ path: target(), kind: "file", is_dir: false });
    const { view, content } = await mountLink();
    expect(kind(content)).toBeUndefined();

    clock += RETRY_FLOOR_MS;
    await rescan(view, 1);
    expect(kind(content)).toBe("file");
    expect(asked()).toBe(2);
  });

  test("is not asked again inside the retry floor", async () => {
    resolveLink.mockRejectedValue(new ApiError(503, "service unavailable"));
    const { view } = await mountLink();
    expect(asked()).toBe(1);

    clock += RETRY_FLOOR_MS - 1;
    await rescan(view, 1);
    await rescan(view, 2);
    expect(asked(), "scans inside the floor").toBe(1);

    clock += 1;
    await rescan(view, 3);
    expect(asked(), "the first scan past the floor").toBe(2);
  });
});

describe("the route's not-found", () => {
  test("is an answer: the pill is broken and is not asked again", async () => {
    resolveLink.mockRejectedValue(new ApiError(404, "link target not found", { code: "link_not_found" }));
    const { view, content } = await mountLink();
    expect(kind(content)).toBe("broken");

    clock += 10 * RETRY_FLOOR_MS;
    await rescan(view, 1);
    expect(kind(content)).toBe("broken");
    expect(asked()).toBe(1);
  });
});
