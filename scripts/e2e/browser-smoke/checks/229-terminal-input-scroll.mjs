// Trusted typing returns Ghostty to the cursor; passive PTY output and
// query replies leave the reader in history. The raw PTY records the key
// before echoing it, so an output-side scroll cannot stand in for input.
// SGR and X10 mouse/wheel reports must also preserve the history view.

import { captureGhosttyTerminals } from "../lib/ghostty-capture.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { drainPointerInput, pointerInputSince } from "../lib/terminal-pointer.mjs";
import { startTerminalFixture } from "../lib/terminal-fixture.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const PROMPT = "PROMPT229> ";
const frame = (page) => page.evaluate(() => new Promise(requestAnimationFrame));

async function waitFor(page, label, read, accept) {
  const deadline = Date.now() + 20_000;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await frame(page);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}


async function readViewport(page, hostQuery) {
  return page.evaluate((hostQuery) => {
    const host = document.querySelector(hostQuery);
    if (!host) throw new Error("Ghostty terminal host missing");
    const term = window.__ghostty229.terminals.find((candidate) => candidate.element === host);
    if (!term) throw new Error("the opened ghostty Terminal was not captured");
    if (!term.core) throw new Error("Ghostty core unavailable");
    const history = term.getScrollbackLength();
    const offset = term.getViewportY();
    const first = Math.max(0, history - Math.floor(offset));
    const rowText = (row) => {
      const text = term.core.plainText({ startRow: row, startCol: 0, endRow: row, endCol: term.cols - 1 });
      if (text === null) throw new Error(`Ghostty plainText returned null for row ${row}`);
      return text;
    };
    const cursor = term.getCursor();
    if (!cursor) throw new Error("Ghostty cursor unavailable");
    return {
      bottom: offset === 0,
      offset,
      history,
      rows: Array.from({ length: term.rows }, (_, row) => rowText(first + row)),
      cursorRow: rowText(history + cursor.y),
      cursorX: cursor.x,
    };
  }, hostQuery);
}

export default {
  name: "terminal-input-scroll",
  async run(ctx) {
    if (!ctx.controlSocket) throw new Error("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    if (!windowId) throw new Error("could not resolve the page's window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const readings = {};
    const failures = [];
    try {
      if (!(await captureGhosttyTerminals(page, "__ghostty229"))) throw new Error("the entry module names no ghostty-web chunk");
      const name = `InputScroll229-ghostty`;
      const result = readings.ghostty = {};
      const fixture = await startTerminalFixture({
        logPath: join(ctx.outDir, `229-ghostty-output.bin`), deadlineMs: 20_000,
      });
      let opened = false;
      try {
        await writeTerminalPrefs(page, token, { mouse_capture: true });
        const spawnArgs = ["--command", "stty -opost -echo && " + fixture.command,
          ...Object.entries(fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
        // Child-process failures include argv. The fixture's private control
        // credential must not enter the runner's saved error message.
        let row;
        try {
          row = await openAttachedTerminal(ctx, page, cs, windowId, name, "ghostty", spawnArgs);
          opened = true;
        } catch (error) {
          throw new Error(String(error.message).replaceAll(fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]"));
        }
        result.fixture = await fixture.ready();
        if (!result.fixture.tty || !result.fixture.raw) throw new Error("fixture is not a raw PTY");
        const hostQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"] .terminal-host`;
        const read = () => readViewport(page, hostQuery);
        await fixture.send("rows", { prefix: "HISTORY229", count: 400 });
        result.initialReply = await drainPointerInput(fixture, "BEFORE229> ");
        await waitFor(page, `ghostty: prompt at bottom`, read,
          (state) => state.bottom && state.rows.some((line) => line.trimEnd() === "BEFORE229>"));
        const box = await page.$eval(hostQuery, (host) => {
          const rect = host.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        await page.mouse.click(box.x, box.y);
        await page.mouse.wheel({ deltaY: -600 });
        result.history = await waitFor(page, `ghostty: wheel enters history`, read,
          (state) => !state.bottom && state.rows.every((line) => !line.includes("BEFORE229>")));
        await ctx.shot(`229-ghostty-history`);

        result.outputReply = await drainPointerInput(fixture, `\r${PROMPT}`);
        await frame(page);
        await frame(page);
        result.afterOutput = await read();
        if (result.afterOutput.bottom || JSON.stringify(result.afterOutput.rows) !== JSON.stringify(result.history.rows)) {
          throw new Error(`output or its query reply moved history: ${JSON.stringify(result)}`);
        }
        await ctx.shot(`229-ghostty-output-keeps-history`);

        const keyIndex = fixture.records.length;
        await page.keyboard.type("q");
        await fixture.waitFor(() => pointerInputSince(fixture, keyIndex).includes("q"));
        result.key = pointerInputSince(fixture, keyIndex);
        await frame(page);
        await frame(page);
        result.beforeEcho = await read();
        // Read before echo: it is the input that must move the viewport.
        if (!result.beforeEcho.bottom) failures.push(`ghostty: typed q reached the PTY but left the view in history`);
        result.echoReply = await drainPointerInput(fixture, "q");
        await frame(page);
        await frame(page);
        result.afterEcho = await read();
        await ctx.shot(`229-ghostty-typed-letter`);
        if (!result.afterEcho.bottom || result.afterEcho.cursorRow?.trimEnd() !== `${PROMPT}q`
            || result.afterEcho.cursorX !== PROMPT.length + 1) {
          failures.push(`ghostty: the typed letter and cursor are not at the bottom: ${JSON.stringify(result.afterEcho)}`);
        }

        result.reports = [];
        for (const encoding of ["sgr", "x10"]) {
          for (const kind of ["mouse", "wheel"]) {
            const report = { encoding, kind };
            result.reports.push(report);
            // Scroll with tracking disabled, then enable it through real
            // program output. The DSR reply proves the mode was parsed.
            await drainPointerInput(fixture, "\x1b[?1000l\x1b[?1006l");
            await page.mouse.move(box.x, box.y);
            await page.mouse.wheel({ deltaY: -300 });
            await waitFor(page, `ghostty/${encoding}/${kind}: wheel enters history`, read,
              (state) => !state.bottom && state.rows.every((line) => !line.includes(PROMPT)));
            await frame(page);
            await frame(page);
            const beforeMode = await read();
            report.modeReply = await drainPointerInput(fixture,
              `\x1b[?1000h\x1b[?1006${encoding === "sgr" ? "h" : "l"}`);
            await frame(page);
            await frame(page);
            report.before = await read();
            if (report.before.bottom || JSON.stringify(report.before.rows) !== JSON.stringify(beforeMode.rows)) {
              throw new Error(`ghostty/${encoding}/${kind}: enabling mouse reports moved history`);
            }
            const surface = `${hostQuery} > canvas`;
            const position = await page.$eval(surface, (node) => {
              const rect = node.getBoundingClientRect();
              return { x: rect.left + 5, y: rect.top + 8 };
            });
            await page.mouse.move(position.x, position.y);
            const inputIndex = fixture.records.length;
            const button = kind === "mouse" ? 0 : 64;
            const pattern = encoding === "sgr"
              ? new RegExp(`^(?:\\x1b\\[<${button};[1-9]\\d*;[1-9]\\d*M)+$`)
              : new RegExp(`^(?:\\x1b\\[M${String.fromCharCode(button + 32)}[\\x21-\\xff]{2})+$`);
            try {
              if (kind === "mouse") await page.mouse.down();
              else await page.mouse.wheel({ deltaY: -120 });
              await fixture.waitFor(() => pattern.test(pointerInputSince(fixture, inputIndex))).catch((error) => {
                throw new Error(`ghostty/${encoding}/${kind}: PTY report was not observed: ${error.message}`, { cause: error });
              });
              report.input = pointerInputSince(fixture, inputIndex);
              await frame(page);
              await frame(page);
              report.after = await read();
              report.expectedBottom = false;
              const sameHistory = !report.after.bottom
                && JSON.stringify(report.after.rows) === JSON.stringify(report.before.rows)
                && report.after.offset === report.before.offset;
              if (!sameHistory) {
                failures.push(`ghostty/${encoding}/${kind}: report viewport rule failed: ${JSON.stringify(report)}`);
              }
              await ctx.shot(`229-ghostty-${encoding}-${kind}-report`);
            } finally {
              if (kind === "mouse") await page.mouse.up();
            }
          }
        }
        if (result.reports.length !== 4 || result.reports.some((report) => !report.input || !report.after)) {
          throw new Error(`ghostty: mouse/wheel report coverage is incomplete`);
        }
      } catch (error) {
        failures.push(`ghostty: ${error.message}`);
        await ctx.shot(`229-ghostty-failure`).catch(() => {});
      } finally {
        result.records = fixture.records;
        // Flush the log without exiting: terminal close selects a live
        // session, so stopping the fixture first races that selection.
        result.cleanup = await fixture.send("barrier", { name: "cleanup" }).catch((error) => {
          failures.push(`ghostty: could not flush fixture: ${error.message}`);
        });
        // Creation can succeed even when attachment times out. Always try
        // to close; a failed creation has no terminal for close to select.
        await cs(["close", "--tab-name", name]).catch((error) => {
          if (opened) failures.push(`ghostty: could not close owned terminal: ${error.message}`);
        });
        await fixture.close();
        writeFileSync(join(ctx.outDir, `229-ghostty.json`), JSON.stringify(result, null, 2) + "\n");
      }
    } finally {
      await page.evaluate(() => window.__ghostty229?.restore()).catch(() => {});
      await writeTerminalPrefs(page, token, { mouse_capture: original.mouse_capture });
    }
    const result = readings.ghostty;
    console.log(`[smoke]   ghostty: history=${result.history ? !result.history.bottom : "unavailable"}, output-kept-history=${result.afterOutput ? !result.afterOutput.bottom : "unavailable"}, input-at-bottom=${result.beforeEcho?.bottom ?? "unavailable"}, cursor=${result.afterEcho?.cursorX ?? "unavailable"}, reports=${result.reports?.length ?? 0}; evidence 229-ghostty.json`);
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
