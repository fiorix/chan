// These reparent probes target engines that can lose canvas capture silently.
// Exclude check 342 from the Chrome suite selection; an unavailable native
// trigger is a skip, with its event trace retained for engine-specific runs.

import assert from "node:assert/strict";
import { drainPointerInput, penPointer, pointerEvents, pointerGrid, pointerReports, pointerWrites, runPointerCheck, seedPointerClipboard, settlePointer } from "../lib/terminal-pointer.mjs";

const TEXT = "REPARENT342";
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
  name: "terminal-pointer-reparent",
  run(ctx) {
    return runPointerCheck(ctx, 342, async ({ page, cdp, details, open, leg }) => {
      await leg("reported-reparent-release", async (result) => {
        const terminal = await open("reported-reparent");
        const grid = result.grid = await terminal.prepare(TEXT);
        result.mode = await drainPointerInput(terminal.fixture, "\x1b[?1002;1006h");
        assert.deepEqual(result.mode, { input: "", reply: "\x1b[2;1R" }, "drag tracking setup reached the parser");
        assert.deepEqual(await terminal.term.evaluate((t) => [t.getMode(1000), t.getMode(1002), t.getMode(1003), t.getMode(1006)]),
          [false, true, false, true], "only button-motion tracking and SGR are enabled");
        const sentinel = "SMOKE342_REPORTED_REPARENT_SENTINEL";
        await seedPointerClipboard(page, sentinel);
        const writes = (await pointerWrites(page)).length;
        const index = terminal.fixture.records.length;
        const y = grid.y + grid.h * 0.5;
        await page.mouse.move(grid.x + grid.w * 2.5, y);
        await page.mouse.down();
        await page.mouse.move(grid.x + grid.w * 7.5, y);
        result.before = await drainPointerInput(terminal.fixture, "", index);
        assert.deepEqual(pointerReports(result.before.input), [
          { button: 0, col: 3, row: 1, end: "M" },
          { button: 32, col: 8, row: 1, end: "M" },
        ], "the reported gesture reaches a known last cell before reparenting");
        const down = result.press = (await pointerEvents(terminal.trace))
          .findLast((event) => event.type === "pointerdown" && event.onCanvas);
        assert.ok(down?.isPrimary && down.isTrusted && down.pointerType === "mouse", "the canvas received a trusted primary mouse press");
        assert.equal(await terminal.trace.evaluate((trace, id) => trace.canvas.hasPointerCapture(id), down.pointerId), true,
          "the reported press owns capture before DOM movement");
        assert.equal(await terminal.term.evaluate((t) => t.getSelection()), "", "the reported drag has no held selection");
        const afterReparent = terminal.fixture.records.length;
        result.reparent = await terminal.term.evaluate((t, id) => {
          const host = t.element, parent = host.parentNode, next = host.nextSibling;
          const canvas = host.querySelector(":scope > canvas");
          host.remove();
          const detachedCapture = canvas.hasPointerCapture(id);
          parent.insertBefore(host, next);
          return { detachedCapture, reattachedCapture: canvas.hasPointerCapture(id), connected: canvas.isConnected };
        }, down.pointerId);
        assert.equal(result.reparent.connected, true, "the original canvas is connected again before motion");
        assert.deepEqual(await pointerGrid(terminal.term), grid, "DOM reparenting preserves the cell geometry");
        if (result.reparent.reattachedCapture) {
          throw unavailable("the engine retained canvas capture across reparenting; no capture-loss trigger was available");
        }
        result.eventsBeforeMove = await pointerEvents(terminal.trace);
        await page.mouse.move(grid.x + grid.w * 10.5, y);
        await settlePointer(page);
        result.eventsAfterMove = await pointerEvents(terminal.trace);
        assert.ok(result.eventsAfterMove.slice(result.eventsBeforeMove.length).some((event) => event.type === "pointermove"
          && event.onCanvas && event.pointerId === down.pointerId && event.pointerType === "mouse"
          && event.isPrimary && event.isTrusted && event.buttons === 1), "a real held move reached the reattached canvas");
        result.loss = await drainPointerInput(terminal.fixture, "", afterReparent);
        assert.deepEqual(pointerReports(result.loss.input), [{ button: 0, col: 8, row: 1, end: "m" }],
          "capture loss reports exactly one release at the last cell before the move");
        const afterLoss = terminal.fixture.records.length;
        await page.mouse.up();
        await page.mouse.move(grid.x + grid.w * 11.5, y);
        await settlePointer(page);
        result.after = await drainPointerInput(terminal.fixture, "", afterLoss);
        result.eventsAfterRelease = await pointerEvents(terminal.trace);
        assert.ok(result.eventsAfterRelease.some((event) => event.type === "pointerup" && event.onCanvas
          && event.pointerId === down.pointerId && event.pointerType === "mouse" && event.isPrimary && event.isTrusted),
        "the late native release reached the canvas");
        assert.equal(result.after.input, "", "late release and hover add no report after capture loss");
        assert.equal(await terminal.term.evaluate((t) => t.getSelection()), "", "report-only capture loss creates no selection");
        result.writes = (await pointerWrites(page)).slice(writes);
        assert.deepEqual(result.writes, [], "report-only reparenting and late release never attempt a copy");
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sentinel, "the reported gesture keeps the sentinel");
      });

      await leg("reparent-then-second-pointer", async (result) => {
        const terminal = await open("reparent");
        const grid = result.grid = await terminal.prepare(TEXT);
        const x = grid.x + grid.w * 0.2, y = grid.y + grid.h * 0.5;
        await seedPointerClipboard(page, "SMOKE342_REPARENT_SENTINEL");
        let penHeld = false;
        let detached;
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
          detached = await terminal.term.evaluateHandle((t) => {
            const host = t.element, parent = host.parentNode, next = host.nextSibling;
            host.remove();
            return { restore() { if (!host.isConnected) parent.insertBefore(host, next); } };
          });
          result.detached = await terminal.trace.evaluate((trace, id) => ({
            connected: trace.canvas.isConnected, captured: trace.canvas.hasPointerCapture(id),
          }), pen.pointerId);
          assert.equal(result.detached.connected, false, "the host stays detached until pen release");
          // Pointer Events 9.5 sends loss to the document when its capture
          // node is disconnected. Release before reinsert can leave the
          // widget uninformed; the native trace must establish that trigger.
          // https://www.w3.org/TR/pointerevents3/#implicit-release-of-pointer-capture
          await penPointer(cdp, "mouseReleased", 1, 1);
          penHeld = false;
          result.eventsWhileDetached = await pointerEvents(terminal.trace);
          await detached.evaluate((state) => state.restore());
          result.reparent = await terminal.trace.evaluate((trace, id) => ({
            connected: trace.canvas.isConnected, reattachedCapture: trace.canvas.hasPointerCapture(id),
          }), pen.pointerId);
          assert.equal(result.reparent.connected, true, "the original canvas is connected before the second pointer");
          assert.deepEqual(await pointerGrid(terminal.term), grid, "DOM reparenting preserves the cell geometry");
          result.afterReparent = await pointerEvents(terminal.trace);
          if (result.reparent.reattachedCapture || result.afterReparent.some((event) => event.onCanvas
              && event.pointerId === pen.pointerId && ["lostpointercapture", "pointerup", "pointercancel"].includes(event.type))) {
            throw unavailable("the engine did not produce silent canvas capture loss after detached pen release; native event trace retained");
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
          try {
            if (penHeld) await penPointer(cdp, "mouseReleased", 1, 1);
          } finally {
            await detached?.evaluate((state) => state.restore());
            await detached?.dispose();
            result.events = await pointerEvents(terminal.trace);
          }
        }
      });
      assert.deepEqual(Object.keys(details.legs), ["reported-reparent-release", "reparent-then-second-pointer"]);
    });
  },
};
