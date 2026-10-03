// Item 6, surface (a): export documents and decks to PDF through the
// Inspector action and assert the downloaded bytes: page counts, A4
// orientation, and per-page nonzero raster ink.
//
// Ink alone is passed by a page that has its text and has lost its image,
// so two exports are also read pixel by pixel. Their seeded images each
// have one known colour, and the check finds that colour on the
// page: an image is where its slide puts it and as large as play shows it,
// a slide taller or wider than its page comes out whole and smaller, a
// block wider than the slide paints no scrollbar, a line that fits in
// play does not break in the PDF, and an image with no size of its own is
// as wide as play lays it out.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

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
const ROSE = [220, 20, 120];
const GREEN = [0, 150, 80];
const CYAN = [17, 153, 211];
const MAGENTA = [180, 0, 180];
const LIME = [80, 180, 10];

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
    /// How wide the slide's content is, in px of that content.
    contentPx: (1920 - 2 * 54) / 2,
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
/// block or just under it, on at least three rows in a row. Text never
/// runs that long in one colour, and the block's own edge, where its fill
/// blends with the page on a row it half covers, is one row and no more.
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
  let band = [];
  const last = Math.min(raster.height - 1, block.y1 + 60);
  for (let y = block.y0; y <= last + 1; y++) {
    const run =
      y <= last &&
      longestRun(
        raster,
        y,
        (c) => !sameColour(c, page, 6) && !sameColour(c, fill, 6) && !sameColour(c, TEAL, 10),
      );
    if (run && run.length >= 300) {
      band.push(y);
      continue;
    }
    if (band.length >= 3) rows.push(...band);
    band = [];
  }
  return { fill, block, rows };
}

/// `deck-box.pdf`, page by page. Returns what it measured and every fault
/// it found, so one run names them all.
function inspectBoxDeck(rasters) {
  const faults = [];
  const details = {};
  const [image, lines, tall, wide, unsized] = rasters;

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

  // Page 5: an image with no size of its own, an SVG that carries only a
  // viewBox ten times as wide as tall, under a marker 100 px wide, on a
  // slide the same wide block shrinks. Play lays such an image out as wide
  // as the slide's content, and the marker says what scale the slide came
  // out at.
  {
    const slide = slideOf(unsized);
    const marker = colourBox(unsized, TEAL);
    const box = colourBox(unsized, ROSE);
    if (!marker) {
      faults.push("page 5: the marker image is not on the page");
    } else if (!box) {
      faults.push("page 5: the image with no size of its own is not on the page");
    } else {
      const scale = marker.width / (100 * slide.pxPerContentPx);
      const width = slide.contentPx * slide.pxPerContentPx * scale;
      details.unsized = {
        width: box.width,
        height: box.height,
        scale: Number(scale.toFixed(3)),
      };
      if (Math.abs(box.width - width) > 0.02 * width) {
        faults.push(
          `page 5: the image with no size of its own is ${box.width} px wide; play ` +
            `shows it as wide as the slide's content, ${width.toFixed(1)} px`,
        );
      }
      if (Math.abs(box.width / box.height - 10) > 0.4) {
        faults.push(
          `page 5: the image with no size of its own is ${box.width}x${box.height}, ` +
            "not ten times as wide as tall",
        );
      }
      if (box.count < 0.95 * box.width * box.height) {
        faults.push(
          `page 5: ${box.count} px of the image's colour in a ${box.width}x${box.height} box`,
        );
      }
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

/// Capture the browser's composed boxes immediately before the lift writes
/// its first stand-in, then after all stand-ins have been written.
async function watchImageLift(page, expectedImage) {
  await page.evaluate((expected) => {
    const original = Element.prototype.setAttribute;
    const originalClone = Element.prototype.cloneNode;
    const names = new Set(["wide-table", "closed-details", "zero-clip", "contain", "partial-clip", "hidden-unsized", "hidden-marker", "height-only", "absolute-escape", "auto-visible"]);
    const capture = { before: null, after: null };
    const read = (host) => ({
      ...Object.fromEntries([...host.querySelectorAll("img[alt]")]
        .filter((img) => names.has(img.alt))
        .map((img) => [img.alt, {
          rect: img.getBoundingClientRect().toJSON(),
          parent: img.parentElement?.getBoundingClientRect().toJSON(),
          natural: [img.naturalWidth, img.naturalHeight],
          style: [getComputedStyle(img).width, getComputedStyle(img).height],
        }])),
      anchor: host.querySelector("#clip-anchor")?.getBoundingClientRect().toJSON(),
    });
    Element.prototype.setAttribute = function (name, value) {
      if (!capture.before && name === "src" && this instanceof HTMLImageElement &&
          String(value).startsWith("data:")) {
        let host = this.parentElement;
        while (host && host.style?.left !== "-10000px") host = host.parentElement;
        if (host && [...host.querySelectorAll("img[alt]")].some((img) => img.alt === expected)) {
          capture.before = read(host);
        }
      }
      return original.call(this, name, value);
    };
    Element.prototype.cloneNode = function (deep) {
      if (capture.before && !capture.after) {
        let host = this.parentElement;
        while (host && host.style?.left !== "-10000px") host = host.parentElement;
        if (host && [...host.querySelectorAll("img[alt]")].some((img) => img.alt === expected)) {
          capture.after = read(host);
        }
      }
      return originalClone.call(this, deep);
    };
    window.__pdfImageLift = { capture, restore: () => {
      Element.prototype.setAttribute = original;
      Element.prototype.cloneNode = originalClone;
    } };
  }, expectedImage);
}

function inspectHeightImage(rasters, capture) {
  const page = rasters[0];
  const before = capture?.before?.["height-only"];
  const after = capture?.after?.["height-only"];
  const box = colourBox(page, GREEN);
  const scale = page.width / 669;
  const faults = [];
  if (!before || !after || !box) {
    faults.push("height-only: the image, final box, or PDF colour is missing");
  } else {
    for (const index of [0, 1]) {
      if (Math.abs(parseFloat(before.style[index]) - parseFloat(after.style[index])) > 0.5) {
        faults.push(`height-only: style ${before.style.join("x")} became ${after.style.join("x")}`);
        break;
      }
    }
    if (Math.abs(box.width / scale - before.rect.width) > 2 ||
        Math.abs(box.height / scale - before.rect.height) > 2) {
      faults.push(`height-only: PDF colour ${box.width / scale}x${box.height / scale} CSS px, composed ${before.rect.width}x${before.rect.height}`);
    }
  }
  return { details: { capture, box }, faults };
}

function inspectLayoutImages(rasters, capture) {
  const faults = [];
  const before = capture?.before ?? {};
  const after = capture?.after ?? {};
  const page = rasters[0];
  const scale = page.width / 669;
  for (const name of ["wide-table", "contain", "partial-clip"]) {
    const a = before[name]?.rect;
    const b = after[name]?.rect;
    if (!a || !b) {
      faults.push(`${name}: the browser did not capture both boxes`);
      continue;
    }
    if (!(a.width > 0 && a.height > 0) || Math.abs(a.width - b.width) > 0.5 ||
        Math.abs(a.height - b.height) > 0.5) {
      faults.push(`${name}: its composed ${a.width}x${a.height} box became ${b.width}x${b.height}`);
    }
  }
  const amber = colourBox(page, AMBER);
  const green = colourBox(page, GREEN);
  const clipped = amber && green ? {
    x0: Math.min(amber.x0, green.x0), x1: Math.max(amber.x1, green.x1),
    y0: Math.min(amber.y0, green.y0), y1: Math.max(amber.y1, green.y1),
    width: Math.max(amber.x1, green.x1) - Math.min(amber.x0, green.x0) + 1,
    height: Math.max(amber.y1, green.y1) - Math.min(amber.y0, green.y0) + 1,
  } : null;
  const expected = [
    ["wide-table", colourBox(page, TEAL), before["wide-table"]?.rect.width, before["wide-table"]?.rect.height],
    ["contain", colourBox(page, VIOLET), 80, 80],
    ["partial-clip", clipped, before["partial-clip"]?.rect.width,
      Math.max(0, Math.min(before["partial-clip"]?.rect.bottom ?? 0,
        before["partial-clip"]?.parent?.bottom ?? 0) -
        Math.max(before["partial-clip"]?.rect.top ?? 0,
          before["partial-clip"]?.parent?.top ?? 0))],
  ];
  const ink = {};
  for (const [name, box, width, height] of expected) {
    ink[name] = box;
    if (!box || !(width > 0 && height > 0)) {
      faults.push(`${name}: no measurable image colour or composed box`);
      continue;
    }
    if (Math.abs(box.width - width * scale) > 4 || Math.abs(box.height - height * scale) > 4) {
      faults.push(`${name}: PDF colour is ${box.width}x${box.height}, composed ${width}x${height} at ${scale.toFixed(3)} raster px per CSS px`);
    }
  }
  const anchor = colourBox(page, CYAN);
  if (!amber || !green || !anchor || !before["partial-clip"] || !before.anchor) {
    faults.push("partial-clip: both colours and the reference box must be visible");
  } else {
    const boundaryInPdf = (green.y0 - anchor.y0) / scale;
    const boundaryComposed = before["partial-clip"].rect.top + 6 - before.anchor.top;
    if (Math.abs(boundaryInPdf - boundaryComposed) > 2) {
      faults.push(`partial-clip: colour boundary ${boundaryInPdf} CSS px below anchor, composed ${boundaryComposed}`);
    }
  }
  if (!before["wide-table"] || before["wide-table"].natural[0] !== 900 ||
      !(before["wide-table"].rect.width < 900)) {
    faults.push("wide-table: the bitmap did not enter shrink-to-fit without its own width");
  }
  if (!before["closed-details"] || !before["zero-clip"]) {
    faults.push("hidden images: the browser did not compose both source elements");
  }
  if (colourBox(page, ROSE)) faults.push("hidden images: rose pixels appeared in the PDF");
  for (const [name, colour] of [["absolute-escape", MAGENTA], ["auto-visible", LIME]]) {
    const composed = before[name]?.rect;
    const box = colourBox(page, colour);
    ink[name] = box;
    if (!composed || !(composed.width > 0 && composed.height > 0) || !box) {
      faults.push(`${name}: no composed box or PDF colour`);
    } else if (Math.abs(box.width / scale - composed.width) > 2 ||
        Math.abs(box.height / scale - composed.height) > 2) {
      faults.push(`${name}: PDF colour ${box.width / scale}x${box.height / scale} CSS px, composed ${composed.width}x${composed.height}`);
    }
  }
  const marker = colourBox(page, BLUE);
  const table = ink["wide-table"];
  const markerTop = before["hidden-marker"]?.rect.top;
  const tableTop = before["wide-table"]?.rect.top;
  if (!marker || !table || markerTop === undefined || tableTop === undefined) {
    faults.push("hidden marker: the PDF or prewrite page has no marker");
  } else if (Math.abs((marker.y0 - table.y0) / scale - (markerTop - tableTop)) > 2) {
    faults.push(`hidden marker: PDF top ${(marker.y0 - table.y0) / scale} CSS px below table, composed ${markerTop - tableTop}`);
  }
  return { details: { capture, ink }, faults };
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

async function pdfOrFailure(page, path) {
  const started = Date.now();
  let lastSize = -1;
  for (;;) {
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0 && size === lastSize) return readFileSync(path);
      lastSize = size;
    }
    const notice = await page.evaluate(() =>
      document.querySelector('[aria-label="status message"]')?.textContent?.trim() ?? "",
    );
    if (notice.startsWith("PDF export failed:")) throw new Error(notice);
    if (Date.now() - started > 90_000) throw new Error(`file did not settle: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export default {
  name: "pdf-inspector",
  async run(ctx) {
    const { page } = ctx;
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
        pages: 5,
        inspect: inspectBoxDeck,
      },
      {
        file: "layout-images.md",
        pdf: "layout-images.pdf",
        orientation: "portrait",
        pages: 1,
        inspect: inspectLayoutImages,
      },
      {
        file: "layout-height.md",
        pdf: "layout-height.pdf",
        orientation: "portrait",
        pages: 1,
        inspect: inspectHeightImage,
      },
      {
        file: "missing-image.md",
        pdf: "missing-image.pdf",
        failure: "missing.png",
      },
    ];
    const details = {};
    // What the pixel reads measured, for the message of a failed run.
    const pixels = {};
    const faults = [];
    for (const c of cases) {
      const target = join(ctx.downloadDir, c.pdf);
      if (existsSync(target)) rmSync(target);

      await selectTreeFile(page, c.file);
      if (c.file === "layout-images.md" || c.file === "layout-height.md") {
        await watchImageLift(page, c.file === "layout-images.md" ? "wide-table" : "height-only");
      }
      await clickExportToPdf(page);
      if (c.failure) {
        let refused = "";
        try {
          await pdfOrFailure(page, target);
        } catch (error) {
          refused = error instanceof Error ? error.message : String(error);
        }
        if (!refused.startsWith("PDF export failed: image ") ||
            !refused.includes(c.failure)) {
          throw new Error(`${c.pdf}: expected a named image refusal, got ${refused || "a PDF"}`);
        }
        details[c.file] = refused;
        continue;
      }
      const bytes = await pdfOrFailure(page, target);
      await ctx.shot(`exported-${c.file}`);
      const capture = (c.file === "layout-images.md" || c.file === "layout-height.md") ? await page.evaluate(() => {
        const result = window.__pdfImageLift?.capture;
        window.__pdfImageLift?.restore();
        delete window.__pdfImageLift;
        return result;
      }) : undefined;

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
        const read = c.inspect(await pdfPageRasters(bytes), capture);
        details[`${c.file}:pixels`] = read.details;
        pixels[c.pdf] = read.details;
        faults.push(...read.faults.map((fault) => `${c.pdf} ${fault}`));
      }
    }
    if (faults.length > 0) {
      throw new Error(`${faults.join("\n")}\nmeasured: ${JSON.stringify(pixels)}`);
    }
    return details;
  },
};
