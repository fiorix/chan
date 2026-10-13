// Real pointer placement at the visible end of rendered Markdown marks.
// Each click types a character to pin which side of the hidden tail owns it.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const DOC = [
  "plain control", "**Reply:**", "**Reply:** after", "*Reply:*", "*Reply:* after",
  "`Reply:`", "`Reply:` after", "[reply](https://example.test)",
  "[reply](https://example.test) after", "<https://example.test>", "~~reply~~",
].join("\n");
const EDITOR = ".editor-tab.active .cm-content";
const ROWS = [
  { kind: "bold", line: 2, inner: 22, outer: 24, rowEnd: 24, style: "cm-md-bold", contentStart: 16 },
  { kind: "bold", line: 3, inner: 33, outer: 35, rowEnd: 41, style: "cm-md-bold", contentStart: 27 },
  { kind: "italic", line: 4, inner: 49, outer: 50, rowEnd: 50, style: "cm-md-italic", contentStart: 43 },
  { kind: "italic", line: 5, inner: 58, outer: 59, rowEnd: 65, style: "cm-md-italic", contentStart: 52 },
  { kind: "code", line: 6, inner: 73, outer: 74, rowEnd: 74, style: "cm-md-code", contentStart: 67 },
  { kind: "code", line: 7, inner: 82, outer: 83, rowEnd: 89, style: "cm-md-code", contentStart: 76 },
  { kind: "link", line: 8, inner: 96, outer: 119, rowEnd: 119, style: "cm-md-link", contentStart: 91 },
  { kind: "link", line: 9, inner: 126, outer: 149, rowEnd: 155, style: "cm-md-link", contentStart: 121 },
  { kind: "autolink", line: 10, inner: 177, outer: 178, rowEnd: 178, style: "cm-md-link", contentStart: 157 },
  { kind: "strike", line: 11, inner: 186, outer: 188, rowEnd: 188, style: "cm-md-strike", contentStart: 181 },
];

async function resetAndPoint(page, row, kind) {
  await page.bringToFront();
  return page.evaluate(async ({ row, kind, doc, selector }) => {
    const content = document.querySelector(selector);
    const view = content?.cmTile?.root?.view;
    if (!view) throw new Error("editor view unavailable");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: 0 } });
    view.focus();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const line = [...content.querySelectorAll(".cm-line")][row.line - 1];
    const mark = line?.querySelector(`.${row.style}`);
    if (!mark) throw new Error(`missing ${row.style} on row ${row.line}: ${line?.outerHTML}`);
    const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.length) nodes.push(node);
    }
    const node = kind === "inside" ? nodes[0] : nodes.at(-1);
    if (!node) throw new Error(`no text in ${row.style} on row ${row.line}`);
    const range = document.createRange();
    if (kind === "inside") {
      range.setStart(node, 0);
      range.setEnd(node, 1);
    } else {
      range.setStart(node, node.textContent.length - 1);
      range.setEnd(node, node.textContent.length);
    }
    const box = range.getBoundingClientRect();
    const contentBox = content.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const x = kind === "inside" ? box.left + box.width / 4
      : kind === "blank" ? Math.min(box.right + 160, contentBox.right - 250)
      : box.right - Math.min(1, box.width / 10);
    return { x, y, lineText: line.textContent, hit: view.posAtCoords({ x, y }) };
  }, { row, kind, doc: DOC, selector: EDITOR });
}

async function selection(page) {
  await page.bringToFront();
  return page.evaluate(async (selector) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const view = document.querySelector(selector)?.cmTile?.root?.view;
    if (!view) throw new Error("editor view unavailable after click");
    const { anchor, head, empty } = view.state.selection.main;
    const line2 = document.querySelector(selector)?.querySelectorAll(".cm-line")[1]?.textContent;
    return { anchor, head, empty, line2, doc: view.state.doc.toString() };
  }, EDITOR);
}

async function typeAtSelection(page) {
  await page.bringToFront();
  await page.evaluate((selector) => document.querySelector(selector)?.cmTile?.root?.view?.focus(), EDITOR);
  await page.keyboard.type("x");
  return selection(page);
}

function insertedAt(pos) {
  return DOC.slice(0, pos) + "x" + DOC.slice(pos);
}

export default {
  name: "editor-mark-clicks",
  async run(ctx) {
    const { page } = ctx;
    writeFileSync(join(ctx.workspaceDir, "mdclick.md"), DOC);
    const windowId = new URL(page.url()).searchParams.get("w");
    await ctx.waitWindowLive(windowId);
    await ctx.exec(ctx.chanBin, ["shell", "open", "mdclick.md"], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 30_000,
    });
    await page.waitForFunction(({ selector, doc }) =>
      document.querySelector(selector)?.cmTile?.root?.view?.state.doc.toString() === doc,
    { timeout: 30_000 }, { selector: EDITOR, doc: DOC });

    const readings = [];
    const failures = [];
    for (const row of ROWS) {
      for (const kind of ["glyph", "blank"]) {
        const point = await resetAndPoint(page, row, kind);
        await page.mouse.click(point.x, point.y);
        const atClick = await selection(page);
        const afterType = await typeAtSelection(page);
        const expected = kind === "glyph" ? row.outer : row.rowEnd;
        const ok = atClick.empty && atClick.head === expected && afterType.doc === insertedAt(expected);
        const reading = { row: row.line, mark: row.kind, kind, point, expected, atClick, afterType: { head: afterType.head, doc: afterType.doc }, ok };
        readings.push(reading);
        console.log(`MDCLICK ${JSON.stringify(reading)}`);
        if (!ok) failures.push(`${row.kind} row ${row.line} ${kind}`);
      }
    }

    const inside = await resetAndPoint(page, ROWS[0], "inside");
    await page.mouse.click(inside.x, inside.y);
    const insideClick = await selection(page);
    const insideType = await typeAtSelection(page);
    const insideOk = insideClick.empty && insideClick.head >= ROWS[0].contentStart &&
      insideClick.head < ROWS[0].inner && insideType.doc === insertedAt(insideClick.head);
    console.log(`MDCLICK-INSIDE ${JSON.stringify({ point: inside, atClick: insideClick, afterType: insideType, ok: insideOk })}`);
    if (!insideOk) failures.push("inside click");

    for (const direction of [-1, 1]) {
      const point = await resetAndPoint(page, ROWS[0], "glyph");
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await new Promise((resolve) => setTimeout(resolve, 700));
      await page.mouse.move(point.x + direction, point.y, { steps: 1 });
      await page.mouse.up();
      const atRelease = await selection(page);
      const afterType = await typeAtSelection(page);
      const ok = atRelease.empty && atRelease.head === 24 && afterType.doc === insertedAt(24);
      console.log(`MDCLICK-MOTION ${JSON.stringify({ direction, point, atRelease, afterType, ok })}`);
      if (!ok) failures.push(`last glyph motion ${direction}`);
    }

    const effectPoint = await resetAndPoint(page, ROWS[0], "glyph");
    await page.mouse.move(effectPoint.x, effectPoint.y);
    await page.mouse.down();
    await page.evaluate((selector) => {
      const view = document.querySelector(selector)?.cmTile?.root?.view;
      if (!view) throw new Error("editor view unavailable during held press");
      view.dispatch({});
    }, EDITOR);
    const afterEffect = await selection(page);
    await page.mouse.move(effectPoint.x + 1, effectPoint.y, { steps: 1 });
    await page.mouse.up();
    const effectRelease = await selection(page);
    const effectType = await typeAtSelection(page);
    const effectOk = afterEffect.empty && afterEffect.anchor === 24 && afterEffect.head === 24 && afterEffect.line2 === "Reply:" &&
      effectRelease.empty && effectRelease.anchor === 24 && effectRelease.head === 24 && effectType.doc === insertedAt(24);
    console.log(`MDCLICK-EFFECT ${JSON.stringify({ point: effectPoint, afterEffect, atRelease: effectRelease, afterType: effectType, ok: effectOk })}`);
    if (!effectOk) failures.push("held press across empty transaction");

    const dragStart = await resetAndPoint(page, ROWS[0], "glyph");
    const dragEnd = await resetAndPoint(page, ROWS[0], "inside");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    const dragHeld = await selection(page);
    await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 });
    const dragMoved = await selection(page);
    await page.mouse.up();
    const dragSelection = await selection(page);
    const dragOk = dragHeld.line2 === "Reply:" && dragMoved.line2 === "Reply:" &&
      !dragSelection.empty && dragSelection.anchor === 22 && dragSelection.head === 16;
    console.log(`MDCLICK-DRAG ${JSON.stringify({ from: dragStart, to: dragEnd, held: dragHeld, moved: dragMoved, atRelease: dragSelection, ok: dragOk })}`);
    if (!dragOk) failures.push("drag across bold text");

    const insidePoint = await resetAndPoint(page, ROWS[0], "inside");
    await page.mouse.move(insidePoint.x, insidePoint.y);
    await page.mouse.down();
    await page.mouse.move(insidePoint.x + 1, insidePoint.y, { steps: 1 });
    await page.mouse.up();
    const insideMotion = await selection(page);
    console.log(`MDCLICK-INSIDE-MOTION ${JSON.stringify({ point: insidePoint, atRelease: insideMotion })}`);
    if (!insideMotion.empty || insideMotion.head < ROWS[0].contentStart || insideMotion.head >= ROWS[0].inner) {
      failures.push("inside glyph motion");
    }

    if (failures.length) throw new Error(`mark click faults: ${failures.join(", ")}`);
    return { readings, insideClick, insideMotion };
  },
};
