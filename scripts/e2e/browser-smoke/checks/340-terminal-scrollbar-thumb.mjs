// Locate the thumb in the app's actual canvas paint. Blank right columns
// separate its pixels from terminal text; no widget geometry is consulted.

import assert from "node:assert/strict";
import { drainPointerInput, paintedThumbBand, pointerEvents, pointerGrid, pointerStripPixels, pointerWrites, runPointerCheck, seedPointerClipboard, settlePointer } from "../lib/terminal-pointer.mjs";

export default {
  name: "terminal-scrollbar-thumb",
  run(ctx) {
    return runPointerCheck(ctx, 340, async ({ page, details, open, leg }) => {
      details.unexercised.nativeWindowRelease = "CDP drives coordinates outside the page viewport; release outside an OS window still needs the native owner check.";
      async function prepare(name, result) {
        const terminal = await open(name);
        await terminal.prepare("THUMB340");
        await terminal.fixture.send("rows", { prefix: "THUMB340", count: 400 });
        result.setup = await drainPointerInput(terminal.fixture);
        result.history = await terminal.term.evaluate((t) => t.getScrollbackLength());
        assert.ok(result.history >= 300, "the thumb fixture has enough retained history");
        await terminal.term.evaluate((t) => t.viewport.scrollTo(t.getScrollbackLength() / 2));
        await settlePointer(page);
        result.grid = await pointerGrid(terminal.term);
        return terminal;
      }
      async function press(terminal, result) {
        // Explicit public positioning refreshes the fade before reading the
        // pixels, so a slow earlier command cannot leave an invisible target.
        await terminal.term.evaluate((t) => t.viewport.scrollBy(1));
        await settlePointer(page);
        const pixels = await pointerStripPixels(terminal.term);
        const band = paintedThumbBand(pixels.samples);
        const point = result.thumb = { x: pixels.x, y: pixels.y + (band.start + band.end) / 2 / pixels.scaleY, band };
        result.styles = await terminal.trace.evaluate(({ canvas }) => ({ user: canvas.style.userSelect, webkit: canvas.style.webkitUserSelect }));
        await seedPointerClipboard(page, "SMOKE340_THUMB_SENTINEL");
        result.writeIndex = (await pointerWrites(page)).length;
        result.inputIndex = terminal.fixture.records.length;
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        const event = result.press = (await pointerEvents(terminal.trace)).findLast((event) => event.type === "pointerdown" && event.onCanvas);
        assert.ok(event?.isTrusted && event.isPrimary && event.pointerType === "mouse", "the painted thumb received a trusted mouse press");
        result.captured = await terminal.trace.evaluate((trace, id) => trace.canvas.hasPointerCapture(id), event.pointerId);
        assert.equal(await terminal.trace.evaluate(({ canvas }) => canvas.style.userSelect), "none", "the thumb press owns the canvas selection style");
        result.atPress = await terminal.term.evaluate((t) => t.viewport.offset);
        return point;
      }
      async function noSelectionOrReport(terminal, result) {
        result.after = await drainPointerInput(terminal.fixture, "", result.inputIndex);
        result.selection = await terminal.term.evaluate((t) => t.getSelection());
        result.writes = (await pointerWrites(page)).slice(result.writeIndex);
        assert.equal(result.after.input, "", "thumb input sends no PTY bytes");
        assert.equal(result.selection, "", "thumb input selects no terminal text");
        assert.deepEqual(result.writes, [], "thumb input attempts no clipboard write");
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "SMOKE340_THUMB_SENTINEL", "thumb input keeps the sentinel");
      }

      await leg("drag-and-release", async (result) => {
        const terminal = await prepare("drag", result);
        const point = await press(terminal, result);
        await page.mouse.move(point.x, point.y + 60, { steps: 5 });
        result.dragged = await terminal.term.evaluate((t) => t.viewport.offset);
        assert.ok(result.dragged < result.atPress && result.dragged > 0, "dragging the painted thumb moves toward newer history");
        await page.mouse.up();
        result.releasedStyles = await terminal.trace.evaluate(({ canvas }) => ({ user: canvas.style.userSelect, webkit: canvas.style.webkitUserSelect }));
        assert.deepEqual(result.releasedStyles, result.styles, "release immediately restores both selection styles");
        await page.mouse.move(point.x, point.y + 120);
        await settlePointer(page);
        result.afterRelease = await terminal.term.evaluate((t) => t.viewport.offset);
        assert.equal(result.afterRelease, result.dragged, "motion after release cannot move the thumb");
        await noSelectionOrReport(terminal, result);
      });

      await leg("overshoot-reverse", async (result) => {
        const terminal = await prepare("overshoot", result);
        const point = await press(terminal, result);
        const top = result.grid.y;
        await page.mouse.move(point.x, top + 1, { steps: 8 });
        await page.mouse.move(point.x, top - 180, { steps: 8 });
        result.firstClamp = await terminal.term.evaluate((t) => t.viewport.offset);
        await page.mouse.move(point.x, top - 200);
        result.secondClamp = await terminal.term.evaluate((t) => t.viewport.offset);
        assert.equal(result.firstClamp, result.history, "the drag reached the oldest retained row");
        assert.equal(result.secondClamp, result.history, "another overshooting move remains clamped");
        await page.mouse.move(point.x, top - 198);
        result.reversed = await terminal.term.evaluate((t) => t.viewport.offset);
        result.events = await pointerEvents(terminal.trace);
        const moves = result.events.filter((event) => event.type === "pointermove" && event.onCanvas && event.buttons === 1);
        assert.ok(moves.some((event) => event.isTrusted && Math.abs(event.y - (top - 200)) < 0.01), "the engine delivered the full 200-pixel overshoot");
        assert.ok(moves.some((event) => event.isTrusted && Math.abs(event.y - (top - 198)) < 0.01), "the engine delivered the two-pixel reversal");
        assert.ok(result.reversed < result.secondClamp && result.reversed > 0, "a two-pixel reversal moves immediately after repeated clamping");
        await page.mouse.up();
        await noSelectionOrReport(terminal, result);
      });

      await leg("hidden-last-column", async (result) => {
        const terminal = await prepare("last-column", result);
        await terminal.term.evaluate((t) => t.viewport.scrollToBottom());
        const grid = result.grid;
        result.textSetup = await drainPointerInput(terminal.fixture, `\x1b[2J\x1b[1;${grid.cols}HZ\x1b[3;1H`);
        assert.equal(result.textSetup.reply, "\x1b[3;1R", "the last-column marker and cursor position were parsed");
        // Wait for the visible overlay to fade, measuring blank rows below
        // the marker. The first scan also proves the paint reader saw it.
        const visible = await pointerStripPixels(terminal.term, 3);
        result.visiblePeak = Math.max(...visible.samples);
        assert.ok(result.visiblePeak >= 12, "the overlay was visible before waiting for its fade");
        const deadline = Date.now() + 8_000;
        let pixels;
        do {
          await settlePointer(page);
          pixels = await pointerStripPixels(terminal.term, 3);
        } while (Math.max(...pixels.samples) > 1 && Date.now() < deadline);
        result.hiddenPeak = Math.max(...pixels.samples);
        assert.ok(result.hiddenPeak <= 1, "the overlay is hidden in the actual canvas paint");
        const start = grid.x + grid.width - grid.w * 0.9;
        const end = grid.x + grid.width - grid.w * 0.05;
        assert.ok(grid.w * 0.9 >= 4 && grid.w * 0.9 <= 12, "the press lies in both the last column and the hidden strip");
        await seedPointerClipboard(page, "SMOKE340_LAST_COLUMN_SENTINEL");
        const writes = (await pointerWrites(page)).length;
        await page.mouse.move(start, grid.y + grid.h * 0.5);
        await page.mouse.down();
        await page.mouse.move(end, grid.y + grid.h * 0.5, { steps: 3 });
        result.heldSelection = await terminal.term.evaluate((t) => t.getSelection());
        await page.mouse.up();
        await settlePointer(page);
        result.clipboard = await page.evaluate(() => navigator.clipboard.readText());
        result.writes = (await pointerWrites(page)).slice(writes);
        assert.equal(result.heldSelection, "Z", "the hidden strip permits selection of the last column");
        assert.equal(result.clipboard, "Z", "the last column copies on release");
        assert.deepEqual(result.writes, [{ text: "Z", status: "fulfilled" }], "the last-column selection copies once");
      });

      await leg("captured-outside-viewport-release", async (result) => {
        const terminal = await prepare("outside", result);
        const point = await press(terminal, result);
        assert.equal(result.captured, true, "the painted thumb acquired capture before leaving the viewport");
        result.outside = await page.evaluate((x) => ({ x, y: innerHeight + 40, width: innerWidth, height: innerHeight,
          hitsPage: document.elementFromPoint(x, innerHeight + 40) !== null }), point.x);
        assert.equal(result.outside.hitsPage, false, "the release point is outside the page viewport");
        await page.mouse.move(point.x, result.outside.y, { steps: 8 });
        result.atEdge = await terminal.term.evaluate((t) => t.viewport.offset);
        assert.ok(result.atEdge < result.atPress, "the captured thumb moved before its outside release");
        await page.mouse.up();
        // Read before the buttonless move: that move has a separate cleanup
        // guard and must not conceal a broken release handler.
        result.afterRelease = await terminal.trace.evaluate((trace, id) => ({ captured: trace.canvas.hasPointerCapture(id),
          styles: { user: trace.canvas.style.userSelect, webkit: trace.canvas.style.webkitUserSelect } }), result.press.pointerId);
        assert.equal(result.afterRelease.captured, false, "outside release ends capture immediately");
        assert.deepEqual(result.afterRelease.styles, result.styles, "outside release restores styles before any later move");
        result.events = await pointerEvents(terminal.trace);
        const releases = result.events.filter((event) => event.type === "pointerup" && event.onCanvas && event.pointerId === result.press.pointerId);
        const losses = result.events.filter((event) => event.type === "lostpointercapture" && event.onCanvas && event.pointerId === result.press.pointerId);
        assert.equal(releases.length, 1, "the captured canvas receives exactly one release");
        assert.equal(losses.length, 1, "capture is lost exactly once after release");
        assert.ok(releases[0].isTrusted && releases[0].y > result.outside.height, "the native release retains its outside-viewport coordinates");
        await page.mouse.move(point.x, point.y - 30);
        await settlePointer(page);
        result.afterMove = await terminal.term.evaluate((t) => t.viewport.offset);
        assert.equal(result.afterMove, result.atEdge, "later pointer motion cannot restart the ended thumb");
        await noSelectionOrReport(terminal, result);
      });
      assert.deepEqual(Object.keys(details.legs), ["drag-and-release", "overshoot-reverse", "hidden-last-column", "captured-outside-viewport-release"]);
    });
  },
};
