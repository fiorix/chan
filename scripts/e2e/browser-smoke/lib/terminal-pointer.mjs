import assert from "node:assert/strict";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CPR = /\x1b\[[1-9]\d*;[1-9]\d*R$/;

export function pointerInputSince(fixture, index) {
  return Buffer.concat(fixture.records.slice(index)
    .filter((record) => record.type === "keys")
    .map((record) => Buffer.from(record.base64, "base64"))).toString("latin1");
}

// The cursor reply follows the gesture through the real PTY. Silence from
// a stalled or disconnected recorder cannot satisfy a no-report assertion.
export async function drainPointerInput(fixture, bytes = "", index = fixture.records.length) {
  await fixture.send("bytes", { base64: Buffer.from(bytes + "\x1b[6n").toString("base64") });
  await fixture.waitFor(() => CPR.test(pointerInputSince(fixture, index)));
  const input = pointerInputSince(fixture, index);
  assert.match(input, CPR, "the terminal answered the cursor query");
  return { input: input.replace(CPR, ""), reply: input.match(CPR)[0] };
}

// Reject extra bytes and partial reports instead of extracting only the
// reports a positive regexp happens to recognize.
export function pointerReports(input) {
  const matches = [...input.matchAll(/\x1b\[<(\d+);([1-9]\d*);([1-9]\d*)([Mm])/g)];
  assert.equal(matches.map((match) => match[0]).join(""), input, "the PTY contains only complete SGR reports");
  return matches.map((match) => ({ button: Number(match[1]), col: Number(match[2]), row: Number(match[3]), end: match[4] }));
}

// Capture the actual app instance through its module's open method. All
// subsequent readings use public Terminal methods and the host's DOM.
export async function capturePointerTerminals(page) {
  const installed = await page.evaluate(async () => {
    if (window.__pointerSmoke) throw new Error("pointer terminal capture already installed");
    for (const script of document.querySelectorAll('script[type="module"][src]')) {
      const name = /ghostty-web-[\w-]+\.js/.exec(await (await fetch(script.src)).text())?.[0];
      if (!name) continue;
      const { Terminal } = await import(new URL(name, script.src).href);
      const open = Terminal.prototype.open;
      const terminals = [];
      Terminal.prototype.open = function (...args) {
        terminals.push(this);
        return open.apply(this, args);
      };
      window.__pointerSmoke = {
        terminals,
        restore() { Terminal.prototype.open = open; delete window.__pointerSmoke; },
      };
      return true;
    }
    return false;
  });
  assert.ok(installed, "the entry module names a Ghostty chunk");
}

export async function pointerTerminal(page, hostQuery) {
  return page.evaluateHandle((query) => {
    const host = document.querySelector(query);
    const term = host && window.__pointerSmoke?.terminals.find((candidate) => candidate.element === host);
    if (!term) throw new Error("the attached Ghostty terminal was not captured");
    return term;
  }, hostQuery);
}

export async function pointerGrid(term) {
  return term.evaluate((terminal) => {
    const canvas = terminal.element?.querySelector(":scope > canvas");
    const rect = canvas?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0 || terminal.cols < 30 || terminal.rows < 4) {
      throw new Error("terminal canvas cannot fit the pointer fixture");
    }
    return {
      x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      cols: terminal.cols, rows: terminal.rows,
      w: rect.width / terminal.cols, h: rect.height / terminal.rows,
    };
  });
}

export async function seedPointerClipboard(page, sentinel) {
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
    if (await navigator.clipboard.readText() !== text) throw new Error("clipboard sentinel was not seeded");
  }, sentinel);
}

export async function copyPointerSelection(page, term) {
  await term.evaluate((terminal) => {
    const input = terminal.element?.querySelector("textarea");
    if (!input) throw new Error("terminal input missing");
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
  await settlePointer(page);
  return page.evaluate(() => navigator.clipboard.readText());
}

export async function settlePointer(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await sleep(200);
}

export const POINTER_RESET_MODES = "\x1b[?1000;1002;1003;1006l";

// A missing native sequence is an instrument limitation, not a passing arm.
export function requirePointerSequence(events, type, ending = "pointerup") {
  const down = events.find((event) => event.type === "pointerdown" && event.onCanvas
    && event.pointerType === type && event.isPrimary && event.isTrusted);
  const matches = (event) => down && event.pointerId === down.pointerId
    && event.pointerType === type && event.isPrimary && event.isTrusted && event.onCanvas;
  if (!down || !events.some((event) => matches(event) && event.type === "pointermove" && event.buttons === 1)
      || !events.some((event) => matches(event) && event.type === ending)) {
    throw Object.assign(new Error(`no complete trusted primary ${type} sequence reached the canvas`), { code: "POINTER_UNAVAILABLE" });
  }
  return down;
}

export function penPointer(cdp, type, x, y) {
  return cdp.send("Input.dispatchMouseEvent", {
    type, x, y, pointerType: "pen", button: type === "mouseMoved" ? "none" : "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

export async function observePointer(term) {
  return term.evaluateHandle((terminal) => {
    const canvas = terminal.element.querySelector(":scope > canvas");
    const events = [];
    const types = ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"];
    const record = (event) => events.push({
      type: event.type, pointerId: event.pointerId, pointerType: event.pointerType,
      isPrimary: event.isPrimary, isTrusted: event.isTrusted, button: event.button, buttons: event.buttons,
      x: event.clientX, y: event.clientY, onCanvas: event.target === canvas,
      connected: canvas.isConnected, captured: canvas.hasPointerCapture(event.pointerId),
    });
    // Document capture also observes a loss retargeted after DOM removal.
    const detached = (event) => { if (!canvas.isConnected) record(event); };
    for (const type of types) {
      document.addEventListener(type, record, true);
      canvas.addEventListener(type, detached);
    }
    return {
      canvas, events,
      dispose() {
        for (const type of types) {
          document.removeEventListener(type, record, true);
          canvas.removeEventListener(type, detached);
        }
      },
    };
  });
}

export const pointerEvents = (trace) => trace.evaluate((value) => value.events.slice());
export const pointerWrites = (page) => page.evaluate(() => window.__pointerSmoke.writes.slice());

export function pointerCheckError(details) {
  const error = Object.assign(new Error(details.failures.join("\n")), { smokeDetails: details });
  const unavailable = Object.values(details.legs).filter((leg) => leg.status === "unavailable").length;
  // An unavailable input source must not turn another arm's product failure
  // or a cleanup failure into a runner skip.
  if (unavailable > 0 && unavailable === details.failures.length) error.smokeSkip = true;
  return error;
}

// Own the raw PTYs and page instruments together so a failed arm cannot
// strand a tab, hide later arms, or lose its partial event evidence.
export async function runPointerCheck(ctx, number, body) {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { openAttachedTerminal } = await import("./terminal-attach.mjs");
  const { startTerminalFixture } = await import("./terminal-fixture.mjs");
  const { assertTerminalPrefs, readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } = await import("./terminal-prefs.mjs");
  const { page } = ctx;
  assert.ok(ctx.controlSocket, "control socket is available");
  await page.bringToFront();
  const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
    || sessionStorage.getItem("chan.session.window")?.trim() || "");
  assert.ok(windowId, "the page has a window id");
  await ctx.waitWindowLive(windowId);
  const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
    cwd: ctx.workspaceDir,
    env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
    timeout: 90_000,
  });
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const original = await readTerminalPrefs(page, token);
  const cdp = await page.createCDPSession();
  const details = { legs: {}, unexercised: {}, pageErrors: [], failures: [] };
  const resources = [];
  const onError = (error) => details.pageErrors.push(error.message);
  page.on("pageerror", onError);
  const cleanup = async (label, action) => {
    try { await action(); } catch (error) { details.failures.push(`${label}: ${error.message}`); }
  };
  const open = async (name) => {
    const tab = `Pointer${number}-${name}`;
    const fixture = await startTerminalFixture({ logPath: join(ctx.outDir, `${number}-${name}-output.bin`), deadlineMs: 20_000 });
    const resource = { fixture, tab, closed: false };
    resources.push(resource);
    resource.close = async () => {
      if (resource.closed) return;
      await cs(["close", "--tab-name", tab]);
      resource.closed = true;
      if (resource.query) await page.waitForSelector(resource.query, { hidden: true, timeout: 10_000 });
    };
    const args = ["--command", "stty -opost -echo && " + fixture.command,
      ...Object.entries(fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
    let row;
    try { row = await openAttachedTerminal(ctx, page, cs, windowId, tab, "ghostty", args); }
    catch (error) { throw new Error(String(error.message).replaceAll(fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]")); }
    resource.query = `.pane[data-pane-id="${row.pane}"] .terminal-tab[data-terminal-tab-id="${row.tab}"]`;
    resource.ready = await fixture.ready();
    assert.ok(resource.ready.tty && resource.ready.raw, "the fixture owns a raw PTY");
    resource.term = await pointerTerminal(page, `${resource.query} .terminal-host`);
    resource.trace = await observePointer(resource.term);
    resource.prepare = async (text) => {
      const setup = await drainPointerInput(fixture, `${POINTER_RESET_MODES}\x1b[?25l\x1b[2J\x1b[H${text}\r\n`);
      assert.equal(setup.reply, "\x1b[2;1R", "fixture text reached the parser without wrapping");
      assert.equal(await resource.term.evaluate((t) => t.getScrollbackLength()), 0,
        "each exact-selection gesture starts with empty scrollback");
      assert.deepEqual(await resource.term.evaluate((t) => [t.getMode(1000), t.getMode(1002), t.getMode(1003), t.getMode(1006)]),
        [false, false, false, false], "each gesture starts with tracking off");
      await settlePointer(page);
      return pointerGrid(resource.term);
    };
    return resource;
  };
  const leg = async (name, action) => {
    const result = details.legs[name] = { status: "running" };
    try { await action(result); result.status = "passed"; }
    catch (error) {
      result.error = error.message;
      result.status = error.code === "POINTER_UNAVAILABLE" ? "unavailable" : "failed";
      if (result.status === "unavailable") details.unexercised[name] = error.message;
      details.failures.push(`${name} (${result.status}): ${error.message}`);
      await ctx.shot(`${number}-${name}-${result.status}`).catch(() => {});
    } finally {
      await cleanup("reset mouse", () => page.mouse.reset());
    }
  };
  try {
    await cdp.send("Browser.grantPermissions", {
      browserContextId: ctx.browser.id, origin: new URL(ctx.serverUrl).origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    await writeTerminalPrefs(page, token, { mouse_capture: true });
    await assertTerminalPrefs(ctx, { mouse_capture: true });
    await capturePointerTerminals(page);
    await page.evaluate(() => {
      const state = window.__pointerSmoke;
      const clipboard = navigator.clipboard;
      const descriptor = Object.getOwnPropertyDescriptor(clipboard, "writeText");
      const original = clipboard.writeText;
      const restore = state.restore;
      state.writes = [];
      clipboard.writeText = function (text) {
        const write = { text, status: "pending" };
        state.writes.push(write);
        return original.call(this, text).then(() => { write.status = "fulfilled"; }, (error) => {
          write.status = "rejected"; write.error = error.message; throw error;
        });
      };
      state.restore = () => {
        if (descriptor) Object.defineProperty(clipboard, "writeText", descriptor);
        else delete clipboard.writeText;
        restore();
      };
    });
    await body({ page, cdp, details, open, leg });
  } catch (error) {
    details.failures.push(`setup/body: ${error.message}`);
  } finally {
    await cleanup("reset mouse", () => page.mouse.reset());
    details.resources = [];
    for (const resource of resources) {
      await cleanup(`close ${resource.tab}`, resource.close);
      const saved = { tab: resource.tab, ready: resource.ready, records: resource.fixture.records };
      if (resource.trace) {
        await cleanup("read events", async () => { saved.events = await pointerEvents(resource.trace); });
        await cleanup("remove observer", () => resource.trace.evaluate((value) => value.dispose()));
        await resource.trace.dispose();
      }
      details.resources.push(saved);
      await cleanup("close fixture", () => resource.fixture.close());
      await resource.term?.dispose();
    }
    await cleanup("save clipboard writes", async () => {
      details.writes = await page.evaluate(() => window.__pointerSmoke?.writes ?? []);
    });
    await cleanup("restore instruments", () => page.evaluate(() => window.__pointerSmoke?.restore()));
    await cleanup("restore preferences", () => restoreTerminalPrefs(ctx, page, token, original));
    await cdp.detach().catch(() => {});
    page.off("pageerror", onError);
    if (details.pageErrors.length) details.failures.push(`page errors: ${details.pageErrors.join("; ")}`);
    writeFileSync(join(ctx.outDir, `${number}-pointer.json`), JSON.stringify(details, null, 2) + "\n");
  }
  if (details.failures.length) throw pointerCheckError(details);
  return details;
}

// Samples are measured colour differences between the painted strip and a
// neighbouring blank column. The thumb must stand out from the track;
// neither history length nor the widget's hit-test formula locates it.
export function paintedThumbBand(samples) {
  assert.ok(samples.length >= 20 && samples.every(Number.isFinite), "the strip has readable pixels");
  const sorted = [...samples].sort((a, b) => a - b);
  const track = sorted[Math.floor(sorted.length / 2)];
  const peak = sorted.at(-1);
  assert.ok(peak >= 12 && peak - track >= 10, "a painted thumb is distinguishable from its track");
  const threshold = (track + peak) / 2;
  const bands = [];
  for (let n = 0; n < samples.length; n++) {
    if (samples[n] < threshold) continue;
    const start = n;
    while (n + 1 < samples.length && samples[n + 1] >= threshold) n++;
    bands.push({ start, end: n + 1 });
  }
  assert.equal(bands.length, 1, "the blank strip contains one painted thumb");
  assert.ok(bands[0].end - bands[0].start >= 8, "the painted thumb has a usable height");
  return { ...bands[0], track, peak };
}

export async function pointerStripPixels(term, startRow = 0) {
  return term.evaluate((t, startRow) => {
    const canvas = t.element.querySelector(":scope > canvas");
    const rect = canvas.getBoundingClientRect();
    const context = canvas.getContext("2d");
    if (!context) throw new Error("terminal paint is not readable");
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    // chan paints an eight CSS-pixel strip, four pixels from the right edge.
    const x = Math.floor((rect.width - 8) * scaleX);
    const referenceX = Math.floor((rect.width - 18) * scaleX);
    const top = Math.floor(startRow * canvas.height / t.rows);
    const strip = context.getImageData(x, top, 1, canvas.height - top).data;
    const reference = context.getImageData(referenceX, top, 1, canvas.height - top).data;
    const samples = [];
    for (let n = 0; n < strip.length; n += 4) {
      samples.push(Math.max(...[0, 1, 2].map((channel) => Math.abs(strip[n + channel] - reference[n + channel]))));
    }
    return { x: rect.left + (x + 0.5) / scaleX, y: rect.top + top / scaleY, scaleY, samples };
  }, startRow);
}
