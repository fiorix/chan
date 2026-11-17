// A terminal whose shell exits for real refuses the next Rich Prompt
// submit with the exited note, keeps the draft, and takes the kept text
// after Restart terminal. No proxy and no reload: `exit` reaches a bare
// shell over `cs terminal write`, the server sends the exit frame and
// closes the socket itself, and the page's patched WebSocket records the
// client's sockets, prompt frames and delivery acks.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal, readTerminalAttachment } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const EXITED = "terminal exited; Restart terminal for a new shell";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Installed in the live page before any terminal of this check opens. This
// window holds no other terminal, so every traced upgrade is this check's.
function traceExitedTerminal() {
  const NativeSocket = window.WebSocket;
  const trace = window.__prompt291 = { sockets: [], prompts: [] };
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args) {
      const url = new URL(args[0], location.href);
      if (url.pathname !== "/api/terminal/ws") {
        return Reflect.construct(target, args);
      }
      const socket = Reflect.construct(target, args);
      const record = { socket, ready: false, delivered: [] };
      trace.sockets.push(record);
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.type === "ready") record.ready = true;
        if (frame.type === "prompt-delivered") record.delivered.push(frame.id);
      });
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          let frame;
          try { frame = JSON.parse(data); } catch { /* Raw input is not JSON. */ }
          if (frame?.type === "prompt") trace.prompts.push({ ...frame, connection: trace.sockets.length });
        }
        return send(data);
      };
      return socket;
    },
  });
  trace.restore = () => { window.WebSocket = NativeSocket; };
}

async function state(page, card) {
  return page.evaluate((card) => {
    const composer = card ? document.querySelector(card) : null;
    const editor = composer?.querySelector(".cm-content");
    const note = composer?.querySelector(".rp-text");
    const trace = window.__prompt291;
    return {
      text: editor?.textContent ?? null,
      editable: editor?.getAttribute("contenteditable") === "true",
      pending: composer?.classList.contains("pending") ?? null,
      note: note?.textContent ?? null,
      live: note?.getAttribute("aria-live") ?? null,
      sockets: trace?.sockets.map(({ socket, ready, delivered }) => ({ state: socket.readyState, ready, delivered })) ?? [],
      prompts: trace?.prompts ?? [],
    };
  }, card);
}

async function waitFor(page, card, label, accept, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let observed;
  do {
    observed = await state(page, card);
    if (accept(observed)) return observed;
    await sleep(50);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(observed)}`);
}

export default {
  name: "rich-prompt-exited",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the check page has a window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const failures = [];
    try {
      await page.evaluate(traceExitedTerminal);
      try {
        for (const backend of ["xterm", "ghostty"]) {
          const name = `Prompt291-${backend}`;
          const text = `PROMPT291-${backend}`;
          const result = { backend, passed: false, pageErrors: [], cleanupErrors: [] };
          const onError = (error) => result.pageErrors.push(String(error));
          page.on("pageerror", onError);
          let opened = false;
          try {
            await writeTerminalPrefs(page, token, { ghostty: backend === "ghostty" });
            const row = await openAttachedTerminal(ctx, page, cs, windowId, name, backend);
            opened = true;
            const attachment = await readTerminalAttachment(page, cs, backend, (entry) => entry.session_id === row.session_id);
            assert.ok(attachment.attached, `the ${backend} terminal is attached`);
            const terminal = attachment.selector;
            const card = `${terminal} .rich-prompt`;
            await page.click(`${terminal} .terminal-host`);
            await page.keyboard.down("Control");
            await page.keyboard.down("Alt");
            await page.keyboard.press("KeyP");
            await page.keyboard.up("Alt");
            await page.keyboard.up("Control");
            await page.waitForSelector(`${card} .cm-content`, { visible: true, timeout: 15_000 });
            await page.click(`${card} .cm-content`);
            await page.keyboard.type(text);
            await waitFor(page, card, "the draft is editable", (value) => value.text === text && value.editable && !value.pending);
            // End the shell for real: the server sends the exit frame and
            // closes the socket, and an exited tab never redials.
            await cs(["write", "--tab-name", name, "exit\n"]);
            result.exited = await waitFor(page, card, "the server closed the exited socket with no redial",
              (value) => value.sockets.length === 1 && value.sockets[0].state === 3, 30_000);
            if (backend === "xterm") {
              await page.keyboard.down("Control");
              await page.keyboard.press("Enter");
              await page.keyboard.up("Control");
            } else {
              await page.click(`${card} .rp-primary`);
            }
            result.refused = await waitFor(page, card, "exited submit shows its note", (value) => value.note === EXITED, 3000);
            assert.equal(result.refused.text, text);
            assert.equal(result.refused.editable, true);
            assert.equal(result.refused.pending, false);
            assert.equal(result.refused.live, "polite");
            assert.deepEqual(result.refused.prompts, []);
            assert.deepEqual(result.refused.sockets.map((socket) => socket.state), [3]);
            await ctx.shot(`291-${backend}-exited-note`);
            // Restart terminal: a new session on a new socket takes the kept text.
            await cs(["restart", "--tab-name", name]);
            result.restarted = await waitFor(page, card, "the restarted terminal reattached",
              (value) => value.sockets.length === 2 && value.sockets[1].state === 1 && value.sockets[1].ready, 30_000);
            if (backend === "xterm") {
              await page.keyboard.down("Control");
              await page.keyboard.press("Enter");
              await page.keyboard.up("Control");
            } else {
              await page.click(`${card} .rp-primary`);
            }
            result.sent = await waitFor(page, card, "the kept text sends on the new session", (value) => value.prompts.length === 1);
            assert.equal(result.sent.prompts[0].data, text);
            assert.equal(result.sent.prompts[0].connection, 2);
            assert.equal(typeof result.sent.prompts[0].id, "string");
            const id = result.sent.prompts[0].id;
            result.delivered = await waitFor(page, card, "the delivered retry clears the composer",
              (value) => value.sockets[1].delivered.includes(id) && value.text === "" && !value.pending);
            assert.equal(result.delivered.note, null);
            assert.deepEqual(result.pageErrors, []);
            await ctx.shot(`291-${backend}-restarted-delivered`);
            result.passed = true;
          } catch (error) {
            result.failure = String(error.message ?? error);
            failures.push(`${backend}: ${result.failure}`);
            result.final = await state(page, null).catch(() => null);
            await ctx.shot(`291-${backend}-failure`).catch(() => {});
          } finally {
            page.off("pageerror", onError);
            const cleanup = async (label, action) => {
              try { await action(); } catch (error) {
                result.cleanupErrors.push(`${label}: ${error.message}`);
                failures.push(`${backend}: ${label}: ${error.message}`);
                result.passed = false;
              }
            };
            await cleanup("owned terminal cleanup", async () => {
              try { await cs(["close", "--tab-name", name]); } catch (error) { if (opened) throw error; }
            });
            if (result.passed && result.pageErrors.length) {
              result.passed = false;
              failures.push(`${backend}: browser exceptions: ${result.pageErrors.join("; ")}`);
            }
            writeFileSync(join(ctx.outDir, `291-${backend}.json`), `${JSON.stringify(result, null, 2)}\n`);
          }
        }
      } finally {
        await page.evaluate(() => window.__prompt291?.restore());
      }
    } finally {
      await writeTerminalPrefs(page, token, { ghostty: original.ghostty });
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
