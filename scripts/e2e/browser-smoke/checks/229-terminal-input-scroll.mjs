// Trusted typing returns both terminal backends to the cursor; passive PTY
// output and the terminal's query reply leave the reader in history. The
// controlled raw PTY records the key before echoing it, so an output-side
// scroll cannot stand in for scrolling on input. Mouse and wheel reports
// are read separately: xterm SGR reports scroll to the live screen; X10
// reports and both Ghostty report encodings preserve the history view.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { startTerminalFixture } from "../lib/terminal-fixture.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const PROMPT = "PROMPT229> ";
const frame = (page) => page.evaluate(() => new Promise(requestAnimationFrame));
const inputSince = (fixture, index) => Buffer.concat(fixture.records.slice(index)
  .filter((record) => record.type === "keys")
  .map((record) => Buffer.from(record.base64, "base64"))).toString("utf8");

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

async function captureGhostty(page) {
  return page.evaluate(async () => {
    for (const script of document.querySelectorAll('script[type="module"][src]')) {
      const name = /ghostty-web-[\w-]+\.js/.exec(await (await fetch(script.src)).text())?.[0];
      if (!name) continue;
      const { Terminal } = await import(new URL(name, script.src).href);
      const open = Terminal.prototype.open;
      window.__ghosttyTerminals229 = [];
      Terminal.prototype.open = function (...args) {
        window.__ghosttyTerminals229.push(this);
        return open.apply(this, args);
      };
      window.__restoreGhostty229 = () => { Terminal.prototype.open = open; };
      return true;
    }
    return false;
  });
}

async function readViewport(page, hostQuery, backend) {
  return page.evaluate(({ hostQuery, backend }) => {
    const host = document.querySelector(hostQuery);
    if (!host) throw new Error(`${backend}: terminal host missing`);
    if (backend === "ghostty") {
      const term = window.__ghosttyTerminals229.find((t) => !t.isDisposed && t.element === host);
      if (!term) throw new Error("the opened ghostty Terminal was not captured");
      const history = term.getScrollbackLength();
      const offset = term.getViewportY();
      const first = Math.max(0, history - Math.floor(offset));
      const rowText = (row) => term.wasmTerm.plainText({
        startRow: row, startCol: 0, endRow: row, endCol: term.cols - 1,
      }) ?? "";
      const cursor = term.wasmTerm.getCursor();
      return {
        bottom: offset === 0,
        offset,
        history,
        rows: Array.from({ length: term.rows }, (_, row) => rowText(first + row)),
        cursorRow: rowText(history + cursor.y),
        cursorX: cursor.x,
      };
    }
    const rows = [...host.querySelectorAll(".xterm-rows > div")];
    const track = host.querySelector(".xterm-scrollable-element > .scrollbar.vertical");
    const slider = track?.querySelector(".slider");
    if (!rows.length || !track || !slider) throw new Error("xterm DOM rows or scrollbar missing");
    const top = Number.parseFloat(slider.style.top);
    const height = Number.parseFloat(slider.style.height);
    const trackHeight = Number.parseFloat(track.style.height);
    const cursor = host.querySelector(".xterm-cursor");
    const cursorRow = cursor?.parentElement;
    let cursorX = 0;
    if (cursorRow) {
      for (const child of cursorRow.childNodes) {
        if (child === cursor) break;
        cursorX += child.textContent.length;
      }
    }
    return {
      bottom: Number.isFinite(top + height + trackHeight) && Math.abs(trackHeight - top - height) <= 1,
      slider: { top, height, trackHeight },
      rows: rows.map((row) => row.textContent.trimEnd()),
      cursorRow: cursorRow?.textContent.trimEnd() ?? null,
      cursorX: cursor ? cursorX : null,
    };
  }, { hostQuery, backend });
}

async function outputAndDrain(fixture, bytes) {
  const index = fixture.records.length;
  await fixture.send("bytes", { base64: Buffer.from(bytes + "\x1b[6n").toString("base64") });
  // The reply proves that the page parsed the preceding output, including
  // output outside its viewport. Received WebSocket bytes alone do not.
  await fixture.waitFor(() => /\x1b\[\d+;\d+R/.test(inputSince(fixture, index)));
  return inputSince(fixture, index);
}

export default {
  name: "terminal-input-scroll",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
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
    // renderer.ts reads this escape hatch when each new terminal opens.
    // DOM rows let this check read the painted xterm cursor and viewport.
    const rendererOverride = await page.evaluate(() => {
      const original = localStorage.getItem("chan:terminal-webgl");
      localStorage.setItem("chan:terminal-webgl", "0");
      return original;
    });
    const readings = {};
    const failures = [];
    try {
      if (!(await captureGhostty(page))) throw new Error("the entry module names no ghostty-web chunk");
      for (const backend of ["xterm", "ghostty"]) {
        const name = `InputScroll229-${backend}`;
        const result = readings[backend] = {};
        const fixture = await startTerminalFixture({
          logPath: join(ctx.outDir, `229-${backend}-output.bin`), deadlineMs: 20_000,
        });
        let opened = false;
        try {
          await writeTerminalPrefs(page, token, { ghostty: backend === "ghostty", mouse_capture: true });
          const spawnArgs = ["--command", "stty -opost -echo && " + fixture.command,
            ...Object.entries(fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
          // Child-process failures include argv. The fixture's private control
          // credential must not enter the runner's saved error message.
          let row;
          try {
            row = await openAttachedTerminal(ctx, page, cs, windowId, name, backend, spawnArgs);
            opened = true;
          } catch (error) {
            throw new Error(String(error.message).replaceAll(fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]"));
          }
          result.fixture = await fixture.ready();
          if (!result.fixture.tty || !result.fixture.raw) throw new Error("fixture is not a raw PTY");
          const hostQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"] .terminal-host`;
          const read = () => readViewport(page, hostQuery, backend);
          await fixture.send("rows", { prefix: "HISTORY229", count: 400 });
          result.initialReply = await outputAndDrain(fixture, "BEFORE229> ");
          await waitFor(page, `${backend}: prompt at bottom`, read,
            (state) => state.bottom && state.rows.some((line) => line.trimEnd() === "BEFORE229>"));
          const box = await page.$eval(hostQuery, (host) => {
            const rect = host.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          });
          await page.mouse.click(box.x, box.y);
          await page.mouse.wheel({ deltaY: -600 });
          result.history = await waitFor(page, `${backend}: wheel enters history`, read,
            (state) => !state.bottom && state.rows.every((line) => !line.includes("BEFORE229>")));
          await ctx.shot(`229-${backend}-history`);

          result.outputReply = await outputAndDrain(fixture, `\r${PROMPT}`);
          await frame(page);
          await frame(page);
          result.afterOutput = await read();
          if (result.afterOutput.bottom || JSON.stringify(result.afterOutput.rows) !== JSON.stringify(result.history.rows)) {
            throw new Error(`output or its query reply moved history: ${JSON.stringify(result)}`);
          }
          await ctx.shot(`229-${backend}-output-keeps-history`);

          const keyIndex = fixture.records.length;
          await page.keyboard.type("q");
          await fixture.waitFor(() => inputSince(fixture, keyIndex).includes("q"));
          result.key = inputSince(fixture, keyIndex);
          await frame(page);
          await frame(page);
          result.beforeEcho = await read();
          // Read before echo: it is the input that must move the viewport.
          if (!result.beforeEcho.bottom) failures.push(`${backend}: typed q reached the PTY but left the view in history`);
          result.echoReply = await outputAndDrain(fixture, "q");
          await frame(page);
          await frame(page);
          result.afterEcho = await read();
          await ctx.shot(`229-${backend}-typed-letter`);
          if (!result.afterEcho.bottom || result.afterEcho.cursorRow?.trimEnd() !== `${PROMPT}q`
              || result.afterEcho.cursorX !== PROMPT.length + 1) {
            failures.push(`${backend}: the typed letter and cursor are not at the bottom: ${JSON.stringify(result.afterEcho)}`);
          }

          // The ghostty overlay thumb drag moves the view with the
          // pointer: no check drags that thumb in an engine, while jsdom
          // alone pinned the fix. Only the ghostty leg runs it.
          if (backend === "ghostty") {
            // The same wheel from the bottom recorded offset 28.57 in four
            // runs: wait for an offset the wheel reaches, not past it.
            await page.mouse.wheel({ deltaY: -600 });
            await waitFor(page, `${backend}: thumb arm enters history`, read,
              (state) => !state.bottom && state.offset > 20);
            const locateThumb = ({ hostQuery }) => {
              const host = document.querySelector(hostQuery);
              const term = window.__ghosttyTerminals229.find((t) => !t.isDisposed && t.element === host);
              if (!term) throw new Error("the opened ghostty Terminal was not captured");
              // Fresh fade: chan's gate claims the strip only while the
              // overlay shows (1.5 s plus a fade), and on a loaded guest a
              // late press lands on content and reads as a product failure.
              term.showScrollbar();
              const canvas = term.renderer.getCanvas();
              const rect = canvas.getBoundingClientRect();
              const history = term.getScrollbackLength();
              const track = rect.height - 8;
              const thumbH = Math.max(20, (term.rows / (history + term.rows)) * track);
              const thumbY = 4 + (track - thumbH) * (1 - term.getViewportY() / history);
              return {
                // Mid-strip: the strip spans width-12 to width-4, and a
                // fractional rect can miss its inclusive left edge.
                x: rect.left + rect.width - 8,
                y: rect.top + thumbY + thumbH / 2,
              };
            };
            const readDragging = ({ hostQuery }) => {
              const host = document.querySelector(hostQuery);
              const term = window.__ghosttyTerminals229.find((t) => !t.isDisposed && t.element === host);
              if (!term) throw new Error("the opened ghostty Terminal was not captured");
              return term.isDraggingScrollbar === true;
            };
            let thumb = await page.evaluate(locateThumb, { hostQuery });
            await page.mouse.move(thumb.x, thumb.y);
            await page.mouse.down();
            await frame(page);
            // A press that missed the strip starts no thumb drag: an
            // instrument fault, not a product verdict. Re-aim once on a
            // fresh fade; a second miss stays an instrument fault.
            let dragging = await page.evaluate(readDragging, { hostQuery });
            if (!dragging) {
              await page.mouse.up();
              thumb = await page.evaluate(locateThumb, { hostQuery });
              await page.mouse.move(thumb.x, thumb.y);
              await page.mouse.down();
              await frame(page);
              dragging = await page.evaluate(readDragging, { hostQuery });
            }
            if (!dragging) {
              throw new Error(
                `${backend}: instrument fault: the thumb press missed the strip twice, ` +
                `no thumb drag to judge`,
              );
            }
            const atPress = (await read()).offset;
            // A nonzero drag down the track moves the view toward newer
            // rows; at the base, without a pointermove path, the view
            // holds and this assertion fails.
            await page.mouse.move(thumb.x, thumb.y + 60);
            await frame(page);
            const dragged = await read();
            await page.mouse.up();
            await page.mouse.move(thumb.x, thumb.y + 120);
            await frame(page);
            const after = await read();
            if (!(dragged.offset < atPress && dragged.offset >= 0)) {
              failures.push(`${backend}: the thumb drag did not move the view toward newer rows: ${atPress} -> ${dragged.offset}`);
            }
            if (Math.abs(after.offset - dragged.offset) >= 1) {
              failures.push(`${backend}: a move after the thumb release changed the view: ${dragged.offset} -> ${after.offset}`);
            }
            await ctx.shot(`229-${backend}-thumb-drag`);
          }

          result.reports = [];
          for (const encoding of ["sgr", "x10"]) {
            for (const kind of ["mouse", "wheel"]) {
              const report = { encoding, kind };
              result.reports.push(report);
              // Scroll with tracking disabled, then enable it through real
              // program output. The DSR reply proves the mode was parsed.
              await outputAndDrain(fixture, "\x1b[?1000l\x1b[?1006l");
              await page.mouse.move(box.x, box.y);
              await page.mouse.wheel({ deltaY: -300 });
              await waitFor(page, `${backend}/${encoding}/${kind}: wheel enters history`, read,
                (state) => !state.bottom && state.rows.every((line) => !line.includes(PROMPT)));
              await frame(page);
              await frame(page);
              const beforeMode = await read();
              report.modeReply = await outputAndDrain(fixture,
                `\x1b[?1000h\x1b[?1006${encoding === "sgr" ? "h" : "l"}`);
              await frame(page);
              await frame(page);
              report.before = await read();
              if (report.before.bottom || JSON.stringify(report.before.rows) !== JSON.stringify(beforeMode.rows)) {
                throw new Error(`${backend}/${encoding}/${kind}: enabling mouse reports moved history`);
              }
              const surface = `${hostQuery} ${backend === "ghostty" ? "> canvas" : ".xterm-screen"}`;
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
                await fixture.waitFor(() => pattern.test(inputSince(fixture, inputIndex))).catch((error) => {
                  throw new Error(`${backend}/${encoding}/${kind}: PTY report was not observed: ${error.message}`, { cause: error });
                });
                report.input = inputSince(fixture, inputIndex);
                await frame(page);
                await frame(page);
                report.after = await read();
                report.expectedBottom = backend === "xterm" && encoding === "sgr";
                const sameHistory = !report.after.bottom
                  && JSON.stringify(report.after.rows) === JSON.stringify(report.before.rows)
                  && (backend === "ghostty" ? report.after.offset === report.before.offset
                    : JSON.stringify(report.after.slider) === JSON.stringify(report.before.slider));
                if (report.expectedBottom ? !report.after.bottom : !sameHistory) {
                  failures.push(`${backend}/${encoding}/${kind}: report viewport rule failed: ${JSON.stringify(report)}`);
                }
                await ctx.shot(`229-${backend}-${encoding}-${kind}-report`);
              } finally {
                if (kind === "mouse") await page.mouse.up();
              }
            }
          }
          if (result.reports.length !== 4 || result.reports.some((report) => !report.input || !report.after)) {
            throw new Error(`${backend}: mouse/wheel report coverage is incomplete`);
          }
        } catch (error) {
          failures.push(`${backend}: ${error.message}`);
          await ctx.shot(`229-${backend}-failure`).catch(() => {});
        } finally {
          result.records = fixture.records;
          // Flush the log without exiting: terminal close selects a live
          // session, so stopping the fixture first races that selection.
          result.cleanup = await fixture.send("barrier", { name: "cleanup" }).catch((error) => {
            failures.push(`${backend}: could not flush fixture: ${error.message}`);
          });
          // Creation can succeed even when attachment times out. Always try
          // to close; a failed creation has no terminal for close to select.
          await cs(["close", "--tab-name", name]).catch((error) => {
            if (opened) failures.push(`${backend}: could not close owned terminal: ${error.message}`);
          });
          await fixture.close();
          writeFileSync(join(ctx.outDir, `229-${backend}.json`), JSON.stringify(result, null, 2) + "\n");
        }
      }
    } finally {
      await page.evaluate((original) => {
        window.__restoreGhostty229?.();
        if (original === null) localStorage.removeItem("chan:terminal-webgl");
        else localStorage.setItem("chan:terminal-webgl", original);
      }, rendererOverride);
      await writeTerminalPrefs(page, token, { ghostty: original.ghostty, mouse_capture: original.mouse_capture });
    }
    for (const [backend, result] of Object.entries(readings)) {
      console.log(`[smoke]   ${backend}: history=${result.history ? !result.history.bottom : "unavailable"}, output-kept-history=${result.afterOutput ? !result.afterOutput.bottom : "unavailable"}, input-at-bottom=${result.beforeEcho?.bottom ?? "unavailable"}, cursor=${result.afterEcho?.cursorX ?? "unavailable"}, reports=${result.reports?.length ?? 0}; evidence 229-${backend}.json`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
