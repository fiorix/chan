// @vitest-environment jsdom
//
// What the Files tree's selection means to its gestures. Delete, from the key,
// the row's menu or the command, removes every selected row behind one
// confirm that names the count; a row under a selected folder goes with the
// folder; a refused delete leaves the rest deleted, says how many went and
// keeps the failed rows selected. A right-click outside the selection, like a
// drag, acts on that row alone. Expanding or collapsing a folder leaves the
// selection as it was.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { api } from "../api/client";
import { ApiError } from "../api/errors";
import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout } from "../__tests__/tabs";
import { allCommands, commandContext } from "../state/commands";
import { browserSelection, fbSelectSet, fbSelectSingle, ui } from "../state/store.svelte";
import { openBrowserInActivePane } from "../state/tabs.svelte";

stubAppEnvironment();

const FILES = ["a.md", "b.md", "c.md", "d.md", "docs/x.md", "docs/y.md"];

beforeEach(async () => {
  await mountApp(
    demoData(FILES.map((path) => ({ path, kind: "document" as const, size: 5, mtime: 100, content: "hello" }))),
  );
  resetLayout([]);
  openBrowserInActivePane();
  await settle();
  await vi.waitFor(() => expect(row("a.md")).toBeDefined());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await unmountApp();
});

function row(path: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) => {
    const title = el.title.replace(/ \(.*\)$/, "");
    return title === path || title.endsWith(`/${path}`);
  });
}

async function menuFor(path: string): Promise<HTMLElement> {
  row(path)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await settle();
  return document.querySelector<HTMLElement>(".ctx")!;
}

function menuItem(menu: HTMLElement, label: string): HTMLButtonElement {
  return [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => (button.querySelector(".menu-row-label") ?? button.querySelector("span"))?.textContent?.trim() === label,
  )!;
}

async function pressDelete(): Promise<void> {
  document
    .querySelector<HTMLElement>('[role="tree"]')!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
  await settle();
}

/// The open confirm's message, once it is up.
async function confirmMessage(): Promise<string> {
  await vi.waitFor(() => expect(document.querySelector(".actions button.ok")).not.toBeNull());
  return document.querySelector(".message")?.textContent?.trim() ?? "";
}

async function confirm(): Promise<void> {
  document.querySelector<HTMLButtonElement>(".actions button.ok")!.click();
  await settle();
}

async function exists(path: string): Promise<boolean> {
  return api.read(path).then(
    () => true,
    () => false,
  );
}

async function gone(...paths: string[]): Promise<void> {
  await vi.waitFor(async () => {
    for (const path of paths) expect(await exists(path), path).toBe(false);
  });
}

describe("Delete on a multi-selection", () => {
  test("the Delete key deletes every selected row behind one confirm naming the count", async () => {
    fbSelectSet(["a.md", "b.md", "c.md"], "b.md");
    await pressDelete();

    expect(await confirmMessage()).toBe("Delete 3 files?");
    await confirm();

    await gone("a.md", "b.md", "c.md");
    expect(await exists("d.md")).toBe(true);
    expect(browserSelection.paths).toEqual([]);
  });

  test("the menu's Delete on a selected row deletes the selection", async () => {
    fbSelectSet(["a.md", "b.md", "c.md"], "b.md");
    menuItem(await menuFor("c.md"), "Delete").click();
    await settle();

    expect(await confirmMessage()).toBe("Delete 3 files?");
    await confirm();

    await gone("a.md", "b.md", "c.md");
    expect(await exists("d.md")).toBe(true);
  });

  test("the Delete command deletes the selection", async () => {
    fbSelectSet(["a.md", "b.md", "c.md"], "b.md");
    const command = allCommands().find((c) => c.id === "app.browser.deleteSelection")!;
    expect(command.available(commandContext())).toBe(true);
    command.run();
    await settle();

    expect(await confirmMessage()).toBe("Delete 3 files?");
    await confirm();

    await gone("a.md", "b.md", "c.md");
    expect(await exists("d.md")).toBe(true);
  });

  test("a refused delete leaves the rest deleted, says how many went and keeps its row selected", async () => {
    const remove = api.remove;
    vi.spyOn(api, "remove").mockImplementation((path: string) =>
      path === "b.md" ? Promise.reject(new Error("permission denied")) : remove(path),
    );
    fbSelectSet(["a.md", "b.md", "c.md"], "c.md");
    await pressDelete();
    await confirmMessage();
    await confirm();

    await gone("a.md", "c.md");
    await vi.waitFor(() => expect(ui.status).toBe("deleted 2 of 3; b.md: permission denied"));
    expect(await exists("b.md")).toBe(true);
    expect(browserSelection.paths).toEqual(["b.md"]);
  });

  test("a row under a selected folder goes with the folder, once", async () => {
    const remove = vi.spyOn(api, "remove");
    // The status line is module state another test may have written.
    ui.status = null;
    fbSelectSet(["docs", "docs/x.md", "a.md"], "a.md");
    await pressDelete();

    expect(await confirmMessage()).toBe("Delete 2 items, including 1 directory and everything in it?");
    await confirm();

    await gone("a.md", "docs/x.md", "docs/y.md");
    expect(remove.mock.calls.map(([path]) => path).sort()).toEqual(["a.md", "docs"]);
    expect(ui.status).toBeNull();
  });

  test("a selection that folds to one folder is cleared once the folder goes", async () => {
    row("docs")!.querySelector<HTMLButtonElement>("button.twirl")!.click();
    await vi.waitFor(() => expect(row("docs/y.md")).toBeDefined());
    fbSelectSet(["docs", "docs/x.md", "docs/y.md"], "docs");
    await pressDelete();

    expect(await confirmMessage()).toBe('Delete directory "docs" and its 2 items?');
    await confirm();

    await gone("docs/x.md", "docs/y.md");
    await vi.waitFor(() => expect(browserSelection.paths).toEqual([]));
    expect(browserSelection.path).toBeNull();
  });

  test("a path already gone when its delete is sent leaves the selection", async () => {
    const remove = api.remove;
    vi.spyOn(api, "remove").mockImplementation((path: string) =>
      path === "b.md" ? Promise.reject(new ApiError(404, "not found")) : remove(path),
    );
    fbSelectSet(["a.md", "b.md", "c.md"], "c.md");
    await pressDelete();
    await confirmMessage();
    await confirm();

    await gone("a.md", "c.md");
    await vi.waitFor(() => expect(ui.status).toBe("deleted 2 of 3; b.md: not found"));
    expect(browserSelection.paths).toEqual([]);
  });
});

describe("Delete on one row", () => {
  test("a single selected row keeps the confirm that names it", async () => {
    fbSelectSingle("a.md");
    await pressDelete();

    expect(await confirmMessage()).toBe('Delete "a.md"?');
    await confirm();

    await gone("a.md");
    expect(await exists("b.md")).toBe(true);
  });

  test("a right-click outside the selection deletes that row alone", async () => {
    fbSelectSet(["a.md", "b.md"], "b.md");
    menuItem(await menuFor("d.md"), "Delete").click();
    await settle();

    expect(await confirmMessage()).toBe('Delete "d.md"?');
    await confirm();

    await gone("d.md");
    expect(await exists("a.md")).toBe(true);
    expect(await exists("b.md")).toBe(true);
  });
});

describe("the expand chevron", () => {
  test("expanding a folder keeps the selection", async () => {
    fbSelectSet(["a.md", "b.md"], "b.md");
    const twirl = row("docs")!.querySelector<HTMLButtonElement>("button.twirl")!;
    twirl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    twirl.click();
    await settle();

    await vi.waitFor(() => expect(row("docs/x.md")).toBeDefined());
    expect(browserSelection.paths).toEqual(["a.md", "b.md"]);
  });
});
