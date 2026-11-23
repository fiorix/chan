import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureGhosttyTerminals } from "./ghostty-capture.mjs";
import { openAttachedTerminal, readTerminalAttachment } from "./terminal-attach.mjs";
import { startTerminalFixture } from "./terminal-fixture.mjs";
import { drainPointerInput, pointerCheckError } from "./terminal-pointer.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const terminalQuery = (row) => `.pane[data-pane-id="${row.pane}"] .terminal-tab[data-terminal-tab-id="${row.tab}"]`;

export async function waitFocus(label, read, accept, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await sleep(50);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}

// Reload can replay old cursor queries. Accept only complete cursor replies
// beside focus reports, so arbitrary bytes or a truncated report cannot hide.
export function focusReports(input) {
  const tokens = input.match(/\x1b\[(?:[IO]|[1-9]\d*;[1-9]\d*R)/g) ?? [];
  assert.equal(tokens.join(""), input, "PTY input contains only complete focus/cursor reports");
  return tokens.filter((token) => token === "\x1b[I" || token === "\x1b[O");
}

export function assertKeyboard(reading, holder) {
  assert.ok(reading.terminal.present && reading.terminal.textareaPresent, "the terminal and its input exist");
  assert.equal(reading.terminal.textareaFocused,
    reading.terminal.containsFocus && reading.active.tag === "TEXTAREA", "textarea focus agrees with document.activeElement");
  if (holder === "composer") {
    assert.ok(reading.terminal.composerFocused && reading.active.composer, "the composer holds the keyboard");
    assert.equal(reading.active.terminal, false, "the terminal host has no keyboard");
    assert.equal(reading.terminal.textareaFocused, false, "the terminal textarea has no keyboard");
  } else {
    assert.ok(reading.active.terminal && (reading.terminal.hostFocused || reading.terminal.textareaFocused),
      "the terminal host or its textarea holds the keyboard");
  }
}

// Install before navigation to retain even a focus stolen and returned in
// one task. This observes DOM events without changing any focus operation.
export function installFocusTrace() {
  const describe = (element) => ({
    tag: element?.tagName ?? null,
    pane: element?.closest?.(".pane")?.getAttribute("data-pane-id") ?? null,
    tab: element?.closest?.(".terminal-tab")?.getAttribute("data-terminal-tab-id") ?? null,
    terminal: !!element?.closest?.(".terminal-host"),
    composer: !!element?.closest?.(".rich-prompt .cm-content"),
  });
  const events = [];
  const record = (event) => events.push({ type: event.type, at: performance.now(),
    target: describe(event.target), active: describe(document.activeElement), related: describe(event.relatedTarget) });
  for (const type of ["focusin", "focusout"]) document.addEventListener(type, record, true);
  window.__focusTrace = {
    events,
    read(query) {
      const tab = document.querySelector(query);
      const host = tab?.querySelector(".terminal-host");
      const textarea = host?.querySelector("textarea");
      const composer = tab?.querySelector(".rich-prompt .cm-content");
      const active = document.activeElement;
      return {
        active: describe(active), events: events.slice(),
        terminal: {
          present: !!host, textareaPresent: !!textarea,
          tabActive: tab?.classList.contains("active") ?? false,
          paneFocused: tab?.closest(".pane")?.classList.contains("focused") ?? false,
          visibility: host ? getComputedStyle(host).visibility : null,
          hostFocused: !!host && host === active,
          containsFocus: !!host && host.contains(active),
          textareaFocused: !!textarea && textarea === active,
          composerFocused: !!composer && composer.contains(active),
        },
      };
    },
    restore() {
      for (const type of ["focusin", "focusout"]) document.removeEventListener(type, record, true);
      delete window.__focusTrace;
    },
  };
}

export const readFocus = (page, query) => page.evaluate((query) => window.__focusTrace.read(query), query);
export const clearFocus = (page) => page.evaluate(() => { window.__focusTrace.events.length = 0; });
export const capturedFocusTerminal = (page, query) => page.evaluateHandle((query) => window.__focusTerminals.term(`${query} .terminal-host`), query);

export async function captureFocusTerminals(page) {
  assert.ok(await captureGhosttyTerminals(page, "__focusTerminals"), "the Ghostty public API was captured");
}

export async function settleFocus(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await sleep(200);
}

export async function clickTerminal(page, query) {
  const point = await page.$eval(`${query} .terminal-host > canvas`, (canvas) => {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + 20, y: rect.top + 20 };
  });
  await page.mouse.click(point.x, point.y);
  await settleFocus(page);
}

export async function enableFocusReports(resource) {
  const receipt = await drainPointerInput(resource.fixture, "\x1b[?1004h\x1b[?2004l");
  assert.equal(await resource.term.evaluate((term) => term.getMode(1004)), true, "DECSET 1004 reached the public core");
  return receipt;
}

export async function runFocusCheck(ctx, number, body) {
  const { page } = ctx;
  const details = { legs: {}, failures: [], pageErrors: [], resources: [] };
  const resources = [], restorers = [];
  const redact = (message) => resources.reduce((text, resource) =>
    text.replaceAll(resource.fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]"), String(message));
  const onError = (error) => details.pageErrors.push(redact(error.message));
  const cleanup = async (label, action) => {
    try { await action(); } catch (error) { details.failures.push(`${label}: ${redact(error.message)}`); }
  };
  let shell, cs;
  page.on("pageerror", onError);
  try {
    assert.ok(ctx.controlSocket, "the runner has a control socket");
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the page has a window id");
    await ctx.waitWindowLive(windowId);
    shell = (args) => ctx.exec(ctx.chanBin, ["shell", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    cs = (args) => shell(["terminal", ...args]);
    await page.evaluate(installFocusTrace);
    await captureFocusTerminals(page);
    const create = async (label) => {
      const fixture = await startTerminalFixture({ logPath: join(ctx.outDir, `${number}-${label}-output.bin`), deadlineMs: 20_000 });
      const resource = { fixture, name: `Focus${number}-${label}`, row: null, term: null };
      resources.push(resource);
      return resource;
    };
    const attach = async (resource, matches) => {
      const { row } = await waitFocus("terminal attachment", () => readTerminalAttachment(page, cs, "ghostty", matches),
        (value) => value.attached && value.row.window === windowId);
      resource.row = row;
      resource.query = terminalQuery(row);
      resource.ready = await resource.fixture.ready();
      assert.ok(resource.ready.tty && resource.ready.raw, "the fixture owns a raw PTY");
      resource.term = await capturedFocusTerminal(page, resource.query);
      return resource;
    };
    const open = async (label, args = []) => {
      const resource = await create(label);
      const spawn = ["--command", "stty -opost -echo && " + resource.fixture.command,
        ...Object.entries(resource.fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), ...args];
      resource.row = await openAttachedTerminal(ctx, page, cs, windowId, resource.name, "ghostty", spawn);
      return attach(resource, (entry) => entry.session_id === resource.row.session_id);
    };
    const leg = async (name, action) => {
      const result = details.legs[name] = { status: "running" };
      try { await action(result); result.status = "passed"; }
      catch (error) {
        result.status = error.code === "FOCUS_UNAVAILABLE" ? "unavailable" : "failed";
        result.error = redact(error.message);
        details.failures.push(`${name} (${result.status}): ${result.error}`);
        await ctx.shot(`${number}-${name}-${result.status}`).catch(() => {});
      }
    };
    await body({ page, details, windowId, shell, cs, create, attach, open, leg,
      restore: (label, action) => restorers.push({ label, action }) });
    assert.ok(Object.keys(details.legs).length, "the check ran at least one leg");
  } catch (error) {
    details.failures.push(`setup/body: ${redact(error.message)}`);
  } finally {
    for (const { label, action } of restorers.reverse()) await cleanup(label, action);
    for (const resource of resources) {
      details.resources.push({ name: resource.name, row: resource.row, ready: resource.ready, records: resource.fixture.records });
      await cleanup("close terminal", async () => {
        if (resource.row) await shell(["pane", "close-tab", "--pane", resource.row.pane, "--tab", resource.row.tab, "--force"]);
        else await cs(["close", "--tab-name", resource.name]);
      });
      await cleanup("close raw fixture", () => resource.fixture.close());
      await resource.term?.dispose().catch(() => {});
    }
    await cleanup("restore page instruments", () => page.evaluate(() => {
      window.__focusTrace?.restore();
      window.__focusTerminals?.restore();
    }));
    page.off("pageerror", onError);
    if (details.pageErrors.length) details.failures.push(`page errors: ${details.pageErrors.join("; ")}`);
    writeFileSync(join(ctx.outDir, `${number}-focus.json`), redact(JSON.stringify(details, null, 2)) + "\n");
  }
  if (details.failures.length) throw pointerCheckError(details);
  return details;
}
