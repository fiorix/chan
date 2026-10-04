#!/usr/bin/env node
// Read the same PDF page pixels as the Chrome inspector after a WebKitGTK export.

import { readFileSync } from "node:fs";

import { pdfPageRasters, assertPdf } from "./browser-smoke/lib/pdf.mjs";
import {
  inspectBoxDeck,
  inspectPageEdge,
  inspectRotate,
} from "./browser-smoke/checks/20-pdf-inspector.mjs";

const CASES = {
  "deck-box.md": { orientation: "landscape", pages: 5, inspect: inspectBoxDeck },
  "layout-rotate.md": { orientation: "portrait", minPages: 1, inspect: inspectRotate },
  "layout-page-edge.md": { orientation: "portrait", minPages: 1, inspect: inspectPageEdge },
};

const [pdf, seed] = process.argv.slice(2);
if (!pdf || !CASES[seed]) {
  console.error("usage: webview-deck-export-read.mjs PDF SEED");
  process.exit(1);
}

const { orientation, pages, minPages, inspect } = CASES[seed];
const faults = [];
let summary = null;
let pixels = null;
try {
  const bytes = readFileSync(pdf);
  const rasters = await pdfPageRasters(bytes);
  if (minPages !== undefined && rasters.length < minPages) {
    faults.push(`${seed}: expected >=${minPages} pages, got ${rasters.length}`);
  }
  try {
    summary = await assertPdf(bytes, {
      pages: pages ?? rasters.length,
      orientation,
    });
  } catch (error) {
    faults.push(`${seed}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const read = inspect(rasters);
  pixels = read.details;
  faults.push(...read.faults.map((fault) => `${seed}: ${fault}`));
} catch (error) {
  faults.push(`${seed}: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(JSON.stringify({ seed, pages: summary, pixels, faults }));
for (const fault of faults) console.error(fault);
process.exitCode = faults.length > 0 ? 1 : 0;
