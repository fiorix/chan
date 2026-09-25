// @vitest-environment jsdom
//
// Reloading the window goes through `reloadWindow()` from every surface: the
// chord (Cmd+R on macOS, Ctrl+Shift+R elsewhere, so a plain Ctrl+R stays with
// the shell's reverse search), the host's `app.window.reload` command, and the
// pane menu's Reload row, which shows the chord the user's OS resolves. A
// reload restores the layout the app last saved, so the save must also follow
// a pane's visible side and theme, which live on the pane rather than a tab,
// and a document's slide preview: whether it is open, on which slide, and
// whether it is playing.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

vi.mock("./api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/desktop")>()),
  reloadWindow: vi.fn(async () => {}),
}));

vi.mock("./state/store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/store.svelte")>()),
  schedulePersistStateToHash: vi.fn(),
  scheduleSessionSave: vi.fn(),
}));

import { reloadWindow } from "./api/desktop";
import { hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { renderTable } from "./state/shortcuts";
import { schedulePersistStateToHash, scheduleSessionSave } from "./state/store.svelte";
import { flipHybrid, type FileTab, type LeafNode, type SlidePreviewTabState } from "./state/tabs.svelte";

stubAppEnvironment();

let pane: LeafNode;

beforeEach(async () => {
  await mountApp();
  pane = resetLayout([fileTab({ id: "a-file", path: "README.md", content: "hello", saved: "hello" })]);
  await settle();
  vi.clearAllMocks();
});

afterEach(async () => {
  await unmountApp();
  vi.restoreAllMocks();
});

describe("the reload chord", () => {
  test("is Ctrl+Shift+R off macOS, leaving plain Ctrl+R to the shell", async () => {
    press({ key: "r", code: "KeyR", ctrlKey: true });
    await settle();
    expect(reloadWindow).not.toHaveBeenCalled();

    press({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true });
    await settle();
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  });

  test("is Cmd+R on macOS", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36",
    );
    press({ key: "r", code: "KeyR", metaKey: true });
    await settle();
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  });

  test("reads that way in the shortcut table", () => {
    expect(renderTable("web", "linux")).toMatch(
      /^Reload window +Ctrl\+Shift\+R +\(Ctrl\+Shift\+R on Linux \/ Windows\)$/m,
    );
    expect(renderTable("native", "mac")).toMatch(/^Reload window +Cmd\+R /m);
  });
});

describe("the other ways to reload", () => {
  test("the host's reload command", async () => {
    hostCommand("app.window.reload");
    await settle();
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  });

  test("the pane's right-click menu Reload row, labelled with the chord", async () => {
    document
      .querySelector<HTMLElement>('[role="tablist"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await settle();
    const row = [...document.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")].find(
      (button) => button.querySelector(".menu-row-label")?.textContent === "Reload",
    );
    expect(row?.querySelector(".menu-row-chord")?.textContent).toBe("Ctrl+Shift+R");

    row!.click();
    await settle();
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  });
});

describe("what a reload restores", () => {
  test("a bare side flip is saved", async () => {
    flipHybrid(pane.id);
    await settle();
    expect(schedulePersistStateToHash).toHaveBeenCalled();
    expect(scheduleSessionSave).toHaveBeenCalled();
  });

  test("a pane theme change is saved", async () => {
    pane.theme = "light";
    await settle();
    expect(schedulePersistStateToHash).toHaveBeenCalled();
    expect(scheduleSessionSave).toHaveBeenCalled();
  });

  test.each([
    ["opening", (preview: SlidePreviewTabState) => (preview.open = true)],
    ["turning to another slide", (preview: SlidePreviewTabState) => (preview.index = 2)],
    ["starting to play", (preview: SlidePreviewTabState) => (preview.mode = "play")],
  ])("a slide preview's %s is saved", async (_change, change) => {
    pane = resetLayout([
      fileTab({
        id: "deck",
        path: "deck.md",
        content: "hello",
        saved: "hello",
        slidePreview: { open: false, index: 0, mode: "preview" },
      }),
    ]);
    await settle();
    vi.clearAllMocks();

    change((pane.tabs[0] as FileTab).slidePreview!);
    await settle();

    expect(schedulePersistStateToHash).toHaveBeenCalled();
    expect(scheduleSessionSave).toHaveBeenCalled();
  });
});
