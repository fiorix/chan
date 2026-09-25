// @vitest-environment jsdom
//
// The Rich Prompt composer floats over a terminal, so its editor themes on
// the terminal surface of a split light/dark hybrid theme, not the editor
// surface a file tab uses. RichPrompt is mounted with its draft api stubbed;
// the assertions read which syntax palette each editor's state carries.

import { highlightingFor } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      createDraft: vi.fn(async () => ({ path: ".Drafts/t/draft.md" })),
      read: vi.fn(async () => ({ content: "" })),
      write: vi.fn(async () => ({})),
    },
  };
});

import RichPrompt from "./RichPrompt.svelte";
import { githubDarkHighlight, githubLightHighlight } from "../editor/highlight";
import { hybridSurfaceThemes, ui } from "../state/store.svelte";
import type { TerminalTab } from "../state/tabs.svelte";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../__tests__/wysiwyg";

installEditorDom();

const mounted: Array<Record<string, unknown>> = [];
const startTheme = ui.theme;

beforeEach(() => {
  ui.theme = "light";
  hybridSurfaceThemes.terminal = "dark";
  delete hybridSurfaceThemes.editor;
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  unmountWysiwygs();
  document.body.innerHTML = "";
  delete hybridSurfaceThemes.terminal;
  ui.theme = startTheme;
});

/// Which of the two syntax palettes the editor's state highlights with.
function palette(view: EditorView): "dark" | "light" | null {
  const classes = highlightingFor(view.state, [tags.keyword]) ?? "";
  if (classes.includes(githubDarkHighlight.style([tags.keyword])!)) return "dark";
  if (classes.includes(githubLightHighlight.style([tags.keyword])!)) return "light";
  return null;
}

async function mountComposer(): Promise<EditorView> {
  const tab = {
    kind: "terminal",
    id: "term-1",
    title: "t",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    richPromptDraftPath: ".Drafts/t/draft.md",
  } as TerminalTab;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(RichPrompt, { target, props: { tab } }) as Record<string, unknown>);
  for (let i = 0; i < 20 && !target.querySelector(".cm-content"); i += 1) {
    await tick();
    await Promise.resolve();
  }
  return EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-content")!)!;
}

describe("the Rich Prompt composer", () => {
  test("takes the terminal surface's theme and follows it", async () => {
    const view = await mountComposer();
    expect(palette(view)).toBe("dark");

    hybridSurfaceThemes.terminal = "light";
    await settle();
    expect(palette(view)).toBe("light");
  });

  test("differs from a file editor, which keeps the editor surface's theme", async () => {
    const composer = await mountComposer();
    const { view: fileEditor } = await mountWysiwyg({ value: "" });
    expect(palette(composer)).toBe("dark");
    expect(palette(fileEditor)).toBe("light");
  });
});
