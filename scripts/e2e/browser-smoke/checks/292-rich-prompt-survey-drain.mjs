// A terminal's composer holds a queued prompt while a survey over the
// terminal shows; the prompt drains under the survey; a `1` answers the
// survey and the composer stays empty. The drain cannot wait for the
// survey (the server drains on its own tick), so the survey shows first
// and the submit goes through the strip's Send button, which needs no
// keyboard: every later frame provably lands under the survey.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal, readTerminalAttachment } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The page's patched WebSocket records prompt frames and delivery acks with
// the tab and session they rode on. Installed before the first leg opens;
// each leg resets the prompt list. Fresh dials carry no `session` value
// (only reattaches do): both legs run in one window, so the tab name scopes
// each leg's waits and the first leg's closed socket cannot satisfy the
// second leg's.
function traceSurveyDrain() {
  const NativeSocket = window.WebSocket;
  const trace = window.__prompt292 = { sockets: [], prompts: [] };
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args) {
      const url = new URL(args[0], location.href);
      if (url.pathname !== "/api/terminal/ws") {
        return Reflect.construct(target, args);
      }
      const socket = Reflect.construct(target, args);
      // Fresh dials carry no `session` value (only reattaches do); the tab
      // name scopes the leg.
      const tab = url.searchParams.get("tab_name");
      const session = url.searchParams.get("session");
      const record = { socket, tab, session, ready: false, delivered: [] };
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
          if (frame?.type === "prompt") trace.prompts.push({ ...frame, session });
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
    const active = document.activeElement;
    const trace = window.__prompt292;
    return {
      text: editor?.textContent ?? null,
      editable: editor?.getAttribute("contenteditable") === "true",
      pending: composer?.classList.contains("pending") ?? null,
      note: note?.textContent ?? null,
      focus: active === null || active === document.body ? "body"
        : active.closest(".survey-card") ? "survey"
        : composer?.contains(active) ? "composer" : `${active.tagName}.${active.className?.toString?.() ?? ""}`,
      card: Boolean(composer?.closest(".terminal-tab")?.querySelector(".survey-card")),
      sockets: trace?.sockets.map(({ socket, tab, session, ready, delivered }) => ({
        state: socket.readyState, tab, session, ready, delivered,
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
  name: "rich-prompt-survey-drain",
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
      await page.evaluate(traceSurveyDrain);
      try {
        for (const backend of ["xterm", "ghostty"]) {
          const name = `Prompt292-${backend}`;
          const text = `PROMPT292-${backend}`;
          const result = { backend, passed: false, pageErrors: [], cleanupErrors: [] };
          const onError = (error) => result.pageErrors.push(String(error));
          page.on("pageerror", onError);
          let opened = false;
          let survey = null;
          try {
            await writeTerminalPrefs(page, token, { ghostty: backend === "ghostty" });
            const row = await openAttachedTerminal(ctx, page, cs, windowId, name, backend);
            opened = true;
            const session = row.session_id;
            const attachment = await readTerminalAttachment(page, cs, backend, (entry) => entry.session_id === session);
            assert.ok(attachment.attached, `the ${backend} terminal is attached`);
            await page.evaluate(() => { window.__prompt292.prompts.length = 0; });
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
            // The survey shows first; the submit, drain and answer all land
            // under it. `cs terminal survey` blocks server-side until the
            // survey resolves, so its result is read back, never awaited.
            survey = { result: null, promise: null };
            survey.promise = cs(["survey", "--tab-name", name, "--timeout", "60",
              "--title", `Keyboard ownership: 292-${backend}`,
              "--option", "Alpha", "--option", "Beta",
              "The composer holds a queued prompt while this survey shows.",
            ]).then(
              ({ stdout }) => (survey.result = { code: 0, stdout: stdout.trim() }),
              (error) => (survey.result = { code: error.code ?? "unknown", stdout: error.stdout ?? "", error: String(error.message ?? error) }),
            );
            await waitFor(page, card, "the survey shows over the terminal", (value) => value.card, 10_000);
            result.surveyShown = await waitFor(page, card, "the survey holds the keyboard", (value) => value.focus === "survey");
            // The Send button needs no keyboard: the click submits under the
            // survey and must send exactly one prompt.
            await page.click(`${card} .rp-primary`);
            result.sent = await waitFor(page, card, "the submit sends one prompt", (value) => value.prompts.length === 1, 5000);
            assert.equal(result.sent.prompts[0].data, text);
            assert.equal(typeof result.sent.prompts[0].id, "string");
            const id = result.sent.prompts[0].id;
            result.delivered = await waitFor(page, card, "the prompt drains without taking the keyboard",
              (value) => value.sockets.some((socket) => socket.tab === name && socket.delivered.includes(id))
                && value.text === "" && !value.pending && value.focus !== "composer" && value.note === null, 10_000);
            await ctx.shot(`292-${backend}-drained-under-survey`);
            // The click left DOM focus on the Send button; selecting the
            // tab hands the keyboard back to the card through the app's
            // own focus routing.
            let reselected = false;
            for (const tab of await page.$$(".pane .tabs .tab-row > .tab")) {
              const label = await tab.$eval(".path", (path) => path.textContent?.trim() ?? "").catch(() => "");
              if (label === name) { await tab.click(); reselected = true; break; }
            }
            assert.ok(reselected, "the leg's terminal tab is selected again");
            await waitFor(page, card, "returning to the survey gives its card the keyboard", (value) => value.focus === "survey");
            await page.keyboard.press("1");
            await waitFor(page, card, "the survey card closes", (value) => !value.card, 20_000);
            result.answered = await waitFor(page, card, "the composer stays empty",
              (value) => value.text === "" && value.editable && !value.pending, 5000);
            const deadline = Date.now() + 20_000;
            while (!survey.result && Date.now() < deadline) await sleep(50);
            assert.ok(survey.result, "the survey answered");
            assert.equal(survey.result.code, 0);
            assert.equal(survey.result.stdout, "Alpha");
            assert.deepEqual(result.pageErrors, []);
            await ctx.shot(`292-${backend}-answered-composer-empty`);
            result.passed = true;
          } catch (error) {
            result.failure = String(error.message ?? error);
            failures.push(`${backend}: ${result.failure}`);
            result.final = await state(page, null).catch(() => null);
            await ctx.shot(`292-${backend}-failure`).catch(() => {});
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
              // The tab bus closes whatever tab is active, live session or
              // not; `cs terminal close` only matches live sessions.
              if (opened) await dispatchCommand(page, "app.tab.close");
            });
          }
          if (result.passed && result.pageErrors.length) {
            result.passed = false;
            failures.push(`${backend}: browser exceptions: ${result.pageErrors.join("; ")}`);
          }
          writeFileSync(join(ctx.outDir, `292-${backend}.json`),
            `${JSON.stringify(result, null, 2)}\n`);
        }
      } finally {
        await page.evaluate(() => window.__prompt292?.restore());
      }
    } finally {
      await writeTerminalPrefs(page, token, { ghostty: original.ghostty });
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
