// @vitest-environment jsdom
//
// The images of an export, through the export's own rasterizer: a page is
// drawn only once each of its images has decoded, an image that does not
// decode fails the export by its name, and the image's own bitmap is what
// lands on the page. The engine's `Image` and canvas are stand-ins, since
// jsdom decodes and paints nothing.

import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  decodesSettleAtOnce,
  heldDecodes,
  imagesHaveBoxes,
  settled,
  standInCanvas,
  StandInImage,
  type Drawn,
  type HeldDecode,
} from "../__tests__/snapshotStandIns";
import { exportMarkdownToPdf } from "./pdf_export";

vi.mock("./mermaid_render", () => ({
  renderMermaid: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
}));
vi.mock("./excalidraw_render", () => ({
  renderExcalidraw: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
  renderExcalidrawFile: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })),
}));

// A valid 1x1 PNG, so pdf-lib embeds what the stand-in canvas encodes to.
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const DOCUMENT = "# Notes\n\n![](shots/photo.png)\n\ntail\n";

const DECK = `---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
---

# One

![](shots/photo.png)
`;

let decodes: HeldDecode[];
let drawn: Drawn[];

beforeEach(() => {
  decodes = heldDecodes();
  vi.stubGlobal("Image", StandInImage);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    })),
  );
  // An image of the composition has arrived: the export waits for that
  // before it measures, and no image of a jsdom page ever loads.
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  imagesHaveBoxes();
  drawn = standInCanvas({ x: 10, y: 20, w: 40, h: 20 }, TINY_PNG);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe.each([
  ["a document", DOCUMENT, "notes/doc.md"],
  ["a deck", DECK, "notes/deck.md"],
])("%s with an image", (_what, markdown, path) => {
  test("draws no page before the image has decoded", async () => {
    const exported = exportMarkdownToPdf({ path, markdown, theme: "light" });
    let failure: unknown = null;
    exported.catch((err) => (failure = err));

    await settled();
    expect(failure).toBeNull();
    expect(decodes).toHaveLength(1);
    expect(drawn).toEqual([]);

    decodes[0]!.settle(true);
    const pdf = await PDFDocument.load(await exported);
    expect(pdf.getPageCount()).toBe(1);
    expect(drawn.map((d) => d.what)).toEqual(["page", "markers", "image"]);
    expect((drawn[2]!.args[0] as StandInImage).src).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  test("fails by the image's name when the image does not decode", async () => {
    const exported = exportMarkdownToPdf({ path, markdown, theme: "light" });
    let failure: unknown = null;
    exported.catch((err) => (failure = err));

    await settled();
    expect(decodes).toHaveLength(1);
    decodes[0]!.settle(false);
    await settled();

    expect((failure as Error | null)?.message).toContain(
      "/api/fs/notes/shots/photo.png",
    );
    expect(drawn).toEqual([]);
  });

  test("fails by the image's name when no page gives the image a place", async () => {
    vi.restoreAllMocks();
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    imagesHaveBoxes();
    // This canvas answers a marker read with no marker at all.
    standInCanvas({ x: 0, y: 0, w: 0, h: 0 }, TINY_PNG);
    decodesSettleAtOnce();

    await expect(
      exportMarkdownToPdf({ path, markdown, theme: "light" }),
    ).rejects.toThrow(
      "image has no place on the page: /api/fs/notes/shots/photo.png",
    );
  });
});

describe("a document whose image has no box where it was composed", () => {
  test("exports without it: the page does not show it, and that is no failure", async () => {
    // jsdom gives no element a box, which is what a closed <details> does
    // to its image in an engine.
    vi.restoreAllMocks();
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    const drawn = standInCanvas({ x: 0, y: 0, w: 0, h: 0 }, TINY_PNG);
    decodesSettleAtOnce();

    const pdf = await PDFDocument.load(
      await exportMarkdownToPdf({
        path: "notes/doc.md",
        markdown: DOCUMENT,
        theme: "light",
      }),
    );
    expect(pdf.getPageCount()).toBe(1);
    expect(drawn.map((d) => d.what)).toEqual(["page"]);
  });
});
