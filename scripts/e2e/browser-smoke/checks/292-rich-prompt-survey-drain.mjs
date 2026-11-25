// A terminal's composer holds a queued prompt while a survey over the
// terminal shows; the prompt drains under the survey; a `1` answers the
// survey and the composer stays empty. The terminal prints until the check
// releases it, which holds the server's queue (the drainer waits for its
// output to go quiet), then turns into a raw PTY recorder: the queued
// prompt is submitted with Ctrl+Enter before the survey shows, drains only
// after the survey holds the keyboard, and the recorder shows the drained
// text reached the PTY and nothing after it, the `1` included. The red
// variant of this check runs the same file on a tree with
// `292-rich-prompt-survey-drain.red.patch` applied: the drained composer
// then takes the keyboard from the survey.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeActiveTerminal } from "../lib/pane-strip.mjs";
import { recordedSince } from "../lib/pty-recorder.mjs";
import { openAttachedTerminal, readTerminalAttachment } from "../lib/terminal-attach.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const bytesOf = (file) => existsSync(file)
  ? [...readFileSync(file)].map((byte) => byte.toString(16).padStart(2, "0"))
  : [];

/// The recorder's size once it has stopped growing for half a second, so a
/// drain read mid-write counts all of its bytes.
async function settledSize(file) {
  const deadline = Date.now() + 10_000;
  let size = bytesOf(file).length;
  let steadySince = Date.now();
  while (Date.now() - steadySince < 500) {
    if (Date.now() > deadline) throw new Error(`the recorder kept growing for 10 s; it holds ${size} bytes`);
    await sleep(100);
    const next = bytesOf(file).length;
    if (next !== size) {
      size = next;
      steadySince = Date.now();
    }
  }
  return size;
}

// The page's patched WebSocket records prompt frames, their acks and
// delivery acks with the tab they rode on. The tab name scopes the waits
// so an unrelated terminal cannot satisfy them.
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
      const tab = url.searchParams.get("tab_name");
      const record = { socket, tab, ready: false, acks: [], delivered: [] };
      trace.sockets.push(record);
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.type === "ready") record.ready = true;
        if (frame.type === "prompt-ack") record.acks.push({ id: frame.id, queued: frame.queued });
        if (frame.type === "prompt-delivered") record.delivered.push(frame.id);
      });
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          let frame;
          try { frame = JSON.parse(data); } catch { /* Raw input is not JSON. */ }
          if (frame?.type === "prompt") trace.prompts.push({ ...frame, tab });
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
      sockets: trace?.sockets.map(({ socket, tab, ready, acks, delivered }) => ({
        state: socket.readyState, tab, ready, acks, delivered,
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
    const backend = "ghostty";
    const directory = mkdtempSync(join(ctx.workspaceDir, ".surveydrain-292-"));
    const failures = [];
    try {
      await page.evaluate(traceSurveyDrain);
      try {
        const name = `Prompt292-${backend}`;
        // No `1` in the text: the recorder must hold none but a stray key.
        const text = `PROMPT292-${backend}`;
        const stop = join(directory, `${backend}.stop`);
        const recorder = join(directory, `${backend}.bytes`);
        const result = { backend, passed: false, pageErrors: [], cleanupErrors: [] };
        const onError = (error) => result.pageErrors.push(String(error));
        page.on("pageerror", onError);
        let opened = false;
        let survey = null;
        try {
          // Output every 200 ms holds the queue; the stop file ends it, at
          // most 60 s later, and the shell becomes a raw recorder of every
          // byte the PTY receives.
          const command =
            `i=0; while [ ! -e ${shellQuote(stop)} ] && [ $i -lt 300 ]; do echo tick; sleep .2; i=$((i+1)); done; ` +
            `stty raw -echo && exec dd bs=1 status=none of=${shellQuote(recorder)}`;
          const row = await openAttachedTerminal(ctx, page, cs, windowId, name, ["--command", command]);
          opened = true;
          const attachment = await readTerminalAttachment(page, cs, (entry) => entry.session_id === row.session_id);
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

          // Submit while the terminal prints: the server queues the prompt.
          // It acks every accepted prompt as queued, so the ack proves no
          // hold; the recorder not yet started does.
          await page.keyboard.down("Control");
          await page.keyboard.press("Enter");
          await page.keyboard.up("Control");
          result.queued = await waitFor(page, card, "the server acknowledges the submit",
            (value) => value.prompts.length === 1 && value.sockets.some((socket) => socket.tab === name
              && socket.acks.some((ack) => ack.id === value.prompts[0].id && ack.queued === true)));
          assert.equal(result.queued.prompts[0].data, text);
          const id = result.queued.prompts[0].id;
          assert.ok(!existsSync(recorder), "precondition: the queue is held, the recorder not yet started");

          // The survey shows over the terminal and takes the keyboard.
          // `cs terminal survey` blocks server-side until the survey
          // resolves, so its result is read back, never awaited.
          survey = { result: null };
          cs(["survey", "--tab-name", name, "--timeout", "60",
            "--title", `Keyboard ownership: 292-${backend}`,
            "--option", "Alpha", "--option", "Beta",
            "The composer holds a queued prompt while this survey shows.",
          ]).then(
            ({ stdout }) => (survey.result = { code: 0, stdout: stdout.trim() }),
            (error) => (survey.result = { code: error.code ?? "unknown", stdout: error.stdout ?? "", error: String(error.message ?? error) }),
          );
          await waitFor(page, card, "the survey shows over the terminal", (value) => value.card, 10_000);
          result.surveyShown = await waitFor(page, card,
            "precondition: the survey holds the keyboard while the prompt still waits",
            (value) => value.focus === "survey" && value.pending
              && !value.sockets.some((socket) => socket.tab === name && socket.delivered.includes(id)));
          await ctx.shot(`292-${backend}-queued-under-survey`);

          // Release the queue: the output stops and the prompt drains
          // under the survey, which keeps the keyboard.
          writeFileSync(stop, "");
          result.delivered = await waitFor(page, card, "the prompt drains without taking the keyboard",
            (value) => value.sockets.some((socket) => socket.tab === name && socket.delivered.includes(id))
              && value.text === "" && !value.pending && value.focus === "survey" && value.note === null, 20_000);
          await recordedSince("the drained prompt reaches the PTY", recorder, 0, "50");
          result.drainedBytes = await settledSize(recorder);
          await ctx.shot(`292-${backend}-drained-under-survey`);

          await page.keyboard.press("1");
          await waitFor(page, card, "the survey card closes", (value) => !value.card, 20_000);
          result.answered = await waitFor(page, card, "the composer stays empty",
            (value) => value.text === "" && value.editable && !value.pending, 5000);
          const deadline = Date.now() + 20_000;
          while (!survey.result && Date.now() < deadline) await sleep(50);
          assert.ok(survey.result, "the survey answered");
          assert.equal(survey.result.code, 0);
          assert.equal(survey.result.stdout, "Alpha");
          await sleep(500);
          const bytes = bytesOf(recorder);
          result.recorded = bytes.length;
          assert.ok(!bytes.includes("31"), `the 1 reached the PTY: ${JSON.stringify(bytes)}`);
          assert.equal(bytes.length, result.drainedBytes,
            `no byte reached the PTY after the drain: ${JSON.stringify(bytes.slice(result.drainedBytes))}`);
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
          // An early failure leaves the loop printing until its bound.
          await cleanup("queue release", async () => writeFileSync(stop, ""));
          await cleanup("owned terminal cleanup", async () => {
            // The recorder is a live process, so the close asks first;
            // the helper confirms it so no prompt keeps the keyboard.
            if (opened) await closeActiveTerminal(page, `${backend} cleanup`);
          });
        }
        if (result.passed && result.pageErrors.length) {
          result.passed = false;
          failures.push(`${backend}: browser exceptions: ${result.pageErrors.join("; ")}`);
        }
        writeFileSync(join(ctx.outDir, `292-${backend}.json`),
          `${JSON.stringify(result, null, 2)}\n`);
      } finally {
        await page.evaluate(() => window.__prompt292?.restore());
      }
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* The workspace teardown removes it. */ }
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
