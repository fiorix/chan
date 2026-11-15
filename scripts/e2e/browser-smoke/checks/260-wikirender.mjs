import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFileTab, selectFile } from "../lib/files.mjs";
import { pdfPageRasters } from "../lib/pdf.mjs";

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

async function exportPdf(ctx, path, pane) {
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
  writeFileSync(join(ctx.outDir, filename), bytes);
  return { bytes, rasters: await pdfPageRasters(bytes), filename };
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

      // The assertions remain pending until every export and raster is saved,
      // so the base run supplies the same visual evidence as the fixed run.
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
      assert.equal(faults.length, 0, faults.join("\n"));
      return evidence;
    } catch (error) {
      error.smokeDetails = { ...evidence, faults };
      throw error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
      writeFileSync(join(ctx.outDir, "wikirender.json"),
        JSON.stringify({ evidence, faults }, null, 2) + "\n");
    }
  },
};
