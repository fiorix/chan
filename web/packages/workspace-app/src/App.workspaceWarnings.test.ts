// @vitest-environment jsdom
//
// A workspace can boot with warnings, such as a broken draft. They show in
// the status bar as one line (or a count), and clicking it opens the warnings
// dialog: each warning can have its path copied or be dismissed for the
// session, and a broken draft the server names a source for can be discarded
// by that source after a confirm, which re-reads the drafts list. A draft's
// warning reads by the draft's name; its path is where the server keeps it,
// outside the workspace. Draft warnings follow the latest successful list;
// other warnings follow the workspace payload.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

import { api } from "./api/client";
import type { DraftList, WorkspaceWarning } from "./api/types";
import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { settle as settleDialog, press as pressDialog } from "./__tests__/dialog";
import { dismissWorkspaceWarning, onWatchEvent, refreshWorkspace, resyncDrafts, ui, openSettings, settingsPanel, workspaceWarningsDialog } from "./state/store.svelte";
import { drafts, refreshDrafts, resetDraftsForTests } from "./state/drafts.svelte";
import { draftPath } from "./__tests__/drafts";

stubAppEnvironment();

let warnings: WorkspaceWarning[];
let writeText: ReturnType<typeof vi.fn>;
let warningRowSequence = 0;

beforeEach(() => {
  resetDraftsForTests();
  warnings = [];
  const read = api.workspace;
  vi.spyOn(api, "workspace").mockImplementation(async () => ({ ...(await read()), warnings: [...warnings] }));
  // A socket-ready resync may list during boot. Keep the payload's warnings
  // until the test supplies a successful list of its own.
  vi.spyOn(api, "listDrafts").mockRejectedValue(new Error("Drafts list unavailable"));
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

function heldList() {
  let answer!: (value: DraftList) => void;
  const pending = new Promise<DraftList>((resolve) => { answer = resolve; });
  return { pending, answer };
}

function draftFrame(event: string, name: string): void {
  onWatchEvent({
    type: "draft", event,
    source: { root: "draft", path: name, draft_id: `life-${name}` },
    source_w: "another-window",
  });
}

describe("draft warnings follow the list", () => {
  test.each(["status", "dialog"])("a receiving window clears its %s after a discarded frame's list answers", async (surface) => {
    warnings = [broken(`discarded-${surface}`)];
    const held = heldList();
    await mountApp();
    await openDialog();
    const list = vi.spyOn(api, "listDrafts").mockClear().mockReturnValue(held.pending);
    vi.mocked(api.workspace).mockClear();

    draftFrame("discarded", `discarded-${surface}`);
    expect(list).toHaveBeenCalledTimes(1);
    expect(statusAction()).not.toBeNull();
    expect(dialog()).not.toBeNull();
    held.answer({ drafts: [], warnings: [] });
    await held.pending;
    await settle();

    expect(api.workspace, "a draft frame adds no workspace request").not.toHaveBeenCalled();
    if (surface === "status") {
      expect(statusAction(), "the answered list clears the receiving window's status action").toBeNull();
    } else {
      expect(dialog(), "the answered list closes the receiving window's warnings dialog").toBeNull();
    }
  });

  test.each(["created", "modified"])("a %s frame clears a warning when the draft lists whole", async (event) => {
    const name = `whole-${event}`;
    warnings = [broken(name)];
    const held = heldList();
    await mountApp();
    const list = vi.spyOn(api, "listDrafts").mockClear().mockReturnValue(held.pending);
    vi.mocked(api.workspace).mockClear();

    draftFrame(event, name);
    expect(list).toHaveBeenCalledTimes(1);
    held.answer({
      drafts: [{ name, draftId: `life-${name}`, path: draftPath(name), hasAttachments: false, busy: false }],
      warnings: [],
    });
    await held.pending;
    await settle();

    expect(drafts.rows.map((row) => row.name)).toEqual([name]);
    expect(statusAction(), "a whole draft's list clears its warning").toBeNull();
    expect(api.workspace).not.toHaveBeenCalled();
  });

  test("composes other payload kinds, list-only rows and preflight while preserving session dismissal", async () => {
    const dismissed = broken("composition-dismissed");
    const extra = broken("list-only", "inspection refused");
    const unrelated = { kind: "other", path: "workspace", message: "keep me" };
    const preflight = { kind: "draft_preflight_failed", path: DRAFT_STORE, message: "store unavailable" };
    warnings = [broken("stale-payload"), dismissed, unrelated, { ...preflight, message: "old refusal" }];
    await mountApp();
    dismissWorkspaceWarning(dismissed);
    vi.spyOn(api, "listDrafts").mockResolvedValue({ drafts: [], warnings: [dismissed, extra, preflight] });

    await refreshDrafts();
    await settle();

    expect(workspaceWarningsDialog.warnings, "the composed set uses both list warning kinds and the session dismissal").toEqual([unrelated, extra, preflight]);
    expect(statusAction()?.textContent?.trim()).toBe("3 workspace warnings found");
    const open = await openDialog();
    expect(open.querySelectorAll(".warning-item")).toHaveLength(3);
    expect(button(open, "Discard metadata"), "a list-only broken row is discardable").toBeDefined();
  });

  test("keeps a dismissed list warning hidden when the next list answers", async () => {
    const dismissed = broken("dismissed-list");
    warnings = [dismissed];
    await mountApp();
    dismissWorkspaceWarning(dismissed);
    vi.spyOn(api, "listDrafts").mockResolvedValue({ drafts: [], warnings: [dismissed] });

    await refreshDrafts();
    await settle();

    expect(workspaceWarningsDialog.warnings, "session dismissal applies to the list's warnings").toEqual([]);
    expect(statusAction()).toBeNull();
  });

  test("a frame during an in-flight list follows that answer with the current list", async () => {
    const old = broken("in-flight");
    warnings = [old];
    await mountApp();
    const first = heldList();
    const second = heldList();
    const list = vi.spyOn(api, "listDrafts")
      .mockClear().mockReturnValueOnce(first.pending).mockReturnValueOnce(second.pending);
    const running = refreshDrafts();
    draftFrame("discarded", "in-flight");
    draftFrame("modified", "in-flight");
    expect(list).toHaveBeenCalledTimes(1);

    first.answer({ drafts: [], warnings: [old] });
    await running;
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(statusAction()).not.toBeNull();
    second.answer({ drafts: [], warnings: [] });
    await second.pending;
    await settle();

    expect(statusAction(), "the queued answer replaces the warning from the older list").toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("a failed list keeps the last successful warnings and the open dialog", async () => {
    const retained = broken("failed-list");
    warnings = [retained];
    await mountApp();
    const list = vi.spyOn(api, "listDrafts").mockResolvedValue({ drafts: [], warnings: [retained] });
    await refreshDrafts();
    await openDialog();
    list.mockRejectedValue(new Error("offline"));

    await refreshDrafts();
    await settle();

    expect(drafts).toMatchObject({ loaded: true, broken: [retained], error: "offline" });
    expect(workspaceWarningsDialog.warnings).toEqual([retained]);
    expect(statusAction()).not.toBeNull();
    expect(dialog()).not.toBeNull();
  });

  test("a failed first list preserves the payload until the first successful list", async () => {
    const initial = broken("first-list");
    warnings = [initial];
    await mountApp();
    const list = vi.spyOn(api, "listDrafts").mockRejectedValue(new Error("offline"));
    await refreshDrafts();
    await settle();
    expect(drafts.loaded).toBe(false);
    expect(workspaceWarningsDialog.warnings).toEqual([initial]);
    list.mockResolvedValue({ drafts: [], warnings: [] });

    await refreshDrafts();
    await settle();

    expect(statusAction(), "the first successful list replaces the boot payload").toBeNull();
  });

  test("a file-event workspace refresh keeps the list's set", async () => {
    const extra = broken("after-file-event", "inspection refused");
    warnings = [broken("stale-file-payload")];
    await mountApp();
    vi.spyOn(api, "listDrafts").mockResolvedValue({ drafts: [], warnings: [extra] });
    await refreshDrafts();
    vi.mocked(api.workspace).mockClear();
    vi.useFakeTimers();
    try {
      onWatchEvent({ type: "watch", event: { kind: "Modified", path: "README.md" } });
      await vi.advanceTimersByTimeAsync(250);
      await settle();

      expect(api.workspace, "the file event refreshed the payload").toHaveBeenCalledTimes(1);
      expect(workspaceWarningsDialog.warnings, "a workspace refresh preserves the list-only warning").toEqual([extra]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a dismissal after a list shows no stale payload entry", async () => {
    const dismissed = broken("dismiss-after-list");
    const extra = broken("retained-list-row");
    warnings = [broken("stale-after-dismiss"), dismissed];
    await mountApp();
    vi.spyOn(api, "listDrafts").mockResolvedValue({ drafts: [], warnings: [dismissed, extra] });
    await refreshDrafts();

    dismissWorkspaceWarning(dismissed);
    await settle();

    expect(workspaceWarningsDialog.warnings, "dismissal recomposes from the list without stale payload warnings").toEqual([extra]);
    expect(statusAction()?.textContent?.trim()).toBe("Broken draft retained-list-row: missing draft.md");
  });

  test.each(["pill", "dialog"])("resync lists for a warning %s without a draft tab or an earlier list", async (surface) => {
    warnings = [broken(`resync-${surface}`)];
    await mountApp();
    expect(drafts.loaded).toBe(false);
    if (surface === "dialog") {
      await openDialog();
      ui.statusAction = null;
    }
    const list = vi.spyOn(api, "listDrafts").mockClear().mockResolvedValue({ drafts: [], warnings: [] });

    resyncDrafts();
    await settle();

    expect(list, "a displayed warning makes the drafts list worth resyncing").toHaveBeenCalledTimes(1);
    expect(statusAction()).toBeNull();
    expect(dialog()).toBeNull();
  });

  test("local discard requests one list and keeps its dialog until that answer", async () => {
    warnings = [broken("local-list")];
    await mountApp();
    const held = heldList();
    const list = vi.spyOn(api, "listDrafts").mockClear().mockReturnValue(held.pending);
    vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);
    vi.mocked(api.workspace).mockClear();
    const open = await openDialog();
    button(open, "Discard metadata")!.click();
    await settle();
    const confirm = document.querySelector<HTMLElement>('[aria-labelledby="confirm-title"]')!;
    button(confirm, "Discard")!.click();
    await settle();
    await settle();
    expect.soft(list, "one list follows a successful local discard").toHaveBeenCalledTimes(1);
    expect.soft(workspaceWarningsDialog.busyKey, "discard stays busy until its list answers").not.toBeNull();
    expect.soft(dialog()).not.toBeNull();
    held.answer({ drafts: [], warnings: [] });
    await held.pending;
    await settle();
    await settle();

    expect(api.workspace, "local discard uses the list instead of the workspace payload").not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(ui.status).toBe("Discarded local-list");
    expect(list).toHaveBeenCalledTimes(1);
  });
});

afterEach(async () => {
  await unmountApp();
  vi.restoreAllMocks();
});

const DRAFT_STORE = "/home/user/.chan/workspaces/demo/Drafts";

function broken(name: string, message = "missing draft.md"): WorkspaceWarning {
  return {
    kind: "broken_draft",
    path: `${DRAFT_STORE}/${name}`,
    message,
    source: { root: "draft", path: name },
  };
}

function statusAction(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".status-msg.status-action");
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="workspace-warnings-title"]');
}

function button(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
}

async function openDialog(): Promise<HTMLElement> {
  statusAction()!.click();
  await settle();
  expect(dialog()).not.toBeNull();
  return dialog()!;
}

describe("warnings at boot", () => {
  test("one warning reads as itself in the status bar, which opens the dialog on it", async () => {
    warnings = [broken("untitled-1")];
    await mountApp();

    expect.soft(statusAction()?.textContent?.trim()).toBe("Broken draft untitled-1: missing draft.md");
    const open = await openDialog();
    expect.soft(open.querySelector(".warning-title")?.textContent).toBe("Broken draft untitled-1: missing draft.md");
    expect(open.querySelector(".warning-meta code")?.textContent).toBe(`${DRAFT_STORE}/untitled-1`);
    expect(button(open, "Copy path")).toBeDefined();
    expect(button(open, "Dismiss")).toBeDefined();
    expect.soft(button(open, "Discard metadata"), "a warning with a source offers Discard").toBeDefined();
  });

  test("several read as a count", async () => {
    warnings = [broken("untitled-2"), broken("untitled-3")];
    await mountApp();

    expect(statusAction()?.textContent?.trim()).toBe("2 workspace warnings found");
  });

  test("a status line that is not the warnings' own opens nothing", async () => {
    warnings = [broken("untitled-4")];
    await mountApp();
    ui.status = "Saved";
    await settle();

    expect(statusAction()).toBeNull();
  });

  test("none leave the status bar alone", async () => {
    await mountApp();

    expect(statusAction()).toBeNull();
  });
});

describe("the warnings dialog", () => {
  test("a refused warning close preserves the underlying App overlay", async () => {
    warnings = [broken("busy-overlay")];
    await mountApp();
    openSettings(); await settle();
    expect(settingsPanel.open).toBe(true);
    const open = await openDialog();
    workspaceWarningsDialog.busyKey = "busy"; await settleDialog();
    try {
      pressDialog(document.body, "Escape"); await settleDialog();
      expect(dialog(), "busy warning remains mounted").toBe(open);
      expect(settingsPanel.open, "refused close preserves Settings").toBe(true);
    } finally { workspaceWarningsDialog.busyKey = null; }
    pressDialog(open, "Escape"); await settleDialog();
    expect(dialog()).toBeNull();
    expect(settingsPanel.open).toBe(true);
    pressDialog(document.body, "Escape"); await settleDialog();
    expect(settingsPanel.open, "App receives Escape after the shell closes").toBe(false);
  });

  test("recovers focus after dismissing a warning row while other rows remain", async () => {
    // Dismissals belong to the session and survive an App fixture unmount.
    const sequence = ++warningRowSequence;
    warnings = [broken(`row-${sequence}-one`), broken(`row-${sequence}-two`)];
    await mountApp();
    const open = await openDialog();
    expect(open.querySelectorAll(".warning-item"), "two undismissed warnings").toHaveLength(2);
    const dismiss = button(open, "Dismiss")!;
    dismiss.focus(); await settleDialog();
    dismiss.click(); await settleDialog();
    expect(dismiss.isConnected, "dismiss removes its row").toBe(false);
    expect(open.querySelectorAll(".warning-item")).toHaveLength(1);
    expect(open.isConnected, "the remaining row keeps the dialog open").toBe(true);
    expect(document.activeElement, "warning row focus repair").toBe(open);
  });

  test("opens discard confirmation above warnings and returns focus after cancellation", async () => {
    warnings = [broken("stack")];
    await mountApp();
    const open = await openDialog();
    const discard = button(open, "Discard metadata")!;
    discard.focus(); discard.click(); await settle();
    const confirm = document.querySelector<HTMLElement>('[aria-labelledby="confirm-title"]')!;
    expect(confirm).not.toBeNull();
    expect(Number(confirm.parentElement!.style.zIndex), "discard confirm layer")
      .toBeGreaterThan(Number(open.parentElement!.style.zIndex));
    expect(document.activeElement).toBe(button(confirm, "Cancel"));
    button(confirm, "Cancel")!.click(); await settle();
    expect(confirm.isConnected).toBe(false);
    expect(document.activeElement, "discard opener restoration").toBe(discard);
  });

  test("Copy path copies the warning's path and says so", async () => {
    warnings = [broken("untitled-5")];
    await mountApp();
    const open = await openDialog();

    button(open, "Copy path")!.click();
    await settle();

    expect(writeText).toHaveBeenCalledWith(`${DRAFT_STORE}/untitled-5`);
    expect(open.querySelector('[role="status"]')?.textContent).toBe("Copied path");
  });

  test("Dismiss hides a warning for the session and clears the status bar", async () => {
    warnings = [broken("untitled-6")];
    await mountApp();
    const open = await openDialog();

    button(open, "Dismiss")!.click();
    await settle();

    expect(dialog()).toBeNull();
    expect(statusAction()).toBeNull();
    await refreshWorkspace();
    await settle();
    expect(statusAction()).toBeNull();
  });

  test("Discard metadata discards by the warning's source after a confirm and re-reads the drafts list", async () => {
    // The path reads like a draft folder inside the workspace and the
    // source carries a lifetime id: the request names the source as given,
    // never the path.
    const source = { root: "draft" as const, path: "untitled-7", draft_id: "life-7" };
    warnings = [{ kind: "broken_draft", path: ".Drafts/untitled-7", message: "missing draft.md", source }];
    await mountApp();
    const discard = vi.spyOn(api, "discardDraft").mockImplementation(async () => {
      warnings = [];
    });
    vi.spyOn(api, "listDrafts").mockImplementation(async () => ({ drafts: [], warnings: [...warnings] }));
    const open = await openDialog();

    button(open, "Discard metadata")!.click();
    await settle();
    expect(discard).not.toHaveBeenCalled();
    const confirm = document.querySelector<HTMLElement>('[aria-labelledby="confirm-title"]')!;
    expect.soft(confirm.textContent, "the confirmation names the draft").toContain("Move untitled-7 to trash?");
    button(confirm, "Discard")!.click();

    await vi.waitFor(() => expect(discard).toHaveBeenCalled());
    expect.soft(discard).toHaveBeenCalledWith(source);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect.soft(ui.status).toBe("Discarded untitled-7");
  });

  test("offers no Discard for a warning the server names no source for", async () => {
    // An entry of the draft store that is not a real directory has no
    // source, and neither does a path that only looks like a draft's.
    warnings = [
      { kind: "broken_draft", path: `${DRAFT_STORE}/untitled-8`, message: "not a directory" },
      { kind: "broken_draft", path: ".Drafts/untitled-9", message: "missing draft.md" },
    ];
    await mountApp();
    const open = await openDialog();

    expect(open.querySelectorAll(".warning-item")).toHaveLength(2);
    expect(button(open, "Discard metadata")).toBeUndefined();
  });

  test("offers no Discard for a warning of another kind, source or not", async () => {
    warnings = [{ kind: "other", path: `${DRAFT_STORE}/untitled-9`, message: "odd", source: { root: "draft", path: "untitled-9" } }];
    await mountApp();
    const open = await openDialog();

    expect(open.querySelectorAll(".warning-item")).toHaveLength(1);
    expect(button(open, "Discard metadata")).toBeUndefined();
  });
});

describe("a workspace refresh", () => {
  test("surfaces warnings that appeared since boot", async () => {
    await mountApp();
    expect(statusAction()).toBeNull();

    warnings = [broken("untitled-10")];
    await refreshWorkspace();
    await settle();

    expect(statusAction()?.textContent?.trim()).toBe("Broken draft untitled-10: missing draft.md");
  });
});
