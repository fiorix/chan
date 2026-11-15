import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFileTab, selectFile } from "../lib/files.mjs";
import { colourBox, pdfPageRasters, pixelAt } from "../lib/pdf.mjs";

const BODY = "# Wikilinks\n\n[[note]]\n\n[[note|alias]]\n\nEnd.\n";
const PLAIN = "# Wikilinks\n\nnote\n\nalias\n\nEnd.\n";
const FRONT = "---\nchan:\n  kind: slides\n---\n\n";
const DIRECTORY = "wiki-probe";
const PREVIEW = ".md-slide-preview .md-slide-preview-content";

async function focusedPane(page) {
  const id = await page.evaluate(() =>
    (document.querySelector(".pane.focused") ?? document.querySelector(".pane"))
      ?.getAttribute("data-pane-id"),
  );
  assert(id, "the active pane has no id");
  return `.pane[data-pane-id=${JSON.stringify(id)}]`;
}

async function openEditor(page, path, pane) {
  await openFileTab(page, path, pane);
  const active = `${pane} .editor-tab.active`;
  await page.waitForSelector(`${active} .cm-editor`, { visible: true, timeout: 30_000 });
  if (await page.$(`${active} .md-source`)) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", {
      detail: { name: "app.editor.toggleMode" },
    })));
  }
  const content = `${active} .md-wysiwyg-cm6 .cm-content`;
  await page.waitForSelector(content, { visible: true, timeout: 30_000 });
  await page.click(content);
  return content;
}

async function exportPdf(ctx, path, pane, outputName) {
  const filename = path.split("/").at(-1).replace(/\.md$/, ".pdf");
  const target = join(ctx.downloadDir, filename);
  rmSync(target, { force: true });
  await selectFile(ctx.page, path, { details: true, scope: pane });
  const details = `${pane} aside[aria-label="Details"]`;
  await ctx.page.waitForSelector(`${details} .pill-caret`, { visible: true });
  await ctx.page.click(`${details} .pill-caret`);
  await ctx.page.waitForSelector(`${details} .action-menu-item`, { visible: true });
  const clicked = await ctx.page.evaluate((scope) => {
    const item = [...document.querySelectorAll(`${scope} .action-menu-item`)]
      .find((el) => el.textContent?.includes("Export to PDF"));
    item?.click();
    return Boolean(item);
  }, details);
  assert(clicked, "Export to PDF action absent");
  const bytes = await ctx.pollFile(target, 90_000);
  writeFileSync(join(ctx.outDir, outputName ?? filename), bytes);
  return { bytes, rasters: await pdfPageRasters(bytes), filename: outputName ?? filename };
}

async function captureDocument(page) {
  await page.evaluate(() => {
    if (window.__pdfPageWindows) throw new Error("document capture already installed");
    const cloneNode = Node.prototype.cloneNode;
    const originals = new Map();
    const clones = [];
    function observedClone(deep) {
      const capture = this instanceof HTMLElement && this.matches(".chan-print-page") &&
        this.isConnected && this.style.height === "" && this.parentElement?.style.left === "-10000px";
      if (capture && !originals.has(this)) {
        const content = this.querySelector(".chan-print-content");
        const origin = content.getBoundingClientRect();
        const bounds = (el) => {
          const rect = el.getBoundingClientRect();
          return { top: rect.top - origin.top, bottom: rect.bottom - origin.top,
            left: rect.left - origin.left, right: rect.right - origin.left };
        };
        originals.set(this, {
          blocks: [...content.children].map((el) => ({ ...bounds(el),
            pageBreak: el.hasAttribute("data-page-break") })),
          diagrams: [...content.querySelectorAll(".md-slide-diagram svg, .md-slide-excalidraw svg")]
            .map((el) => ({ ...bounds(el), text: el.textContent, paths: el.querySelectorAll("path").length })),
        });
      }
      const clone = cloneNode.call(this, deep);
      if (capture) clones.push(clone);
      return clone;
    }
    Node.prototype.cloneNode = observedClone;
    window.__pdfPageWindows = () => {
      Node.prototype.cloneNode = cloneNode;
      delete window.__pdfPageWindows;
      return { originals: [...originals.values()], windows: clones.map((clone) => {
        const startPx = -parseFloat(clone.querySelector(".chan-print-content").style.marginTop);
        return { startPx, endPx: startPx + parseFloat(clone.style.height) };
      }) };
    };
  });
}

async function preferences(ctx, patch) {
  const token = new URL(ctx.serverUrl).searchParams.get("t");
  return ctx.page.evaluate(async ({ token, patch }) => {
    const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const response = await fetch("/api/config", { headers });
    if (!response.ok) throw new Error(`config read ${response.status}`);
    const config = await response.json();
    if (patch) {
      const changed = await fetch("/api/config", { method: "PATCH", headers,
        body: JSON.stringify({ expected_revision: config.revision, preferences: patch }) });
      if (!changed.ok) throw new Error(`config patch ${changed.status}`);
    }
    return config.preferences;
  }, { token, patch });
}

function inspectDocument(capture, rasters) {
  assert(capture, "document window capture missing");
  assert.equal(capture.originals.length, 1, "expected one composed document");
  assert.equal(capture.windows.length, rasters.length, "captured/exported page count differs");
  const { blocks, diagrams } = capture.originals[0];
  assert(blocks.length > 0, "composed document has no blocks");
  const gapPages = capture.windows.flatMap((window, index) => {
    assert(Number.isFinite(window.startPx) && Number.isFinite(window.endPx) &&
      window.endPx > window.startPx, "invalid captured page window");
    // CSS serialization rounds fractional cuts; allow less than one CSS pixel.
    const content = blocks.some((block) => !block.pageBreak &&
      block.bottom > window.startPx + 0.01 && block.top < window.endPx - 0.01);
    return content ? [] : [index + 1];
  });
  assert.deepEqual(gapPages, [], "document pages containing only an inter-block gap");
  assert.equal(rasters.length, 10, "document fixture page count");
  assert.equal(diagrams.length, 3, "both Mermaid diagrams and Excalidraw must render");
  for (const text of ["Source document", "Raster PDF", "Boundary diagram start", "Boundary diagram end"]) {
    assert(diagrams.some((diagram) => diagram.text.includes(text)), `diagram label missing: ${text}`);
  }
  for (const diagram of diagrams) {
    assert(diagram.paths > 0 && diagram.bottom > diagram.top, "diagram geometry missing");
    // The captured SVG's region must contain painted detail in the PDF too.
    const colours = new Set();
    for (const [index, window] of capture.windows.entries()) {
      const raster = rasters[index];
      const scale = raster.width / 669;
      const y0 = Math.max(0, Math.ceil((diagram.top - window.startPx) * scale));
      const y1 = Math.min(raster.height, Math.floor((Math.min(diagram.bottom, window.endPx) - window.startPx) * scale));
      for (let y = y0; y < y1; y += 2) {
        for (let x = Math.max(0, Math.ceil(diagram.left * scale)); x < Math.min(raster.width, diagram.right * scale); x += 2) {
          colours.add(pixelAt(raster, x, y).join(","));
        }
      }
    }
    assert(colours.size > 4, "diagram region has no painted detail in the PDF");
  }
}

function imageMarkerBoxes(rasters, colours) {
  return Object.fromEntries(Object.entries(colours).map(([name, colour]) => {
    const tolerance = name === "tallBody" || name === "boundaryLower" ? 2 : 12;
    return [name, rasters.map((raster) => colourBox(raster, colour, tolerance))];
  }));
}

async function inspectFixtures(ctx, directory, evidence, faults) {
  cpSync(join(ctx.repoRoot, "scripts/e2e/browser-smoke/fixtures/pdfexport"),
    join(directory, "pdfexport"), { recursive: true });
  const colours = JSON.parse(readFileSync(join(directory, "pdfexport/colours.json"), "utf8"));
  const original = await preferences(ctx);
  const windowId = new URL(ctx.page.url()).searchParams.get("w");
  evidence.pdfFixtures = [];
  try {
    for (const theme of ["light", "dark"]) {
      await preferences(ctx, { theme, hybrid_surface_themes: { ...original.hybrid_surface_themes, editor: theme } });
      await ctx.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await ctx.page.waitForSelector(".pane", { timeout: 30_000 });
      await ctx.waitWindowLive(windowId);
      await ctx.page.waitForFunction((want) => document.documentElement.dataset.theme === want,
        { timeout: 20_000 }, theme);
      const prefs = await preferences(ctx);
      assert.equal(prefs.hybrid_surface_themes.editor, theme);
      const pane = await focusedPane(ctx.page);
      for (const kind of ["document", "deck"]) {
        const record = { theme, kind };
        evidence.pdfFixtures.push(record);
        try {
          if (kind === "document") await captureDocument(ctx.page);
          let rendered;
          try {
            rendered = await exportPdf(ctx, `${DIRECTORY}/pdfexport/${kind}.md`, pane, `${theme}-${kind}.pdf`);
          } finally {
            if (kind === "document") record.pagination = await ctx.page.evaluate(() => window.__pdfPageWindows?.() ?? null);
          }
          record.pages = rendered.rasters.length;
          evidence.artifacts.push(rendered.filename);
          for (const [index, raster] of rendered.rasters.entries()) {
            const png = `${theme}-${kind}-page-${index + 1}.png`;
            await saveRaster(ctx, raster, png);
            evidence.artifacts.push(png);
          }
          record.colours = imageMarkerBoxes(rendered.rasters, colours);
          for (const [name, boxes] of Object.entries(record.colours)) {
            assert(boxes.some((box) => box && box.count > 100), `${theme} ${kind}: missing image marker ${name}`);
          }
          record.background = pixelAt(rendered.rasters[0], 2, 2);
          assert(theme === "dark" ? Math.max(...record.background) < 100 : Math.min(...record.background) > 180,
            `${theme} ${kind}: wrong page background ${record.background}`);
          if (kind === "document") inspectDocument(record.pagination, rendered.rasters);
          await ctx.assertPdf(rendered.bytes, { pages: kind === "document" ? 10 : 6,
            orientation: kind === "document" ? "portrait" : "landscape" });
        } catch (error) {
          record.error = error.message;
          faults.push(`${theme} ${kind}: ${error.message}`);
        }
      }
    }
  } finally {
    await preferences(ctx, { theme: original.theme, hybrid_surface_themes: original.hybrid_surface_themes ?? {} });
  }
}

async function saveRaster(ctx, raster, filename) {
  const page = await ctx.browser.newPage();
  try {
    const png = await page.evaluate(({ width, height, channels, base64 }) => {
      const raw = atob(base64);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      const pixels = context.createImageData(width, height);
      for (let p = 0; p < width * height; p++) {
        for (let c = 0; c < 3; c++) {
          pixels.data[4 * p + c] = raw.charCodeAt(channels * p + c);
        }
        pixels.data[4 * p + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      document.body.style.margin = "0";
      document.body.append(canvas);
      return canvas.toDataURL("image/png").split(",")[1];
    }, {
      width: raster.width,
      height: raster.height,
      channels: raster.channels,
      base64: Buffer.from(raster.raw).toString("base64"),
    });
    writeFileSync(join(ctx.outDir, filename), Buffer.from(png, "base64"));
  } finally {
    await page.close();
  }
}

function sameRaster(a, b) {
  return a.width === b.width && a.height === b.height &&
    a.channels === b.channels && Buffer.from(a.raw).equals(Buffer.from(b.raw));
}

export default {
  name: "wikirender",
  async run(ctx) {
    const fixtures = {
      "note.md": "# Note\n",
      "wiki-probe-note.md": BODY,
      "wiki-probe-note-reference.md": PLAIN,
      "wiki-probe-deck.md": FRONT + BODY,
      "wiki-probe-deck-reference.md": FRONT + PLAIN,
    };
    const faults = [];
    const evidence = { editor: [], slide: [], exports: {}, artifacts: [] };
    const directory = join(ctx.workspaceDir, DIRECTORY);
    mkdirSync(directory);
    try {
      for (const [name, text] of Object.entries(fixtures)) {
        writeFileSync(join(directory, name), text);
      }
      const pane = await focusedPane(ctx.page);
      const editor = await openEditor(ctx.page, `${DIRECTORY}/wiki-probe-note.md`, pane);
      await ctx.page.keyboard.down("Control");
      await ctx.page.keyboard.press("End");
      await ctx.page.keyboard.up("Control");
      await ctx.page.waitForFunction((selector) =>
        document.querySelectorAll(`${selector} .cm-md-wiki-pill`).length >= 2,
      { timeout: 15_000 }, editor);
      evidence.editor = await ctx.page.$$eval(`${editor} .cm-md-wiki-pill`,
        (items) => items.map((el) => el.textContent));
      evidence.artifacts.push(await ctx.shot("editor-wikilinks"));
      if (JSON.stringify(evidence.editor) !== JSON.stringify(["note", "alias"])) {
        faults.push(`editor labels: ${JSON.stringify(evidence.editor)}`);
      }

      await openEditor(ctx.page, `${DIRECTORY}/wiki-probe-deck.md`, pane);
      await ctx.page.keyboard.down("Control");
      await ctx.page.keyboard.press("Home");
      await ctx.page.keyboard.press("Enter");
      await ctx.page.keyboard.up("Control");
      await ctx.page.waitForSelector(PREVIEW, { visible: true, timeout: 15_000 });
      evidence.slide = await ctx.page.$$eval(`${PREVIEW} p`,
        (items) => items.map((el) => el.textContent.trim()));
      evidence.artifacts.push(await ctx.shot("slide-wikilinks"));
      if (JSON.stringify(evidence.slide) !== JSON.stringify(["note", "alias", "End."])) {
        faults.push(`slide paragraphs: ${JSON.stringify(evidence.slide)}`);
      }
      await ctx.page.keyboard.press("Escape");
      await ctx.page.waitForSelector(PREVIEW, { hidden: true });

      // Save every export and raster before reporting assertion failures.
      for (const kind of ["note", "deck"]) {
        const exports = {};
        for (const reference of [false, true]) {
          const label = reference ? "reference" : "actual";
          try {
            const filename = `wiki-probe-${kind}${reference ? "-reference" : ""}.md`;
            const rendered = await exportPdf(ctx, `${DIRECTORY}/${filename}`, pane);
            exports[label] = rendered;
            evidence.artifacts.push(rendered.filename);
            for (const [index, raster] of rendered.rasters.entries()) {
              const png = `${kind}-${label}-page-${index + 1}.png`;
              await saveRaster(ctx, raster, png);
              evidence.artifacts.push(png);
            }
            await ctx.assertPdf(rendered.bytes, {
              pages: 1,
              orientation: kind === "deck" ? "landscape" : "portrait",
            });
          } catch (error) {
            faults.push(`${kind} ${label}: ${error.message}`);
          }
        }
        const a = exports.actual?.rasters;
        const b = exports.reference?.rasters;
        const same = Boolean(a && b && a.length === b.length &&
          a.every((raster, index) => sameRaster(raster, b[index])));
        evidence.exports[kind] = {
          same,
          actual: a?.map((r) => [r.width, r.height, r.channels]) ?? null,
          reference: b?.map((r) => [r.width, r.height, r.channels]) ?? null,
        };
        if (!same) faults.push(`${kind} PDF raster differs from rendered plain labels`);
      }
      await inspectFixtures(ctx, directory, evidence, faults);
      assert.equal(faults.length, 0, faults.join("\n"));
      return evidence;
    } catch (error) {
      error.smokeDetails = { ...evidence, faults };
      throw error;
    } finally {
      writeFileSync(join(ctx.outDir, "wikirender.json"),
        JSON.stringify({ evidence, faults }, null, 2) + "\n");
      rmSync(directory, { recursive: true, force: true });
    }
  },
};
