// A terminal whose shell exits for real refuses the next Rich Prompt
// submit with the exited note, keeps the draft, and takes the kept text
// after Restart terminal. No proxy and no reload: `exit` reaches a bare
// shell over `cs terminal write`, the server sends the exit frame and
// closes the socket itself, and the page's patched WebSocket records the
// client's sockets, prompt frames and delivery acks. Sockets are scoped by
// tab name (fresh dials carry no session value): both legs run in one
// window, so the first leg's closed socket must not satisfy the second
// leg's waits. Restart and cleanup go through
// the page (the command launcher, the tab bus): `cs terminal` addresses
// live sessions only, and an exited terminal has none.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeActiveTerminal, selectLauncherCommand, windowSessions } from "../lib/pane-strip.mjs";
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
      const connection = trace.sockets.length;
      const socket = Reflect.construct(target, args);
      // Fresh dials carry no `session` value (only reattaches do); the tab
      // name scopes the leg and survives a restart of the same tab.
      const tab = new URL(args[0], location.href).searchParams.get("tab_name");
      const record = { socket, tab, connection, ready: false, delivered: [] };
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
          if (frame?.type === "prompt") trace.prompts.push({ ...frame, connection });
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
      sockets: trace?.sockets.map(({ socket, tab, connection, ready, delivered }) => ({
        state: socket.readyState,
        tab,
        connection,
        ready,
        delivered,
      })) ?? [],
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
            const session = row.session_id;
            const attachment = await readTerminalAttachment(page, cs, backend, (entry) => entry.session_id === session);
            assert.ok(attachment.attached, `the ${backend} terminal is attached`);
            await page.evaluate(() => { window.__prompt291.prompts.length = 0; });
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
            const own = (value) => value.sockets.filter((socket) => socket.tab === name);
            result.exited = await waitFor(page, card, "the server closed the exited socket with no redial",
              (value) => own(value).length === 1 && own(value)[0].state === 3, 30_000);
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
            assert.deepEqual(own(result.refused).map((socket) => socket.state), [3]);
            await ctx.shot(`291-${backend}-exited-note`);
            // Restart terminal through the command launcher: `cs terminal`
            // addresses live sessions only, and an exited terminal has none.
            // A new session on a new socket takes the kept text. The restart
            // opens exactly one new socket on the same tab name.
            const seen = own(await state(page, card)).length;
            await selectLauncherCommand(page, "Restart terminal");
            await page.keyboard.press("Enter");
            result.restarted = await waitFor(page, card, "the restarted terminal reattached", (value) => {
              const next = value.sockets.filter((socket) => socket.tab === name && socket.state !== 3);
              return value.sockets.filter((socket) => socket.tab === name).length === seen + 1
                && next.length === 1 && next[0].ready ? { ...value, next: next[0] } : false;
            }, 30_000);
            assert.deepEqual(result.restarted.prompts, [], "no prompt sends by itself after the restart");
            await sleep(500);
            const pre = await state(page, card);
            assert.deepEqual(own(pre).map((socket) => socket.state), [3], "no redial before the restart");
            // Restart hands the keyboard to the new terminal, so the retry
            // returns focus to the composer first.
            await page.click(`${card} .cm-content`);
            if (backend === "xterm") {
              await page.keyboard.down("Control");
              await page.keyboard.press("Enter");
              await page.keyboard.up("Control");
            } else {
              await page.click(`${card} .rp-primary`);
            }
            result.sent = await waitFor(page, card, "the kept text sends on the new session", (value) => value.prompts.length === 1);
            assert.equal(result.sent.prompts[0].data, text);
            assert.equal(typeof result.sent.prompts[0].id, "string");
            const id = result.sent.prompts[0].id;
            result.delivered = await waitFor(page, card, "the delivered retry clears the composer",
              (value) => value.sockets.some((socket) => socket.tab === name && socket.delivered.includes(id))
                && value.text === "" && !value.pending);
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
              // A restarted leg is live and asks "Close tab?" before it
              // closes; the helper answers and waits for the count to drop.
              // `cs terminal close` only matches live sessions.
              if (opened) {
                await closeActiveTerminal(page, name);
                const left = await state(page, null).catch(() => null);
                assert.ok(!left || !left.sockets.some((socket) => socket.tab === name && socket.state !== 3),
                  "the leg leaves no live socket behind");
              }
            });
            // The server's roster for this window, read after cleanup: empty
            // when the leg left nothing behind.
            result.roster = await windowSessions(page, token).catch((error) => ({ error: String(error.message ?? error) }));
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
