// @vitest-environment jsdom
//
// What a workspace window does with its tabs when a draft's request is
// answered stale, and when it hears of a draft. The list decides whether a
// lifetime is gone: its tabs are then marked missing, as a tab whose file
// vanished is. A stale answer for a lifetime still listed leaves the tab on
// the draft and the request is made once more. A draft saved to the
// workspace takes the tab on its primary along, also when the tab was
// marked missing first, since the list and the news arrive in either order.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { draftPath } from "../__tests__/drafts";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { api, sessionWindowId } from "../api/client";
import { ApiError } from "../api/errors";
import type { DraftList } from "../api/types";
import { refreshDrafts, resetDraftsForTests } from "./drafts.svelte";
import { noteDraftCreated, onWatchEvent, resyncDrafts } from "./store.svelte";
import { closeTab, draftCloseState, forceReloadFromDisk, saveTab } from "./tabs.svelte";

const DRAFT = draftPath("untitled");
const IMAGE = draftPath("untitled", "image.png");
const OTHER = draftPath("other");
const SOURCE = { root: "draft", path: "untitled/draft.md", draft_id: "life-untitled" };
const ELSEWHERE = "w-another-window";

function listed(...names: string[]): DraftList {
  return {
    drafts: names.map((name) => ({
      name,
      draftId: `life-${name}`,
      path: draftPath(name),
      hasAttachments: false,
      busy: false,
    })),
    warnings: [],
  };
}

function stale(): ApiError {
  return new ApiError(409, "draft `untitled` session closed", { code: "draft_stale", name: "untitled" });
}

function onDisk(content: string, path = "untitled/draft.md") {
  return { path, content, mtime: 9, mtime_ns: "9", writable: true };
}

function written() {
  return { mtime: 10, mtime_ns: "10", authority_version: null, disk_conflicted: false };
}

function clean(id: string, path: string) {
  return fileTab({ id, path, content: "as saved", saved: "as saved", savedMtime: 7, savedMtimeNs: "7" });
}

async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function draftFrame(event: string, extra: Record<string, unknown> = {}): void {
  onWatchEvent({ type: "draft", event, source: SOURCE, source_w: ELSEWHERE, ...extra });
}

beforeEach(() => {
  resetDraftsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLayout([]);
});

describe("a stale answer to a draft tab's read", () => {
  test("with the draft still listed, is read once more and the tab stays on the draft", async () => {
    resetLayout([clean("tab", DRAFT)]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed("untitled"));
    const read = vi.spyOn(api, "readStream").mockRejectedValueOnce(stale()).mockResolvedValue(onDisk("fresh"));

    await forceReloadFromDisk("tab");

    expect.soft(read).toHaveBeenCalledTimes(2);
    expect.soft(readTab("tab")).toMatchObject({ path: DRAFT, fileMissing: null, error: null, content: "fresh" });
  });

  test("with the draft gone from the list, marks the tab missing and reads no more", async () => {
    resetLayout([clean("tab", DRAFT)]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    const read = vi.spyOn(api, "readStream").mockRejectedValue(stale());

    await forceReloadFromDisk("tab");

    expect.soft(read).toHaveBeenCalledTimes(1);
    expect.soft(readTab("tab")?.fileMissing, "the tab is marked missing").toMatchObject({ path: DRAFT });
    expect.soft(readTab("tab")?.error).toBeNull();
  });
});

describe("a stale answer to a draft tab's save", () => {
  function dirty() {
    return fileTab({ id: "tab", path: DRAFT, content: "typed", saved: "as saved", savedMtime: 7, savedMtimeNs: "7" });
  }

  test("with the draft still listed, is saved once more and lands", async () => {
    resetLayout([dirty()]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed("untitled"));
    const write = vi.spyOn(api, "write").mockRejectedValueOnce(stale()).mockResolvedValue(written());

    await saveTab(readTab("tab")!).catch(() => {});

    expect.soft(write).toHaveBeenCalledTimes(2);
    expect.soft(readTab("tab")).toMatchObject({ saved: "typed", fileMissing: null });
  });

  test("with the draft gone from the list, marks the tab missing and keeps what was typed", async () => {
    resetLayout([dirty()]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    const write = vi.spyOn(api, "write").mockRejectedValue(stale());

    await saveTab(readTab("tab")!).catch(() => {});

    expect.soft(write).toHaveBeenCalledTimes(1);
    expect.soft(readTab("tab")?.fileMissing, "the tab is marked missing").toMatchObject({ path: DRAFT });
    expect.soft(readTab("tab")).toMatchObject({ content: "typed", saved: "as saved" });
  });
});

describe("closing a tab whose draft is gone", () => {
  test("closes it with no dialog and nothing to discard", async () => {
    const pane = resetLayout([clean("tab", DRAFT)]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    vi.spyOn(api, "inspectDraft").mockRejectedValue(stale());
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);

    await closeTab(pane.id, "tab");

    expect.soft(readTab("tab"), "the tab is closed").toBeUndefined();
    expect.soft(draftCloseState.open).toBe(false);
    expect.soft(discard).not.toHaveBeenCalled();
  });
});

describe("a draft event", () => {
  test("of a discard marks every tab of that lifetime missing, and no other draft's", async () => {
    resetLayout([clean("primary", DRAFT), clean("image", IMAGE), clean("other", OTHER)]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed("other"));

    draftFrame("discarded");
    await settle();

    expect.soft(readTab("primary")?.fileMissing, "the primary's tab").toMatchObject({ path: DRAFT });
    expect.soft(readTab("image")?.fileMissing, "the image's tab").toMatchObject({ path: IMAGE });
    expect.soft(readTab("other")?.fileMissing, "another draft's tab").toBeNull();
  });

  test("of a write in another window raises the tab's changed-on-disk banner; this window's own does not", async () => {
    resetLayout([clean("tab", DRAFT)]);
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed("untitled"));

    draftFrame("modified", { source_w: sessionWindowId() });
    await settle();
    expect.soft(readTab("tab")?.externalChange ?? false, "after this window's own write").toBe(false);
    expect.soft(list, "the list is fetched for the window's own event too").toHaveBeenCalledTimes(1);

    draftFrame("modified");
    await settle();
    expect.soft(readTab("tab")?.externalChange, "after another window's write").toBe(true);
    expect.soft(readTab("tab")?.fileMissing).toBeNull();
  });

  test("of a promotion moves a clean tab on the primary to the file and reads it there; the lifetime's other tabs go missing", async () => {
    resetLayout([clean("primary", DRAFT), clean("image", IMAGE)]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    const read = vi.spyOn(api, "readStream").mockResolvedValue(onDisk("promoted", "notes/final/draft.md"));

    draftFrame("promoted", { destination: { root: "workspace", path: "notes/final/draft.md" } });
    await settle();

    expect.soft(read.mock.calls.map((call) => call[0])).toEqual(["notes/final/draft.md"]);
    expect.soft(readTab("primary")).toMatchObject({
      path: "notes/final/draft.md",
      content: "promoted",
      fileMissing: null,
    });
    expect.soft(readTab("image")?.fileMissing, "the image's tab").toMatchObject({ path: IMAGE });
  });

  test("of a promotion moves a tab already marked missing to the file and clears the mark", async () => {
    const gone = clean("primary", DRAFT);
    gone.fileMissing = { path: DRAFT, fragment: null };
    resetLayout([gone]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    vi.spyOn(api, "readStream").mockResolvedValue(onDisk("promoted", "notes/final.md"));

    draftFrame("promoted", { destination: { root: "workspace", path: "notes/final.md" } });
    await settle();

    expect.soft(readTab("primary")).toMatchObject({ path: "notes/final.md", fileMissing: null, content: "promoted" });
  });

  test("of a promotion moves a dirty tab to the file with what was typed, and reads nothing over it", async () => {
    resetLayout([fileTab({ id: "primary", path: DRAFT, content: "typed", saved: "as saved", savedMtime: 7 })]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    const read = vi.spyOn(api, "readStream").mockResolvedValue(onDisk("promoted", "notes/final.md"));

    draftFrame("promoted", { destination: { root: "workspace", path: "notes/final.md" } });
    await settle();

    expect.soft(read).not.toHaveBeenCalled();
    expect.soft(readTab("primary")).toMatchObject({ path: "notes/final.md", content: "typed", fileMissing: null });
  });

  test("with no file named, a resync, fetches the list and marks the tabs of a lifetime it no longer has", async () => {
    resetLayout([clean("tab", DRAFT)]);
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed());

    onWatchEvent({ type: "draft", event: "resync" });
    await settle();

    expect.soft(list).toHaveBeenCalledTimes(1);
    expect.soft(readTab("tab")?.fileMissing, "the tab is marked missing").toMatchObject({ path: DRAFT });
  });

  test("is apart from a workspace file's event at the same relative path", async () => {
    resetLayout([clean("tab", DRAFT)]);
    vi.spyOn(api, "listDrafts").mockResolvedValue(listed("untitled"));
    vi.spyOn(api, "workspace").mockRejectedValue(new Error("not asked in this test"));

    onWatchEvent({ event: { kind: "Modified", path: "untitled/draft.md" }, source_w: ELSEWHERE });
    await settle();

    expect(readTab("tab")?.externalChange ?? false).toBe(false);
    expect(readTab("tab")?.fileMissing).toBeNull();
  });
});

describe("a gap in what the window heard", () => {
  test("fetches the list again where a draft's tab is open, and marks a lifetime it no longer has", async () => {
    resetLayout([clean("tab", DRAFT)]);
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed());

    resyncDrafts();
    await settle();

    expect.soft(list).toHaveBeenCalledTimes(1);
    expect.soft(readTab("tab")?.fileMissing, "the tab is marked missing").toMatchObject({ path: DRAFT });
  });

  test("fetches nothing in a window that holds no draft and never listed any", async () => {
    resetLayout([clean("tab", "notes/a.md")]);
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed());

    resyncDrafts();
    await settle();

    expect(list).not.toHaveBeenCalled();
  });

  test("fetches the list again once a list was answered, whatever tabs are open", async () => {
    resetLayout([]);
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue(listed());
    await refreshDrafts();

    resyncDrafts();
    await settle();

    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("a draft made for this window", () => {
  test("asks for the list, and its tab is not marked missing by a list taken before it existed", async () => {
    resetLayout([clean("tab", DRAFT)]);
    let answer!: (list: DraftList) => void;
    const early = new Promise<DraftList>((resolve) => {
      answer = resolve;
    });
    const list = vi.spyOn(api, "listDrafts").mockReturnValueOnce(early).mockResolvedValue(listed("untitled"));
    const before = refreshDrafts();

    await noteDraftCreated(DRAFT);
    answer(listed());
    await before;
    await settle();

    expect.soft(list.mock.calls.length, "a list is asked for after the draft exists").toBeGreaterThanOrEqual(2);
    expect.soft(readTab("tab")?.fileMissing).toBeNull();
  });
});
