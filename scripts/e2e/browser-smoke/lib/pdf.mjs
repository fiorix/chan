// pdf-lib byte assertions for exported PDFs: page count, A4 dims, and
// per-page nonzero raster ink. The export engine embeds each page as
// one FlateDecode image XObject (raw pixels), so ink is measured by
// inflating the stream and counting pixels that differ from the page's
// corner pixel - no canvas or native decoder needed. The same pixels
// answer where a known colour is on a page (`pdfPageRasters`,
// `colourBox`, `longestRun`), which is how a check reads an image, a
// cut or a scrollbar out of a PDF.

import { inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

const A4 = { short: 595.28, long: 841.89 };

function approx(a, b, eps = 0.5) {
  return Math.abs(a - b) <= eps;
}

/// Fraction of pixels differing from the top-left pixel by more than
/// `tol` on any channel. 0 for a blank page.
function inkRatio(raw, width, height, channels, tol = 8) {
  const total = width * height;
  if (total === 0 || raw.length < total * channels) return 0;
  let ink = 0;
  const base = [];
  for (let c = 0; c < channels; c++) base.push(raw[c]);
  for (let p = 0; p < total; p++) {
    for (let c = 0; c < channels; c++) {
      if (Math.abs(raw[p * channels + c] - base[c]) > tol) {
        ink++;
        break;
      }
    }
  }
  return ink / total;
}

function pageImageInk(page) {
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  if (!xobjects) return { ratio: 0, images: 0 };
  let best = { ratio: 0, images: 0 };
  for (const key of xobjects.keys()) {
    const stream = xobjects.lookup(key);
    if (!(stream instanceof PDFRawStream)) continue;
    const dict = stream.dict;
    const width = dict.lookup(PDFName.of("Width"))?.asNumber?.() ?? 0;
    const height = dict.lookup(PDFName.of("Height"))?.asNumber?.() ?? 0;
    let raw;
    try {
      raw = inflateSync(Buffer.from(stream.contents));
    } catch {
      continue;
    }
    const channels = Math.max(1, Math.round(raw.length / (width * height)));
    const ratio = inkRatio(raw, width, height, channels);
    best = {
      ratio: Math.max(best.ratio, ratio),
      images: best.images + 1,
    };
  }
  return best;
}

/// A page's raster as its raw pixels: `{ width, height, channels, raw }`,
/// `raw` holding `channels` bytes per pixel in rows, red, green and blue
/// first. A transparent pixel reads as black here: its alpha lives in the
/// image's soft mask, which this does not read.
function pageRaster(page) {
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  if (!xobjects) return null;
  for (const key of xobjects.keys()) {
    const stream = xobjects.lookup(key);
    if (!(stream instanceof PDFRawStream)) continue;
    const dict = stream.dict;
    const width = dict.lookup(PDFName.of("Width"))?.asNumber?.() ?? 0;
    const height = dict.lookup(PDFName.of("Height"))?.asNumber?.() ?? 0;
    let raw;
    try {
      raw = inflateSync(Buffer.from(stream.contents));
    } catch {
      continue;
    }
    const channels = Math.round(raw.length / (width * height));
    if (channels < 3) continue;
    return { width, height, channels, raw };
  }
  return null;
}

/// Every page's raster, in page order (see `pageRaster`). Throws for a
/// page that carries none, so a caller never reads a missing page as an
/// empty one.
export async function pdfPageRasters(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page, i) => {
    const raster = pageRaster(page);
    if (!raster) throw new Error(`page ${i + 1}: no raster image content`);
    return raster;
  });
}

/// The colour of one pixel of a raster, as `[r, g, b]`.
export function pixelAt(raster, x, y) {
  const at = (y * raster.width + x) * raster.channels;
  return [raster.raw[at], raster.raw[at + 1], raster.raw[at + 2]];
}

/// Whether two colours differ by at most `tol` on every channel.
export function sameColour(a, b, tol) {
  return (
    Math.abs(a[0] - b[0]) <= tol &&
    Math.abs(a[1] - b[1]) <= tol &&
    Math.abs(a[2] - b[2]) <= tol
  );
}

/// Where a colour is on a raster: the box of the pixels within `tol` of
/// `rgb` on every channel and how many they are, `{ x0, y0, x1, y1, width,
/// height, count }`, or null when no pixel is. A solid block of the colour
/// has `count` equal to `width * height`.
export function colourBox(raster, rgb, tol = 10) {
  const { width, height, channels, raw } = raster;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      if (
        Math.abs(raw[at] - rgb[0]) > tol ||
        Math.abs(raw[at + 1] - rgb[1]) > tol ||
        Math.abs(raw[at + 2] - rgb[2]) > tol
      ) {
        continue;
      }
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (count === 0) return null;
  return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1, count };
}

/// The longest run of one colour in a row, among the pixels `counts`
/// accepts: `{ x, length, colour }`. A run is pixels within `tol` of its
/// first one.
export function longestRun(raster, y, counts, tol = 3) {
  let best = { x: 0, length: 0, colour: [0, 0, 0] };
  let x = 0;
  while (x < raster.width) {
    const colour = pixelAt(raster, x, y);
    if (!counts(colour)) {
      x++;
      continue;
    }
    let end = x + 1;
    while (end < raster.width && sameColour(pixelAt(raster, end, y), colour, tol)) {
      end++;
    }
    if (end - x > best.length) best = { x, length: end - x, colour };
    x = end;
  }
  return best;
}

/// Decode a page's raster to a grayscale matrix plus per-row ink
/// counts and a structured-row mask. A row is structured when its own
/// pixels vary (glyph or diagram edges); uniform regions of any color
/// carry no matching evidence. Transparent pixels decode as black in
/// the raw stream (their alpha lives in the SMask), so uniformity, not
/// distance from the background, is the featureless test.
function pageGray(page, tol = 24) {
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  if (!xobjects) return null;
  for (const key of xobjects.keys()) {
    const stream = xobjects.lookup(key);
    if (!(stream instanceof PDFRawStream)) continue;
    const dict = stream.dict;
    const width = dict.lookup(PDFName.of("Width"))?.asNumber?.() ?? 0;
    const height = dict.lookup(PDFName.of("Height"))?.asNumber?.() ?? 0;
    let raw;
    try {
      raw = inflateSync(Buffer.from(stream.contents));
    } catch {
      continue;
    }
    const channels = Math.max(1, Math.round(raw.length / (width * height)));
    const gray = new Uint8Array(width * height);
    const rowInk = new Uint32Array(height);
    const structured = new Uint8Array(height);
    let bg = 0;
    for (let c = 0; c < channels; c++) bg += raw[c];
    bg /= channels;
    for (let y = 0; y < height; y++) {
      let lo = 255;
      let hi = 0;
      for (let x = 0; x < width; x++) {
        let v = 0;
        const p = y * width + x;
        for (let c = 0; c < channels; c++) v += raw[p * channels + c];
        v /= channels;
        gray[p] = v;
        if (Math.abs(v - bg) > tol) rowInk[y]++;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      structured[y] = hi - lo > 48 ? 1 : 0;
    }
    return { gray, rowInk, structured, width, height };
  }
  return null;
}

/// Mean absolute pixel difference between page B's structured rows
/// within [bStart, bStart+band) and page A's corresponding rows
/// starting at aStart, with A blended between adjacent rows by `alpha`
/// to absorb sub-pixel raster offsets between the two page snapshots.
function bandResidual(A, B, aStart, bStart, band, alpha) {
  const { width } = A;
  let sum = 0;
  let rows = 0;
  for (let k = 0; k < band; k++) {
    if (!B.structured[bStart + k]) continue;
    rows++;
    const a0 = (aStart + k) * width;
    const a1 = Math.min(A.height - 1, aStart + k + 1) * width;
    const b0 = (bStart + k) * width;
    for (let x = 0; x < width; x++) {
      const av = (1 - alpha) * A.gray[a0 + x] + alpha * A.gray[a1 + x];
      sum += Math.abs(av - B.gray[b0 + x]);
    }
  }
  return rows === 0 ? Infinity : sum / (rows * width);
}

/// Assert that no content band is painted on two adjacent pages: for
/// each pair, the head band of page N+1 is searched for anywhere in
/// page N via a coarse row-ink-profile alignment shortlist, then a
/// sub-pixel pixel residual over the band's STRUCTURED rows only, so
/// featureless regions (page background, transparent tails) carry no
/// matching evidence. A low residual means the same ink appears on
/// both pages. Requires a document whose content does not repeat
/// itself across a boundary.
export async function assertNoDuplicateBands(
  bytes,
  { band = 400, dupResidual = 3, minStructuredRows = 40 } = {},
) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const grays = pages.map(pageGray);
  const summary = [];
  for (let i = 0; i + 1 < grays.length; i++) {
    const A = grays[i];
    const B = grays[i + 1];
    if (!A || !B || A.width !== B.width) continue;
    const bStart = B.structured.findIndex((v) => v > 0);
    if (bStart < 0) continue; // featureless page
    // Grow the band from the first structured row until it carries
    // enough structured rows to be discriminating.
    let bandRows = 0;
    let structuredRows = 0;
    while (
      bStart + bandRows < B.height &&
      bandRows < band &&
      structuredRows < 2 * minStructuredRows
    ) {
      structuredRows += B.structured[bStart + bandRows];
      bandRows++;
    }
    if (structuredRows < minStructuredRows) continue; // too sparse to judge
    // Coarse shortlist: row-ink-profile distance at every alignment.
    const coarse = [];
    for (let a = 0; a + bandRows <= A.height; a++) {
      let d = 0;
      for (let k = 0; k < bandRows; k++) {
        d += Math.abs(A.rowInk[a + k] - B.rowInk[bStart + k]);
      }
      coarse.push({ a, d });
    }
    coarse.sort((p, q) => p.d - q.d);
    let best = { a: -1, residual: Infinity };
    const tried = new Set();
    for (const { a } of coarse.slice(0, 12)) {
      for (const j of [-1, 0, 1]) {
        const aj = a + j;
        if (aj < 0 || aj + bandRows > A.height || tried.has(aj)) continue;
        tried.add(aj);
        for (const alpha of [0, 0.25, 0.5, 0.75]) {
          const r = bandResidual(A, B, aj, bStart, bandRows, alpha);
          if (r < best.residual) best = { a: aj, residual: r };
        }
      }
    }
    summary.push({
      pair: `${i + 1}/${i + 2}`,
      residual: Number(best.residual.toFixed(2)),
      align: best.a,
      structuredRows,
    });
    if (best.residual < dupResidual) {
      throw new Error(
        `pages ${i + 1}/${i + 2}: duplicated boundary band (head of page ${i + 2} ` +
          `found at page ${i + 1} row ${best.a}, residual ${best.residual.toFixed(2)} < ${dupResidual})`,
      );
    }
  }
  return summary;
}

/// Assert exported PDF bytes: `pages` (exact count), `orientation`
/// ("portrait" | "landscape", A4), and `minInkRatio` per page. Throws
/// with a precise message on the first violation; returns a summary.
export async function assertPdf(bytes, { pages, orientation, minInkRatio = 0.001 }) {
  const doc = await PDFDocument.load(bytes);
  if (doc.getPageCount() !== pages) {
    throw new Error(`expected ${pages} pages, got ${doc.getPageCount()}`);
  }
  const summary = [];
  for (const [i, page] of doc.getPages().entries()) {
    const w = page.getWidth();
    const h = page.getHeight();
    const want =
      orientation === "landscape"
        ? { w: A4.long, h: A4.short }
        : { w: A4.short, h: A4.long };
    if (!approx(w, want.w) || !approx(h, want.h)) {
      throw new Error(
        `page ${i + 1}: expected A4 ${orientation} (${want.w}x${want.h}pt), got ${w}x${h}pt`,
      );
    }
    const ink = pageImageInk(page);
    if (ink.images === 0) {
      throw new Error(`page ${i + 1}: no raster image content`);
    }
    if (ink.ratio < minInkRatio) {
      throw new Error(
        `page ${i + 1}: raster ink ratio ${ink.ratio.toFixed(5)} below ${minInkRatio}`,
      );
    }
    summary.push({ page: i + 1, widthPt: w, heightPt: h, inkRatio: ink.ratio });
  }
  return summary;
}
