// A terminal whose core fails to load shows its own error, saying no shell was
// started, with Retry, Reload window and Close; it opens no other terminal in
// its place and spawns no PTY, while the window around it keeps working;
// Retry, once the core loads again, opens one Ghostty terminal on one PTY in
// the same document. A failed widget chunk, a module import the engine may
// keep failed, shows the same error over the live session, and Retry and
// Reload window are read after the chunk loads again. A core the engine
// refuses to compile is a failure the page keeps: the card offers Reload
// window and Close only, and in the focused pane holds the keyboard itself.
// Where the keyboard rests is read after each failure and after the tab's
// menu closes, and keys typed with the page's keyboard into the retried and
// the reloaded terminal are read back from the shell and the widget.
//
// The failures are the network's: request interception aborts the page's
// requests for the core's wasm asset, or for the widget's JS chunk, while the
// check holds them failed, and lets them through once it lifts the failure.
// The final failure answers the core with a page that is not wasm, as a
// server's fallback page would be. Chrome's cache is off for the whole check:
// a reloaded document is otherwise handed the widget's chunk from the
// renderer's cache of the document before, a load request interception never
// sees, so the abort fails nothing and the terminal opens. What the network
// did with each core and chunk request is recorded beside what the check
// asked of it.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { captureGhosttyTerminals } from "../lib/ghostty-capture.mjs";
import { readTerminalAttachment } from "../lib/terminal-attach.mjs";
import { waitSaved } from "./290-rich-prompt-disconnected.mjs";

const NAME = "Load347";
// The terminal the final failure's leg opens beside the restored one.
const FINAL_NAME = "Load347f";
const FILE = "load347.md";
const WAIT_MS = 30_000;
const KEYBOARD_MS = 5_000;
// Long enough for a reload or a close an action started to show.
const KEYS_SETTLE_MS = 1_000;
const CORE = /\/ghostty-vt[^/]*\.wasm(?:[?#]|$)/;
// The widget's chunk, as the build emits it (`assets/ghostty-web-<hash>.js`).
const CHUNK = /\/assets\/ghostty-web-[A-Za-z0-9_-]+\.js(?:[?#]|$)/;
// A 200 answer for the core that is not wasm, which the engine refuses to
// compile.
const NOT_WASM = "<!doctype html><title>chan</title>";
const CAPTURE = "__check347terminals";
const FAILED = "The terminal view could not load.";
const NO_SHELL = "No shell was started.";
const SHELL_RUNS = "The failure did not end its shell; Retry attaches to it.";
const FINAL = "This window will not load the terminal again until it is reloaded.";
const FINAL_SHELL_RUNS = "The failure did not end its shell; the reload attaches to it.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  name: "terminal-load-failure",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("opening and counting terminals needs the server's control socket");
    const { page } = ctx;
    const details = { coreRequests: [], chunkRequests: [], network: [], continueErrors: [], legs: {} };
    await page.setViewport({ width: 1280, height: 800 });

    // How the check answers each kind of request: "abort" fails it in the
    // network, "hold" leaves it unanswered until `releaseHeld`, and "not
    // wasm" (the core only) answers it with NOT_WASM; null lets it through.
    const failing = { core: "abort", chunk: null };
    const held = [];
    const onRequest = (request) => {
      if (request.isInterceptResolutionHandled()) return;
      const answered = (error) => details.continueErrors.push(`${request.url()}: ${error.message}`);
      for (const [kind, pattern, list] of [["core", CORE, details.coreRequests], ["chunk", CHUNK, details.chunkRequests]]) {
        if (!pattern.test(request.url())) continue;
        const answer = failing[kind] ?? "through";
        list.push({ url: request.url(), failed: answer === "abort", answer });
        if (answer === "abort") return void request.abort("failed").catch(answered);
        if (answer === "hold") return void held.push({ request, answered });
        if (answer === "not wasm") {
          return void request.respond({ status: 200, contentType: "text/html", body: NOT_WASM }).catch(answered);
        }
      }
      void request.continue().catch(answered);
    };
    const releaseHeld = () => {
      for (const { request, answered } of held.splice(0)) void request.continue().catch(answered);
    };
    // How each core and chunk request ended: failed by the network, or
    // finished, from the cache or not.
    const kindOf = (url) => (CORE.test(url) ? "core" : CHUNK.test(url) ? "chunk" : null);
    const onFailed = (request) => {
      const kind = kindOf(request.url());
      if (kind) details.network.push({ kind, url: request.url(), ended: "failed", error: request.failure()?.errorText ?? null });
    };
    const onFinished = (request) => {
      const kind = kindOf(request.url());
      if (kind) details.network.push({ kind, url: request.url(), ended: "finished", fromCache: request.response()?.fromCache() ?? null });
    };
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", onRequest);
    page.on("requestfailed", onFailed);
    page.on("requestfinished", onFinished);
    writeFileSync(join(ctx.workspaceDir, FILE), "# Load 347\n");
    // The cleanup below reads these, so they live outside the try.
    let terminal = null;
    let sessions = null;
    // The window's sessions before the check opens its terminal.
    let baseline = null;
    // Whether the check itself threw: a cleanup error then must not replace
    // the check's error.
    let checkFailed = false;
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS });
      await page.waitForSelector(".pane", { visible: true, timeout: WAIT_MS });
      const windowId = await page.evaluate(
        () =>
          new URL(location.href).searchParams.get("w")?.trim() ||
          window.sessionStorage.getItem("chan.session.window")?.trim() ||
          "",
      );
      assert.ok(windowId, "the page's window id");
      await ctx.waitWindowLive(windowId);
      const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
      const shell = (args) => ctx.exec(ctx.chanBin, ["shell", ...args], { cwd: ctx.workspaceDir, env, timeout: 60_000 });
      terminal = (args) => shell(["terminal", ...args]);
      const rows = async () => Object.values(JSON.parse((await terminal(["list", "--json"])).stdout).groups ?? {}).flat();
      // Every session the window gained since the baseline, whatever its
      // name: a second PTY for the same tab is registered under a name of
      // its own (Load347-2), and must still count.
      sessions = async () =>
        (await rows()).filter((row) => row.window === windowId && !baseline.has(row.session_id));

      // What a terminal tab holds: its load error and actions, and what
      // opened in its terminal area.
      const tabState = (tabId) =>
        page.evaluate((id) => {
          const tab = document.querySelector(`.terminal-tab[data-terminal-tab-id="${id}"]`);
          const area = tab?.querySelector(".terminal-host");
          const alert = tab?.querySelector(".terminal-main [role=alert]");
          return {
            mounted: !!tab,
            error: alert?.textContent?.replace(/\s+/g, " ").trim() ?? null,
            clicked: alert?.hasAttribute("data-check347-clicked") ?? false,
            actions: alert ? [...alert.querySelectorAll("button")].map((button) => button.textContent.trim()) : [],
            area: area ? [...area.children].map((child) => `${child.tagName.toLowerCase()}.${String(child.className)}`) : null,
            canvases: area ? area.querySelectorAll("canvas").length : null,
          };
        }, tabId);

      // A mark on the document: a reload replaces the document, and the mark
      // goes with it.
      const markDocument = (mark) => page.evaluate((value) => void (window.__check347 = value), mark);
      const documentMark = () => page.evaluate(() => window.__check347 ?? null);

      // Click one of the tab's load error actions, by name. The error it was
      // clicked on keeps a mark, so a read after the click can tell that error
      // from one shown since.
      const clickAction = async (tabId, name) => {
        const button = await page.evaluateHandle((id, label) => {
          const alert = document.querySelector(`.terminal-tab[data-terminal-tab-id="${id}"] .terminal-main [role=alert]`);
          const found = [...(alert?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === label) ?? null;
          alert?.setAttribute("data-check347-clicked", "");
          return found;
        }, tabId, name);
        assert.ok(await button.evaluate((b) => b !== null), `the ${name} action`);
        await button.asElement().click();
      };

      // After a reload: the window's one terminal, the check's, once it shows
      // its load error.
      const restoredFailure = async (shot) => {
        const end = Date.now() + WAIT_MS;
        for (;;) {
          const tabs = await page.$$eval(".terminal-tab[data-terminal-tab-id]", (all) =>
            all.map((tab) => tab.getAttribute("data-terminal-tab-id")));
          assert.ok(tabs.length <= 1, `the window holds one terminal, the check's; it shows ${JSON.stringify(tabs)}`);
          const state = tabs.length === 1 ? await tabState(tabs[0]) : null;
          if (state?.error) return { tabId: tabs[0], state };
          if (Date.now() > end) {
            await ctx.shot(shot);
            assert.fail(`the restored terminal's load error never showed: ${JSON.stringify({ tabs, state })}`);
          }
          await sleep(100);
        }
      };

      // The terminal attached on `tabId`, or null.
      const attachedOn = async (tabId) => {
        const attachment = await readTerminalAttachment(page, terminal, (row) => row.name === NAME);
        return attachment.attached && attachment.row.tab === tabId ? attachment.row : null;
      };

      const hostOf = (tabId) => `.terminal-tab[data-terminal-tab-id="${tabId}"] .terminal-host`;

      // Where the keyboard is, as `document.activeElement` says: the element,
      // its pane, and whether it is the tab's load error card itself, one of
      // the card's actions, inside the terminal's area or in an editor.
      const keyboard = (tabId) =>
        page.evaluate((id) => {
          const holder = document.activeElement;
          const tab = document.querySelector(`.terminal-tab[data-terminal-tab-id="${id}"]`);
          const card = tab?.querySelector(".terminal-main [role=alert]") ?? null;
          const area = tab?.querySelector(".terminal-host") ?? null;
          const inCard = !!card && !!holder && card.contains(holder);
          return {
            holder: holder ? [holder.tagName.toLowerCase(), ...holder.classList].join(".") : null,
            pane: holder?.closest(".pane")?.getAttribute("data-pane-id") ?? null,
            card: !!card && holder === card,
            inCard,
            action: inCard && holder instanceof HTMLButtonElement ? holder.textContent.trim() : null,
            terminal: !!area && !!holder && area.contains(holder),
            editor: !!holder?.closest(".editor-wrap .cm-content"),
            focusVisible: holder?.matches(":focus-visible") ?? false,
          };
        }, tabId);

      // The keyboard once `accept` reads it so, or, marked unsettled, the
      // last reading when it never does.
      const keyboardSoon = async (tabId, accept) => {
        const end = Date.now() + KEYBOARD_MS;
        for (;;) {
          const reading = await keyboard(tabId);
          const settled = accept(reading);
          if (settled || Date.now() > end) return { ...reading, settled };
          await sleep(100);
        }
      };

      // The keyboard once `accept` reads it so, or a red naming where it is.
      const keyboardWhen = async (tabId, accept, what, shot) => {
        const reading = await keyboardSoon(tabId, accept);
        if (reading.settled) return reading;
        await ctx.shot(shot);
        assert.fail(`${what}: the keyboard is on ${JSON.stringify(reading)}`);
      };

      // The rows the widget shows, read from its core through the capture of
      // the document the terminal opened in.
      const screenRows = (tabId) =>
        page.evaluate((key, query) => {
          const term = window[key].term(query);
          const first = Math.max(0, term.getScrollbackLength() - Math.floor(term.getViewportY()));
          return Array.from({ length: term.rows }, (_, row) =>
            term.core.plainText({ startRow: first + row, startCol: 0, endRow: first + row, endCol: term.cols - 1 }));
        }, CAPTURE, hostOf(tabId));

      // Type a command with the page's keyboard, into whatever holds it, and
      // read its output in the session's scrollback and on the widget's
      // screen. The output `kb<marker>` is not in the typed text, so only a
      // shell that ran the typed keys prints it.
      const typeMarker = async (tabId, marker, shot) => {
        const output = `kb${marker}`;
        const reading = { output };
        await page.keyboard.type(`printf 'kb%s\\n' ${marker}`);
        await page.keyboard.press("Enter");
        const end = Date.now() + WAIT_MS;
        for (;;) {
          const { stdout } = await terminal(["scrollback", "--tab-name", NAME]);
          const rows = await screenRows(tabId);
          reading.scrollback = stdout.includes(output);
          reading.screen = rows.some((row) => typeof row === "string" && row.includes(output));
          if (reading.scrollback && reading.screen) return reading;
          if (Date.now() > end) {
            await ctx.shot(shot);
            assert.fail(`the typed ${output} never came back: ${JSON.stringify({ ...reading, scrollbackTail: stdout.slice(-400), rows })}`);
          }
          await sleep(250);
        }
      };

      const before = await page.$$eval(".terminal-tab[data-terminal-tab-id]", (tabs) =>
        tabs.map((tab) => tab.getAttribute("data-terminal-tab-id")));
      const listed = await rows();
      assert.deepEqual(listed.filter((row) => row.name === NAME), [], `no ${NAME} session before the check`);
      baseline = new Set(listed.filter((row) => row.window === windowId).map((row) => row.session_id));
      details.baseline = baseline.size;
      await terminal(["new", "--tab-name", NAME]);
      const tabId = await page.waitForFunction(
        (known) => [...document.querySelectorAll(".terminal-tab[data-terminal-tab-id]")]
          .map((tab) => tab.getAttribute("data-terminal-tab-id"))
          .find((id) => !known.includes(id)) ?? null,
        { timeout: WAIT_MS },
        before,
      ).then((handle) => handle.jsonValue());

      // The failure: the terminal's own error with Retry, nothing in its area
      // and no PTY.
      const failed = { tabId };
      details.legs.failed = failed;
      const end = Date.now() + WAIT_MS;
      for (;;) {
        failed.state = await tabState(tabId);
        if (failed.state.error !== null) break;
        if (Date.now() > end) {
          failed.sessions = await sessions();
          await ctx.shot("347-no-load-error");
          assert.fail(`the terminal's load error never showed: the tab reads ${JSON.stringify(failed.state)}, ` +
            `with ${failed.sessions.length} session(s) new in the window`);
        }
        await sleep(100);
      }
      await ctx.shot("347-load-error");
      failed.coreRequests = details.coreRequests.length;
      assert.ok(failed.coreRequests >= 1 && details.coreRequests.every((r) => r.failed), "the page asked for the core and every request failed");
      assert.deepEqual(failed.state.actions.slice(0, 2), ["Retry", "Reload window"], "a failed fetch offers Retry and a reload");
      assert.equal(failed.state.actions.length, 3, "and one more way out");
      assert.match(failed.state.actions[2], /^Close \S/, "the third closes the tab");
      assert.ok(failed.state.error.includes(FAILED), "the error says what failed");
      assert.ok(failed.state.error.includes(NO_SHELL), "and that no shell was started");
      assert.deepEqual(failed.state.area, [], "nothing opened in the terminal's area");
      // The terminal opened in the focused pane, so its card takes the
      // keyboard as the terminal would have: onto Retry.
      failed.keyboard = await keyboardWhen(tabId, (k) => k.action === "Retry", "the focused pane's card hands the keyboard to Retry",
        "347-failed-keyboard");
      await sleep(1_000);
      failed.sessions = await sessions();
      assert.deepEqual(failed.sessions, [], "no PTY was spawned for the failed terminal");

      // The card's column: with Details open, the card takes the hidden
      // terminal area's place in the row and centres in the terminal's column
      // beside the inspector, and the area shows nothing. Details is toggled
      // the way a user does it, from the Details row of the tab's menu; the
      // press on the tab hands the keyboard to the pane's surface, which is
      // the card, so once the menu closes Retry holds it again.
      const column = { tabId };
      details.legs.column = column;
      const toggleDetails = async (open) => {
        const strip = await page.evaluateHandle((name) => {
          const tabs = [...document.querySelectorAll(".pane .tab")]
            .filter((tab) => tab.querySelector(".tab-label")?.textContent?.includes(name));
          return tabs.length === 1 ? tabs[0] : null;
        }, NAME);
        assert.ok(await strip.evaluate((tab) => tab !== null), `one ${NAME} tab in the strip`);
        await strip.asElement().click({ button: "right" });
        await page.waitForSelector(".terminal-tab-menu-bubble", { visible: true, timeout: WAIT_MS });
        const row = await page.$$eval(".terminal-tab-menu-bubble button.mbtn", (rows) => {
          const found = rows.find((button) => button.querySelector(".mbtn-label")?.textContent.trim() === "Details");
          const checked = found?.getAttribute("aria-checked") ?? null;
          found?.click();
          return { found: !!found, checked };
        });
        assert.ok(row.found, "the tab's menu offers Details");
        assert.equal(row.checked, String(!open), `the Details row reads ${open ? "off before it opens" : "on before it closes"}`);
        await page.waitForFunction(() => !document.querySelector(".terminal-tab-menu-bubble"), { timeout: WAIT_MS });
      };
      const inspectorSelector = `.terminal-tab[data-terminal-tab-id="${tabId}"] .terminal-main aside.inspector`;
      await toggleDetails(true);
      await page.waitForSelector(inspectorSelector, { visible: true, timeout: WAIT_MS });
      column.keyboardMenuOpened = await keyboardWhen(tabId, (k) => k.action === "Retry",
        "Retry holds the keyboard once the menu that opened Details closes", "347-menu-keyboard-open");
      column.boxes = await page.evaluate((id) => {
        const tab = document.querySelector(`.terminal-tab[data-terminal-tab-id="${id}"]`);
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const inspector = tab?.querySelector(".terminal-main aside.inspector");
        return {
          main: box(tab?.querySelector(".terminal-main")),
          area: box(tab?.querySelector(".terminal-host")),
          card: box(tab?.querySelector(".terminal-main [role=alert]")),
          inspector: box(inspector),
          inspectorMarginLeft: inspector ? parseFloat(getComputedStyle(inspector).marginLeft) || 0 : null,
        };
      }, tabId);
      await ctx.shot("347-card-column");
      const { main, area, card, inspector, inspectorMarginLeft } = column.boxes;
      assert.ok(main && area && card && inspector, `every box reads: ${JSON.stringify(column.boxes)}`);
      assert.equal(area.width * area.height, 0, `the terminal's area shows nothing: ${JSON.stringify(column.boxes)}`);
      assert.ok(card.width > 0 && card.height > 0, "the card shows");
      const columnRight = inspector.left - inspectorMarginLeft;
      assert.ok(card.left >= main.left && card.right <= columnRight,
        `the card lies in the terminal's column, clear of Details: ${JSON.stringify(column.boxes)}`);
      column.offCentre = (card.left + card.right) / 2 - (main.left + columnRight) / 2;
      assert.ok(Math.abs(column.offCentre) <= 2, `the card centres in the terminal's column: ${JSON.stringify(column)}`);
      await toggleDetails(false);
      await page.waitForFunction((selector) => !document.querySelector(selector), { timeout: WAIT_MS }, inspectorSelector);
      column.keyboardMenuClosed = await keyboardWhen(tabId, (k) => k.action === "Retry",
        "Retry holds the keyboard once the menu that closed Details closes", "347-menu-keyboard-closed");

      // The window around it still works: a file opens in a new pane.
      const panes = async () => JSON.parse((await shell(["pane", "list", "--json"])).stdout).panes;
      const [first] = await panes();
      await shell(["pane", "new", "right", "--pane", first.id]);
      const right = (await panes()).find((pane) => pane.id !== first.id);
      assert.ok(right, "the split made a second pane");
      await shell(["open", FILE, "--pane", right.id]);
      await page.waitForSelector(`.pane[data-pane-id="${right.id}"] .editor-wrap .cm-content`, { visible: true, timeout: WAIT_MS });
      details.legs.window = { fileOpened: true, terminalStillFailed: (await tabState(tabId)).error !== null };
      assert.equal(details.legs.window.terminalStillFailed, true, "the failed terminal keeps its error beside the opened file");

      // Retry once the core loads again: one Ghostty terminal on one PTY, in
      // the document the error was shown in, holding the keyboard the
      // pressed Retry held, and wired to read what the page's keyboard types.
      failing.core = null;
      const retried = {};
      details.legs.retried = retried;
      if (!(await captureGhosttyTerminals(page, CAPTURE))) assert.fail("no entry module of the page names the widget's chunk");
      await markDocument("retry");
      await clickAction(tabId, "Retry");
      const attachedBy = Date.now() + WAIT_MS;
      while (!(await attachedOn(tabId))) {
        if (Date.now() > attachedBy) {
          retried.state = await tabState(tabId);
          await ctx.shot("347-retry-not-attached");
          assert.fail(`Retry did not open the terminal: ${JSON.stringify({ sessions: await sessions(), tab: retried.state })}`);
        }
        await sleep(250);
      }
      retried.mark = await documentMark();
      retried.state = await tabState(tabId);
      retried.coreRequests = details.coreRequests.length;
      assert.equal(retried.mark, "retry", "Retry opened the terminal without reloading the page");
      assert.equal(retried.state.error, null, "the error is gone");
      assert.equal(retried.state.canvases, 1, "one terminal in the terminal's area");
      assert.ok(retried.coreRequests > failed.coreRequests, "the retry asked for the core again");
      retried.keyboard = await keyboardWhen(tabId, (k) => k.terminal, "Retry hands the keyboard to the terminal it opened",
        "347-retried-keyboard");
      await terminal(["write", "--tab-name", NAME, "printf 'ok%s\\n' 347\n"]);
      const echoedBy = Date.now() + WAIT_MS;
      for (;;) {
        const { stdout } = await terminal(["scrollback", "--tab-name", NAME]);
        if (stdout.includes("ok347")) break;
        if (Date.now() > echoedBy) assert.fail(`the shell never answered; its scrollback reads ${JSON.stringify(stdout.slice(-400))}`);
        await sleep(250);
      }
      retried.typed = await typeMarker(tabId, "347r", "347-retried-typed");
      await sleep(1_000);
      retried.sessions = await sessions();
      assert.equal(retried.sessions.length, 1, "one PTY for the terminal, spawned once");
      await ctx.shot("347-retried");
      const session = retried.sessions[0].session_id;

      // The widget's chunk fails in a fresh document: the restored terminal
      // shows the error over its live session, and the core is never asked
      // for, since the chunk and the core's URL load before the fetch. The
      // reload waits until the window's saved layout names the session, so
      // the restored tab holds it.
      const reloadFailingChunk = async (leg, shot) => {
        await waitSaved(ctx, page, windowId, session);
        failing.chunk = "abort";
        const coreBefore = details.coreRequests.length;
        const chunkBefore = details.chunkRequests.length;
        const networkBefore = details.network.length;
        await page.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS });
        await page.waitForSelector(".pane", { visible: true, timeout: WAIT_MS });
        await ctx.waitWindowLive(windowId);
        // A red here says whether the network failed the chunk the check
        // aborted, or the terminal opened over a chunk it failed.
        const restored = await restoredFailure(shot).catch((error) => {
          error.message += `; since the reload the check aborted ${details.chunkRequests.slice(chunkBefore).filter((r) => r.failed).length} ` +
            `chunk request(s), and the network ended these: ${JSON.stringify(details.network.slice(networkBefore))}`;
          throw error;
        });
        Object.assign(leg, restored);
        leg.network = details.network.slice(networkBefore);
        const chunkRequests = details.chunkRequests.slice(chunkBefore);
        leg.chunkRequests = chunkRequests.length;
        leg.coreRequests = details.coreRequests.length - coreBefore;
        assert.ok(chunkRequests.length >= 1 && chunkRequests.every((r) => r.failed), "the page asked for the widget's chunk and every request failed");
        assert.equal(leg.coreRequests, 0, "the core was not asked for: the chunk failed the load");
        assert.deepEqual(leg.state.actions.slice(0, 2), ["Retry", "Reload window"], "a failed chunk offers Retry and a reload");
        assert.equal(leg.state.actions.length, 3, "and Close");
        assert.ok(leg.state.error.includes(FAILED), "the error says what failed");
        assert.ok(leg.state.error.includes(SHELL_RUNS), "and that the failure did not end the live shell");
        assert.deepEqual(leg.state.area, [], "nothing opened in the terminal's area");
        leg.sessions = await sessions();
        assert.deepEqual(leg.sessions.map((row) => row.session_id), [session], "the live session is kept, and no PTY spawned");
        failing.chunk = null;
      };

      // Retry once the chunk loads again: the engine either imports it anew
      // and the terminal attaches to its session, or answers from the failed
      // import, and the error shows again with Reload window, in the same
      // document either way.
      const chunk = {};
      details.legs.chunkRetry = chunk;
      await reloadFailingChunk(chunk, "347-chunk-no-load-error");
      await ctx.shot("347-chunk-load-error");
      const chunkAfterLift = details.chunkRequests.length;
      await markDocument("chunk-retry");
      await clickAction(chunk.tabId, "Retry");
      const settledBy = Date.now() + WAIT_MS;
      for (;;) {
        if (await attachedOn(chunk.tabId)) {
          chunk.outcome = "opened";
          break;
        }
        const state = await tabState(chunk.tabId);
        if (state.error !== null && !state.clicked) {
          chunk.outcome = "failed again";
          break;
        }
        if (Date.now() > settledBy) {
          await ctx.shot("347-chunk-retry-unsettled");
          assert.fail(`Retry after the chunk loads again neither opened the terminal nor showed the error: ${JSON.stringify(state)}`);
        }
        await sleep(250);
      }
      chunk.afterRetry = await tabState(chunk.tabId);
      chunk.mark = await documentMark();
      chunk.chunkRequestsAfterRetry = details.chunkRequests.length - chunkAfterLift;
      chunk.sessionsAfterRetry = await sessions();
      assert.equal(chunk.mark, "chunk-retry", "Retry did not reload the page");
      assert.deepEqual(chunk.sessionsAfterRetry.map((row) => row.session_id), [session], "one PTY, the live session's");
      if (chunk.outcome === "opened") {
        assert.equal(chunk.afterRetry.error, null, "the error is gone");
        assert.equal(chunk.afterRetry.canvases, 1, "one terminal in the terminal's area");
      } else {
        assert.ok(chunk.afterRetry.actions.includes("Reload window"), "the error still offers Reload window");
        assert.deepEqual(chunk.afterRetry.area, [], "nothing opened in the terminal's area");
      }
      await ctx.shot("347-chunk-retried");

      // Reload window from a failed chunk, once the chunk loads again: a new
      // document, whose restored terminal attaches to the live session and
      // reads what the page's keyboard types once a click hands it the
      // keyboard. The new document's core requests are held until the
      // widget's terminals are captured, so the capture sees the restored
      // terminal open.
      const reload = {};
      details.legs.chunkReload = reload;
      if (chunk.outcome === "opened") {
        await reloadFailingChunk(reload, "347-chunk-reload-no-load-error");
      } else {
        reload.tabId = chunk.tabId;
        reload.state = chunk.afterRetry;
      }
      await markDocument("chunk-reload");
      failing.core = "hold";
      const navigated = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: WAIT_MS }).then(() => true, () => false);
      await clickAction(reload.tabId, "Reload window");
      reload.navigated = await navigated;
      assert.equal(reload.navigated, true, "Reload window reloaded the page");
      reload.mark = await documentMark();
      assert.equal(reload.mark, null, "a new document");
      await page.waitForSelector(".pane", { visible: true, timeout: WAIT_MS });
      if (!(await captureGhosttyTerminals(page, CAPTURE))) assert.fail("no entry module of the reloaded page names the widget's chunk");
      reload.heldCoreRequests = held.length;
      failing.core = null;
      releaseHeld();
      await ctx.waitWindowLive(windowId);
      const reattachedBy = Date.now() + WAIT_MS;
      for (;;) {
        const tabs = await page.$$eval(".terminal-tab[data-terminal-tab-id]", (all) =>
          all.map((tab) => tab.getAttribute("data-terminal-tab-id")));
        if (tabs.length === 1 && (await attachedOn(tabs[0]))) {
          reload.reloadedTabId = tabs[0];
          break;
        }
        if (Date.now() > reattachedBy) {
          await ctx.shot("347-chunk-reload-not-attached");
          assert.fail(`the reloaded window's terminal did not attach: ${JSON.stringify({ tabs, sessions: await sessions() })}`);
        }
        await sleep(250);
      }
      reload.state = await tabState(reload.reloadedTabId);
      reload.sessions = await sessions();
      assert.equal(reload.state.error, null, "no error in the reloaded window");
      assert.equal(reload.state.canvases, 1, "one terminal in the terminal's area");
      assert.deepEqual(reload.sessions.map((row) => row.session_id), [session], "attached to the live session, with no PTY spawned");
      await ctx.shot("347-chunk-reloaded");
      reload.keyboardAtLoad = await keyboardWhen(reload.reloadedTabId, (k) => k.terminal,
        "the reloaded terminal takes the keyboard by itself", "347-reloaded-keyboard-at-load");
      await page.click(hostOf(reload.reloadedTabId));
      reload.keyboard = await keyboardWhen(reload.reloadedTabId, (k) => k.terminal, "a click hands the reloaded terminal the keyboard",
        "347-reloaded-keyboard");
      reload.typed = await typeMarker(reload.reloadedTabId, "347n", "347-reloaded-typed");

      // A final failure, in a fresh document: the core is answered with a
      // page that is not wasm, which the engine refuses to compile, and the
      // page keeps that failure for its life. The restored terminal shows it
      // over its live session, offering Reload window and Close. A terminal
      // then opened from the editor in the other pane shows it without asking
      // for the core again, and its card takes the keyboard from the editor
      // and holds it itself, with no action holding it; the card gives it up
      // once the editor's pane takes focus.
      const final = {};
      details.legs.final = final;
      await waitSaved(ctx, page, windowId, session);
      failing.core = "not wasm";
      const coreBeforeFinal = details.coreRequests.length;
      await page.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS });
      await page.waitForSelector(".pane", { visible: true, timeout: WAIT_MS });
      await ctx.waitWindowLive(windowId);
      const restored = (final.restored = await restoredFailure("347-final-no-load-error"));
      restored.keyboard = await keyboardWhen(restored.tabId, (k) => k.card,
        "the restored terminal's final card itself takes the keyboard", "347-final-restored-keyboard");
      final.coreRequests = details.coreRequests.slice(coreBeforeFinal).map((request) => request.answer);
      assert.ok(final.coreRequests.length >= 1 && final.coreRequests.every((answer) => answer === "not wasm"),
        `the page asked for the core and was answered with a page that is not wasm: ${JSON.stringify(final.coreRequests)}`);
      assert.equal(restored.state.actions.length, 2, `a final failure offers two ways out: ${JSON.stringify(restored.state.actions)}`);
      assert.equal(restored.state.actions[0], "Reload window", "a reload first");
      assert.match(restored.state.actions[1], /^Close \S/, "then Close");
      assert.ok(restored.state.error.includes(FAILED), "the error says what failed");
      assert.ok(restored.state.error.includes(`${FINAL} ${FINAL_SHELL_RUNS}`),
        "and that the window will not load it again, and the reload attaches to the live shell");
      assert.deepEqual(restored.state.area, [], "nothing opened in the terminal's area");
      restored.sessions = await sessions();
      assert.deepEqual(restored.sessions.map((row) => row.session_id), [session], "the final failure kept the live session");
      await ctx.shot("347-final-restored");

      const placed = await page.waitForFunction((id) => {
        const terminalPane = document.querySelector(`.terminal-tab[data-terminal-tab-id="${id}"]`)?.closest(".pane")?.getAttribute("data-pane-id");
        const editorPane = [...document.querySelectorAll(".pane")]
          .find((pane) => pane.querySelector(".editor-wrap .cm-content"))?.getAttribute("data-pane-id");
        return terminalPane && editorPane && terminalPane !== editorPane ? { terminalPane, editorPane } : null;
      }, { timeout: WAIT_MS }, restored.tabId).then((handle) => handle.jsonValue());
      Object.assign(final, placed);
      const editorSelector = `.pane[data-pane-id="${placed.editorPane}"] .editor-wrap .cm-content`;
      await page.click(editorSelector);
      final.editorKeyboard = await keyboardWhen(restored.tabId, (k) => k.editor && k.pane === placed.editorPane,
        "the editor holds the keyboard before the terminal opens", "347-final-editor-keyboard");

      const fresh = (final.fresh = {});
      const tabsBefore = await page.$$eval(".terminal-tab[data-terminal-tab-id]", (tabs) =>
        tabs.map((tab) => tab.getAttribute("data-terminal-tab-id")));
      const coreBeforeFresh = details.coreRequests.length;
      await terminal(["new", "--tab-name", FINAL_NAME, "--pane", placed.terminalPane]);
      fresh.tabId = await page.waitForFunction(
        (known) => [...document.querySelectorAll(".terminal-tab[data-terminal-tab-id]")]
          .map((tab) => tab.getAttribute("data-terminal-tab-id"))
          .find((id) => !known.includes(id)) ?? null,
        { timeout: WAIT_MS },
        tabsBefore,
      ).then((handle) => handle.jsonValue());
      const freshBy = Date.now() + WAIT_MS;
      for (;;) {
        fresh.state = await tabState(fresh.tabId);
        if (fresh.state.error !== null) break;
        if (Date.now() > freshBy) {
          await ctx.shot("347-final-fresh-no-load-error");
          assert.fail(`the fresh terminal's load error never showed: ${JSON.stringify(fresh.state)}`);
        }
        await sleep(100);
      }
      fresh.keyboard = await keyboardWhen(fresh.tabId, (k) => k.card, "the final card itself takes the keyboard from the editor",
        "347-final-fresh-keyboard");
      fresh.tabindex = await page.evaluate((id) =>
        document.querySelector(`.terminal-tab[data-terminal-tab-id="${id}"] .terminal-main [role=alert]`)?.getAttribute("tabindex") ?? null,
      fresh.tabId);
      await ctx.shot("347-final-card-focused");
      assert.equal(fresh.tabindex, "-1", "the card holds the keyboard without joining the Tab order");
      // A key typed ahead onto the card reaches no action: Enter and Space
      // neither reload the window nor close the tab.
      await markDocument("final-keys");
      for (const key of ["Enter", "Space"]) await page.keyboard.press(key);
      await sleep(KEYS_SETTLE_MS);
      fresh.afterKeys = { mark: await documentMark().catch(() => null), state: await tabState(fresh.tabId).catch(() => null) };
      assert.equal(fresh.afterKeys.mark, "final-keys", "Enter and Space on the final card did not reload the window");
      assert.equal(fresh.afterKeys.state?.mounted, true, "Enter and Space on the final card did not close the tab");
      assert.ok(fresh.afterKeys.state.error?.includes(FAILED), "the tab still shows the final failure");
      assert.equal(fresh.state.actions.length, 2, `a final failure offers two ways out: ${JSON.stringify(fresh.state.actions)}`);
      assert.equal(fresh.state.actions[0], "Reload window", "a reload first");
      assert.match(fresh.state.actions[1], /^Close \S/, "then Close");
      assert.ok(fresh.state.error.includes(FAILED), "the error says what failed");
      assert.ok(fresh.state.error.includes(`${FINAL} ${NO_SHELL}`), "and that the window will not load it again, and no shell was started");
      assert.deepEqual(fresh.state.area, [], "nothing opened in the terminal's area");
      fresh.coreRequests = details.coreRequests.length - coreBeforeFresh;
      assert.equal(fresh.coreRequests, 0, "the page kept the failure: the core was not asked for again");
      fresh.sessions = await sessions();
      assert.deepEqual(fresh.sessions.map((row) => row.session_id), [session], "no PTY was spawned for the fresh terminal");

      await shell(["pane", "focus", placed.editorPane]);
      fresh.keyboardPaneLeft = await keyboardWhen(fresh.tabId, (k) => !k.inCard && k.editor && k.pane === placed.editorPane,
        "the card gives up the keyboard to the editor once its pane takes focus", "347-final-keyboard-kept");
      await ctx.shot("347-final-pane-left");

      assert.deepEqual(details.continueErrors, [], "every intercepted request was answered");
      return details;
    } catch (error) {
      checkFailed = true;
      error.smokeDetails = details;
      throw error;
    } finally {
      try {
        failing.core = null;
        failing.chunk = null;
        releaseHeld();
        page.off("request", onRequest);
        page.off("requestfailed", onFailed);
        page.off("requestfinished", onFinished);
        await page.setRequestInterception(false).catch(() => {});
        await page.setCacheEnabled(true).catch(() => {});
        // Every session the window gained goes with the check: the retried
        // terminal and, at a red, one opened in place of the error or a second
        // PTY. A session closes by its name, which the registry keeps unique.
        if (terminal) {
          const found = baseline && sessions ? await sessions().catch(() => []) : [];
          details.closed = [...new Set([NAME, ...found.map((row) => row.name).filter(Boolean)])];
          for (const name of details.closed) await terminal(["close", "--tab-name", name]).catch(() => {});
        }
        rmSync(join(ctx.workspaceDir, FILE), { force: true });
        // What the closes left, read back: a session still open after a pass
        // fails the check.
        if (terminal && baseline && sessions) {
          const end = Date.now() + 10_000;
          for (;;) {
            details.leftOpen = (await sessions()).map((row) => row.name ?? row.session_id);
            if (details.leftOpen.length === 0) break;
            if (Date.now() > end) {
              throw new Error(`the check left ${details.leftOpen.length} session(s) open: ${JSON.stringify(details.leftOpen)}`);
            }
            await sleep(250);
          }
        }
      } catch (cleanupError) {
        // After a pass the cleanup's failure is the result, with the check's
        // details; after a red the check's own error stays the result and
        // carries this one.
        if (!checkFailed) {
          if (cleanupError instanceof Error) cleanupError.smokeDetails = details;
          throw cleanupError;
        }
        details.cleanupError = String(cleanupError?.stack ?? cleanupError);
      }
    }
  },
};
