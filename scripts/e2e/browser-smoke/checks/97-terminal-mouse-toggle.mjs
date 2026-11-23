// Mouse capture is read when a Ghostty terminal opens. A raw PTY enables
// drag tracking and SGR encoding; public mode/selection readings and the
// real copy chord distinguish captured gestures from local selection.
// Each gesture starts with an empty selection, a fresh clipboard sentinel
// and a drained PTY record boundary. The capture-on reports are positive
// controls for the capture-off absence checks.

import { captureGhosttyTerminals } from "../lib/ghostty-capture.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { startTerminalFixture } from "../lib/terminal-fixture.mjs";
import { assertTerminalPrefs, readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = (page) => page.evaluate(() => new Promise(requestAnimationFrame));
const inputSince = (fixture, index) => Buffer.concat(fixture.records.slice(index)
  .filter((record) => record.type === "keys")
  .map((record) => Buffer.from(record.base64, "base64"))).toString("utf8");
const CPR = /\x1b\[[1-9]\d*;[1-9]\d*R$/;

async function outputAndDrain(fixture, bytes = "", index = fixture.records.length) {
  await fixture.send("bytes", { base64: Buffer.from(bytes + "\x1b[6n").toString("base64") });
  await fixture.waitFor(() => CPR.test(inputSince(fixture, index)));
  const input = inputSince(fixture, index);
  return { input: input.replace(CPR, ""), reply: input.match(CPR)[0] };
}

async function captureGhostty(page) {
  const chunk = await captureGhosttyTerminals(page, "__mouse97");
  if (!chunk) return null;
  await page.evaluate(() => {
    const state = window.__mouse97;
    state.term = (query) => {
      const host = document.querySelector(query);
      const term = host && state.terminals.find((candidate) => candidate.element === host);
      if (!term) throw new Error("the attached Ghostty terminal was not captured");
      return term;
    };
  });
  return chunk;
}

async function selection(page, hostQuery) {
  return page.evaluate((query) => {
    const term = window.__mouse97.term(query);
    return { active: term.hasSelection(), text: term.getSelection() };
  }, hostQuery);
}

async function copySelection(page, hostQuery) {
  await page.$eval(`${hostQuery} textarea`, (input) => {
    input.focus();
    if (document.activeElement !== input) throw new Error("terminal input did not take focus");
  });
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  try { await page.keyboard.press("KeyC"); }
  finally {
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
  }
  await sleep(300);
  return page.evaluate(() => navigator.clipboard.readText());
}

export default {
  name: "terminal-mouse-toggle",
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
    const cdp = await page.createCDPSession();
    const details = {};
    const failures = [];
    try {
      await cdp.send("Browser.grantPermissions", {
        browserContextId: ctx.browser.id,
        origin: new URL(ctx.serverUrl).origin,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      assert.ok(await captureGhostty(page), "the entry module names a Ghostty chunk");
      for (const capture of [true, false]) {
        const leg = capture ? "on" : "off";
        const name = capture ? "SmokeMouse97On" : "SmokeMouse97Off";
        const marker = capture ? "M97ON_READY" : "M97OFF_READY";
        const result = details[`${leg}Leg`] = {};
        const fixture = await startTerminalFixture({
          logPath: join(ctx.outDir, `97-${leg}-output.bin`), deadlineMs: 20_000,
        });
        let opened = false;
        try {
          await writeTerminalPrefs(page, token, { mouse_capture: capture });
          await assertTerminalPrefs(ctx, { mouse_capture: capture });
          const spawnArgs = ["--command", "stty -opost -echo && " + fixture.command,
            ...Object.entries(fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
          let row;
          try {
            row = await openAttachedTerminal(ctx, page, cs, windowId, name, "ghostty", spawnArgs);
            opened = true;
          } catch (error) {
            throw new Error(String(error.message).replaceAll(fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]"));
          }
          result.fixture = await fixture.ready();
          assert.ok(result.fixture.tty && result.fixture.raw, `${leg}: fixture is a raw PTY`);
          const hostQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"] .terminal-host`;
          // The cursor reply follows the marker and DECSET in the real PTY
          // stream, proving the page parsed both before any gesture.
          result.setup = await outputAndDrain(fixture,
            `\x1b[2J\x1b[H97_${leg}_ROW_ONE\r\n${marker}\r\n97_${leg}_ROW_THREE\r\n\x1b[?1002;1006h`);
          assert.deepEqual(result.setup, { input: "", reply: "\x1b[4;1R" }, `${leg}: fixture text was parsed`);
          result.modes = await page.evaluate((query) => {
            const term = window.__mouse97.term(query);
            return { tracking: term.hasMouseTracking(), drag: term.getMode(1002), sgr: term.getMode(1006) };
          }, hostQuery);
          assert.deepEqual(result.modes, { tracking: capture, drag: capture, sgr: capture }, `${leg}: effective mouse modes`);
          await frame(page);
          await frame(page);
          const box = await page.evaluate((query) => {
            const term = window.__mouse97.term(query);
            const canvas = document.querySelector(`${query} > canvas`);
            const rect = canvas?.getBoundingClientRect();
            if (!rect || rect.width <= 0 || rect.height <= 0 || term.cols < 30 || term.rows < 4) {
              throw new Error("terminal canvas cannot fit the selection fixture");
            }
            return { x: rect.left, y: rect.top, cellWidth: rect.width / term.cols, cellHeight: rect.height / term.rows };
          }, hostQuery);
          result.gestures = {};
          for (const kind of ["drag", "wheel"]) {
            const sentinel = `SMOKE97_${leg}_${kind}_CLIPBOARD_SENTINEL`;
            const gesture = result.gestures[kind] = { sentinel };
            await page.evaluate(async ({ query, sentinel }) => {
              const term = window.__mouse97.term(query);
              term.clearSelection();
              const input = document.querySelector(`${query} textarea`);
              if (!input) throw new Error("terminal textarea missing");
              input.focus();
              if (document.activeElement !== input) throw new Error("terminal input did not take focus");
              await navigator.clipboard.writeText(sentinel);
              if (await navigator.clipboard.readText() !== sentinel) throw new Error("clipboard sentinel was not seeded");
            }, { query: hostQuery, sentinel });
            assert.deepEqual(await selection(page, hostQuery), { active: false, text: "" }, `${leg}/${kind}: selection starts empty`);
            gesture.before = await outputAndDrain(fixture);
            assert.equal(gesture.before.input, "", `${leg}/${kind}: PTY is drained before the gesture`);
            const index = fixture.records.length;
            await page.mouse.move(box.x + box.cellWidth / 2, box.y + box.cellHeight / 2);
            if (kind === "drag") {
              await page.mouse.down();
              try {
                await page.mouse.move(box.x + box.cellWidth * 24.5, box.y + box.cellHeight * 2.5, { steps: 6 });
              } finally { await page.mouse.up(); }
            } else {
              await page.mouse.wheel({ deltaY: -240 });
              await page.mouse.wheel({ deltaY: -240 });
            }
            await frame(page);
            await frame(page);
            await sleep(300);
            // The following DSR reply is a live round trip after the gesture;
            // a disconnected recorder cannot satisfy the no-report arm.
            gesture.after = await outputAndDrain(fixture, "", index);
            gesture.selection = await selection(page, hostQuery);
            gesture.clipboard = await copySelection(page, hostQuery);
            if (capture) {
              const reports = kind === "drag"
                ? /^\x1b\[<0;[1-9]\d*;[1-9]\d*M(?:\x1b\[<32;[1-9]\d*;[1-9]\d*M)+\x1b\[<0;[1-9]\d*;[1-9]\d*m$/
                : /^(?:\x1b\[<64;[1-9]\d*;[1-9]\d*M)+$/;
              assert.match(gesture.after.input, reports, `${leg}/${kind}: raw PTY mouse reports`);
              assert.deepEqual(gesture.selection, { active: false, text: "" }, `${leg}/${kind}: tracking prevents selection`);
              assert.equal(gesture.clipboard, sentinel, `${leg}/${kind}: empty copy preserves the sentinel`);
            } else {
              assert.equal(gesture.after.input, "", `${leg}/${kind}: capture off suppresses PTY reports`);
              if (kind === "drag") {
                assert.ok(gesture.selection.active, "off/drag: public selection is active");
                assert.ok(gesture.selection.text.includes(marker), "off/drag: selection contains the complete output marker");
                assert.equal(gesture.clipboard, gesture.selection.text, "off/drag: copy returns the public selection");
              } else {
                assert.deepEqual(gesture.selection, { active: false, text: "" }, "off/wheel: no selection");
                assert.equal(gesture.clipboard, sentinel, "off/wheel: empty copy preserves the sentinel");
              }
            }
            await ctx.shot(`97-${leg}-${kind}`);
          }
        } catch (error) {
          result.error = error.message;
          failures.push(`${leg}: ${error.message}`);
          await ctx.shot(`97-${leg}-failure`).catch(() => {});
        } finally {
          result.records = fixture.records;
          result.cleanup = await fixture.send("barrier", { name: "cleanup" }).catch((error) => {
            failures.push(`${leg}: could not flush fixture: ${error.message}`);
          });
          await cs(["close", "--tab-name", name]).catch((error) => {
            if (opened) failures.push(`${leg}: could not close owned terminal: ${error.message}`);
          });
          await fixture.close();
          writeFileSync(join(ctx.outDir, `97-${leg}.json`), JSON.stringify(result, null, 2) + "\n");
        }
      }
    } finally {
      await page.evaluate(() => window.__mouse97?.restore()).catch((error) => {
        failures.push(`capture cleanup: ${error.message}`);
      });
      await restoreTerminalPrefs(ctx, page, token, original).catch((error) => {
        failures.push(`preference cleanup: ${error.message}`);
      });
      await cdp.detach().catch(() => {});
    }
    if (failures.length) throw new Error(failures.join("\n"));
    return details;
  },
};
