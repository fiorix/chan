// Trusted CDP gestures on the app's real terminal prove selection survives
// outside clicks, capture completes a reported outside release, and enabling
// tracking during a local drag cannot change that drag's owner. Turning
// tracking off during a reported press suppresses the later release. The raw PTY
// fixture changes modes through an independent control connection; cursor
// replies prove each change was parsed and drain the report stream.
// Cancellation is not exercised: no native mouse-cancel path has been
// established for this Chrome runner, and a fabricated event cannot prove it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyPointerSelection, drainPointerInput, pointerGrid, pointerReports, POINTER_RESET_MODES, runPointerCheck, seedPointerClipboard, settlePointer } from "../lib/terminal-pointer.mjs";

const TEXT = "SELECTION337";
const FIND = "FIND337TARGET";

async function paintedFindRow(term) {
  const pixels = await term.evaluate((terminal, length) => {
    const canvas = terminal.element.querySelector(":scope > canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("terminal canvas has no readable 2D paint");
    const width = Math.floor(canvas.width / terminal.cols * length);
    const top = Math.floor(canvas.height / terminal.rows);
    const bottom = Math.floor(canvas.height / terminal.rows * 2);
    if (width <= 0 || bottom <= top) throw new Error("find row has no pixels");
    return [...context.getImageData(0, top, width, bottom - top).data];
  }, FIND.length);
  return createHash("sha256").update(Buffer.from(pixels)).digest("hex");
}

export default {
  name: "terminal-pointer-gesture-ownership",
  async run(ctx) {
    return runPointerCheck(ctx, 337, async ({ page, details, open, leg: runLeg, shell, windowId }) => {
      details.unexercised.pointercancel = "No established native Chrome mouse-cancel path; no synthetic substitute dispatched.";
      const resource = await open("ownership");
      const { fixture, term, row, query: tabQuery } = resource;
      details.fixture = resource.ready;
      let otherPane, held = false;
      const leg = (name, body) => runLeg(name, async (result) => {
        try { await body(result); }
        finally {
          if (held) {
            await page.mouse.up();
            held = false;
          }
          await page.keyboard.up("Shift");
          await page.keyboard.up("Control");
          const input = await page.$(`${tabQuery} .terminal-find input.find`);
          if (input) {
            await input.focus();
            await page.keyboard.press("Escape");
            await page.waitForSelector(`${tabQuery} .terminal-find`, { hidden: true, timeout: 5_000 });
            await input.dispose();
          }
        }
      });
      try {
        const split = await shell(["pane", "split", "right", "--window", windowId, "--pane", row.pane]);
        otherPane = split.stdout.trim();
        assert.match(otherPane, /^[\w-]+$/, "split returned a pane id");
        assert.notEqual(otherPane, row.pane, "the split created another pane");
        const otherQuery = `.pane[data-pane-id="${otherPane}"]`;
        await page.waitForSelector(otherQuery, { visible: true, timeout: 10_000 });
        await settlePointer(page);

        async function prepare(result) {
          result.setup = await drainPointerInput(fixture, `${POINTER_RESET_MODES}\x1b[2J\x1b[H${TEXT}\r\n${FIND}\r\n`);
          assert.equal(result.setup.reply, "\x1b[3;1R", "fixture text reached the terminal parser");
          assert.equal(await term.evaluate((t) => t.getScrollbackLength()), 0,
            "each exact-selection gesture starts with empty scrollback");
          assert.deepEqual(await term.evaluate((t) => [t.getMode(1000), t.getMode(1002), t.getMode(1003), t.getMode(1006)]),
            [false, false, false, false], "each gesture starts without mouse tracking");
          await settlePointer(page);
          const grid = await pointerGrid(term);
          // A real click makes the source pane active before keyboard chords.
          await page.mouse.click(grid.x + grid.w * 2.5, grid.y + grid.h * 3.5);
          await term.evaluate((t) => t.clearSelection());
          assert.equal(await term.evaluate((t) => t.getSelection()), "", "each gesture starts without a selection");
          assert.equal((await drainPointerInput(fixture)).input, "", "the raw PTY is drained");
          result.grid = grid;
          return grid;
        }

        async function otherPoint(grid, beyondBottom = false) {
          return page.$eval(otherQuery, (pane, { grid, beyondBottom }) => {
            const rect = pane.getBoundingClientRect();
            const point = { x: rect.left + rect.width / 2, y: beyondBottom ? grid.y + grid.height + 1 : rect.top + rect.height / 2 };
            const hit = document.elementFromPoint(point.x, point.y);
            if (!hit || !pane.contains(hit) || point.x <= grid.x + grid.width ||
                point.y <= rect.top || point.y >= rect.bottom) {
              throw new Error("the release/click point does not hit the other pane beyond the terminal grid");
            }
            return point;
          }, { grid, beyondBottom });
        }

        async function beginSelection(grid) {
          await page.mouse.move(grid.x + grid.w * 0.25, grid.y + grid.h * 0.5);
          await page.mouse.down();
          held = true;
          await page.mouse.move(grid.x + grid.w * (TEXT.length - 0.25), grid.y + grid.h * 0.5, { steps: 6 });
          assert.equal(await term.evaluate((t) => t.getSelection()), TEXT, "the held drag selected the complete fixture word");
        }

        await leg("selection-outside-click", async (result) => {
          const grid = await prepare(result);
          const sentinel = "SMOKE337_SELECTION_SENTINEL";
          await seedPointerClipboard(page, sentinel);
          const index = fixture.records.length;
          await beginSelection(grid);
          await page.mouse.up();
          held = false;
          await settlePointer(page);
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), TEXT, "the initial drag copied the selection");
          result.outside = await otherPoint(grid);
          await page.mouse.click(result.outside.x, result.outside.y);
          await settlePointer(page);
          // Reseeding here isolates the later copy chord from the first
          // release copy; retaining that old clipboard value proves nothing.
          await seedPointerClipboard(page, sentinel);
          result.copy = await copyPointerSelection(page, term);
          result.selection = await term.evaluate((t) => t.getSelection());
          result.after = await drainPointerInput(fixture, "", index);
          assert.equal(result.copy, TEXT, "copy after clicking another pane keeps the selection");
          assert.equal(result.selection, TEXT, "outside click keeps the public selection");
          assert.equal(result.after.input, "", "local selection sends no PTY bytes");
        });

        await leg("find-outside-click", async (result) => {
          const grid = await prepare(result);
          result.before = await paintedFindRow(term);
          await term.evaluate((t) => t.element.querySelector("textarea").focus());
          await page.keyboard.down("Control");
          await page.keyboard.down("Shift");
          try { await page.keyboard.press("KeyF"); }
          finally { await page.keyboard.up("Shift"); await page.keyboard.up("Control"); }
          const inputQuery = `${tabQuery} .terminal-find input.find`;
          const countQuery = `${tabQuery} .terminal-find .find-count`;
          await page.waitForFunction((query) => document.activeElement === document.querySelector(query), { timeout: 10_000 }, inputQuery);
          await page.keyboard.type(FIND);
          await page.waitForFunction((query) => document.querySelector(query)?.textContent === "1 of 1", { timeout: 10_000 }, countQuery);
          await settlePointer(page);
          assert.equal(await term.evaluate((t) => t.getSelection()), FIND, "find selected the unique fixture match");
          result.highlight = await paintedFindRow(term);
          assert.notEqual(result.highlight, result.before, "find visibly painted its selected match");
          await page.click(countQuery);
          await settlePointer(page);
          result.afterBar = { text: await term.evaluate((t) => t.getSelection()), pixels: await paintedFindRow(term) };
          assert.deepEqual(result.afterBar, { text: FIND, pixels: result.highlight }, "a click on the find bar keeps its highlight");
          const outside = await otherPoint(grid);
          await page.mouse.click(outside.x, outside.y);
          await settlePointer(page);
          result.afterPane = { text: await term.evaluate((t) => t.getSelection()), pixels: await paintedFindRow(term) };
          assert.deepEqual(result.afterPane, { text: FIND, pixels: result.highlight }, "a click on another pane keeps the find highlight");
          assert.equal(await page.$eval(countQuery, (el) => el.textContent), "1 of 1", "the find bar keeps its match count");
        });

        await leg("reported-outside-release", async (result) => {
          const grid = await prepare(result);
          result.mode = await drainPointerInput(fixture, "\x1b[?1002;1006h");
          assert.equal(result.mode.input, "", "reporting mode setup sends no gesture bytes");
          assert.deepEqual(await term.evaluate((t) => [t.getMode(1002), t.getMode(1006)]), [true, true], "drag tracking and SGR were parsed");
          const sentinel = "SMOKE337_OUTSIDE_SENTINEL";
          await seedPointerClipboard(page, sentinel);
          result.outside = await otherPoint(grid, true);
          const index = fixture.records.length;
          await page.mouse.move(grid.x + grid.w * 2.5, grid.y + grid.h * 1.5);
          await page.mouse.down();
          held = true;
          await page.mouse.move(result.outside.x, result.outside.y, { steps: 8 });
          await page.mouse.up();
          held = false;
          await settlePointer(page);
          result.after = await drainPointerInput(fixture, "", index);
          result.reports = pointerReports(result.after.input);
          assert.deepEqual(result.reports[0], { button: 0, col: 3, row: 2, end: "M" }, "the drag starts with one press report");
          const releases = result.reports.filter((report) => report.end === "m");
          assert.deepEqual(releases, [{ button: 0, col: grid.cols, row: grid.rows, end: "m" }], "the outside release reports exactly once, clamped to both grid edges");
          assert.deepEqual(result.reports.at(-1), releases[0], "no report follows the release");
          const motion = result.reports.slice(1, -1);
          assert.ok(motion.length > 0, "the held drag produces motion reports");
          assert.ok(motion.every((report) => report.button === 32 && report.end === "M"
            && report.col >= 1 && report.col <= grid.cols && report.row >= 1 && report.row <= grid.rows), "all motion reports stay inside the grid");
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sentinel, "a reported outside release copies nothing");
        });

        await leg("tracking-enabled-mid-drag", async (result) => {
          const grid = await prepare(result);
          const sentinel = "SMOKE337_MID_DRAG_SENTINEL";
          await seedPointerClipboard(page, sentinel);
          const index = fixture.records.length;
          await beginSelection(grid);
          result.mid = await drainPointerInput(fixture, "\x1b[?1003;1006h", index);
          assert.deepEqual(await term.evaluate((t) => [t.getMode(1003), t.getMode(1006)]), [true, true], "tracking became active while the button was held");
          const afterMode = fixture.records.length;
          // Motion after the mode change must keep the press's disposition.
          await page.mouse.move(grid.x + grid.w * (TEXT.length - 0.4), grid.y + grid.h * 0.5);
          await page.mouse.up();
          held = false;
          await settlePointer(page);
          result.after = await drainPointerInput(fixture, "", afterMode);
          result.selection = await term.evaluate((t) => t.getSelection());
          result.clipboard = await page.evaluate(() => navigator.clipboard.readText());
          assert.equal(result.mid.input, "", "the local press and first moves sent no bytes");
          assert.equal(result.after.input, "", "enabling tracking cannot report a local drag's motion or release");
          assert.equal(result.selection, TEXT, "the held selection survives the mode change");
          assert.equal(result.clipboard, TEXT, "release copies the selection after tracking is enabled");
        });

        await leg("tracking-disabled-mid-press", async (result) => {
          const grid = await prepare(result);
          result.mode = await drainPointerInput(fixture, "\x1b[?1000;1006h");
          assert.deepEqual(result.mode, { input: "", reply: "\x1b[3;1R" }, "press-only tracking setup reached the parser");
          assert.deepEqual(await term.evaluate((t) => [t.getMode(1000), t.getMode(1002), t.getMode(1003), t.getMode(1006)]),
            [true, false, false, true], "only press/release tracking and SGR are enabled");
          const sentinel = "SMOKE337_TRACKING_OFF_SENTINEL";
          await seedPointerClipboard(page, sentinel);
          const index = fixture.records.length;
          await page.mouse.move(grid.x + grid.w * 2.5, grid.y + grid.h * 0.5);
          await page.mouse.down();
          held = true;
          result.mid = await drainPointerInput(fixture, "\x1b[?1000l", index);
          assert.equal(result.mid.reply, "\x1b[3;1R", "tracking-off control output was parsed while the button was held");
          assert.deepEqual(pointerReports(result.mid.input), [{ button: 0, col: 3, row: 1, end: "M" }],
            "the PTY received exactly the press before tracking was turned off");
          assert.deepEqual(await term.evaluate((t) => [t.getMode(1000), t.getMode(1002), t.getMode(1003), t.getMode(1006)]),
            [false, false, false, true], "tracking is off before release while SGR stays enabled");
          const afterMode = fixture.records.length;
          await page.mouse.up();
          held = false;
          await settlePointer(page);
          result.after = await drainPointerInput(fixture, "", afterMode);
          result.selection = await term.evaluate((t) => t.getSelection());
          result.clipboard = await page.evaluate(() => navigator.clipboard.readText());
          assert.equal(result.after.input, "", "turning tracking off suppresses the reported press's later release");
          assert.equal(result.selection, "", "the reported press never becomes a local selection");
          assert.equal(result.clipboard, sentinel, "turning tracking off does not copy the reported press");
        });
        assert.deepEqual(Object.keys(details.legs), ["selection-outside-click", "find-outside-click", "reported-outside-release", "tracking-enabled-mid-drag", "tracking-disabled-mid-press"], "all required pointer legs ran");
      } finally {
        if (held) await page.mouse.up().catch((error) => details.failures.push(`mouse cleanup: ${error.message}`));
        await resource.close().catch((error) => details.failures.push(`terminal cleanup: ${error.message}`));
        details.records = fixture.records;
        if (otherPane) await shell(["pane", "close", otherPane, "--window", windowId, "--force"])
          .catch((error) => details.failures.push(`pane cleanup: ${error.message}`));
      }
    });
  },
};
