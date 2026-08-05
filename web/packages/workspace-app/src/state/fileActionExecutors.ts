// Shared non-policy operations backing the file-action classifier
// (state/fileActions). Applicability lives in the classifier; surface
// chrome lives in the components. An operation lands here only when
// more than one surface needs the identical behavior.

import { api } from "../api/client";
import { isTauriDesktop, saveBytesToDownloads } from "../api/desktop";
import { downloadBytes } from "../api/download";
import { basename } from "./format";
import { effectiveHybridSurfaceTheme, setTransientStatus, ui } from "./store.svelte";

/// Render a markdown document to PDF and save it: the native
/// Downloads pipeline on desktop, a browser download on the web. The
/// engine loads on first use (dynamic import) and renders with the
/// editor surface theme.
export async function exportPathToPdf(path: string): Promise<void> {
  setTransientStatus(`exporting ${basename(path)}...`);
  try {
    const doc = await api.read(path);
    const { exportMarkdownToPdf, pdfFilenameFor } = await import(
      "../editor/pdf_export"
    );
    const theme = effectiveHybridSurfaceTheme("editor") === "dark" ? "dark" : "light";
    const bytes = await exportMarkdownToPdf({
      path,
      markdown: doc.content,
      theme,
      styleSource: null,
    });
    const filename = pdfFilenameFor(path);
    if (isTauriDesktop()) {
      await saveBytesToDownloads(bytes, filename);
    } else {
      downloadBytes(bytes, filename, "application/pdf");
    }
    setTransientStatus(`exported ${filename}`);
  } catch (err) {
    ui.status = `PDF export failed: ${err instanceof Error ? err.message : String(err)}`;
    ui.statusKind = "persistent";
  }
}
