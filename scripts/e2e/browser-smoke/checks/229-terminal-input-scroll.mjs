// Trusted typing returns both terminal backends to the cursor; passive PTY
// output and the terminal's query reply leave the reader in history. The
// controlled raw PTY records the key before echoing it, so an output-side
// scroll cannot stand in for scrolling on input.

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
          await writeTerminalPrefs(page, token, { ghostty: backend === "ghostty", mouse_capture: false });
          const spawnArgs = ["--command", "stty -opost -echo && " + fixture.command,
            ...Object.entries(fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
          // Child-process failures include argv. The fixture's private control
          // credential must not enter the runner's saved error message.
          let row;
          try {
            opened = true;
            row = await openAttachedTerminal(ctx, page, cs, windowId, name, backend, spawnArgs);
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
        } catch (error) {
          failures.push(`${backend}: ${error.message}`);
          await ctx.shot(`229-${backend}-failure`).catch(() => {});
        } finally {
          result.records = fixture.records;
          await fixture.send("stop").catch(() => {});
          await fixture.close();
          if (opened) await cs(["close", "--tab-name", name]).catch((error) => {
            failures.push(`${backend}: could not close owned terminal: ${error.message}`);
          });
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
      console.log(`[smoke]   ${backend}: history=${result.history ? !result.history.bottom : "unavailable"}, output-kept-history=${result.afterOutput ? !result.afterOutput.bottom : "unavailable"}, input-at-bottom=${result.beforeEcho?.bottom ?? "unavailable"}, cursor=${result.afterEcho?.cursorX ?? "unavailable"}; evidence 229-${backend}.json`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
