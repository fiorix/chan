// @vitest-environment jsdom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations } from "../decorations";
import {
  EXCALIDRAW_LANG,
  diagramDecorations,
  excalidrawDecorations,
  mermaidDecorations,
} from "./diagram";
import { writeClipboardPayload } from "../../api/clipboard";
import { openDiagramZoom } from "../../state/diagramZoom";
import { hybridSurfaceThemes } from "../../state/store.svelte";
import { installEditorDom, mountWysiwyg, unmountWysiwygs } from "../../__tests__/wysiwyg";

vi.mock("../../api/clipboard", () => ({
  writeClipboardPayload: vi.fn(async () => {}),
}));

vi.mock("../../state/diagramZoom", () => ({ openDiagramZoom: vi.fn() }));

// The mermaid library, standing in for the real one so a render resolves in
// jsdom with a recognisable face.
const mermaidLib = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, _source: string) => ({ svg: '<svg id="mermaid-face"></svg>' })),
}));
vi.mock("mermaid", () => ({ default: mermaidLib }));

// Excalidraw + React are heavy; mock the two libraries so mounting an
// excalidraw block in jsdom never pulls the real React runtime. The widget
// only needs the render to be an async void, so a trivial SVG suffices.
vi.mock("@excalidraw/mermaid-to-excalidraw", () => ({
  parseMermaidToExcalidraw: async () => ({ elements: [], files: {} }),
}));
const exportToSvg = vi.hoisted(() =>
  vi.fn(async (_opts: unknown) => document.createElementNS("http://www.w3.org/2000/svg", "svg")),
);
vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (els: unknown) => els,
  exportToSvg,
  restore: (scene: unknown) => scene,
}));

installEditorDom();

const MERMAID_DOC = [
  "before",
  "",
  "```mermaid",
  "pie title Pets",
  '  "Dogs" : 3',
  '  "Cats" : 2',
  "```",
  "",
  "after",
].join("\n");

const EXCALIDRAW_DOC = [
  "before",
  "",
  "```mermaid-to-excalidraw",
  "flowchart TD",
  "  A --> B",
  "```",
  "",
  "after",
].join("\n");

// An unclosed fence (still being typed): no closer ```.
const UNCLOSED = ["before", "", "```mermaid", "pie title Pets"].join("\n");

function mount(
  extension: ReturnType<typeof mermaidDecorations>,
  doc: string,
  caret?: number,
): { parent: HTMLElement; view: EditorView } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: caret !== undefined ? EditorSelection.cursor(caret) : undefined,
      // Mounting replaces the closed block with the diagram widget; the
      // renderer library is not imported until the render runs, but that is
      // an async void in the widget, so the field/decoration is jsdom-safe.
      extensions: [chanMarkdown(), extension],
    }),
  });
  // The initial parse at state creation runs under a small wall-clock budget,
  // so on a cold or loaded worker the tree - and therefore the decoration set
  // scanned from it - can be incomplete at mount. Force the parse through the
  // document before any assertion: the tests assert what the widget renders,
  // not how fast the machine parsed.
  if (!forceParsing(view, view.state.doc.length, 5000)) {
    throw new Error("parse did not complete within its budget");
  }
  return { parent, view };
}

describe("mermaid diagram cursor-render", () => {
  const deco = mermaidDecorations(() => false);

  test("cursor OUTSIDE a closed block renders the diagram widget", () => {
    const { parent, view } = mount(deco, MERMAID_DOC, 0); // caret at "before"
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeTruthy();
    expect(parent.querySelector(".cm-md-diagram-body")).toBeTruthy();
    // The block is replaced; the raw fence text is not in the DOM.
    expect(parent.textContent).not.toContain("pie title Pets");
    expect(view.state.doc.toString()).toBe(MERMAID_DOC);
    view.destroy();
    parent.remove();
  });

  test("cursor INSIDE the block suppresses the widget (source editable)", () => {
    const { parent, view } = mount(deco, MERMAID_DOC, MERMAID_DOC.indexOf("pie title"));
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeNull();
    view.destroy();
    parent.remove();
  });

  test("an unclosed (mid-typing) block never renders", () => {
    const { parent, view } = mount(deco, UNCLOSED, 0);
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeNull();
    view.destroy();
    parent.remove();
  });
});

describe("parse-progress recompute", () => {
  /// The decoration set the field currently provides, read through the
  /// public atomicRanges facet (the widget sits far below jsdom's rendered
  /// viewport in this test, so its DOM never materializes either way).
  function atomicCount(view: EditorView): number {
    return view.state
      .facet(EditorView.atomicRanges)
      .reduce((n, ranges) => n + ranges(view).size, 0);
  }

  test("a block past the initial parse frontier renders once the parse completes", () => {
    // The parse run at state creation never covers more than the first 3000
    // characters, so a fence this deep is deterministically absent from the
    // tree the decoration field first scans.
    const doc = "prose paragraph line\n".repeat(4000) + MERMAID_DOC;
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [chanMarkdown(), mermaidDecorations(() => false)],
      }),
    });
    expect(syntaxTree(view.state).length).toBeLessThan(view.state.doc.length);
    expect(atomicCount(view)).toBe(0);
    // Completing the parse dispatches an effects-only transaction (the async
    // ParseWorker's shape: no doc change, no selection). The field must
    // rescan on the new tree, or the diagram would stay raw source until the
    // next edit or caret move.
    expect(forceParsing(view, view.state.doc.length, 5000)).toBe(true);
    expect(atomicCount(view)).toBe(1);
    view.destroy();
    parent.remove();
  });
});

describe("excalidraw diagram cursor-render", () => {
  test("the trigger token is the upstream spelling", () => {
    // The request wrote `mermaid-to-excallidraw` (double l); the shipped
    // token matches the upstream library, `mermaid-to-excalidraw`.
    expect(EXCALIDRAW_LANG).toBe("mermaid-to-excalidraw");
  });

  test("a closed mermaid-to-excalidraw block renders the diagram widget", () => {
    const { parent, view } = mount(excalidrawDecorations(() => false), EXCALIDRAW_DOC, 0);
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeTruthy();
    // The block is replaced; the raw fence source is not in the DOM.
    expect(parent.textContent).not.toContain("flowchart TD");
    view.destroy();
    parent.remove();
  });

  test("a mermaid block does NOT render under the excalidraw renderer", () => {
    // Each renderer matches only its own fence language; the two decoration
    // fields never cross.
    const { parent, view } = mount(excalidrawDecorations(() => false), MERMAID_DOC, 0);
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeNull();
    view.destroy();
    parent.remove();
  });
});

describe("diagram copy affordance", () => {
  /// jsdom's Image never decodes; this stand-in fires onload as soon as a
  /// src lands, which is the browser contract the rasterizer relies on.
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;

  beforeEach(() => {
    vi.stubGlobal("Image", FakeImage);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    })) as never;
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    HTMLCanvasElement.prototype.getContext = origGetContext;
    HTMLCanvasElement.prototype.toBlob = origToBlob;
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  test("copy hides until the render succeeds, then writes a PNG payload", async () => {
    const deco = diagramDecorations({
      lang: "mermaid",
      label: "Mermaid",
      render: async () => ({ ok: true, svg: '<svg viewBox="0 0 40 20"></svg>' }),
      isDark: () => false,
    });
    const { parent, view } = mount(deco, MERMAID_DOC, 0);
    const copyBtn = parent.querySelector<HTMLButtonElement>(
      ".cm-md-diagram-copy-png",
    );
    expect(copyBtn).toBeTruthy();
    // Same gating as View: hidden until the async render lands.
    expect(copyBtn!.style.display).toBe("none");
    await vi.waitFor(() => {
      expect(copyBtn!.style.display).toBe("");
    });
    copyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(writeClipboardPayload).toHaveBeenCalledWith(
        "image/png",
        expect.any(Uint8Array),
      );
    });
    view.destroy();
    parent.remove();
  });

  test("SVG choice copies vector markup without rasterizing", async () => {
    const svg = '<svg viewBox="0 0 40 20"><text>vector</text></svg>';
    const deco = diagramDecorations({
      lang: "mermaid",
      label: "Mermaid",
      render: async () => ({ ok: true, svg }),
      isDark: () => false,
    });
    const { parent, view } = mount(deco, MERMAID_DOC, 0);
    const copyBtn = parent.querySelector<HTMLButtonElement>(
      ".cm-md-diagram-copy-svg",
    );
    await vi.waitFor(() => {
      expect(copyBtn!.style.display).toBe("");
    });
    copyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(writeClipboardPayload).toHaveBeenCalledWith(
        "text/plain;charset=utf-8",
        new TextEncoder().encode(svg),
      );
    });
    view.destroy();
    parent.remove();
  });

  test("a dark editor copies a fresh light render", async () => {
    const render = vi.fn(async (_src: string, dark: boolean) => ({
      ok: true,
      svg: `<svg viewBox="0 0 40 20" data-dark="${dark}"></svg>`,
    }));
    const deco = diagramDecorations({
      lang: "mermaid",
      label: "Mermaid",
      render,
      isDark: () => true,
    });
    const { parent, view } = mount(deco, MERMAID_DOC, 0);
    const copyBtn = parent.querySelector<HTMLButtonElement>(
      ".cm-md-diagram-copy-png",
    );
    await vi.waitFor(() => {
      expect(copyBtn!.style.display).toBe("");
    });
    copyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // The face rendered dark; the copy path re-renders light before
    // rasterizing (the dark strokes would be illegible on paste targets).
    await vi.waitFor(() => {
      expect(render).toHaveBeenCalledWith(expect.any(String), false);
      expect(writeClipboardPayload).toHaveBeenCalledTimes(1);
    });
    view.destroy();
    parent.remove();
  });

  test("a copy-specific renderer replaces the visible face before rasterizing", async () => {
    const render = vi.fn(async () => ({
      ok: true,
      svg: '<svg viewBox="0 0 40 20"><foreignObject/></svg>',
    }));
    const renderForCopy = vi.fn(async () => ({
      ok: true,
      svg: '<svg viewBox="0 0 40 20"><text>safe</text></svg>',
    }));
    const deco = diagramDecorations({
      lang: "mermaid",
      label: "Mermaid",
      render,
      renderForCopy,
      isDark: () => false,
    });
    const { parent, view } = mount(deco, MERMAID_DOC, 0);
    const copyBtn = parent.querySelector<HTMLButtonElement>(
      ".cm-md-diagram-copy-png",
    );
    await vi.waitFor(() => {
      expect(copyBtn!.style.display).toBe("");
    });
    copyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(renderForCopy).toHaveBeenCalledWith(expect.any(String), false);
      expect(writeClipboardPayload).toHaveBeenCalledTimes(1);
    });
    // Copy-only rendering must not replace the visible face.
    expect(parent.querySelector(".cm-md-diagram-body foreignObject")).toBeTruthy();
    view.destroy();
    parent.remove();
  });
});

describe("errored diagram face click-through", () => {
  // MERMAID_DOC fence: opener ```mermaid at doc line 3, source at doc
  // lines 4-6, closer ``` at line 7. CM6 maps a widget click to the
  // nearest block EDGE (opener / closer line), so the face's own mousedown
  // handler is what lands the caret on the blamed line.
  function erroring(errorLine: number, errorCol?: number) {
    return diagramDecorations({
      lang: "mermaid",
      label: "Mermaid",
      render: async () => ({
        ok: false,
        error: `Parse error on line ${errorLine}`,
        errorLine,
        errorCol,
      }),
      isDark: () => false,
    });
  }

  async function mountErrored(deco: ReturnType<typeof diagramDecorations>) {
    const mounted = mount(deco, MERMAID_DOC, 0);
    await vi.waitFor(() => {
      expect(mounted.parent.querySelector(".cm-md-diagram-error")).toBeTruthy();
    });
    return mounted;
  }

  test("mousedown on the echoed line lands the caret ON the failing line", async () => {
    const { parent, view } = await mountErrored(erroring(2));
    parent
      .querySelector(".cm-md-diagram-error-src")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // Source line 2 sits at doc line openLine + 2 = 5.
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
    // The selection is now inside the block, so the widget de-rendered and
    // the caret sits visibly on the source.
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeNull();
    view.destroy();
    parent.remove();
  });

  test("errorCol refines the caret to the blamed column", async () => {
    const { parent, view } = await mountErrored(erroring(2, 4));
    parent
      .querySelector(".cm-md-diagram-error-src")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    expect(line.number).toBe(5);
    expect(head - line.from).toBe(3); // 1-indexed column 4
    view.destroy();
    parent.remove();
  });

  test("the face leads with the renderer label and the blamed line", async () => {
    const { parent, view } = await mountErrored(erroring(2));
    const face = parent.querySelector(".cm-md-diagram-error");
    expect(face?.textContent).toContain("Mermaid error - line 2");
    view.destroy();
    parent.remove();
  });

  test("stepping into the source accents the blamed line", async () => {
    const { parent, view } = await mountErrored(erroring(2));
    parent
      .querySelector(".cm-md-diagram-error-src")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // Source line 2 is doc line 5, the first data row of the pie chart.
    const accented = parent.querySelectorAll(".cm-md-diagram-error-line");
    expect(accented).toHaveLength(1);
    expect(accented[0]!.textContent).toContain('"Dogs" : 3');
    view.destroy();
    parent.remove();
  });

  test("a blamed line past the source clamps to the last fence line", async () => {
    // Mermaid EOF errors blame a line beyond the source. No echoed row
    // renders for it, and the WHOLE face (head + reason rows) is
    // click-through, so a press anywhere still reaches the source.
    const { parent, view } = await mountErrored(erroring(99));
    expect(parent.querySelector(".cm-md-diagram-error-src")).toBeNull();
    parent
      .querySelector(".cm-md-diagram-error")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // Clamped to the last source line, doc line 6 (closer fence minus 1).
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(6);
    view.destroy();
    parent.remove();
  });
});

describe("diagram bundle composition", () => {
  // Which modules the initial chunk pulls shows in when each library is
  // evaluated: a fresh import of a renderer evaluates none of its library,
  // and its first render does.

  test("the mermaid renderer loads mermaid on its first render, not on import", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("mermaid", () => {
      loads += 1;
      return { default: mermaidLib };
    });
    const { renderMermaid } = await import("../mermaid_render");
    expect(loads).toBe(0);
    await expect(renderMermaid("pie title Pets", false)).resolves.toMatchObject({ ok: true });
    expect(loads).toBe(1);
  });

  test("the excalidraw renderer loads both of its libraries on its first render, not on import", async () => {
    vi.resetModules();
    const loads = { convert: 0, excalidraw: 0 };
    vi.doMock("@excalidraw/mermaid-to-excalidraw", () => {
      loads.convert += 1;
      return { parseMermaidToExcalidraw: async () => ({ elements: [], files: {} }) };
    });
    vi.doMock("@excalidraw/excalidraw", () => {
      loads.excalidraw += 1;
      return { convertToExcalidrawElements: (els: unknown) => els, exportToSvg, restore: (scene: unknown) => scene };
    });
    const { renderExcalidraw } = await import("../excalidraw_render");
    expect(loads).toEqual({ convert: 0, excalidraw: 0 });
    await expect(renderExcalidraw("flowchart TD\n  A --> B", false)).resolves.toMatchObject({ ok: true });
    expect(loads).toEqual({ convert: 1, excalidraw: 1 });
  });
});

describe("the generic block decorations know nothing about diagrams", () => {
  test("a mermaid fence renders as ordinary fenced code without the renderer", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: MERMAID_DOC,
        selection: EditorSelection.cursor(0),
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });
    forceParsing(view, view.state.doc.length, 5000);
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeNull();
    expect(parent.textContent).toContain("pie title Pets");
    view.destroy();
    parent.remove();
  });

  test("an excalidraw fence renders as ordinary fenced code too", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: EXCALIDRAW_DOC,
        selection: EditorSelection.cursor(0),
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });
    forceParsing(view, view.state.doc.length, 5000);
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeNull();
    expect(parent.textContent).toContain("flowchart TD");
    view.destroy();
    parent.remove();
  });
});

describe("the View affordance", () => {
  const LIGHT = '<svg id="light"></svg>';
  const DARK = '<svg id="dark"></svg>';

  function viewer(dark: boolean): {
    deco: ReturnType<typeof diagramDecorations>;
    render: ReturnType<typeof vi.fn>;
    onView: ReturnType<typeof vi.fn>;
  } {
    const render = vi.fn(async (_source: string, isDark: boolean) => ({
      ok: true as const,
      svg: isDark ? DARK : LIGHT,
    }));
    const onView = vi.fn();
    return {
      deco: diagramDecorations({
        lang: "mermaid",
        label: "Mermaid",
        render,
        isDark: () => dark,
        onView,
      }),
      render,
      onView,
    };
  }

  /// The View button, distinguished from the copy buttons that share its
  /// class.
  function viewButton(parent: HTMLElement): HTMLButtonElement {
    const btn = parent.querySelector<HTMLButtonElement>(
      ".cm-md-diagram-view:not(.cm-md-diagram-copy)",
    );
    expect(btn).toBeTruthy();
    return btn!;
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("hides until the render lands, then opens the viewer on the cached face", async () => {
    const { deco, render, onView } = viewer(false);
    const { parent, view } = mount(deco, MERMAID_DOC, 0);
    const btn = viewButton(parent);
    expect(btn.style.display).toBe("none");
    await vi.waitFor(() => {
      expect(btn.style.display).toBe("");
    });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onView).toHaveBeenCalledWith(LIGHT);
    expect(render).toHaveBeenCalledTimes(1);
    view.destroy();
    parent.remove();
  });

  test("a dark editor re-renders light for the viewer's light panel", async () => {
    const { deco, render, onView } = viewer(true);
    const { parent, view } = mount(deco, MERMAID_DOC, 0);
    const btn = viewButton(parent);
    await vi.waitFor(() => {
      expect(btn.style.display).toBe("");
    });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(onView).toHaveBeenCalledWith(LIGHT);
    });
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith(expect.any(String), false);
    view.destroy();
    parent.remove();
  });

  test("no View button when the editor wires no viewer", () => {
    const deco = diagramDecorations({
      lang: "mermaid",
      label: "Mermaid",
      render: async () => ({ ok: true as const, svg: LIGHT }),
      isDark: () => false,
    });
    const { parent, view } = mount(deco, MERMAID_DOC, 0);
    expect(
      parent.querySelector(".cm-md-diagram-view:not(.cm-md-diagram-copy)"),
    ).toBeNull();
    view.destroy();
    parent.remove();
  });

  test("the actions row carries the buttons the editor styles", async () => {
    const { deco } = viewer(false);
    const { parent, view } = mount(deco, MERMAID_DOC, 0);
    const actions = parent.querySelector(".cm-md-diagram-actions");
    expect(actions).toBeTruthy();
    expect(actions!.querySelector(".cm-md-diagram-copy-svg")).toBeTruthy();
    expect(actions!.querySelector(".cm-md-diagram-copy-png")).toBeTruthy();
    view.destroy();
    parent.remove();
  });
});

describe("vertical caret entry", () => {
  // jsdom has no layout, so each test decides where CodeMirror's vertical
  // motion would land; a move that crosses a rendered block past it is the
  // case the keymap redirects.
  const FROM = MERMAID_DOC.indexOf("```mermaid");
  const TO = MERMAID_DOC.indexOf("```\n\nafter") + 3;

  function rendered(): { parent: HTMLElement; view: EditorView } {
    const deco = diagramDecorations({
      lang: "mermaid",
      label: "Mermaid",
      render: async () => ({ ok: true as const, svg: "<svg></svg>" }),
      isDark: () => false,
    });
    return mount(deco, MERMAID_DOC, 0);
  }

  function press(view: EditorView, key: string): void {
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  test("ArrowDown that would step over a rendered block lands on its first line, showing the source", () => {
    const { parent, view } = rendered();
    view.dispatch({ selection: EditorSelection.cursor(FROM - 1) });
    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(MERMAID_DOC.indexOf("after")));
    press(view, "ArrowDown");
    expect(view.state.selection.main.head).toBe(FROM);
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeNull();
    view.destroy();
  });

  test("ArrowUp that would step over it from below lands on its last line", () => {
    const { parent, view } = rendered();
    view.dispatch({ selection: EditorSelection.cursor(MERMAID_DOC.indexOf("after")) });
    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(0));
    press(view, "ArrowUp");
    expect(view.state.selection.main.head).toBe(TO);
    expect(parent.querySelector(".cm-md-diagram-rendered")).toBeNull();
    view.destroy();
  });

  test("a vertical move that stays clear of the block leaves it rendered", () => {
    const { parent, view } = rendered();
    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(FROM - 1));
    press(view, "ArrowDown");
    expect(view.state.selection.main.head).not.toBe(FROM);
    expect(parent.querySelector(".cm-md-diagram-rendered")).not.toBeNull();
    view.destroy();
  });
});

describe("the reverse flip", () => {
  // A caret entering a rendered block drops the widget at once, so the face
  // is rebuilt from its cached render as a ghost and folded away. jsdom has
  // neither layout nor the Web Animations API; the block's coordinates and
  // animate() are stubbed, and animate() keeps the ghost until released.
  const FACE = '<svg id="cached-face"></svg>';
  const INSIDE = MERMAID_DOC.indexOf("pie title");
  let animations: Array<{ ghost: Element; keyframes: Keyframe[]; finish: () => void }>;

  beforeEach(() => {
    animations = [];
    (Element.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: Keyframe[]) {
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      animations.push({ ghost: this, keyframes, finish });
      return { finished };
    };
  });

  afterEach(() => {
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  async function renderedWithFace(render = async () => ({ ok: true as const, svg: FACE })) {
    const deco = diagramDecorations({ lang: "mermaid", label: "Mermaid", render, isDark: () => false });
    const mounted = mount(deco, MERMAID_DOC, 0);
    vi.spyOn(mounted.view, "coordsAtPos").mockReturnValue({ left: 0, right: 0, top: 30, bottom: 50 });
    return mounted;
  }

  test("entering a rendered block ghosts its cached face and folds it out", async () => {
    const { parent, view } = await renderedWithFace();
    await vi.waitFor(() => expect(parent.innerHTML).toContain("cached-face"));

    view.dispatch({ selection: EditorSelection.cursor(INSIDE) });
    await vi.waitFor(() => expect(animations).toHaveLength(1));
    const [flip] = animations;
    expect(flip!.ghost.classList.contains("cm-md-diagram-ghost")).toBe(true);
    expect(flip!.ghost.innerHTML).toContain("cached-face");
    expect(flip!.ghost.isConnected).toBe(true);
    expect(flip!.keyframes.map((k) => k.transform)).toEqual([
      "perspective(1200px) rotateX(0deg)",
      "perspective(1200px) rotateX(90deg)",
    ]);

    flip!.finish();
    await vi.waitFor(() => expect(flip!.ghost.isConnected).toBe(false));
    view.destroy();
  });

  test("an edit that lands the caret inside does not flip", async () => {
    const { parent, view } = await renderedWithFace();
    await vi.waitFor(() => expect(parent.innerHTML).toContain("cached-face"));

    view.dispatch({ changes: { from: INSIDE, insert: " " }, selection: EditorSelection.cursor(INSIDE + 1) });
    await new Promise((r) => setTimeout(r, 50));
    expect(animations).toHaveLength(0);
    view.destroy();
  });

  test("entering before the first render lands has no face to flip", async () => {
    const { view } = await renderedWithFace(() => new Promise(() => {}));
    view.dispatch({ selection: EditorSelection.cursor(INSIDE) });
    await new Promise((r) => setTimeout(r, 50));
    expect(animations).toHaveLength(0);
    view.destroy();
  });
});

describe("in the Wysiwyg editor", () => {
  afterEach(() => {
    unmountWysiwygs();
    delete hybridSurfaceThemes.editor;
    document.body.innerHTML = "";
  });

  test("both kinds of block render in the editor surface's theme", async () => {
    hybridSurfaceThemes.editor = "dark";
    mermaidLib.initialize.mockClear();
    exportToSvg.mockClear();
    const { content } = await mountWysiwyg({ value: `${MERMAID_DOC}\n\n${EXCALIDRAW_DOC}` });

    await vi.waitFor(() => expect(content.querySelectorAll(".cm-md-diagram-rendered")).toHaveLength(2));
    await vi.waitFor(() => expect(exportToSvg).toHaveBeenCalled());
    expect(mermaidLib.initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(exportToSvg).toHaveBeenCalledWith(
      expect.objectContaining({ appState: expect.objectContaining({ exportWithDarkMode: true }) }),
    );
  });

  test("View opens the pan and zoom viewer on the diagram", async () => {
    vi.mocked(openDiagramZoom).mockClear();
    const { content } = await mountWysiwyg({ value: MERMAID_DOC });
    const view = await vi.waitFor(() => {
      const btn = content.querySelector<HTMLButtonElement>(".cm-md-diagram-view:not(.cm-md-diagram-copy)");
      expect(btn?.style.display).toBe("");
      return btn!;
    });
    view.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(openDiagramZoom).toHaveBeenCalledWith('<svg id="mermaid-face"></svg>'));
  });
});
