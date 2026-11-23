// Trusted CDP gestures on the app's real terminal prove selection survives
// outside clicks, capture completes a reported outside release, and enabling
// tracking during a local drag cannot change that drag's owner. The raw PTY
// fixture changes modes through an independent control connection; cursor
// replies prove each change was parsed and drain the report stream.
// Cancellation is not exercised: no native mouse-cancel path has been
// established for this Chrome runner, and a fabricated event cannot prove it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { startTerminalFixture } from "../lib/terminal-fixture.mjs";
import { capturePointerTerminals, copyPointerSelection, drainPointerInput, pointerGrid, pointerReports, pointerTerminal, seedPointerClipboard, settlePointer } from "../lib/terminal-pointer.mjs";
import { assertTerminalPrefs, readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB = "PointerOwnership337";
const TEXT = "SELECTION337";
const FIND = "FIND337TARGET";
const RESET_MODES = "\x1b[?1000;1002;1003;1006l";

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
    if (!ctx.controlSocket) throw new Error("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    if (!windowId) throw new Error("could not resolve the page's window id");
    await ctx.waitWindowLive(windowId);
    const shell = (args) => ctx.exec(ctx.chanBin, ["shell", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const cs = (args) => shell(["terminal", ...args]);
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const cdp = await page.createCDPSession();
    const details = {
      legs: {},
      unexercised: { pointercancel: "No established native Chrome mouse-cancel path; no synthetic substitute dispatched." },
    };
    const failures = [];
    let fixture, term, otherPane, tabQuery;
    let held = false;
    const leg = async (name, body) => {
      const result = details.legs[name] = {};
      try { await body(result); }
      catch (error) {
        result.error = error.message;
        failures.push(`${name}: ${error.message}`);
        await ctx.shot(`337-${name}-failure`).catch(() => {});
      } finally {
        if (held) {
          await page.mouse.up().catch(() => {});
          held = false;
        }
        await page.keyboard.up("Shift").catch(() => {});
        await page.keyboard.up("Control").catch(() => {});
        const input = tabQuery && await page.$(`${tabQuery} .terminal-find input.find`);
        if (input) {
          await input.focus();
          await page.keyboard.press("Escape");
          await page.waitForSelector(`${tabQuery} .terminal-find`, { hidden: true, timeout: 5_000 });
          await input.dispose();
        }
      }
    };
    try {
      await cdp.send("Browser.grantPermissions", {
        browserContextId: ctx.browser.id,
        origin: new URL(ctx.serverUrl).origin,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      await writeTerminalPrefs(page, token, { mouse_capture: true });
      await assertTerminalPrefs(ctx, { mouse_capture: true });
      await capturePointerTerminals(page);
      fixture = await startTerminalFixture({ logPath: join(ctx.outDir, "337-output.bin"), deadlineMs: 20_000 });
      const args = ["--command", "stty -opost -echo && " + fixture.command,
        ...Object.entries(fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
      let row;
      try { row = await openAttachedTerminal(ctx, page, cs, windowId, TAB, "ghostty", args); }
      catch (error) { throw new Error(String(error.message).replaceAll(fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]")); }
      details.fixture = await fixture.ready();
      assert.ok(details.fixture.tty && details.fixture.raw, "the fixture owns a raw PTY");
      tabQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
      term = await pointerTerminal(page, `${tabQuery} .terminal-host`);
      const split = await shell(["pane", "split", "right", "--window", windowId, "--pane", row.pane]);
      otherPane = split.stdout.trim();
      assert.match(otherPane, /^[\w-]+$/, "split returned a pane id");
      assert.notEqual(otherPane, row.pane, "the split created another pane");
      const otherQuery = `.pane[data-pane-id="${otherPane}"]`;
      await page.waitForSelector(otherQuery, { visible: true, timeout: 10_000 });
      await settlePointer(page);

      async function prepare(result) {
        result.setup = await drainPointerInput(fixture, `${RESET_MODES}\x1b[2J\x1b[H${TEXT}\r\n${FIND}\r\n`);
        assert.equal(result.setup.reply, "\x1b[3;1R", "fixture text reached the terminal parser");
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
      assert.deepEqual(Object.keys(details.legs), ["selection-outside-click", "find-outside-click", "reported-outside-release", "tracking-enabled-mid-drag"], "all required pointer legs ran");
    } finally {
      if (held) await page.mouse.up().catch(() => {});
      await cs(["close", "--tab-name", TAB]).catch((error) => failures.push(`terminal cleanup: ${error.message}`));
      if (fixture) {
        details.records = fixture.records;
        await fixture.close();
      }
      await term?.dispose();
      await page.evaluate(() => window.__pointerSmoke?.restore()).catch((error) => failures.push(`capture cleanup: ${error.message}`));
      if (otherPane) await shell(["pane", "close", otherPane, "--window", windowId, "--force"])
        .catch((error) => failures.push(`pane cleanup: ${error.message}`));
      await restoreTerminalPrefs(ctx, page, token, original).catch((error) => failures.push(`preference cleanup: ${error.message}`));
      await cdp.detach().catch(() => {});
      details.failures = failures;
      writeFileSync(join(ctx.outDir, "337-pointer-ownership.json"), JSON.stringify(details, null, 2) + "\n");
    }
    if (failures.length) throw new Error(failures.join("\n"));
    return details;
  },
};
