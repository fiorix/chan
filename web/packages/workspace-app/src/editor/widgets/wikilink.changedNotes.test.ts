// @vitest-environment jsdom
//
// A link pill's kind is the resolver's answer about the notes as they were
// when it was asked. A note created, moved or deleted can change any answer,
// so each site that hears of one drops the answers kept, and every pill asks
// again without a reload. The resolver is stubbed to answer from the
// in-memory demo workspace, which the file operations run over, and the watch
// socket to hand the case its ready hook, which the store hears at each open.

import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const resolveLink = vi.hoisted(() => vi.fn());
const socket = vi.hoisted(() => ({ opened: null as (() => void) | null }));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: { ...actual.api, resolveLink },
    openWatchSocket: (_onEvent: unknown, _onStatus: unknown, onReady?: () => void) => {
      socket.opened = onReady ?? null;
      return Object.assign(() => {}, {
        subscribeDir() {},
        unsubscribeDir() {},
        reportTransfers() {},
      });
    },
  };
});

import { api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../../demo/install";
import type { MockWorkspaceStore } from "../../demo/store";
import { trackTimers, type TimerTrack } from "../../demo/timers";
import { confirmState, resolveConfirm } from "../../state/confirm.svelte";
import {
  fbClipboardClear,
  fbClipboardPaste,
  fbClipboardSet,
  fileOps,
  handleDraftPromoted,
  onWatchEvent,
  pathPromptState,
  reconnectWatcher,
  refreshTree,
  refreshWorkspace,
  resolvePathPrompt,
} from "../../state/store.svelte";
import { closeTab } from "../../state/tabs.svelte";
import { fileTab, resetLayout } from "../../__tests__/tabs";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../../__tests__/wysiwyg";

installEditorDom();

let disk: MockWorkspaceStore;
let timers: TimerTrack;

// The kind cache lives as long as the module, so each test links names of
// its own: one the workspace holds and one it does not.
let run = 0;
const there = (): string => `notes/there-${run}.md`;
const absent = (): string => `notes/absent-${run}.md`;
const moved = (): string => `notes/moved-${run}.md`;

// The link kinds read the clock for the window a burst of frames shares and
// for a failed resolve's wait. Each case runs a minute after the one before
// it by that clock, outside any window an earlier case's frame opened.
const realNow = Date.now.bind(Date);

beforeEach(async () => {
  run += 1;
  const minutes = run;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + minutes * 60_000);
  timers = trackTimers();
  disk = installDemoWorkspace({
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 2,
      textCount: 2,
    },
    files: [
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: there(), kind: "document", size: 5, mtime: 100, content: "hello" },
    ],
  });
  resolveLink.mockImplementation(async (target: string) => {
    if (disk.isDir(target)) return { path: target, kind: "file", is_dir: true };
    if (disk.get(target)) return { path: target, kind: "file", is_dir: false };
    throw new ApiError(404, "link target not found", { code: "link_not_found" });
  });
  await refreshWorkspace();
  await refreshTree();
});

afterEach(async () => {
  vi.useRealTimers();
  unmountWysiwygs();
  if (pathPromptState.open) resolvePathPrompt(null);
  if (confirmState.open) resolveConfirm(false);
  fbClipboardClear();
  await settle(2);
  document.body.innerHTML = "";
  resolveLink.mockReset();
  vi.restoreAllMocks();
  uninstallDemoWorkspace();
  timers.release();
});

/// A note beside `path` that links it, mounted, with its editor.
async function mountLink(path: string): Promise<{ kind: () => string | undefined; view: EditorView }> {
  const { content, view } = await mountWysiwyg({
    value: `see [x](${path.slice("notes/".length)})`,
    currentPath: "notes/a.md",
  });
  await settle(6);
  return { kind: () => content.querySelector<HTMLElement>(".cm-md-wiki-pill")?.dataset.refkind, view };
}

/// Answers the kind the pill of a note that links `path` shows now.
async function pillFor(path: string): Promise<() => string | undefined> {
  return (await mountLink(path)).kind;
}

const NOT_FOUND = (): ApiError => new ApiError(404, "link target not found", { code: "link_not_found" });

/// Hold the resolver's next answer. `answer` then gives it what the notes
/// held when it was asked: the note, or the route's not-found.
function holdNextAnswer(): { answer: (found: boolean) => void } {
  let settle: (found: boolean) => void = () => {};
  resolveLink.mockImplementationOnce(
    (target: string) =>
      new Promise((resolve, reject) => {
        settle = (found) => (found ? resolve({ path: target, kind: "file", is_dir: false }) : reject(NOT_FOUND()));
      }),
  );
  return { answer: (found) => settle(found) };
}

/// The pill's kind before and after `change`, with no caret move and no
/// reload between them.
async function across(path: string, change: () => unknown): Promise<{ before?: string; after?: string }> {
  const kind = await pillFor(path);
  const before = kind();
  await change();
  await settle(6);
  return { before, after: kind() };
}

const APPEARS = { before: "broken", after: "file" };
const GOES = { before: "file", after: "broken" };

describe("a watch frame", () => {
  test("of a note's creation gives the pill that resolved as missing its kind", async () => {
    const seen = await across(absent(), () => {
      disk.create(absent(), false, "new");
      onWatchEvent({ type: "watch", event: { kind: "Created", path: absent() } });
    });

    expect(seen).toEqual(APPEARS);
  });

  test("of a note's removal leaves its pill no stale kind", async () => {
    const seen = await across(there(), () => {
      disk.remove(there());
      onWatchEvent({ type: "watch", event: { kind: "Removed", path: there() } });
    });

    expect(seen).toEqual(GOES);
  });

  test("of a note's move leaves its pill no stale kind", async () => {
    const seen = await across(there(), () => {
      disk.move(there(), moved());
      onWatchEvent({ type: "watch", event: { kind: "Renamed", path: there(), to: moved() } });
    });

    expect(seen).toEqual(GOES);
  });

  test("of a note's edit asks the resolver nothing", async () => {
    const kind = await pillFor(there());
    const asked = resolveLink.mock.calls.length;
    onWatchEvent({ type: "watch", event: { kind: "Modified", path: there() } });
    await settle(6);

    expect({ kind: kind(), asked: resolveLink.mock.calls.length - asked }).toEqual({ kind: "file", asked: 0 });
  });
});

// A request on the wire when the change is heard was asked of the notes as
// they were. Its answer may land after the pill has asked again.
describe("an answer asked before a change and landed after it", () => {
  test("of a note's creation is dropped: the pill keeps the kind it asked for since", async () => {
    const early = holdNextAnswer();
    const kind = await pillFor(absent());
    disk.create(absent(), false, "new");
    onWatchEvent({ type: "watch", event: { kind: "Created", path: absent() } });
    await settle(6);
    early.answer(false);
    await settle(6);

    expect(kind()).toBe("file");
  });

  test("of a note's removal is dropped: the pill keeps the kind it asked for since", async () => {
    const early = holdNextAnswer();
    const kind = await pillFor(there());
    disk.remove(there());
    onWatchEvent({ type: "watch", event: { kind: "Removed", path: there() } });
    await settle(6);
    early.answer(true);
    await settle(6);

    expect(kind()).toBe("broken");
  });

  test("does not free its target for a third request while the second is on the wire", async () => {
    const early = holdNextAnswer();
    const { view } = await mountLink(absent());
    holdNextAnswer();
    onWatchEvent({ type: "watch", event: { kind: "Created", path: absent() } });
    await settle(6);
    const second = resolveLink.mock.calls.length;
    early.answer(false);
    await settle(6);
    // A caret move outside the link, which makes the editor scan its pills.
    view.dispatch({ selection: { anchor: 1 } });
    await settle(6);

    expect({ second, after: resolveLink.mock.calls.length }).toEqual({ second: 2, after: 2 });
  });
});

// A checkout or a build frames many paths in a moment, and each drop has
// every pill on screen ask again. The clock is the case's from the mount on.
describe("a burst of watch frames", () => {
  const asked = (): number => resolveLink.mock.calls.length;

  test("asks a pill at its first frame and once after the window, not once per frame", async () => {
    const kind = await pillFor(absent());
    const before = asked();
    vi.useFakeTimers({ now: Date.now() });
    for (let frame = 0; frame < 10; frame += 1) {
      // The linked note is created in the middle of the burst.
      const path = frame === 5 ? absent() : `notes/burst-${run}-${frame}.md`;
      disk.create(path, false, "new");
      onWatchEvent({ type: "watch", event: { kind: "Created", path } });
      await vi.advanceTimersByTimeAsync(1);
    }
    const inside = { asked: asked() - before, kind: kind() };
    await vi.advanceTimersByTimeAsync(250);

    expect(
      { inside, after: { asked: asked() - before, kind: kind() } },
      "the pill's requests and kind inside the window and after it",
    ).toEqual({ inside: { asked: 1, kind: "broken" }, after: { asked: 2, kind: "file" } });
  });

  test("leaves a target whose resolve failed with no answer its wait", async () => {
    resolveLink.mockRejectedValueOnce(new ApiError(500, "the index is not ready"));
    const { kind, view } = await mountLink(absent());
    const before = asked();
    vi.useFakeTimers({ now: Date.now() });
    disk.create(absent(), false, "new");
    onWatchEvent({ type: "watch", event: { kind: "Created", path: absent() } });
    await vi.advanceTimersByTimeAsync(1);
    view.dispatch({ selection: { anchor: 1 } });
    await vi.advanceTimersByTimeAsync(1);
    const inside = { asked: asked() - before, kind: kind() };
    await vi.advanceTimersByTimeAsync(5_000);
    view.dispatch({ selection: { anchor: 2 } });
    await vi.advanceTimersByTimeAsync(1);

    expect(
      { inside, past: { asked: asked() - before, kind: kind() } },
      "the pill's requests and kind inside the failed resolve's wait and past it",
    ).toEqual({ inside: { asked: 0, kind: undefined }, past: { asked: 1, kind: "file" } });
  });
});

describe("this window's own", () => {
  test("move leaves the moved note's pill no stale kind", async () => {
    const seen = await across(there(), () => fileOps.moveTo(there(), moved()));

    expect(seen).toEqual(GOES);
  });

  test("delete leaves the deleted note's pill no stale kind", async () => {
    const seen = await across(there(), async () => {
      const removing = fileOps.remove(there());
      await settle(2);
      resolveConfirm(true);
      await removing;
    });

    expect(seen).toEqual(GOES);
  });

  test("New File gives the pill that resolved as missing its kind", async () => {
    resetLayout([]);
    const seen = await across(absent(), async () => {
      const creating = fileOps.createFile("notes");
      await settle(2);
      resolvePathPrompt(absent());
      await creating;
    });

    expect(seen).toEqual(APPEARS);
  });

  test("promotion of a draft gives the pill that resolved as missing its kind", async () => {
    const seen = await across(absent(), async () => {
      disk.create(absent(), false, "promoted");
      await handleDraftPromoted(absent());
    });

    expect(seen).toEqual(APPEARS);
  });

  test("discard of an empty file at its tab's close leaves its pill no stale kind", async () => {
    const pane = resetLayout([
      fileTab({ id: "empty", path: there(), content: "", saved: "", openedEmpty: true }),
    ]);
    const seen = await across(there(), () => closeTab(pane.id, "empty"));

    expect(seen).toEqual(GOES);
  });

  /// A directory beside the notes, for a transfer to land in.
  const SUB = "notes/sub";
  const landed = (): string => `${SUB}/there-${run}.md`;
  async function makeSub(): Promise<void> {
    disk.create(SUB, true);
    await refreshTree();
  }

  test("move of several entries at once leaves a moved note's pill no stale kind", async () => {
    await makeSub();
    const seen = await across(there(), () => fileOps.moveManyTo([there()], SUB));

    expect({ seen, moved: disk.get(landed()) !== undefined }, "the pill of the moved note").toEqual({
      seen: GOES,
      moved: true,
    });
  });

  test("paste of a cut leaves the moved note's pill no stale kind", async () => {
    await makeSub();
    const seen = await across(there(), async () => {
      fbClipboardSet("cut", [there()]);
      await fbClipboardPaste(SUB);
    });

    expect({ seen, moved: disk.get(landed()) !== undefined }, "the pill of the cut note").toEqual({
      seen: GOES,
      moved: true,
    });
  });

  test("paste of a copy gives the pill that resolved the copy's path as missing its kind", async () => {
    await makeSub();
    const seen = await across(landed(), async () => {
      fbClipboardSet("copy", [there()]);
      await fbClipboardPaste(SUB);
    });

    expect({ seen, copied: disk.get(landed()) !== undefined }, "the pill of the path the copy landed at").toEqual({
      seen: APPEARS,
      copied: true,
    });
  });

  test("paste that moves nothing asks the resolver nothing", async () => {
    const kind = await pillFor(there());
    const asked = resolveLink.mock.calls.length;
    // A cut pasted into the note's own directory is a move the route skips.
    fbClipboardSet("cut", [there()]);
    const moved = await fbClipboardPaste("notes");
    await settle(6);

    expect({ moved, kind: kind(), asked: resolveLink.mock.calls.length - asked }, "after the skipped move").toEqual({
      moved: [],
      kind: "file",
      asked: 0,
    });
  });
});

// A note created, moved or deleted while the socket was down sent this page
// no frame. The store keeps one such socket for the page's life, so this is
// the one case that opens it: its first open is the page's first.
describe("the watch socket", () => {
  test("drops the kinds kept when it opens again, and nothing at the page's first open", async () => {
    vi.spyOn(api, "terminalRoster").mockResolvedValue({ sessions: [] } as never);
    vi.spyOn(api, "health").mockResolvedValue({ instance: "one" } as never);
    vi.spyOn(api, "extensions").mockResolvedValue([]);
    vi.spyOn(api, "getSession").mockResolvedValue(null);
    reconnectWatcher();
    const kind = await pillFor(absent());
    const asked = resolveLink.mock.calls.length;

    socket.opened!();
    await settle(6);
    expect(
      { kind: kind(), asked: resolveLink.mock.calls.length - asked },
      "across the page's first open",
    ).toEqual({ kind: "broken", asked: 0 });

    disk.create(absent(), false, "new");
    socket.opened!();
    await settle(6);
    expect(kind(), "the pill of a note created while the socket was down").toBe("file");
  });
});
