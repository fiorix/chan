// A terminal whose core fails to load shows its own error, saying no shell was
// started, with Retry, Reload window and Close; it opens no other terminal in
// its place and spawns no PTY, while the window around it keeps working;
// Retry, once the core loads again, opens one Ghostty terminal on one PTY in
// the same document. A failed widget chunk, a module import the engine may
// keep failed, shows the same error over the live session, and Retry and
// Reload window are read after the chunk loads again.
//
// The failures are the network's: request interception aborts the page's
// requests for the core's wasm asset, or for the widget's JS chunk, while the
// check holds them failed, and lets them through once it lifts the failure.
// Chrome's cache is off for the whole check: a reloaded document is otherwise
// handed the widget's chunk from the renderer's cache of the document before,
// a load request interception never sees, so the abort fails nothing and the
// terminal opens. What the network did with each core and chunk request is
// recorded beside what the check asked of it.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readTerminalAttachment } from "../lib/terminal-attach.mjs";
import { waitSaved } from "./290-rich-prompt-disconnected.mjs";

const NAME = "Load347";
const FILE = "load347.md";
const WAIT_MS = 30_000;
const CORE = /\/ghostty-vt[^/]*\.wasm(?:[?#]|$)/;
// The widget's chunk, as the build emits it (`assets/ghostty-web-<hash>.js`).
const CHUNK = /\/assets\/ghostty-web-[A-Za-z0-9_-]+\.js(?:[?#]|$)/;
const FAILED = "The terminal view could not load.";
const NO_SHELL = "No shell was started.";
const SHELL_RUNS = "The failure did not end its shell; Retry attaches to it.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  name: "terminal-load-failure",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("opening and counting terminals needs the server's control socket");
    const { page } = ctx;
    const details = { coreRequests: [], chunkRequests: [], network: [], continueErrors: [], legs: {} };
    await page.setViewport({ width: 1280, height: 800 });

    const failing = { core: true, chunk: false };
    const onRequest = (request) => {
      if (request.isInterceptResolutionHandled()) return;
      const answered = (error) => details.continueErrors.push(`${request.url()}: ${error.message}`);
      for (const [kind, pattern, list] of [["core", CORE, details.coreRequests], ["chunk", CHUNK, details.chunkRequests]]) {
        if (!pattern.test(request.url())) continue;
        list.push({ url: request.url(), failed: failing[kind] });
        if (failing[kind]) return void request.abort("failed").catch(answered);
      }
      void request.continue().catch(answered);
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
        const attachment = await readTerminalAttachment(page, terminal, "ghostty", (row) => row.name === NAME);
        return attachment.attached && attachment.row.tab === tabId ? attachment.row : null;
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
      await sleep(1_000);
      failed.sessions = await sessions();
      assert.deepEqual(failed.sessions, [], "no PTY was spawned for the failed terminal");

      // The card's column: with Details open, the card takes the hidden
      // terminal area's place in the row and centres in the terminal's column
      // beside the inspector, and the area shows nothing. Details is toggled
      // the way a user does it, from the Details row of the tab's menu.
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
      // the document the error was shown in.
      failing.core = false;
      const retried = {};
      details.legs.retried = retried;
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
      await terminal(["write", "--tab-name", NAME, "printf 'ok%s\\n' 347\n"]);
      const echoedBy = Date.now() + WAIT_MS;
      for (;;) {
        const { stdout } = await terminal(["scrollback", "--tab-name", NAME]);
        if (stdout.includes("ok347")) break;
        if (Date.now() > echoedBy) assert.fail(`the shell never answered; its scrollback reads ${JSON.stringify(stdout.slice(-400))}`);
        await sleep(250);
      }
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
        failing.chunk = true;
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
        failing.chunk = false;
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
      // document, whose restored terminal attaches to the live session.
      const reload = {};
      details.legs.chunkReload = reload;
      if (chunk.outcome === "opened") {
        await reloadFailingChunk(reload, "347-chunk-reload-no-load-error");
      } else {
        reload.tabId = chunk.tabId;
        reload.state = chunk.afterRetry;
      }
      await markDocument("chunk-reload");
      const navigated = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: WAIT_MS }).then(() => true, () => false);
      await clickAction(reload.tabId, "Reload window");
      reload.navigated = await navigated;
      assert.equal(reload.navigated, true, "Reload window reloaded the page");
      reload.mark = await documentMark();
      assert.equal(reload.mark, null, "a new document");
      await page.waitForSelector(".pane", { visible: true, timeout: WAIT_MS });
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

      assert.deepEqual(details.continueErrors, [], "every intercepted request was answered");
      return details;
    } catch (error) {
      checkFailed = true;
      error.smokeDetails = details;
      throw error;
    } finally {
      try {
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
      } catch (cleanupError) {
        // After a pass the cleanup's failure is the result; after a red the
        // check's own error stays the result and carries this one.
        if (!checkFailed) throw cleanupError;
        details.cleanupError = String(cleanupError?.stack ?? cleanupError);
      }
    }
  },
};
