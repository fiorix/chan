// @vitest-environment jsdom
//
// The drafts list, and what it decides. The server answers a request on a
// draft "stale" both when the draft's lifetime is gone and while a lifecycle
// on it is closing, which may yet fail and leave the same lifetime alive. So
// a stale answer is decided by the list fetched after it: a lifetime the
// list no longer has is gone, one it still has is alive and the request is
// made once more.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { draftPath } from "../__tests__/drafts";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { DraftList } from "../api/types";
import {
  decidingStale,
  draftGone,
  DraftGoneError,
  drafts,
  noteDraftBorn,
  onDraftsListed,
  refreshDrafts,
  resetDraftsForTests,
} from "./drafts.svelte";

const DRAFT = draftPath("untitled");

function row(name: string) {
  return { name, draftId: `life-${name}`, path: draftPath(name), hasAttachments: false, busy: false };
}

function listed(...names: string[]): DraftList {
  return { drafts: names.map(row), warnings: [] };
}

function stale(): ApiError {
  return new ApiError(409, "draft `untitled` session closed", { code: "draft_stale", name: "untitled" });
}

/// A list request the test answers when it chooses to.
function heldList() {
  let answer!: (list: DraftList) => void;
  const pending = new Promise<DraftList>((resolve) => {
    answer = resolve;
  });
  return { pending, answer };
}

beforeEach(() => {
  resetDraftsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the drafts list", () => {
  test("holds the listed lifetimes, the damaged drafts and a refused store apart", async () => {
    const broken = { kind: "broken_draft", path: "/store/Drafts/bad", message: "missing draft.md" };
    const refused = { kind: "draft_preflight_failed", path: "/store/Drafts", message: "not a directory" };
    vi.spyOn(api, "listDrafts").mockResolvedValue({ drafts: [row("untitled")], warnings: [broken, refused] });

    await refreshDrafts();

    expect(drafts).toMatchObject({
      rows: [row("untitled")],
      broken: [broken],
      preflight: refused,
      loaded: true,
      error: null,
    });
  });

  test("a failed request keeps the rows it had and says why", async () => {
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed("untitled"));
    await refreshDrafts();
    list.mockRejectedValue(new Error("offline"));

    await refreshDrafts();

    expect(drafts).toMatchObject({ rows: [row("untitled")], loaded: true, error: "offline" });
  });

  test("calls made while a request is in flight share one more request, begun after it", async () => {
    const first = heldList();
    const list = vi
      .spyOn(api, "listDrafts")
      .mockReturnValueOnce(first.pending)
      .mockResolvedValue(listed("untitled", "second"));
    const running = refreshDrafts();
    const a = refreshDrafts();
    const b = refreshDrafts();
    expect(list).toHaveBeenCalledTimes(1);

    first.answer(listed("untitled"));
    await Promise.all([running, a, b]);

    expect(list).toHaveBeenCalledTimes(2);
    expect(drafts.rows.map((r) => r.name)).toEqual(["untitled", "second"]);
  });

  test("a listener that throws fails neither the request nor the listeners after it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const heard = vi.fn();
    const stopFirst = onDraftsListed(() => {
      throw new Error("a listener's own fault");
    });
    const stopSecond = onDraftsListed(heard);
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    try {
      await expect.soft(refreshDrafts(), "a refresh never rejects").resolves.toBeUndefined();
      expect.soft(heard, "the listener after it still hears").toHaveBeenCalledTimes(1);
      expect.soft(drafts.loaded, "and the list is what was answered").toBe(true);
      await expect.soft(refreshDrafts()).resolves.toBeUndefined();
      expect.soft(list, "the next refresh asks again").toHaveBeenCalledTimes(2);
      expect.soft(logged).toHaveBeenCalled();
    } finally {
      stopFirst();
      stopSecond();
    }
  });

  test("tells its listeners after each answered list, and not after a failed one", async () => {
    const heard = vi.fn();
    const stop = onDraftsListed(heard);
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    await refreshDrafts();
    list.mockRejectedValue(new Error("offline"));
    await refreshDrafts();
    stop();

    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("whether a draft's lifetime is gone", () => {
  test("is not said before any list is answered", () => {
    expect(draftGone(DRAFT)).toBe(false);
  });

  test("is said of a lifetime the answered list does not have, and not of one it has", async () => {
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed("other"));
    await refreshDrafts();

    expect(draftGone(DRAFT)).toBe(true);
    expect(draftGone(draftPath("other"))).toBe(false);
    expect(draftGone(draftPath("other", "image.png"))).toBe(false);
  });

  test("is not said of a lifetime under the same name with another id", async () => {
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed("untitled"));
    await refreshDrafts();

    expect(draftGone(draftPath("untitled", "draft.md", "an-earlier-life"))).toBe(true);
    expect(draftGone(DRAFT)).toBe(false);
  });

  test("is not said of a busy lifetime the list keeps with no file to open", async () => {
    vi.spyOn(api, "listDrafts").mockResolvedValue({
      drafts: [{ name: "untitled", draftId: "life-untitled", path: null, hasAttachments: false, busy: true }],
      warnings: [],
    });
    await refreshDrafts();

    expect(draftGone(DRAFT)).toBe(false);
  });

  test("is never said of a workspace path", async () => {
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    await refreshDrafts();

    expect(draftGone("untitled/draft.md")).toBe(false);
  });

  test("is not said of a draft made for this window after the list's request began", async () => {
    const early = heldList();
    vi.spyOn(api, "listDrafts").mockReturnValueOnce(early.pending).mockResolvedValue(listed("untitled"));
    const running = refreshDrafts();
    // The server makes the draft while the list request is in flight; the
    // answer, taken before it, does not have it.
    noteDraftBorn(DRAFT);
    early.answer(listed());
    await running;

    expect(drafts.loaded).toBe(true);
    expect(draftGone(DRAFT)).toBe(false);

    // A list asked for after the draft was made decides.
    await refreshDrafts();
    expect(draftGone(DRAFT)).toBe(false);
  });
});

describe("a stale answer to a draft's request", () => {
  test("with the lifetime still listed, the request is made once more and its answer stands", async () => {
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed("untitled"));
    const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(stale()).mockResolvedValue("read");

    await expect(decidingStale(DRAFT, request)).resolves.toBe("read");

    expect(request).toHaveBeenCalledTimes(2);
    expect(api.listDrafts).toHaveBeenCalledTimes(1);
  });

  test("with the lifetime gone from the list, fails as a draft that no longer exists, with no second request", async () => {
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(stale());

    await expect(decidingStale(DRAFT, request)).rejects.toBeInstanceOf(DraftGoneError);

    expect(request).toHaveBeenCalledTimes(1);
  });

  test("answered stale a second time, the second answer stands", async () => {
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed("untitled"));
    const again = stale();
    const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(stale()).mockRejectedValue(again);

    await expect(decidingStale(DRAFT, request)).rejects.toBe(again);

    expect(request).toHaveBeenCalledTimes(2);
    expect(api.listDrafts).toHaveBeenCalledTimes(1);
  });

  test("any other refusal passes through without a look at the list", async () => {
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    const refused = new ApiError(400, "broken draft");
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(refused);

    await expect(decidingStale(DRAFT, request)).rejects.toBe(refused);

    expect(request).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  test("a workspace file's request is left alone, whatever its refusal's code", async () => {
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    const refused = stale();
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(refused);

    await expect(decidingStale("notes/a.md", request)).rejects.toBe(refused);

    expect(list).not.toHaveBeenCalled();
  });
});
