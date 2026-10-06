#!/usr/bin/env node
// Say where the seed's colours are in an exported PDF. The export embeds
// each page as one raster, which the browser smoke's reader inflates with no
// canvas; this imports that reader and judges nothing: it prints, per page,
// how many pixels are within a tolerance of each named colour and the box
// they cover, as one JSON line. The driver decides what the numbers mean.
//
//   pdf-read.mjs <pdf> <colours.json>
//
// Exit 0 with the JSON line, 2 when the smoke's reader cannot be loaded, 3
// when the file cannot be read as a PDF of rasters (not a verdict on the
// export: the driver reports it).
//
// Needs `npm ci` in scripts/e2e/browser-smoke, for pdf-lib. The smoke's
// directory is the sibling of this one in a checkout; OBS_SMOKE_DIR names it
// when the drivers run from a copy that sits elsewhere.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const smoke = resolve(process.env.OBS_SMOKE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../browser-smoke"));
let colourBox;
let pdfPageRasters;
try {
  ({ colourBox, pdfPageRasters } = await import(pathToFileURL(join(smoke, "lib/pdf.mjs")).href));
} catch (error) {
  // The environment cannot run the reader; nothing was read.
  console.error(`pdf-read: cannot load the smoke's PDF reader from ${smoke}: ${error?.message ?? error}`);
  process.exit(2);
}

const [pdf, coloursFile] = process.argv.slice(2);
if (!pdf || !coloursFile) {
  console.error("usage: pdf-read.mjs <pdf> <colours.json>");
  process.exit(3);
}

try {
  const colours = JSON.parse(readFileSync(coloursFile, "utf8"));
  const bytes = readFileSync(pdf);
  const rasters = await pdfPageRasters(bytes);
  const pages = rasters.map((raster, index) => {
    const found = {};
    for (const [name, rgb] of Object.entries(colours)) {
      const box = colourBox(raster, rgb, 12);
      found[name] = box ? { count: box.count, box: [box.x0, box.y0, box.x1, box.y1] } : null;
    }
    return { page: index + 1, width: raster.width, height: raster.height, colours: found };
  });
  // The whole document's count of each colour, which is what an arm reads.
  const totals = {};
  for (const name of Object.keys(colours)) {
    totals[name] = pages.reduce((sum, page) => sum + (page.colours[name]?.count ?? 0), 0);
  }
  console.log(JSON.stringify({ pdf, bytes: bytes.length, pageCount: pages.length, totals, pages }));
} catch (error) {
  console.error(`pdf-read: ${error?.message ?? error}`);
  process.exit(3);
}
