// PDF export orchestrator: markdown in, PDF bytes out. Slide decks
// (chan slides frontmatter) render one slide per A4 landscape page;
// documents render paginated A4 portrait. Every page is composed by
// pdf_pages, made self-contained and rasterized by pdf_snapshot, and
// embedded as a PNG through pdf-lib (dynamic-imported so the library
// never loads until an export runs).

import {
  A4_LANDSCAPE_PT,
  A4_PORTRAIT_PT,
  buildDocDom,
  buildDocPageElements,
  buildSlidePageDom,
  DOC_CONTENT_WIDTH_PX,
  DOC_MARGIN_PT,
  docPageGeometry,
  measureDocBlocks,
  normalizeDocPageBreaks,
  paginateDocBlocks,
} from "./pdf_pages";
import { api } from "../api/client";
import {
  snapshotPage,
  SnapshotError,
  type PageBoxPx,
  type PageSnapshot,
} from "./pdf_snapshot";
import { parseSlidesSpec, splitSlidePages } from "./slides";
import { type SlideDomTheme } from "./slide_dom";

/// Ceiling for one page's full hydrate -> snapshot pass. The engine
/// fails with an error rather than hanging.
const PAGE_TIMEOUT_MS = 30_000;

export type ExportMarkdownOptions = {
  /// Workspace path of the markdown source (image resolution + naming).
  path: string;
  markdown: string;
  theme: SlideDomTheme;
  styleSource?: Element | null;
};

/// Test seam: the orchestrator's page rasterizer. `box` is the CSS-px
/// box `root` lays out at; deck pages also pass a per-page scale that
/// maps their preview-reference layout box onto the fixed A4 bitmap
/// (documents omit it and raster at the default RASTER_SCALE).
export type ExportSeams = {
  rasterize?: (
    root: HTMLElement,
    box: PageBoxPx,
    opts?: { scale?: number },
  ) => Promise<PageSnapshot>;
};

function withPageTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new SnapshotError(`${what} timed out after ${PAGE_TIMEOUT_MS}ms`)),
      PAGE_TIMEOUT_MS,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/// Parse a CSS color (computed rgb()/rgba() or hex literal) into 0..1
/// channels for pdf-lib. Unparseable input falls back to white.
export function cssColorToRgb01(color: string): {
  r: number;
  g: number;
  b: number;
} {
  const rgb = color.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/,
  );
  if (rgb) {
    return {
      r: Number(rgb[1]) / 255,
      g: Number(rgb[2]) / 255,
      b: Number(rgb[3]) / 255,
    };
  }
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full =
      hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    return {
      r: parseInt(full.slice(0, 2), 16) / 255,
      g: parseInt(full.slice(2, 4), 16) / 255,
      b: parseInt(full.slice(4, 6), 16) / 255,
    };
  }
  return { r: 1, g: 1, b: 1 };
}

/// Derive the exported PDF filename from the document path: the
/// basename with its extension swapped for `.pdf` (or `.pdf` appended
/// when the basename has no extension). Empty paths fall back to a
/// generic name.
export function pdfFilenameFor(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = i < 0 ? path : path.slice(i + 1);
  const trimmed = base.trim();
  if (!trimmed) return "document.pdf";
  const dot = trimmed.lastIndexOf(".");
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${stem}.pdf`;
}

/// The export-job window_command payload (Contract B): `cs export`
/// pushed a job to this window; render `path` via the exporter
/// registry, upload the bytes to `out`, reply with the request id.
export type ExportJobCommand = {
  id: string;
  path: string;
  format: string;
  out: string;
};

/// Exporter registry, keyed by the opaque wire format string. The
/// server never interprets the format; unknown values reply ok:false.
const EXPORTERS: Record<
  string,
  {
    render: (
      opts: ExportMarkdownOptions,
      seams: ExportSeams,
    ) => Promise<Uint8Array>;
    mime: string;
  }
> = {
  pdf: {
    render: (opts, seams) => exportMarkdownToPdf(opts, seams),
    mime: "application/pdf",
  },
};

/// Answer an export-job window_command: run the export and POST the
/// result to `/api/window/reply`, unblocking the waiting CLI. A thrown
/// error is reported as `ok:false` rather than dropped, so the CLI
/// always gets a reply (or times out server-side).
export async function respondExportJob(
  frame: ExportJobCommand,
  theme: SlideDomTheme,
  seams: ExportSeams = {},
): Promise<void> {
  let payload:
    | { ok: true; out: string }
    | { ok: false; error: string };
  try {
    await runExportJob(frame, theme, seams);
    payload = { ok: true, out: frame.out };
  } catch (e) {
    payload = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    await api.windowReply({ requestId: frame.id, payload });
  } catch (e) {
    // 404 = the CLI already timed out (stale request id). Anything else
    // would leave it hanging blind, so surface it to the console.
    if ((e as { status?: number } | null)?.status !== 404) {
      console.warn("export-job reply POST failed", e);
    }
  }
}

async function runExportJob(
  frame: ExportJobCommand,
  theme: SlideDomTheme,
  seams: ExportSeams,
): Promise<void> {
  const exporter = EXPORTERS[frame.format];
  if (!exporter) throw new Error(`unknown export format: ${frame.format}`);
  const doc = await api.read(frame.path);
  const bytes = await exporter.render(
    {
      path: frame.path,
      markdown: doc.content,
      theme,
      styleSource: null,
    },
    seams,
  );
  await uploadExportBytes(bytes, frame.out, exporter.mime);
}

/// Write the export output through the workspace upload route (all
/// writes stay inside the Workspace sandbox). The replace mode requires
/// an existing target, so a fresh out file falls back to the plain
/// upload mode (multipart is the binary-safe write; the JSON create
/// route refuses non-text paths). Upload picks a free name on
/// collision, so a raced-in target is replaced and the stray removed.
async function uploadExportBytes(
  bytes: Uint8Array,
  out: string,
  mime: string,
): Promise<void> {
  const filename = out.split("/").pop() || "export";
  const file = new File([bytes as BlobPart], filename, { type: mime });
  try {
    await api.replaceFile(file, out);
    return;
  } catch (replaceErr) {
    let uploaded: { path: string };
    try {
      const dir = out.split("/").slice(0, -1).join("/");
      uploaded = await api.uploadFile(file, dir);
    } catch {
      throw replaceErr;
    }
    if (uploaded.path !== out) {
      await api.replaceFile(file, out);
      void api.remove(uploaded.path).catch(() => {});
    }
  }
}

/// Render markdown to PDF bytes: deck when the source carries the chan
/// slides frontmatter, paginated document otherwise.
export async function exportMarkdownToPdf(
  opts: ExportMarkdownOptions,
  seams: ExportSeams = {},
): Promise<Uint8Array> {
  const rasterize =
    seams.rasterize ?? ((root, box, opts) => snapshotPage(root, box, opts));
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();

  const spec = parseSlidesSpec(opts.markdown);
  if (spec) {
    for (const page of splitSlidePages(opts.markdown)) {
      const slide = buildSlidePageDom({
        markdown: page.markdown,
        fromPath: opts.path,
        spec,
        theme: opts.theme,
        styleSource: opts.styleSource,
      });
      const snap = await withPageTimeout(
        slide.completion.then(() =>
          rasterize(slide.root, slide.box, { scale: slide.rasterScale }),
        ),
        `slide ${page.number} render`,
      );
      const png = await pdf.embedPng(snap.png);
      const pdfPage = pdf.addPage([
        A4_LANDSCAPE_PT.widthPt,
        A4_LANDSCAPE_PT.heightPt,
      ]);
      pdfPage.drawImage(png, {
        x: 0,
        y: 0,
        width: A4_LANDSCAPE_PT.widthPt,
        height: A4_LANDSCAPE_PT.heightPt,
      });
    }
    return await pdf.save();
  }

  const geometry = docPageGeometry();
  const doc = buildDocDom({
    markdown: normalizeDocPageBreaks(opts.markdown),
    path: opts.path,
    theme: opts.theme,
    styleSource: opts.styleSource,
    contentWidthPx: DOC_CONTENT_WIDTH_PX,
  });

  // Attach offscreen: pagination measures final layout.
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${DOC_CONTENT_WIDTH_PX}px;`;
  host.appendChild(doc.root);
  document.body.appendChild(host);
  try {
    await withPageTimeout(doc.completion, "document render");
    const bg = cssColorToRgb01(getComputedStyle(doc.root).backgroundColor);
    const windows = paginateDocBlocks(
      measureDocBlocks(doc.content),
      geometry.pageContentHeightPx,
    );
    const pages = buildDocPageElements(doc, windows);
    const { rgb } = await import("pdf-lib");
    for (const [index, pageEl] of pages.entries()) {
      const snap = await withPageTimeout(
        rasterize(pageEl, {
          widthPx: DOC_CONTENT_WIDTH_PX,
          heightPx: geometry.pageContentHeightPx,
        }),
        `page ${index + 1} render`,
      );
      const png = await pdf.embedPng(snap.png);
      const pdfPage = pdf.addPage([
        A4_PORTRAIT_PT.widthPt,
        A4_PORTRAIT_PT.heightPt,
      ]);
      pdfPage.drawRectangle({
        x: 0,
        y: 0,
        width: A4_PORTRAIT_PT.widthPt,
        height: A4_PORTRAIT_PT.heightPt,
        color: rgb(bg.r, bg.g, bg.b),
      });
      pdfPage.drawImage(png, {
        x: DOC_MARGIN_PT,
        y: A4_PORTRAIT_PT.heightPt - DOC_MARGIN_PT - geometry.printableHeightPt,
        width: geometry.printableWidthPt,
        height: geometry.printableHeightPt,
      });
    }
    return await pdf.save();
  } finally {
    host.remove();
  }
}
