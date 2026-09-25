// @vitest-environment jsdom
//
// Show Source Code flips the active file tab between its rendered view and
// its source: Ctrl+E (Cmd+E on macOS), or the app.editor.toggleMode command.
// A markdown file keeps its caret across the flip, remapped between rendered
// and source offsets; a file with no rendered view stays in source, and a
// tab that is not a file is left alone. The chord stays inside a focused
// terminal, where Ctrl+E is readline's end-of-line, and the editor's tab menu
// does not repeat the command.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinks);

import { hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, readTab, resetLayout, terminalTab } from "./__tests__/tabs";
import { renderedCaretForSourceCaret, sourceCaretForRenderedCaret } from "./editor/caret_mapping";
import { SHORTCUTS, shouldEscapeTerminal } from "./state/shortcuts";
import { openTabMenu, closeTabMenu } from "./state/tabMenu.svelte";
import { layout, type LeafNode } from "./state/tabs.svelte";

stubAppEnvironment();

const DOC = "# Title\n\nsome **bold** text";
const CTRL_E = { key: "e", code: "KeyE", ctrlKey: true } as const;

beforeEach(async () => {
  await mountApp();
});

afterEach(async () => {
  closeTabMenu();
  vi.restoreAllMocks();
  await unmountApp();
});

async function seedDoc(mode: "wysiwyg" | "source", caret = { from: 12, to: 12 }): Promise<void> {
  resetLayout([fileTab({ id: "doc", path: "notes/a.md", content: DOC, saved: DOC, mode, caret })]);
  await settle();
}

describe("Show Source Code", () => {
  test("Ctrl+E flips a document to source with its caret remapped, and back", async () => {
    await seedDoc("wysiwyg");
    const rendered = { ...readTab("doc")!.caret! };

    press(CTRL_E);
    expect(readTab("doc")!.mode).toBe("source");
    expect(readTab("doc")!.caret).toEqual(sourceCaretForRenderedCaret(DOC, rendered));

    const source = { ...readTab("doc")!.caret! };
    press(CTRL_E);
    expect(readTab("doc")!.mode).toBe("wysiwyg");
    expect(readTab("doc")!.caret).toEqual(renderedCaretForSourceCaret(DOC, source));
  });

  test("Cmd+E flips it on macOS", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36",
    );
    await seedDoc("wysiwyg");

    press({ key: "e", code: "KeyE", metaKey: true });

    expect(readTab("doc")!.mode).toBe("source");
  });

  test("the host's toggle command flips it the same way", async () => {
    await seedDoc("source");

    hostCommand("app.editor.toggleMode");
    await settle();

    expect(readTab("doc")!.mode).toBe("wysiwyg");
  });

  test("leaves a file with no rendered view in source", async () => {
    resetLayout([
      fileTab({ id: "code", path: "src/main.rs", fileKind: "text", content: "fn main() {}", saved: "fn main() {}", mode: "source" }),
    ]);
    await settle();

    press(CTRL_E);

    expect(readTab("code")!.mode).toBe("source");
  });

  test("leaves a terminal tab alone", async () => {
    resetLayout([terminalTab({ id: "term" })]);
    await settle();

    press(CTRL_E);

    expect((layout.nodes["pane-test"] as LeafNode).tabs).toMatchObject([{ id: "term", kind: "terminal" }]);
  });
});

describe("the chord", () => {
  test("is Mod+E in the Editor group of the shortcut table", () => {
    expect(SHORTCUTS.find((shortcut) => shortcut.id === "app.editor.toggleMode")).toMatchObject({
      label: "Show Source Code (toggle rendered/source)",
      web: "Mod+E",
      native: "Mod+E",
      group: "Editor",
    });
  });

  test("stays inside a focused terminal", () => {
    expect(shouldEscapeTerminal(new KeyboardEvent("keydown", CTRL_E))).toBe(false);
  });

  test("is not repeated in the editor's tab menu", async () => {
    await seedDoc("wysiwyg");

    openTabMenu("doc", { left: 0, top: 0, right: 0, bottom: 0 });
    await settle();

    const menu = document.querySelector('[aria-label="tab menu"]')!;
    expect(menu).not.toBeNull();
    expect(menu.textContent).not.toContain("Show Source Code");
  });
});
