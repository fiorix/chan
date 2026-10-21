// Keys typed into a terminal of a broadcast group reach every member while
// that terminal's output is being parsed, and a reply the terminal makes to
// its program reaches that program alone. Two xterm.js terminals of one
// group each run `lib/typed-broadcast-reader.mjs`, which records the bytes
// its PTY delivers; the source prints 720-character lines every 2 ms while
// 36 keys are typed into it with a 10 ms delay. A silent arm, three arms
// under steady output, and a cursor position request from the source, whose
// answer must reach the source and not the target.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const SOURCE = "TypedBroadcastSource178";
const TARGET = "TypedBroadcastTarget178";
const reader = join(import.meta.dirname, "../lib/typed-broadcast-reader.mjs");
const sequence = "0123456789abcdefghijklmnopqrstuvwxyz";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rows(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function inputHex(path) {
  return rows(path).filter((row) => row.type === "input").map((row) => row.hex).join("");
}

function keyCount(hex) {
  const received = Buffer.from(hex, "hex").toString("utf8");
  return {
    count: [...sequence].filter((key) => received.includes(key)).length,
    missing: [...sequence].filter((key) => !received.includes(key)).join(""),
    exact: received === sequence,
  };
}

async function waitFor(read, accept, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await pause(50);
  }
  throw new Error(`${label}: last=${JSON.stringify(last)} error=${lastError?.message ?? "none"}`);
}

async function selectTab(page, name) {
  for (const tab of await page.$$(".tab")) {
    const label = await tab.$eval(".path", (node) => node.textContent?.trim() ?? "").catch(() => "");
    if (label !== name) continue;
    await tab.click();
    await page.waitForSelector(".terminal-tab.active .terminal.xterm .xterm-screen", { timeout: 10_000 });
    await page.click(".terminal-tab.active .terminal.xterm .xterm-screen");
    await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea"), { timeout: 10_000 });
    return;
  }
  throw new Error(`tab not found: ${name}`);
}

export default {
  name: "typed-broadcast",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() =>
      new URL(location.href).searchParams.get("w")?.trim() ||
      sessionStorage.getItem("chan.session.window")?.trim() || "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    await ctx.waitWindowLive(windowId);
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir, env, timeout: 30_000,
    });
    const paths = {
      source: join(ctx.outDir, "178-source-input.jsonl"),
      target: join(ctx.outDir, "178-target-input.jsonl"),
    };
    const originalPrefs = await readTerminalPrefs(page, token);
    const opened = [];
    let sourcePid = null;
    let streaming = false;
    let failed = false;
    const details = { arms: [] };
    try {
      await writeTerminalPrefs(page, token, { ghostty: false });
      for (const [role, name] of [["source", SOURCE], ["target", TARGET]]) {
        await openAttachedTerminal(ctx, page, cs, windowId, name, "xterm");
        opened.push(name);
        await cs(["write", "--tab-name", name, `node ${reader} ${role} ${paths[role]}\n`]);
        const ready = await waitFor(() => Promise.resolve(rows(paths[role])),
          (found) => found[0]?.type === "ready", `${role} reader ready`);
        if (role === "source") sourcePid = ready[0].pid;
        await waitFor(async () => (await cs(["scrollback", "--tab-name", name])).stdout,
          (text) => text.includes(`TBCAST_READY_${role}`), `${role} reader in raw mode`);
      }

      // Both terminals in one broadcast group, from the target's tab menu.
      let targetTab = null;
      for (const tab of await page.$$(".tab")) {
        const label = await tab.$eval(".path", (node) => node.textContent?.trim() ?? "").catch(() => "");
        if (label === TARGET) { targetTab = tab; break; }
      }
      assert.ok(targetTab, "the target's tab is in the strip");
      await targetTab.click({ button: "right" });
      await page.waitForSelector(".terminal-tab-menu-bubble");
      let selected = false;
      for (const button of await page.$$(".terminal-tab-menu-bubble button.mbtn")) {
        if (await button.evaluate((node) => node.textContent?.includes("Select All"))) {
          await button.click();
          selected = true;
          break;
        }
      }
      assert.ok(selected, "the tab menu offers Select All for the broadcast group");
      details.group = await page.$$eval(".terminal-tab-menu-bubble .target-row input", (nodes) =>
        nodes.map((node) => ({ checked: node.checked, name: node.closest(".target-row")?.textContent?.trim() })));
      assert.ok(details.group.length === 2 && details.group.every((row) => row.checked),
        `both terminals are in the group: ${JSON.stringify(details.group)}`);
      await page.keyboard.press("Escape");
      await selectTab(page, SOURCE);

      for (const [name, live] of [["silent", false], ["live-1", true], ["live-2", true], ["live-3", true]]) {
        const before = { source: inputHex(paths.source), target: inputHex(paths.target) };
        const ticksBefore = rows(paths.source).filter((row) => row.type === "stream").length;
        let startNs;
        let endNs;
        try {
          if (live) {
            process.kill(sourcePid, "SIGUSR2");
            streaming = true;
            await waitFor(() => Promise.resolve(rows(paths.source)),
              (found) => found.filter((row) => row.type === "stream").length >= ticksBefore + 20, `${name} output started`);
          }
          startNs = process.hrtime.bigint();
          await page.keyboard.type(sequence, { delay: 10 });
          endNs = process.hrtime.bigint();
          await waitFor(() => Promise.resolve(inputHex(paths.source)),
            (hex) => hex.length >= before.source.length + sequence.length * 2, `${name} source input`);
          // The target's keys arrive through the group's route: give them the
          // time the source's took, and more.
          await waitFor(() => Promise.resolve(inputHex(paths.target)),
            (hex) => hex.length >= before.target.length + sequence.length * 2, `${name} target input`, 5_000).catch(() => {});
        } finally {
          if (streaming) {
            process.kill(sourcePid, "SIGUSR1");
            streaming = false;
            await pause(150);
          }
        }
        const during = rows(paths.source).filter((row) => row.type === "stream" &&
          BigInt(row.tNs) >= startNs && BigInt(row.tNs) <= endNs).length;
        const arm = {
          name, live, streamTicksDuringTyping: during,
          source: keyCount(inputHex(paths.source).slice(before.source.length)),
          target: keyCount(inputHex(paths.target).slice(before.target.length)),
        };
        details.arms.push(arm);
        console.log(`[smoke]   arm ${JSON.stringify(arm)}`);
        if (live) assert.ok(during >= 10, `${name}: the source printed while the keys were typed (${during} lines)`);
        assert.ok(arm.source.exact, `${name}: the source received the 36 keys in order: ${JSON.stringify(arm.source)}`);
        assert.ok(arm.target.exact, `${name}: the target received the 36 keys in order: ${JSON.stringify(arm.target)}`);
      }

      // A cursor position request from the source: the answer reaches the
      // source and not the target.
      const before = { source: inputHex(paths.source), target: inputHex(paths.target) };
      process.kill(sourcePid, "SIGHUP");
      const reply = await waitFor(() => Promise.resolve(Buffer.from(inputHex(paths.source).slice(before.source.length), "hex").toString("utf8")),
        (text) => /\x1b\[\d+;\d+R/.test(text), "the source's cursor position answer");
      await pause(1_000);
      details.reply = { source: JSON.stringify(reply), target: inputHex(paths.target).slice(before.target.length) };
      assert.equal(details.reply.target, "", "the target received nothing of the source's answer");
      details.engine = await page.browser().version();
      return details;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (streaming && sourcePid) process.kill(sourcePid, "SIGUSR1");
        for (const name of opened.reverse()) await cs(["close", "--tab-name", name]);
        await restoreTerminalPrefs(ctx, page, token, originalPrefs);
      } catch (error) {
        // A terminal or preference left behind fails the check, unless the
        // check has already failed.
        if (!failed) throw error;
        console.log(`[smoke]   cleanup failed after the check's failure: ${error.message}`);
      }
    }
  },
};
