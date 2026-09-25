// @vitest-environment jsdom
//
// A workspace can boot with warnings, such as a broken draft. They show in
// the status bar as one line (or a count), and clicking it opens the warnings
// dialog: each warning can have its path copied or be dismissed for the
// session, and a broken draft directly under the drafts folder can be
// discarded after a confirm, which re-reads the workspace. A later refresh of
// the workspace surfaces new warnings the same way.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinks);

import { api } from "./api/client";
import type { WorkspaceWarning } from "./api/types";
import { mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { refreshWorkspace, ui } from "./state/store.svelte";

stubAppEnvironment();

let warnings: WorkspaceWarning[];
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  warnings = [];
  const read = api.workspace;
  vi.spyOn(api, "workspace").mockImplementation(async () => ({ ...(await read()), warnings: [...warnings] }));
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(async () => {
  await unmountApp();
  vi.restoreAllMocks();
});

function broken(name: string, message = "missing draft.md"): WorkspaceWarning {
  return { kind: "broken_draft", path: `.Drafts/${name}`, message };
}

function statusAction(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".status-msg.status-action");
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.workspace-warnings-backdrop [role="dialog"]');
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

    expect(statusAction()?.textContent?.trim()).toBe("Broken draft .Drafts/untitled-1: missing draft.md");
    const open = await openDialog();
    expect(open.querySelector(".warning-title")?.textContent).toBe("Broken draft .Drafts/untitled-1: missing draft.md");
    expect(button(open, "Copy path")).toBeDefined();
    expect(button(open, "Dismiss")).toBeDefined();
    expect(button(open, "Discard metadata")).toBeDefined();
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
  test("Copy path copies the warning's path and says so", async () => {
    warnings = [broken("untitled-5")];
    await mountApp();
    const open = await openDialog();

    button(open, "Copy path")!.click();
    await settle();

    expect(writeText).toHaveBeenCalledWith(".Drafts/untitled-5");
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

  test("Discard metadata moves the broken draft away after a confirm and re-reads the workspace", async () => {
    warnings = [broken("untitled-7")];
    await mountApp();
    const discard = vi.spyOn(api, "discardDraft").mockImplementation(async () => {
      warnings = [];
    });
    const open = await openDialog();

    button(open, "Discard metadata")!.click();
    await settle();
    expect(discard).not.toHaveBeenCalled();
    button(document, "Discard")!.click();

    await vi.waitFor(() => expect(ui.status).toBe("Discarded .Drafts/untitled-7"));
    expect(discard).toHaveBeenCalledWith(".Drafts/untitled-7");
    expect(dialog()).toBeNull();
  });

  test("offers no Discard for a warning outside the drafts folder's own entries", async () => {
    warnings = [broken("untitled-8/nested"), { kind: "other", path: ".Drafts/untitled-9", message: "odd" }];
    await mountApp();
    const open = await openDialog();

    expect(open.querySelectorAll(".warning-item")).toHaveLength(2);
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

    expect(statusAction()?.textContent?.trim()).toBe("Broken draft .Drafts/untitled-10: missing draft.md");
  });
});
