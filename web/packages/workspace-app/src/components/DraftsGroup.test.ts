// @vitest-environment jsdom
//
// The Drafts group above the file tree lists the workspace's drafts from
// the server's list: one row per draft that opens its primary, a damaged
// draft as a row that can only be discarded, and one banner in place of the
// rows when the draft store refused to open. A draft's client path carries a
// mark and the id of its lifetime; neither is ever shown.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mountDialog, settle, unmountDialogs } from "../__tests__/dialog";
import { draftPath } from "../__tests__/drafts";
import { resetLayout } from "../__tests__/tabs";
import { api } from "../api/client";
import type { DraftList, WorkspaceWarning } from "../api/types";
import { resetDraftsForTests } from "../state/drafts.svelte";
import { confirmState, resolveConfirm } from "../state/confirm.svelte";
import { workspaceWarningsDialog } from "../state/store.svelte";
import { activePane } from "../state/tabs.svelte";
import DraftsGroup from "./DraftsGroup.svelte";

const MARK = String.fromCharCode(0);
const STORE = "/home/user/.chan/workspaces/demo/Drafts";

function row(name: string, over: Partial<DraftList["drafts"][number]> = {}) {
  return { name, draftId: `life-${name}`, path: draftPath(name), hasAttachments: false, busy: false, ...over };
}

function broken(name: string, source = true): WorkspaceWarning {
  return {
    kind: "broken_draft",
    path: `${STORE}/${name}`,
    message: "missing draft.md",
    ...(source ? { source: { root: "draft" as const, path: name } } : {}),
  };
}

async function shown(list: DraftList): Promise<HTMLElement> {
  vi.spyOn(api, "listDrafts").mockResolvedValue(list);
  const target = mountDialog(DraftsGroup);
  await settle();
  await settle();
  return target;
}

function names(target: HTMLElement): string[] {
  return [...target.querySelectorAll(".draft-name")].map((el) => el.textContent ?? "");
}

/// Everything a person can read or hear from the group: its text, titles
/// and aria labels. Not its URLs, which rightly carry a draft's id.
function readable(target: HTMLElement): string {
  const parts = [target.textContent ?? ""];
  for (const el of target.querySelectorAll("[title], [aria-label]")) {
    parts.push(el.getAttribute("title") ?? "", el.getAttribute("aria-label") ?? "");
  }
  return parts.join(" ");
}

beforeEach(() => {
  resetDraftsForTests();
  resetLayout([]);
});

afterEach(() => {
  resolveConfirm(false);
  unmountDialogs();
  vi.restoreAllMocks();
  resetLayout([]);
});

describe("the Drafts group", () => {
  test("asks for the list as it mounts and shows nothing while there are no drafts", async () => {
    const target = await shown({ drafts: [], warnings: [] });

    expect(api.listDrafts).toHaveBeenCalledTimes(1);
    expect(target.querySelector(".drafts-group")).toBeNull();
  });

  test("lists one row per draft under a heading that says where drafts are kept", async () => {
    const target = await shown({
      drafts: [row("untitled"), row("sketch", { hasAttachments: true })],
      warnings: [],
    });

    expect(target.querySelector(".drafts-title")?.textContent).toBe("Drafts");
    expect(target.querySelector(".drafts-note")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Drafts are kept outside the workspace. They are not in search or the graph until saved to the workspace.",
    );
    expect(names(target)).toEqual(["untitled", "sketch"]);
    const marks = [...target.querySelectorAll(".draft-row")].map((el) => el.querySelector(".draft-mark") !== null);
    expect(marks, "which rows are marked as holding attachments").toEqual([false, true]);
  });

  test("a click on a row opens the draft's primary in the active pane", async () => {
    vi.spyOn(api, "readStream").mockResolvedValue({ path: "untitled/draft.md", content: "# Draft\n", mtime: 1, writable: true });
    const target = await shown({ drafts: [row("untitled")], warnings: [] });

    target.querySelector<HTMLButtonElement>(".draft-row")!.click();
    await settle();

    expect(activePane().tabs.map((tab) => (tab.kind === "file" ? tab.path : tab.kind))).toEqual([draftPath("untitled")]);
  });

  test("a busy draft the server names no file for is listed and opens nothing", async () => {
    const target = await shown({ drafts: [row("closing", { path: null, busy: true })], warnings: [] });
    const button = target.querySelector<HTMLButtonElement>(".draft-row")!;

    expect(names(target)).toEqual(["closing"]);
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".draft-busy")?.textContent).toBe("busy");
    button.click();
    await settle();
    expect(activePane().tabs).toEqual([]);
  });

  test("a damaged draft is a row with what is wrong and a Discard that names the draft to the server", async () => {
    const warning = broken("bad");
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);
    vi.spyOn(api, "workspace").mockRejectedValue(new Error("not asked in this test"));
    const target = await shown({ drafts: [], warnings: [warning] });
    const item = target.querySelector(".draft-broken")!;

    expect(item.querySelector(".draft-name")?.textContent).toBe("bad");
    expect(item.querySelector(".draft-problem")?.textContent).toBe("missing draft.md");
    expect(target.querySelector(".draft-row"), "a damaged draft has no row that opens").toBeNull();

    item.querySelector<HTMLButtonElement>(".draft-discard")!.click();
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith(warning.source));
  });

  test("a refused discard says why under the row, with the warnings dialog closed", async () => {
    const warning = broken("bad");
    const discard = vi.spyOn(api, "discardDraft").mockRejectedValue(new Error("draft `bad` is busy"));
    const target = await shown({ drafts: [], warnings: [warning] });

    target.querySelector<HTMLButtonElement>(".draft-discard")!.click();
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);
    await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
    await settle();

    expect.soft(workspaceWarningsDialog.open, "the dialog is not what shows it").toBe(false);
    expect.soft(target.querySelector('.draft-refusal[role="alert"]')?.textContent).toBe(
      "Not discarded: draft `bad` is busy",
    );
    expect.soft(target.querySelector(".draft-broken .draft-name")?.textContent, "the row stays").toBe("bad");
  });

  test("a discard that landed is not called refused when only the refresh after it failed", async () => {
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);
    vi.spyOn(api, "workspace").mockRejectedValue(new Error("offline"));
    const target = await shown({ drafts: [], warnings: [broken("bad")] });

    target.querySelector<HTMLButtonElement>(".draft-discard")!.click();
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    resolveConfirm(true);
    await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
    await settle();

    expect(target.querySelector(".draft-refusal")).toBeNull();
  });

  test("a damaged entry the server names no draft for offers no Discard", async () => {
    const target = await shown({ drafts: [], warnings: [broken("stray", false)] });

    expect(target.querySelector(".draft-broken")).not.toBeNull();
    expect(target.querySelector(".draft-discard")).toBeNull();
  });

  test("a draft store that refused to open is one banner naming where it is, in place of the rows", async () => {
    const refused = { kind: "draft_preflight_failed", path: STORE, message: "Drafts is not a directory" };
    const target = await shown({ drafts: [], warnings: [refused] });
    const banner = target.querySelector('[role="alert"]')!;

    expect(banner.textContent).toContain("Drafts is not a directory");
    expect(banner.querySelector("code")?.textContent).toBe(STORE);
    expect(target.querySelector(".drafts-rows")).toBeNull();
  });

  test("shows no mark and no lifetime id in its text, titles or labels", async () => {
    const target = await shown({
      drafts: [row("untitled", { hasAttachments: true }), row("closing", { path: null, busy: true })],
      warnings: [broken("bad")],
    });

    const text = readable(target);
    expect(text).toContain("untitled");
    expect(text).not.toContain(MARK);
    expect(text).not.toContain("life-");
  });
});
