// @vitest-environment jsdom
//
// The PDF export names the document it exports by its last path component,
// cut at `/` alone: a name that holds `\` is shown and saved whole.

import { afterEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  statuses: [] as string[],
  read: null as null | (() => Promise<{ content: string }>),
}));

vi.mock("./store.svelte", () => ({
  effectiveHybridSurfaceTheme: () => "light",
  setTransientStatus: (text: string) => h.statuses.push(text),
  ui: { status: null, statusKind: null },
}));
vi.mock("../api/client", () => ({
  api: { read: vi.fn(async () => h.read!()) },
}));
vi.mock("../api/desktop", () => ({
  isTauriDesktop: () => false,
  saveBytesToDownloads: vi.fn(),
}));
vi.mock("../api/download", () => ({ downloadBytes: vi.fn() }));
vi.mock("../editor/pdf_export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../editor/pdf_export")>()),
  exportMarkdownToPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
}));

import { downloadBytes } from "../api/download";
import { exportPathToPdf } from "./fileActionExecutors";
import { ui } from "./store.svelte";

afterEach(() => {
  h.statuses = [];
  h.read = null;
  vi.clearAllMocks();
});

describe("exporting a document whose name holds a backslash", () => {
  test("the status names the document whole", async () => {
    h.read = async () => {
      throw new Error("unreadable");
    };

    await exportPathToPdf("dir/a\\b.md");

    expect(h.statuses[0]).toBe("exporting a\\b.md...");
    expect(ui.status).toBe("PDF export failed: unreadable");
  });

  test("the saved file keeps the whole name", async () => {
    h.read = async () => ({ content: "# a" });

    await exportPathToPdf("dir/a\\b.md");

    expect(downloadBytes).toHaveBeenCalledWith(expect.any(Uint8Array), "a\\b.pdf", "application/pdf");
    expect(h.statuses.at(-1)).toBe("exported a\\b.pdf");
  });
});
