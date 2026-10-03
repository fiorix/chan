// Item 6, surface (a): export documents and decks to PDF through the
// Inspector action and assert the downloaded bytes: page counts, A4
// orientation, and per-page nonzero raster ink.
//
// Ink alone is passed by a page that has its text and has lost its image,
// so two exports are also read pixel by pixel. Their images are written
// here, each of one known colour, and the check finds that colour on the
// page: an image is where its slide puts it and as large as play shows it,
// a slide taller or wider than its page comes out whole and smaller, a
// block wider than the slide paints no scrollbar, and a line that fits in
// play does not break in the PDF.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import {
  colourBox,
  longestRun,
  pdfPageRasters,
  pixelAt,
  sameColour,
} from "../lib/pdf.mjs";

const TEAL = [0, 128, 128];
const VIOLET = [128, 0, 200];
const AMBER = [255, 176, 0];
const BLUE = [20, 90, 200];
const ORANGE = [230, 60, 20];

/// An opaque 8-bit RGB PNG whose pixel at (x, y) is `colourAt(x, y)`.
function png(width, height, colourAt) {
  const stride = 1 + width * 3;
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rows.set(colourAt(x, y), y * stride + 1 + x * 3);
    }
  }
  const chunk = (tag, data) => {
    const body = Buffer.concat([Buffer.from(tag, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/// The images `seed/deck-box.md` and `seed/doc.md` name. `tall.png` is
/// twice as tall as it is wide and ends in a foot of its own colour, so a
/// page that cuts the image shows no foot.
function writeImages(dir) {
  for (const [name, colour] of [
    ["mark-teal.png", TEAL],
    ["mark-violet.png", VIOLET],
    ["mark-amber.png", AMBER],
  ]) {
    writeFileSync(join(dir, name), png(8, 8, () => colour));
  }
  writeFileSync(
    join(dir, "tall.png"),
    png(100, 200, (_x, y) => (y < 180 ? BLUE : ORANGE)),
  );
}

/// A deck page of the export: A4 landscape, the 16:9 slide fitted to the
/// page's width and centred on it, laid out as play lays it out on a
/// screen 1920 by 1080, with the deck's content zoomed by 2.
function slideOf(raster) {
  const height = (raster.width * 9) / 16;
  const top = (raster.height - height) / 2;
  const pxPerCss = raster.width / 1920;
  return {
    bottom: top + height,
    /// Raster px of one px of the slide's zoomed content.
    pxPerContentPx: 2 * pxPerCss,
    padding: 54 * pxPerCss,
  };
}

/// What is wrong with a block of one colour that should be a whole square
/// image, `sidePx` wide and centred on the page.
function squareFaults(raster, box, what, sidePx) {
  if (!box) return [`${what}: its colour is nowhere on the page`];
  const faults = [];
  if (box.count < 0.95 * box.width * box.height) {
    faults.push(`${what}: ${box.count} px of its colour in a ${box.width}x${box.height} box`);
  }
  if (Math.abs(box.width - box.height) > 3) {
    faults.push(`${what}: ${box.width}x${box.height}, not square`);
  }
  if (Math.abs((box.x0 + box.x1 + 1) / 2 - raster.width / 2) > 3) {
    faults.push(`${what}: at x ${box.x0}-${box.x1}, not centred on ${raster.width}`);
  }
  if (sidePx !== undefined && Math.abs(box.width - sidePx) > 4) {
    faults.push(`${what}: ${box.width} px wide, play shows it ${sidePx.toFixed(1)} px wide`);
  }
  return faults;
}

/// Rows where a block wider than the slide painted a scrollbar: a long run
/// of one colour that is neither the page's nor the block's, inside the
/// block or just under it. Text never runs that long in one colour.
function scrollbarRows(raster) {
  const page = pixelAt(raster, 2, 2);
  // The block's own fill is the page's most common colour after the page.
  const seen = new Map();
  for (let y = 0; y < raster.height; y += 2) {
    for (let x = 0; x < raster.width; x += 2) {
      const colour = pixelAt(raster, x, y);
      if (sameColour(colour, page, 6)) continue;
      const key = colour.join(",");
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const fill = [...seen.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0]
    .split(",")
    .map(Number);
  if (!fill) return { fill: null, rows: [] };
  const block = colourBox(raster, fill, 3);
  const rows = [];
  const last = Math.min(raster.height - 1, block.y1 + 60);
  for (let y = block.y0; y <= last; y++) {
    const run = longestRun(
      raster,
      y,
      (c) => !sameColour(c, page, 6) && !sameColour(c, fill, 6) && !sameColour(c, TEAL, 10),
    );
    if (run.length >= 300) rows.push(y);
  }
  return { fill, block, rows };
}

/// `deck-box.pdf`, page by page. Returns what it measured and every fault
/// it found, so one run names them all.
function inspectBoxDeck(rasters) {
  const faults = [];
  const details = {};
  const [image, lines, tall, wide] = rasters;

  // Page 1: one image under a heading, 180 px wide in the deck's content.
  {
    const slide = slideOf(image);
    const box = colourBox(image, TEAL);
    details.image = box;
    faults.push(...squareFaults(image, box, "page 1 image", 180 * slide.pxPerContentPx));
  }

  // Page 2: two bullets that fill a line in play, between two markers, and
  // two short ones between the next two. The same number of lines takes the
  // same room, so the two gaps are equal unless a long bullet broke.
  {
    const a = colourBox(lines, TEAL);
    const b = colourBox(lines, VIOLET);
    const c = colourBox(lines, AMBER);
    if (!a || !b || !c) {
      faults.push("page 2: a marker image is not on the page");
    } else {
      const long = b.y0 - a.y1 - 1;
      const short = c.y0 - b.y1 - 1;
      details.lines = { long, short };
      if (Math.abs(long - short) > 8) {
        faults.push(
          `page 2: the bullets that fit one line in play take ${long} px and their ` +
            `one-line twins ${short} px: a line broke`,
        );
      }
    }
  }

  // Page 3: an image taller than what the slide has left. It is whole (its
  // foot is there, and it is twice as tall as wide) and inside the slide.
  {
    const slide = slideOf(tall);
    const body = colourBox(tall, BLUE);
    const foot = colourBox(tall, ORANGE);
    if (!body) {
      faults.push("page 3: the tall image is not on the page");
    } else if (!foot) {
      faults.push(
        `page 3: the tall image ends at row ${body.y1} with no foot: the slide was cut`,
      );
    } else {
      const width = Math.max(body.x1, foot.x1) - Math.min(body.x0, foot.x0) + 1;
      const height = foot.y1 - body.y0 + 1;
      const scale = width / (250 * slide.pxPerContentPx);
      details.tall = { width, height, bottom: foot.y1, scale: Number(scale.toFixed(3)) };
      if (Math.abs(height / width - 2) > 0.04) {
        faults.push(`page 3: the tall image is ${width}x${height}, not twice as tall as wide`);
      }
      if (foot.y1 > slide.bottom - slide.padding + 3) {
        faults.push(
          `page 3: the tall image ends at row ${foot.y1}, below the slide's content ` +
            `at ${(slide.bottom - slide.padding).toFixed(1)}`,
        );
      }
      if (!(scale < 0.98)) {
        faults.push(`page 3: the slide is at scale ${scale.toFixed(3)}, not smaller`);
      }
    }
  }

  // Page 4: a code block wider than the slide, under a marker 100 px wide.
  // The marker says what scale the slide came out at, and no row of the
  // block is a scrollbar.
  {
    const slide = slideOf(wide);
    const marker = colourBox(wide, TEAL);
    if (!marker) {
      faults.push("page 4: the marker image is not on the page");
    } else {
      const scale = marker.width / (100 * slide.pxPerContentPx);
      details.wide = { marker: marker.width, scale: Number(scale.toFixed(3)) };
      if (!(scale > 0.4 && scale < 0.9)) {
        faults.push(
          `page 4: the slide with the wide block is at scale ${scale.toFixed(3)}; ` +
            "a block of 177 characters fits its slide at about 0.6",
        );
      }
    }
    const bar = scrollbarRows(wide);
    details.wideBlock = { fill: bar.fill, block: bar.block, scrollbarRows: bar.rows.length };
    if (bar.rows.length > 0) {
      faults.push(
        `page 4: a scrollbar is painted in rows ${bar.rows[0]}-${bar.rows.at(-1)}`,
      );
    }
  }
  return { details, faults };
}

/// `doc.pdf`: the image of a known colour on its first page, 120 px wide
/// in a content column 669 px wide.
function inspectDoc(rasters) {
  const page = rasters[0];
  const box = colourBox(page, VIOLET);
  return {
    details: { image: box },
    faults: squareFaults(page, box, "page 1 image", (120 * page.width) / 669),
  };
}

async function openFileBrowser(page) {
  const open = await page.$(".file-tree, [role=tree]");
  if (open) return;
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
    );
  });
  await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
}

async function selectTreeFile(page, filename) {
  const clicked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[role="treeitem"] button.name')].find(
      (b) => b.textContent?.trim() === name,
    );
    if (!row) return false;
    row.click();
    return true;
  }, filename);
  if (!clicked) throw new Error(`tree row not found: ${filename}`);
}

async function clickExportToPdf(page) {
  await page.waitForSelector(".pill-caret", { timeout: 10_000 });
  await page.click(".pill-caret");
  await page.waitForSelector(".action-menu-item", { timeout: 5_000 });
  const clicked = await page.evaluate(() => {
    const item = [...document.querySelectorAll(".action-menu-item")].find((b) =>
      b.textContent?.includes("Export to PDF"),
    );
    if (!item) return false;
    item.click();
    return true;
  });
  if (!clicked) throw new Error("Export to PDF menu item not found");
}

export default {
  name: "pdf-inspector",
  async run(ctx) {
    const { page } = ctx;
    writeImages(ctx.workspaceDir);
    await openFileBrowser(page);
    await ctx.shot("file-browser");

    const cases = [
      {
        file: "doc.md",
        pdf: "doc.pdf",
        orientation: "portrait",
        minPages: 2,
        inspect: inspectDoc,
      },
      // Long non-repeating corpus: every sentence is unique, so any
      // ink band appearing on two pages is a pagination bug.
      {
        file: "long-doc.md",
        pdf: "long-doc.pdf",
        orientation: "portrait",
        minPages: 6,
        boundaries: true,
      },
      { file: "deck-169.md", pdf: "deck-169.pdf", orientation: "landscape", pages: 3 },
      { file: "deck-43.md", pdf: "deck-43.pdf", orientation: "landscape", pages: 3 },
      {
        file: "deck-box.md",
        pdf: "deck-box.pdf",
        orientation: "landscape",
        pages: 4,
        inspect: inspectBoxDeck,
      },
    ];
    const details = {};
    const faults = [];
    for (const c of cases) {
      const target = join(ctx.downloadDir, c.pdf);
      if (existsSync(target)) rmSync(target);

      await selectTreeFile(page, c.file);
      await clickExportToPdf(page);
      const bytes = await ctx.pollFile(target, 90_000);
      await ctx.shot(`exported-${c.file}`);

      if (c.pages !== undefined) {
        details[c.file] = await ctx.assertPdf(bytes, {
          pages: c.pages,
          orientation: c.orientation,
        });
      } else {
        // Documents paginate by content height; pin a floor, not an
        // exact count, so copy tweaks don't flake the smoke.
        const { PDFDocument } = await import("pdf-lib");
        const count = (await PDFDocument.load(bytes)).getPageCount();
        if (count < c.minPages) {
          throw new Error(`${c.pdf}: expected >=${c.minPages} pages, got ${count}`);
        }
        details[c.file] = await ctx.assertPdf(bytes, {
          pages: count,
          orientation: c.orientation,
        });
      }
      if (c.boundaries) {
        details[`${c.file}:boundaries`] = await ctx.assertNoDuplicateBands(bytes);
      }
      if (c.inspect) {
        const read = c.inspect(await pdfPageRasters(bytes));
        details[`${c.file}:pixels`] = read.details;
        faults.push(...read.faults.map((fault) => `${c.pdf} ${fault}`));
      }
    }
    if (faults.length > 0) {
      throw new Error(`${faults.join("\n")}\nmeasured: ${JSON.stringify(details)}`);
    }
    return details;
  },
};
