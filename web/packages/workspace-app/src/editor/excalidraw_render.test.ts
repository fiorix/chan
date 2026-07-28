// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  renderExcalidraw,
  renderExcalidrawFile,
  renderExcalidrawForClipboard,
} from "./excalidraw_render";

// Mock the two heavy libraries so the render path is exercised without
// loading React / excalidraw. parseMermaidToExcalidraw throws on sentinel
// sources so both error branches are covered (a genuine parse error and the
// WebKit-only "SubGraph element not found"); exportToSvg returns a real
// (jsdom) SVG element so `.outerHTML` produces an <svg> string.
vi.mock("@excalidraw/mermaid-to-excalidraw", () => ({
  parseMermaidToExcalidraw: async (def: string) => {
    if (def.includes("BOOM")) {
      throw new Error("Parse error on line 2, column 3: unexpected token");
    }
    if (def.includes("SUBGRAPH")) {
      throw new Error("SubGraph element not found");
    }
    return { elements: [{ type: "rectangle" }], files: {} };
  },
}));
vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (els: unknown[]) => els,
  restore: (data: { elements?: unknown[]; appState?: object; files?: object }) => ({
    elements: data.elements ?? [],
    appState: data.appState ?? {},
    files: data.files ?? {},
  }),
  exportToSvg: async (opts?: {
    appState?: { exportWithDarkMode?: boolean; exportScale?: number };
  }) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-rendered", "1");
    svg.setAttribute("data-dark", opts?.appState?.exportWithDarkMode ? "1" : "0");
    svg.setAttribute(
      "data-scale",
      opts?.appState?.exportScale !== undefined
        ? String(opts.appState.exportScale)
        : "none",
    );
    return svg;
  },
}));
// Mock the fallback renderer so the excalidraw error path never loads real
// mermaid. It "renders" any source that is valid mermaid and fails only on
// the BOOM sentinel, mirroring how the plain mermaid renderer draws a valid
// flowchart-with-subgraph but rejects genuinely bad source.
vi.mock("./mermaid_render", () => ({
  renderMermaid: async (source: string) => {
    if (source.includes("BOOM")) {
      return { ok: false, error: "mermaid parse failed" };
    }
    return { ok: true, svg: '<svg data-mermaid="1"></svg>' };
  },
  renderMermaidForClipboard: async (source: string) => {
    if (source.includes("BOOM")) {
      return { ok: false, error: "mermaid parse failed" };
    }
    return { ok: true, svg: '<svg data-copy-safe-mermaid="1"></svg>' };
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderExcalidraw", () => {
  test("returns the exported SVG string on success", async () => {
    const res = await renderExcalidraw("flowchart TD\n  A --> B", false);
    expect(res.ok).toBe(true);
    expect(res.svg).toContain("<svg");
    expect(res.svg).toContain('data-rendered="1"');
  });

  test("shrinks the fence diagram via exportScale but leaves a .excalidraw scene unscaled", async () => {
    const fence = await renderExcalidraw("flowchart TD\n  A --> B", false);
    expect(fence.ok).toBe(true);
    // The fence path passes the mermaid-to-excalidraw shrink constant.
    expect(fence.svg).toContain(`data-scale="${String(1 / 1.5)}"`);

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            path: "board.excalidraw",
            content: JSON.stringify({
              type: "excalidraw",
              elements: [{ id: "a", type: "rectangle", isDeleted: false }],
              appState: {},
              files: {},
            }),
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    // A user-authored .excalidraw scene keeps its own size (no exportScale).
    const scene = await renderExcalidrawFile(
      "/api/files/board.excalidraw?t=tok",
      true,
    );
    expect(scene.ok).toBe(true);
    expect(scene.svg).toContain('data-scale="none"');
  });

  test("degrades to the mermaid renderer when the excalidraw conversion fails", async () => {
    // WebKit throws "SubGraph element not found" here; the source is valid
    // mermaid, so the block still shows a diagram via the mermaid fallback.
    const res = await renderExcalidraw("flowchart LR\n  subgraph SUBGRAPH\n    A --> B\n  end", false);
    expect(res.ok).toBe(true);
    expect(res.svg).toContain('data-mermaid="1"');
  });

  test("uses the copy-safe Mermaid fallback for a clipboard render", async () => {
    const res = await renderExcalidrawForClipboard("SUBGRAPH", false);
    expect(res.ok).toBe(true);
    expect(res.svg).toContain('data-copy-safe-mermaid="1"');
  });

  test("resolves to a structured error when mermaid also fails (never throws)", async () => {
    const res = await renderExcalidraw("BOOM", false);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Parse error");
    // mermaid-to-excalidraw parses mermaid underneath, so its "line N,
    // column M" is surfaced for the failing-source accent.
    expect(res.errorLine).toBe(2);
    expect(res.errorCol).toBe(3);
  });

  test("renders a fetched .excalidraw scene as a themed SVG string", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          path: "board.excalidraw",
          content: JSON.stringify({
            type: "excalidraw",
            elements: [{ id: "a", type: "rectangle", isDeleted: false }],
            appState: {},
            files: {},
          }),
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await renderExcalidrawFile(
      "/api/files/board.excalidraw?t=tok",
      true,
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/files/board.excalidraw?t=tok");
    expect(res.ok).toBe(true);
    expect(res.svg).toContain("<svg");
    expect(res.svg).toContain('data-dark="1"');
  });
});
