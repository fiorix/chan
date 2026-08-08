// @vitest-environment jsdom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import {
  EXCALIDRAW_LANG,
  diagramDecorations,
  excalidrawDecorations,
  mermaidDecorations,
} from "./diagram";
import { writeClipboardPayload } from "../../api/clipboard";
import diagramSrc from "./diagram.ts?raw";
import diagramCopySrc from "./diagram_copy.ts?raw";
import mermaidRenderSrc from "../mermaid_render.ts?raw";
import excalidrawRenderSrc from "../excalidraw_render.ts?raw";
import blocksSrc from "../decorations/blocks.ts?raw";
import wysiwygSrc from "../Wysiwyg.svelte?raw";

vi.mock("../../api/clipboard", () => ({
  writeClipboardPayload: vi.fn(async () => {}),
}));

// Excalidraw + React are heavy; mock the two libraries so mounting an
// excalidraw block in jsdom never pulls the real React runtime. The widget
// only needs the render to be an async void, so a trivial SVG suffices.
vi.mock("@excalidraw/mermaid-to-excalidraw", () => ({
  parseMermaidToExcalidraw: async () => ({ elements: [], files: {} }),
}));
vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (els: unknown) => els,
  exportToSvg: async () => document.createElementNS("http://www.w3.org/2000/svg", "svg"),
}));

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

describe("diagram wiring", () => {
  test("mermaid is dynamic-imported (never in the initial bundle)", () => {
    expect(mermaidRenderSrc).toMatch(/import\("mermaid"\)/);
    expect(mermaidRenderSrc).not.toMatch(/^import .* from "mermaid"/m);
  });

  test("excalidraw is dynamic-imported (never in the initial bundle)", () => {
    // Both heavy libraries are pulled only when an excalidraw block first
    // renders; a static import would drag React into the eager editor bundle.
    expect(excalidrawRenderSrc).toMatch(/import\("@excalidraw\/mermaid-to-excalidraw"\)/);
    expect(excalidrawRenderSrc).toMatch(/import\("@excalidraw\/excalidraw"\)/);
    expect(excalidrawRenderSrc).not.toMatch(/^import .* from "@excalidraw\//m);
  });

  test("blocks.ts stays generic (no diagram special-case)", () => {
    expect(blocksSrc).not.toMatch(/mermaid/i);
    expect(blocksSrc).not.toMatch(/excalidraw/i);
  });

  test("View affordance opens the zoom overlay with a light render", () => {
    // The hover "View" button is the explicit zoom trigger, gated on the
    // onView option and only revealed after a successful render; clicking the
    // diagram body still defers to CM6 caret placement (cursor-out reveal).
    expect(diagramSrc).toMatch(/onView\?: \(svg: string\) => void/);
    expect(diagramSrc).toMatch(/if \(onView\)/);
    expect(diagramSrc).toMatch(/createElement\("button"\)/);
    // The zoom always presents the light render on a light panel: a dark
    // editor re-renders light for the overlay, a light editor passes the
    // cached (already light) face.
    expect(diagramSrc).toMatch(/this\.spec\.render\(this\.source, false\)/);
    expect(diagramSrc).toMatch(/onView\(renderedSvg\)/);
  });

  test("copy affordance offers vector SVG and raster PNG payloads", () => {
    // The fenced-block widget exposes both formats. PNG rides the native
    // image bridge; SVG markup rides the portable text clipboard.
    expect(diagramSrc).toMatch(
      /cm-md-diagram-copy-svg/,
    );
    expect(diagramSrc).toMatch(/cm-md-diagram-copy-png/);
    expect(diagramCopySrc).toMatch(/writeClipboardPayload\("image\/png"/);
    expect(diagramCopySrc).toMatch(/"text\/plain;charset=utf-8"/);
    expect(wysiwygSrc).toMatch(/cm-md-diagram-actions/);
  });

  test("vertical arrow keys step INTO a rendered block (no widget skip)", () => {
    // A block-replace widget has no internal lines, so ArrowUp/Down skip it
    // (atomicRanges snaps the caret past the atom). The fix is an
    // ArrowUp/ArrowDown keymap that redirects a crossing move onto the block
    // edge so scan() de-renders it. moveVertically needs real layout (jsdom
    // has none), so the behaviour is browser-verified; this pins the
    // mechanism so it can't silently drop out.
    expect(diagramSrc).toMatch(/key:\s*"ArrowUp",\s*run:\s*stepInto\(false\)/);
    expect(diagramSrc).toMatch(/key:\s*"ArrowDown",\s*run:\s*stepInto\(true\)/);
    expect(diagramSrc).toMatch(/view\.moveVertically\(range, forward\)/);
    expect(diagramSrc).toMatch(/EditorSelection\.cursor\(enter\)/);
  });

  test("reverse flip: cursor-enter ghosts the cached face and folds it out", () => {
    // The forward flip plays on widget mount; the reverse needs a ghost
    // because CM removes the widget DOM instantly on enter. Needs real layout
    // + WAAPI (jsdom has neither), so behaviour is browser-verified; this pins
    // the mechanism. The ghost rotateX-folds from 0 to +90, CONTINUING the
    // forward rotation the mount flip started (-90 -> 0) rather than
    // mirroring it, over the same duration.
    expect(diagramSrc).toMatch(/cacheFace\(this\.spec, this\.source, this\.dark, res\.svg\)/);
    expect(diagramSrc).toMatch(/function flipOutGhost/);
    expect(diagramSrc).toMatch(/rotateX\(0deg\)/);
    expect(diagramSrc).toMatch(/rotateX\(90deg\)/);
    expect(diagramSrc).toMatch(/if \(update\.docChanged \|\| !update\.selectionSet\) return/);
    expect(diagramSrc).toMatch(/flipOutGhost\(update\.view, it\.from, widget\)/);
  });

  test("error locatability: failing line accented in source + actionable face", () => {
    // Errors are cached per source on render and the source line they blame
    // (openLine + N) is line-decorated while the cursor is inside the block;
    // the rendered face leads with the line number. Browser-verified end to
    // end (needs the library + layout); pinned here.
    expect(diagramSrc).toMatch(/errorCache: new Map/);
    expect(diagramSrc).toMatch(/cm-md-diagram-error-line/);
    expect(diagramSrc).toMatch(/info\.openLine \+ err\.line/);
    // Actionable face leads with the renderer label + line number.
    expect(diagramSrc).toMatch(/\$\{label\} error - line \$\{res\.errorLine\}/);
    // Error cleared on a successful re-render so a fixed line stops accenting.
    expect(diagramSrc).toMatch(/cacheError\(this\.spec, this\.source, null\)/);
  });

  test("errored face click-through resolves the block at event time", () => {
    // The jsdom tests above cover the caret landings; this pins the
    // mechanism: the ERROR branch swallows mousedown and places the caret
    // itself via posAtDOM on the wrap (the block may have moved since
    // toDOM), while the success face keeps CM6's edge mapping.
    expect(diagramSrc).toMatch(/function placeCaretOnErrorLine/);
    expect(diagramSrc).toMatch(/view\.posAtDOM\(wrap\)/);
    expect(diagramSrc).toMatch(
      /placeCaretOnErrorLine\(view, wrap, this\.source, res\)/,
    );
    // Exactly one attach site: the error branch, never the success face.
    expect(diagramSrc.match(/placeCaretOnErrorLine\(/g)).toHaveLength(2);
  });

  test("Wysiwyg wires BOTH renderers and the diagram-zoom opener", () => {
    // Both decoration fields are registered, each reads the editor theme and
    // passes the pan/zoom opener as onView.
    expect(wysiwygSrc).toMatch(
      /mermaidDecorations\([\s\S]{1,120}effectiveHybridSurfaceTheme\(surface\) === "dark"/,
    );
    expect(wysiwygSrc).toMatch(
      /excalidrawDecorations\([\s\S]{1,120}effectiveHybridSurfaceTheme\(surface\) === "dark"/,
    );
    expect(wysiwygSrc).toMatch(/openDiagramZoom\(svg\)/);
  });
});
