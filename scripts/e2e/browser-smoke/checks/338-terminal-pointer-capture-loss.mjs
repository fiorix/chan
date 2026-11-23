// Clipboard writes are observed without replacing the real browser clipboard.
// Native capture events pin completion; disposal is exercised through tab close.

import assert from "node:assert/strict";
import { drainPointerInput, penPointer, pointerEvents, pointerGrid, pointerWrites, runPointerCheck, seedPointerClipboard, settlePointer } from "../lib/terminal-pointer.mjs";

const TEXT = "CAPTURE338";
const unavailable = (message) => Object.assign(new Error(message), { code: "POINTER_UNAVAILABLE" });

async function begin(page, terminal, grid) {
  await page.mouse.move(grid.x + grid.w * 0.2, grid.y + grid.h * 0.5);
  await page.mouse.down();
  await page.mouse.move(grid.x + grid.w * (TEXT.length - 0.2), grid.y + grid.h * 0.5, { steps: 6 });
  assert.equal(await terminal.term.evaluate((t) => t.getSelection()), TEXT, "the held drag selected the fixture word");
  const down = (await pointerEvents(terminal.trace)).findLast((event) => event.type === "pointerdown" && event.onCanvas);
  assert.ok(down?.isPrimary && down.isTrusted && down.pointerType === "mouse", "the canvas received a trusted primary mouse press");
  return down;
}

export default {
  name: "terminal-pointer-capture-loss",
  run(ctx) {
    return runPointerCheck(ctx, 338, async ({ page, cdp, details, open, leg }) => {
      await leg("connected-capture-loss", async (result) => {
        const terminal = await open("loss");
        const grid = result.grid = await terminal.prepare(TEXT);
        await seedPointerClipboard(page, "SMOKE338_LOSS_SENTINEL");
        const writes = (await pointerWrites(page)).length;
        const index = terminal.fixture.records.length;
        const down = result.press = await begin(page, terminal, grid);
        result.hadCapture = await terminal.trace.evaluate((trace, id) => trace.canvas.hasPointerCapture(id), down.pointerId);
        assert.equal(result.hadCapture, true, "the held selection owns pointer capture before loss");
        await terminal.trace.evaluate((trace, id) => trace.canvas.releasePointerCapture(id), down.pointerId);
        // The engine processes pending capture changes on the next real move.
        await page.mouse.move(grid.x + grid.w * (TEXT.length - 0.3), grid.y + grid.h * 0.5);
        await settlePointer(page);
        result.eventsAfterLoss = await pointerEvents(terminal.trace);
        const losses = result.eventsAfterLoss.filter((event) => event.type === "lostpointercapture" && event.onCanvas);
        assert.equal(losses.length, 1, "one connected loss reached the canvas");
        assert.deepEqual(losses.map(({ pointerId, pointerType, isPrimary, isTrusted }) => ({ pointerId, pointerType, isPrimary, isTrusted })),
          [{ pointerId: down.pointerId, pointerType: "mouse", isPrimary: true, isTrusted: true }], "the native loss retains the gesture identity");
        result.writesAtLoss = (await pointerWrites(page)).slice(writes);
        assert.deepEqual(result.writesAtLoss, [{ text: TEXT, status: "fulfilled" }], "capture loss copies exactly once before pointerup");
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), TEXT, "capture loss wrote the real clipboard");
        await page.mouse.up();
        await page.mouse.move(grid.x + grid.w * (TEXT.length + 3), grid.y + grid.h * 0.5);
        await settlePointer(page);
        result.writesAfterRelease = (await pointerWrites(page)).slice(writes);
        assert.deepEqual(result.writesAfterRelease, result.writesAtLoss, "late release and motion cannot copy again");
        result.after = await drainPointerInput(terminal.fixture, "", index);
        assert.equal(result.after.input, "", "local capture loss sends no PTY bytes");
      });

      await leg("dispose-during-autoscroll", async (result) => {
        const terminal = await open("dispose");
        await terminal.prepare(TEXT);
        await terminal.fixture.send("rows", { prefix: "DISPOSE338", count: 400 });
        result.setup = await drainPointerInput(terminal.fixture);
        await terminal.term.evaluate((t) => t.viewport.scrollTo(160));
        await settlePointer(page);
        const grid = result.grid = await pointerGrid(terminal.term);
        const initial = result.initialOffset = await terminal.term.evaluate((t) => t.viewport.offset);
        assert.ok(initial >= 150, "history leaves room for running bottom-edge auto-scroll");
        const sentinel = "SMOKE338_DISPOSE_SENTINEL";
        await seedPointerClipboard(page, sentinel);
        const writes = (await pointerWrites(page)).length;
        await page.mouse.move(grid.x + grid.w * 0.2, grid.y + grid.height - grid.h * 2.5);
        await page.mouse.down();
        await page.mouse.move(grid.x + grid.w * 8, grid.y + grid.height + 2, { steps: 5 });
        await page.waitForFunction((t, before) => t.viewport.offset < before && t.viewport.offset > 0,
          { timeout: 5_000 }, terminal.term, initial);
        result.scrollingOffset = await terminal.term.evaluate((t) => t.viewport.offset);
        assert.ok((await terminal.term.evaluate((t) => t.getSelection())).length > 0, "the active auto-scroll drag has a selection");
        const down = (await pointerEvents(terminal.trace)).findLast((event) => event.type === "pointerdown" && event.onCanvas);
        result.captured = await terminal.trace.evaluate((trace, id) => trace.canvas.hasPointerCapture(id), down.pointerId);
        await terminal.close();
        assert.equal(await terminal.trace.evaluate((trace) => trace.canvas.isConnected), false, "closing the tab detached the held canvas");
        await settlePointer(page);
        await page.mouse.up();
        await settlePointer(page);
        result.clipboard = await page.evaluate(() => navigator.clipboard.readText());
        result.writes = (await pointerWrites(page)).slice(writes);
        assert.equal(result.clipboard, sentinel, "disposing an active drag leaves the sentinel intact");
        assert.deepEqual(result.writes, [], "dispose and its late release never attempt a copy");
        assert.deepEqual(details.pageErrors, [], "disposing while auto-scroll is running raises no page error");
        const next = await open("after-dispose");
        const nextGrid = await next.prepare(TEXT);
        await begin(page, next, nextGrid);
        await page.mouse.up();
        await settlePointer(page);
        result.nextClipboard = await page.evaluate(() => navigator.clipboard.readText());
        assert.equal(result.nextClipboard, TEXT, "the next terminal selects and copies normally");
        assert.deepEqual((await pointerWrites(page)).slice(writes), [{ text: TEXT, status: "fulfilled" }], "only the next terminal copied");
      });

      await leg("reparent-then-second-pointer", async (result) => {
        const terminal = await open("reparent");
        const grid = result.grid = await terminal.prepare(TEXT);
        const x = grid.x + grid.w * 0.2, y = grid.y + grid.h * 0.5;
        await seedPointerClipboard(page, "SMOKE338_REPARENT_SENTINEL");
        let penHeld = false;
        try {
          await penPointer(cdp, "mousePressed", x, y);
          penHeld = true;
          await penPointer(cdp, "mouseMoved", grid.x + grid.w * (TEXT.length - 0.2), y);
          result.before = await pointerEvents(terminal.trace);
          const pen = result.before.find((event) => event.type === "pointerdown" && event.onCanvas
            && event.pointerType === "pen" && event.isPrimary && event.isTrusted);
          if (!pen) throw unavailable("CDP did not deliver a trusted primary pen to begin reparent recovery");
          assert.equal(await terminal.term.evaluate((t) => t.getSelection()), TEXT, "the first pointer selected before DOM movement");
          assert.equal(await terminal.trace.evaluate((trace, id) => trace.canvas.hasPointerCapture(id), pen.pointerId), true,
            "the first pointer owns capture before DOM movement");
          result.reparent = await terminal.term.evaluate((t, id) => {
            const host = t.element, parent = host.parentNode, next = host.nextSibling;
            const canvas = host.querySelector(":scope > canvas");
            host.remove();
            const detachedCapture = canvas.hasPointerCapture(id);
            parent.insertBefore(host, next);
            return { detachedCapture, reattachedCapture: canvas.hasPointerCapture(id), connected: canvas.isConnected };
          }, pen.pointerId);
          // End the old pen outside the canvas. No same-pointer event at the
          // widget may heal its stale owner before the mouse press tests it.
          assert.ok(grid.x > 1 || grid.y > 1, "the pen release is outside the canvas");
          await penPointer(cdp, "mouseReleased", 1, 1);
          penHeld = false;
          result.afterReparent = await pointerEvents(terminal.trace);
          if (result.reparent.reattachedCapture || result.afterReparent.some((event) => event.onCanvas
              && event.pointerId === pen.pointerId && ["lostpointercapture", "pointerup", "pointercancel"].includes(event.type))) {
            throw unavailable("Chrome did not produce silent canvas capture loss after reparenting; native event trace retained");
          }
          const writes = (await pointerWrites(page)).length;
          const mouse = result.secondPress = await begin(page, terminal, await pointerGrid(terminal.term));
          assert.notEqual(mouse.pointerId, pen.pointerId, "recovery uses another pointer id");
          await page.mouse.up();
          await settlePointer(page);
          result.clipboard = await page.evaluate(() => navigator.clipboard.readText());
          assert.equal(result.clipboard, TEXT, "another pointer selects after silent loss");
          assert.deepEqual((await pointerWrites(page)).slice(writes), [{ text: TEXT, status: "fulfilled" }], "the recovered pointer copies once");
        } finally {
          result.events = await pointerEvents(terminal.trace);
          if (penHeld) await penPointer(cdp, "mouseReleased", 1, 1);
        }
      });
      assert.deepEqual(Object.keys(details.legs), ["connected-capture-loss", "dispose-during-autoscroll", "reparent-then-second-pointer"]);
    });
  },
};
