// @vitest-environment jsdom
//
// The source and rich-text editors follow a light/dark switch by
// reconfiguring their theme compartment (base.ts), and the rich-text editor's
// diagram and image faces redraw on that reconfiguration. Each test switches a
// mounted editor twice and compares what it paints with a fresh mount in the
// same theme: the computed colours of every element (CodeMirror injects its
// theme and highlight rules as a stylesheet jsdom applies; the app's own CSS
// is not loaded, so token colours read as their var() text, which no theme
// changes) and every rendered face, which the stand-in renderers stamp with
// the theme they drew in. Every paint is taken from a finished parse, since
// the highlighter colours only what the parse has reached.

import { forceParsing, syntaxTreeAvailable } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import Source from "./Source.svelte";
import { installEditorDom, mountWysiwyg, unmountWysiwygs } from "../__tests__/wysiwyg";
import { ui } from "../state/store.svelte";

// The mermaid library, standing in for the real one: each face names the
// theme the last initialize asked for, as mermaid draws in it.
const mermaidLib = vi.hoisted(() => {
  let theme = "unset";
  return {
    initialize: vi.fn((opts: { theme?: string }) => {
      theme = opts.theme ?? "unset";
    }),
    render: vi.fn(async () => ({ svg: `<svg class="face-mermaid" data-drawn="${theme}"></svg>` })),
  };
});
vi.mock("mermaid", () => ({ default: mermaidLib }));

// Excalidraw, standing in for the export the image embed draws with: the face
// names the palette the export was asked for.
vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (els: unknown) => els,
  restore: (scene: unknown) => scene,
  exportToSvg: async (opts: { appState: { exportWithDarkMode: boolean } }) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "face-excalidraw");
    svg.setAttribute("data-drawn", opts.appState.exportWithDarkMode ? "dark" : "light");
    return svg;
  },
}));

installEditorDom();

const BOARD = JSON.stringify({
  type: "excalidraw",
  elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 40, height: 20, isDeleted: false }],
  appState: {},
  files: {},
});

/// A rich-text document with a code block the highlighter colours, a Mermaid
/// diagram, a raster image and an Excalidraw board embedded as an image.
const RICH_DOC = [
  "# Theme switch",
  "",
  "```js",
  'const answer = 42; // "comment"',
  "```",
  "",
  "```mermaid",
  "pie title Pets",
  '  "Dogs" : 3',
  "```",
  "",
  "![photo](photo.png)",
  "",
  "![board](board.excalidraw)",
  "",
  "after",
].join("\n");

const SOURCE_DOC = 'const answer = 42; // a comment\nfunction greet(name) { return "hi " + name; }\n';

type Theme = "light" | "dark";
const startTheme = ui.theme;
const realFetch = globalThis.fetch;

/// The bound on every wait for a precondition: a language's first dynamic
/// import in a cold worker, a face's render or a finished parse can take
/// seconds on a loaded machine, past vi.waitFor's default of one second.
const PRECONDITION = { timeout: 10_000 };

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("board.excalidraw")) return new Response(BOARD, { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  unmountWysiwygs();
  for (const c of sources.splice(0)) unmount(c);
  document.body.innerHTML = "";
  ui.theme = startTheme;
  globalThis.fetch = realFetch;
});

async function switchTo(theme: Theme): Promise<void> {
  ui.theme = theme;
  document.documentElement.dataset.theme = theme;
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// Finish the parse of the editor in `target`, and wait until its tree covers
/// the whole document. CodeMirror parses in slices bounded by wall-clock time
/// (20 ms when a language arrives, then a slice per idle callback), so on a
/// loaded machine an editor can paint from a tree that stops short of where
/// another editor's reached, and the tokens past that point are coloured
/// differently. A fence whose language is still loading stays unparsed until
/// it arrives, so the parse is retried until the tree is whole.
async function parsed(target: HTMLElement): Promise<void> {
  const dom = target.querySelector<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("no editor view");
  await vi.waitFor(
    () => {
      forceParsing(view, view.state.doc.length, 1_000);
      expect(syntaxTreeAvailable(view.state), "the whole document parsed").toBe(true);
    },
    PRECONDITION,
  );
  await settle();
}

/// What an editor paints, one line per element: its tag, its classes (less
/// CodeMirror's generated `ͼ` classes, which a new theme object renames
/// without changing its rules), its computed colours, a leaf's text and a
/// face's markup.
function paint(target: HTMLElement): string[] {
  const editor = target.querySelector<HTMLElement>(".cm-editor");
  if (!editor) throw new Error("no editor");
  const rows: string[] = [];
  for (const el of [editor, ...editor.querySelectorAll<Element>("*")]) {
    const tag = el.tagName.toLowerCase();
    if (tag !== "svg" && el.closest("svg")) continue;
    const s = getComputedStyle(el);
    const classes = [...el.classList].filter((c) => !c.startsWith("ͼ")).join(".");
    const text = el.children.length === 0 ? (el.textContent ?? "") : "";
    const face = tag === "svg" ? el.outerHTML : "";
    rows.push(
      `${tag}.${classes} color=${s.color} bg=${s.backgroundColor} caret=${s.caretColor} cursor=${s.borderLeftColor} font=${s.fontStyle}/${s.fontWeight} ${JSON.stringify(text)} ${face}`,
    );
  }
  return rows;
}

/// The colour of the first span whose text is `token`: the highlighter's
/// reading of that token.
function tokenColour(target: HTMLElement, token: string): string {
  const span = [...target.querySelectorAll<HTMLElement>(".cm-line span")].find((el) => el.textContent === token);
  return span ? getComputedStyle(span).color : "missing";
}

const KEYWORD = { light: "rgb(207, 34, 46)", dark: "rgb(255, 123, 114)" } as const;

const sources: Array<Record<string, unknown>> = [];

async function mountSource(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  sources.push(mount(Source, { target, props: { value: SOURCE_DOC, path: "greet.js", autoFocus: false } }));
  // The language loads lazily; the keyword is highlighted once it has.
  await vi.waitFor(() => expect(tokenColour(target, "const")).not.toBe("missing"), PRECONDITION);
  await parsed(target);
  return target;
}

async function mountRich(): Promise<HTMLElement> {
  const { target } = await mountWysiwyg({ value: RICH_DOC, autoFocus: false });
  await vi.waitFor(() => {
    // The fence's language loads lazily; its keyword is highlighted once it has.
    expect(tokenColour(target, "const")).not.toBe("missing");
    expect(target.querySelector("svg.face-mermaid")).not.toBeNull();
    expect(target.querySelector("svg.face-excalidraw")).not.toBeNull();
    expect(target.querySelector("img")).not.toBeNull();
  }, PRECONDITION);
  await parsed(target);
  return target;
}

/// A fresh mount's paint in the current theme, the mount removed after.
async function freshPaint(mountOne: () => Promise<HTMLElement>, drawn: Theme): Promise<string[]> {
  const target = await mountOne();
  await waitForFaces(target, drawn);
  const rows = paint(target);
  target.remove();
  return rows;
}

/// Wait until every face in `target` is drawn in `theme` (mermaid's own
/// names are "default" and "dark").
async function waitForFaces(target: HTMLElement, theme: Theme): Promise<void> {
  const mermaid = theme === "dark" ? "dark" : "default";
  await vi.waitFor(() => {
    for (const face of target.querySelectorAll("svg.face-mermaid")) expect(face.getAttribute("data-drawn"), "the Mermaid face").toBe(mermaid);
    for (const face of target.querySelectorAll("svg.face-excalidraw")) expect(face.getAttribute("data-drawn"), "the Excalidraw embed's face").toBe(theme);
  }, PRECONDITION);
  await settle();
}

describe.each([
  { name: "the source editor", mountOne: mountSource, faces: false },
  { name: "the rich-text editor with a diagram and images", mountOne: mountRich, faces: true },
])("$name switched twice", ({ mountOne, faces }) => {
  test.each([
    { order: ["light", "dark", "light"] as Theme[] },
    { order: ["dark", "light", "dark"] as Theme[] },
  ])("$order ends in a fresh mount's colours at each step", async ({ order }) => {
    const [first, ...rest] = order as [Theme, ...Theme[]];
    await switchTo(first);
    const target = await mountOne();
    if (faces) await waitForFaces(target, first);
    expect(tokenColour(target, "const"), `keyword in ${first}`).toBe(KEYWORD[first]);
    const mountedIn = { [first]: paint(target) } as Record<Theme, string[]>;

    for (const theme of rest) {
      await switchTo(theme);
      if (faces) await waitForFaces(target, theme);
      expect(tokenColour(target, "const"), `keyword after the switch to ${theme}`).toBe(KEYWORD[theme]);
      const live = paint(target);
      const fresh = await freshPaint(mountOne, theme);
      expect(live, `after the switch to ${theme}`).toEqual(fresh);
      if (mountedIn[theme]) expect(live, `back in ${theme}`).toEqual(mountedIn[theme]);
      mountedIn[theme] = live;
    }
    expect(mountedIn.light, "light and dark paint differently").not.toEqual(mountedIn.dark);
  });
});
