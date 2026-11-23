// CDP supplies native pen and touch input. Event fields establish which
// device reached the widget before any selection/report verdict is accepted.

import assert from "node:assert/strict";
import { drainPointerInput, penPointer, pointerEvents, pointerWrites, requirePointerSequence, runPointerCheck, seedPointerClipboard, settlePointer } from "../lib/terminal-pointer.mjs";

const TEXT = "POINTER339";

export default {
  name: "terminal-pointer-pen-touch",
  run(ctx) {
    return runPointerCheck(ctx, 339, async ({ page, cdp, details, open, leg }) => {
      await leg("pen-select-copy", async (result) => {
        const terminal = await open("pen");
        const grid = result.grid = await terminal.prepare(TEXT);
        await seedPointerClipboard(page, "SMOKE339_PEN_SENTINEL");
        const writes = (await pointerWrites(page)).length;
        const index = terminal.fixture.records.length;
        const y = grid.y + grid.h * 0.5;
        const endX = grid.x + grid.w * (TEXT.length - 0.2);
        let held = false;
        try {
          await penPointer(cdp, "mousePressed", grid.x + grid.w * 0.2, y);
          held = true;
          for (let step = 1; step <= 6; step++) {
            await penPointer(cdp, "mouseMoved", grid.x + grid.w * (0.2 + (TEXT.length - 0.4) * step / 6), y);
          }
          result.heldSelection = await terminal.term.evaluate((t) => t.getSelection());
          await penPointer(cdp, "mouseReleased", endX, y);
          held = false;
          await settlePointer(page);
          result.events = await pointerEvents(terminal.trace);
          result.pen = requirePointerSequence(result.events, "pen");
          result.selection = await terminal.term.evaluate((t) => t.getSelection());
          result.clipboard = await page.evaluate(() => navigator.clipboard.readText());
          result.writes = (await pointerWrites(page)).slice(writes);
          result.after = await drainPointerInput(terminal.fixture, "", index);
          assert.equal(result.heldSelection, TEXT, "a held pen selects the fixture word");
          assert.equal(result.selection, TEXT, "pen release retains the selection");
          assert.equal(result.clipboard, TEXT, "pen release copies through the real clipboard");
          assert.deepEqual(result.writes, [{ text: TEXT, status: "fulfilled" }], "pen release copies exactly once");
          assert.equal(result.after.input, "", "a local pen drag sends no PTY bytes");
        } finally {
          result.events = await pointerEvents(terminal.trace);
          if (held) await penPointer(cdp, "mouseReleased", endX, y);
        }
      });

      await leg("touch-under-tracking", async (result) => {
        const terminal = await open("touch");
        const grid = result.grid = await terminal.prepare(TEXT);
        result.mode = await drainPointerInput(terminal.fixture, "\x1b[?1003;1006h");
        assert.deepEqual(await terminal.term.evaluate((t) => [t.getMode(1003), t.getMode(1006)]), [true, true], "any-motion tracking and SGR are active");
        const sentinel = "SMOKE339_TOUCH_SENTINEL";
        await seedPointerClipboard(page, sentinel);
        const writes = (await pointerWrites(page)).length;
        const index = terminal.fixture.records.length;
        const y = grid.y + grid.h * 0.5;
        result.selections = [];
        const point = (x) => [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
        let held = false;
        try {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(grid.x + grid.w * 0.2) });
          held = true;
          result.selections.push(await terminal.term.evaluate((t) => t.getSelection()));
          for (let step = 1; step <= 6; step++) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
              touchPoints: point(grid.x + grid.w * (0.2 + (TEXT.length - 0.4) * step / 6)) });
            result.selections.push(await terminal.term.evaluate((t) => t.getSelection()));
          }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          held = false;
          await settlePointer(page);
          result.events = await pointerEvents(terminal.trace);
          result.ending = result.events.some((event) => event.type === "pointercancel" && event.pointerType === "touch")
            ? "pointercancel" : "pointerup";
          result.touch = requirePointerSequence(result.events, "touch", result.ending);
          result.selections.push(await terminal.term.evaluate((t) => t.getSelection()));
          result.clipboard = await page.evaluate(() => navigator.clipboard.readText());
          result.writes = (await pointerWrites(page)).slice(writes);
          result.after = await drainPointerInput(terminal.fixture, "", index);
          assert.ok(result.selections.every((text) => text === ""), "touch never starts or leaves a terminal selection");
          assert.equal(result.clipboard, sentinel, "touch leaves the clipboard sentinel intact");
          assert.deepEqual(result.writes, [], "touch attempts no clipboard write");
          assert.equal(result.after.input, "", "touch sends no report under tracking");
        } finally {
          result.events = await pointerEvents(terminal.trace);
          if (held) await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        }
      });
      assert.deepEqual(Object.keys(details.legs), ["pen-select-copy", "touch-under-tracking"]);
    });
  },
};
