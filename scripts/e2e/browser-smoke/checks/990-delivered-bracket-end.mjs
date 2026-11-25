// The receiving PTY sees one cleaned paste, then its submit key. A private
// server owns the Gemini/Muse overrides so this check cannot change another
// check's encoding. The raw stand-ins record actual PTY input; read boundaries
// are not treated as evidence of write boundaries.

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../lib/program-status.mjs";
import { findControlSocket, launchServer, seedWorkspace, teardownServer } from "../lib/server.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";
const TEMPLATE = String.raw`\e[200~{}\e[201~\r`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hostile(leg) {
  return {
    text: `pastend ${leg}\x1b[201~; echo injected\x03\x15\x7f\nsecond line\tlast`,
    cleaned: `pastend ${leg} [201~; echo injected   \nsecond line\tlast`,
  };
}

// This describes the captured input's paste/key ordering. Exact byte equality
// is asserted separately, so an unfinished or unexpected escape is not hidden.
export function inputEvents(bytes) {
  const events = [];
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.startsWith(OPEN, offset)) {
      const end = bytes.indexOf(CLOSE, offset + OPEN.length);
      if (end < 0) {
        events.push({ kind: "unfinished-paste", text: bytes.slice(offset + OPEN.length) });
        break;
      }
      events.push({ kind: "paste", text: bytes.slice(offset + OPEN.length, end) });
      offset = end + CLOSE.length;
    } else {
      events.push({ kind: "key", byte: bytes.charCodeAt(offset++) });
    }
  }
  return events;
}

async function recorded(file, offset, end) {
  const read = () => readFileSync(file).subarray(offset).toString("utf8");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const bytes = read();
    if (bytes.endsWith(end)) {
      await sleep(500);
      const settled = read();
      if (settled === bytes) return settled;
    }
    await sleep(100);
  }
  throw new Error(`PTY delivery did not finish: ${JSON.stringify(read())}`);
}

async function centreOf(page, selector) {
  return page.$eval(selector, (element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 4 };
  });
}

async function richPrompt(ctx, page, host, text, label) {
  const at = await centreOf(page, host);
  await page.mouse.click(at.x, at.y);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "terminal.richPrompt" } }));
  });
  await page.waitForSelector(".rich-prompt .cm-content", { timeout: 15_000 });
  await page.waitForFunction(() => document.activeElement?.closest?.(".rich-prompt") != null, { timeout: 10_000 });
  await page.evaluate((value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    document.querySelector(".rich-prompt .cm-content").dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
  }, text);
  await ctx.shot(`${label}-rich-prompt`, page);
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
}

export default {
  name: "delivered-bracket-end",
  async run(ctx) {
    for (const agent of ["CODEX", "GEMINI", "MUSE"]) {
      if (process.env[`CHAN_SUBMIT_${agent}`] !== undefined) {
        throw new Error(`Unset CHAN_SUBMIT_${agent}: the check owns its private submit.toml`);
      }
    }
    const workspaceDir = seedWorkspace();
    const dir = mkdtempSync(join(tmpdir(), "chan-pastend-990-"));
    const logs = [];
    const config = `[gemini]\ntemplate = '${TEMPLATE}'\n\n[muse]\ntemplate = '${TEMPLATE}'\n`;
    const server = launchServer(ctx.chanBin, workspaceDir, (line) => logs.push(maskTokens(line)), {
      prepareChanHome(chanHome) { writeFileSync(join(chanHome, "submit.toml"), config); },
    });
    let page;
    let cs;
    const names = [];
    const failures = [];
    const result = { backend: "ghostty", overrideConfig: config, legs: [] };
    const record = (label, bytes, payload, submitted) => {
      const expected = `${OPEN}${payload}${CLOSE}${submitted ? "\r" : ""}`;
      const events = inputEvents(bytes);
      const expectedEvents = [{ kind: "paste", text: payload }, ...(submitted ? [{ kind: "key", byte: 13 }] : [])];
      const path = join(ctx.outDir, `990-${label}.bytes`);
      writeFileSync(path, bytes);
      result.legs.push({ leg: label, bytes, events, artifact: path });
      console.log(`[smoke]   ${label}: PTY ${JSON.stringify(bytes)}`);
      if (bytes !== expected || JSON.stringify(events) !== JSON.stringify(expectedEvents)) {
        failures.push(`${label}: expected one cleaned paste${submitted ? " then CR" : ""}; got ${JSON.stringify(bytes)}`);
      }
    };
    try {
      result.browser = await ctx.browser.browser().version();
      const serverUrl = await server.url;
      const windowId = "paste-end-990";
      const socket = findControlSocket(server.child.pid);
      if (!socket) throw new Error("private server control socket unavailable");
      const env = { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId };
      const control = (args) => ctx.exec(ctx.chanBin, ["shell", ...args], { cwd: workspaceDir, env, timeout: 30_000 });
      cs = (args) => control(["terminal", ...args]);
      await ctx.browser.overridePermissions(new URL(serverUrl).origin, ["clipboard-read", "clipboard-sanitized-write"]);
      page = await ctx.browser.newPage();
      await page.goto(`${serverUrl}&w=${windowId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      const liveDeadline = Date.now() + 30_000;
      for (;;) {
        try { await control(["pane", "list", "--window", windowId, "--json"]); break; }
        catch (error) { if (Date.now() > liveDeadline) throw error; await sleep(200); }
      }
      const localCtx = { ...ctx, page, serverUrl, workspaceDir };
      for (const agent of ["codex", "gemini", "muse"]) {
        const name = `PasteEnd990-${agent}`;
        const file = join(dir, `${agent}.bytes`);
        const ready = join(dir, `${agent}.ready`);
        const recorder = join(dir, `${agent}.mjs`);
        const stub = join(dir, agent);
        // Node is the suite's existing runtime. A short output pulse after
        // input lets the queue observe generation before its next idle gate.
        writeFileSync(recorder, `import { appendFileSync, writeFileSync } from "node:fs";
if (!process.stdin.isTTY) throw new Error("stand-in stdin is not a PTY");
process.stdin.setRawMode(true);
writeFileSync(${JSON.stringify(file)}, "");
process.stdout.write("\\x1b[?2004hREADY\\r\\n");
writeFileSync(${JSON.stringify(ready)}, "ready");
process.stdin.on("data", (bytes) => {
  appendFileSync(${JSON.stringify(file)}, bytes);
  process.stdout.write(".");
});
`);
        writeFileSync(stub, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(recorder)}\n`);
        chmodSync(stub, 0o755);
        names.push(name);
        const row = await openAttachedTerminal(localCtx, page, cs, windowId, name, ["--command", shellQuote(stub)]);
        await ctx.pollFile(ready, 30_000);
        await sleep(500);
        if (row.agent !== agent) throw new Error(`${name}: derived ${JSON.stringify(row.agent)}, expected ${agent}`);
        const host = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"] .terminal-host`;
        if (agent === "codex") {
          const { text, cleaned } = hostile("ghostty-native-paste");
          const clipboardError = await page.evaluate(async (value) => {
            await navigator.clipboard.writeText(value);
            return (await navigator.clipboard.readText()) === value ? null : "clipboard text differs";
          }, text);
          if (clipboardError) throw new Error(clipboardError);
          const at = await centreOf(page, host);
          await page.mouse.click(at.x, at.y);
          const offset = statSync(file).size;
          await page.keyboard.down("Control");
          await page.keyboard.down("Shift");
          await page.keyboard.down("KeyV", { commands: ["paste"] });
          await page.keyboard.up("KeyV");
          await page.keyboard.up("Shift");
          await page.keyboard.up("Control");
          record("ghostty-native-paste", await recorded(file, offset, CLOSE), cleaned.replaceAll("\n", "\r"), false);
        }
        for (const method of ["cs-write", "rich-prompt"]) {
          const label = `${agent}-${method}`;
          const { text, cleaned } = hostile(label);
          const offset = statSync(file).size;
          if (method === "cs-write") await cs(["write", "--tab-name", name, "--submit", agent, text]);
          else await richPrompt(ctx, page, host, text, label);
          record(label, await recorded(file, offset, `${CLOSE}\r`), `${cleaned}\n`, true);
          await ctx.shot(label, page);
        }
        await cs(["close", "--tab-name", name]);
        names.pop();
      }
      if (failures.length) throw new Error(`${failures.length} delivery leg(s) failed:\n${failures.join("\n")}`);
      return result;
    } catch (error) {
      error.smokeDetails = result;
      if (page) await ctx.shot("990-failure", page).catch(() => {});
      throw error;
    } finally {
      if (cs) for (const name of names) await cs(["close", "--tab-name", name]).catch(() => {});
      if (page) await page.close().catch(() => {});
      await teardownServer(ctx.chanBin, server.child, workspaceDir, server.chanHome);
      writeFileSync(join(ctx.outDir, "990-server.log"), logs.join("\n") + "\n");
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
