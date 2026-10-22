// A press on a rendered widget keeps it drawn under the held button, shows
// its source at the release with the caret where the widget's press puts
// it, and a pixel of motion during the press selects nothing, so the typed
// character lands in the widget's source and deletes nothing. The image
// keeps its own press: the ring, and no caret move.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const PAGE_BREAK = '<hr class="chan-page-break">';
const DOC = [
  "plain control",
  "",
  "| a | b |",
  "| --- | --- |",
  "| one | two |",
  "",
  "```mermaid",
  "graph LR",
  "  A --> B",
  "```",
  "",
  "See [[notes]] for more.",
  "",
  PAGE_BREAK,
  "",
  "![box](box.png)",
  "",
  "end",
].join("\n");
const EDITOR = ".editor-tab.active .cm-content";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each widget: its rendered element, the element pressed inside it, and the
// caret its press places in DOC.
const WIDGETS = [
  { name: "table", selector: ".cm-md-table-wrap", pick: "td", text: "one", caret: DOC.indexOf("| one") + "| one".length },
  { name: "diagram", selector: ".cm-md-diagram-rendered", pick: ".cm-md-diagram-body svg", caret: DOC.indexOf("graph LR") },
  { name: "page break", selector: ".cm-md-page-break", pick: null, caret: DOC.indexOf(PAGE_BREAK) + PAGE_BREAK.length },
  { name: "wikilink", selector: ".cm-md-wiki-pill", pick: null, caret: DOC.indexOf("]]") },
];

/// An opaque PNG, wide enough that its hover action row covers only its top
/// right corner.
function png(width, height) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function reset(page, selector, ready) {
  await page.bringToFront();
  await page.evaluate(async ({ doc, editor }) => {
    const view = document.querySelector(editor)?.cmTile?.root?.view;
    if (!view) throw new Error("editor view unavailable");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: 0 } });
    view.focus();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { doc: DOC, editor: EDITOR });
  await page.waitForFunction((editor, wanted) => {
    const el = document.querySelector(editor)?.querySelector(wanted);
    const box = el?.getBoundingClientRect();
    return Boolean(box && box.width > 4 && box.height > 4);
  }, { timeout: 30_000 }, EDITOR, ready ?? selector);
}

async function pointIn(page, widget, where = { x: 0.5, y: 0.5 }) {
  return page.evaluate(({ editor, widget, where }) => {
    const root = document.querySelector(editor).querySelector(widget.selector);
    let target = root;
    if (widget.pick) {
      const candidates = [...root.querySelectorAll(widget.pick)];
      target = candidates.find((el) => !widget.text || el.textContent.includes(widget.text));
      if (!target) throw new Error(`no ${widget.pick} in the ${widget.name}`);
    }
    target.scrollIntoView({ block: "center" });
    const box = target.getBoundingClientRect();
    return { x: Math.round(box.left + box.width * where.x), y: Math.round(box.top + box.height * where.y) };
  }, { editor: EDITOR, widget, where });
}

async function sample(page, selector) {
  return page.evaluate(async ({ editor, selector }) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const content = document.querySelector(editor);
    const view = content?.cmTile?.root?.view;
    if (!view) throw new Error("editor view unavailable");
    const { head, empty } = view.state.selection.main;
    return {
      head,
      empty,
      ranges: view.state.selection.ranges.length,
      lines: content.querySelectorAll(".cm-line").length,
      drawn: Boolean(content.querySelector(selector)),
      focused: view.hasFocus,
      doc: view.state.doc.toString(),
    };
  }, { editor: EDITOR, selector });
}

const insertedAt = (pos) => DOC.slice(0, pos) + "x" + DOC.slice(pos);
const strip = ({ doc, ...rest }) => rest;

/// Press, dwell, one pixel of motion, release, one typed character. With
/// `background`, a transaction that neither edits nor selects is dispatched
/// from the page during the hold; with `unfocused`, the editor has no focus
/// at the press.
async function press(page, widget, { background = false, unfocused = false } = {}) {
  await reset(page, widget.selector);
  const point = await pointIn(page, widget);
  if (unfocused) {
    await page.evaluate((editor) => document.querySelector(editor).blur(), EDITOR);
  }
  const rest = await sample(page, widget.selector);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await sleep(250);
  const held = await sample(page, widget.selector);
  let afterBackground = null;
  if (background) {
    await page.evaluate((editor) => document.querySelector(editor).cmTile.root.view.dispatch({}), EDITOR);
    await sleep(250);
    afterBackground = await sample(page, widget.selector);
  }
  await page.mouse.move(point.x + 1, point.y, { steps: 1 });
  await sleep(250);
  const moved = await sample(page, widget.selector);
  await page.mouse.up();
  const released = await sample(page, widget.selector);
  await page.keyboard.type("x");
  const typed = await sample(page, widget.selector);
  const drawnHeld = (s) => s.drawn && s.lines === rest.lines && s.empty && s.ranges === 1 && s.head === widget.caret;
  const faults = [];
  if (!rest.drawn) faults.push("not drawn before the press");
  if (!drawnHeld(held)) faults.push("not held drawn at the press");
  if (afterBackground && !drawnHeld(afterBackground)) faults.push("not held drawn through a background transaction");
  if (!drawnHeld(moved)) faults.push("not held drawn, or a range, after one pixel");
  if (released.drawn || !released.empty || released.head !== widget.caret || !released.focused) faults.push("source, caret or focus wrong at the release");
  if (typed.doc !== insertedAt(widget.caret)) faults.push("the typed character is not at the caret");
  return { widget: widget.name, background, unfocused, point, rest: strip(rest), held: strip(held), afterBackground: afterBackground && strip(afterBackground), moved: strip(moved), released: strip(released), typedOk: typed.doc === insertedAt(widget.caret), faults };
}

/// The image's own press lights its ring and moves no caret: a press on the
/// picture, clear of its hover action row.
async function pressImage(page) {
  const widget = { name: "image", selector: ".cm-md-image-wrap", pick: "img" };
  await reset(page, widget.selector, ".cm-md-image-wrap img");
  await page.waitForFunction((editor) => {
    const img = document.querySelector(editor)?.querySelector(".cm-md-image-wrap img");
    return Boolean(img?.complete && img.naturalWidth > 0);
  }, { timeout: 30_000 }, EDITOR);
  const point = await pointIn(page, widget, { x: 0.2, y: 0.8 });
  await page.mouse.move(point.x, point.y);
  await sleep(300);
  const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, point);
  if (under !== "IMG") throw new Error(`the image press point is over ${under}, not the picture`);
  await page.mouse.down();
  await sleep(250);
  await page.mouse.up();
  const released = await page.evaluate(async (editor) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const content = document.querySelector(editor);
    const view = content.cmTile.root.view;
    return {
      head: view.state.selection.main.head,
      ring: Boolean(content.querySelector(".cm-md-image-wrap[data-selected]")),
      editing: Boolean(content.querySelector('.cm-md-image-wrap[data-editing="true"]')),
      zoom: Boolean(document.querySelector(".md-image-zoom")),
    };
  }, EDITOR);
  const faults = [];
  if (!released.ring || released.editing || released.zoom || released.head !== 0) faults.push("ring, edit mode, zoom or caret wrong at the release");
  return { widget: "image", point, released, faults };
}

export default {
  name: "widget-press",
  async run(ctx) {
    const { page } = ctx;
    writeFileSync(join(ctx.workspaceDir, "widgets.md"), DOC);
    writeFileSync(join(ctx.workspaceDir, "notes.md"), "# notes\n");
    writeFileSync(join(ctx.workspaceDir, "box.png"), png(480, 240));
    const windowId = new URL(page.url()).searchParams.get("w");
    await ctx.waitWindowLive(windowId);
    await ctx.exec(ctx.chanBin, ["shell", "open", "widgets.md"], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 30_000,
    });
    await page.waitForFunction(({ editor, doc }) =>
      document.querySelector(editor)?.cmTile?.root?.view?.state.doc.toString() === doc,
    { timeout: 30_000 }, { editor: EDITOR, doc: DOC });
    // The diagram renders once its library has loaded.
    await page.waitForFunction((editor) => Boolean(document.querySelector(editor)?.querySelector(".cm-md-diagram-rendered svg")),
      { timeout: 30_000 }, EDITOR);

    const readings = [];
    for (const widget of WIDGETS) readings.push(await press(page, widget));
    readings.push(await press(page, WIDGETS[0], { background: true }));
    readings.push(await press(page, WIDGETS[0], { unfocused: true }));
    readings.push(await pressImage(page));
    for (const reading of readings) console.log(`WIDGET-PRESS ${JSON.stringify(reading)}`);
    const failed = readings.filter((r) => r.faults.length > 0);
    if (failed.length) {
      throw new Error(`widget press faults: ${failed.map((r) => `${r.widget}${r.background ? " (background)" : ""}${r.unfocused ? " (unfocused)" : ""}: ${r.faults.join(", ")}`).join("; ")}`);
    }
    return { readings };
  },
};
