// A terminal whose core fails to load shows its own error with Retry, opens
// no other terminal in its place and spawns no PTY, while the window around
// it keeps working; Retry, once the core loads again, opens one Ghostty
// terminal on one PTY.
//
// The failure is the network's: request interception aborts the page's
// requests for the core's wasm asset while the check holds it failed, and
// lets them through once it lifts the failure. The page reloads with
// interception on, so no kit the page loaded before the check is reused.

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readTerminalAttachment } from "../lib/terminal-attach.mjs";

const NAME = "Load347";
const FILE = "load347.md";
const WAIT_MS = 30_000;
const CORE = /\/ghostty-vt[^/]*\.wasm(?:[?#]|$)/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  name: "terminal-load-failure",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("opening and counting terminals needs the server's control socket");
    const { page } = ctx;
    const details = { coreRequests: [], legs: {} };
    await page.setViewport({ width: 1280, height: 800 });

    let failing = true;
    const onRequest = (request) => {
      if (request.isInterceptResolutionHandled()) return;
      if (CORE.test(request.url())) {
        details.coreRequests.push({ url: request.url(), failed: failing });
        if (failing) return void request.abort("failed").catch(() => {});
      }
      void request.continue().catch(() => {});
    };
    await page.setRequestInterception(true);
    page.on("request", onRequest);
    writeFileSync(join(ctx.workspaceDir, FILE), "# Load 347\n");
    let terminal = null;
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
      const sessions = async () =>
        Object.values(JSON.parse((await terminal(["list", "--json"])).stdout).groups ?? {})
          .flat()
          .filter((row) => row.name === NAME);

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
            actions: alert ? [...alert.querySelectorAll("button")].map((button) => button.textContent.trim()) : [],
            area: area ? [...area.children].map((child) => `${child.tagName.toLowerCase()}.${String(child.className)}`) : null,
          };
        }, tabId);

      const before = await page.$$eval(".terminal-tab[data-terminal-tab-id]", (tabs) =>
        tabs.map((tab) => tab.getAttribute("data-terminal-tab-id")));
      assert.deepEqual(await sessions(), [], `no ${NAME} session before the check`);
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
            `with ${failed.sessions.length} ${NAME} session(s)`);
        }
        await sleep(100);
      }
      await ctx.shot("347-load-error");
      failed.coreRequests = details.coreRequests.length;
      assert.ok(failed.coreRequests >= 1 && details.coreRequests.every((r) => r.failed), "the page asked for the core and every request failed");
      assert.deepEqual(failed.state.actions, ["Retry"], "a failed fetch offers Retry");
      assert.deepEqual(failed.state.area, [], "nothing opened in the terminal's area");
      await sleep(1_000);
      failed.sessions = await sessions();
      assert.deepEqual(failed.sessions, [], "no PTY was spawned for the failed terminal");

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

      // Retry once the core loads again: one Ghostty terminal on one PTY.
      failing = false;
      const retried = {};
      details.legs.retried = retried;
      const retry = await page.evaluateHandle((id) => {
        const alert = document.querySelector(`.terminal-tab[data-terminal-tab-id="${id}"] .terminal-main [role=alert]`);
        return [...(alert?.querySelectorAll("button") ?? [])].find((button) => button.textContent.trim() === "Retry") ?? null;
      }, tabId);
      assert.ok(await retry.evaluate((button) => button !== null), "the Retry action");
      await retry.asElement().click();
      const attachedBy = Date.now() + WAIT_MS;
      for (;;) {
        const attachment = await readTerminalAttachment(page, terminal, "ghostty", (row) => row.name === NAME);
        if (attachment.attached && attachment.row.tab === tabId) break;
        if (Date.now() > attachedBy) {
          retried.state = await tabState(tabId);
          await ctx.shot("347-retry-not-attached");
          assert.fail(`Retry did not open the terminal: ${JSON.stringify({ row: attachment.row, tab: retried.state })}`);
        }
        await sleep(250);
      }
      retried.state = await tabState(tabId);
      retried.coreRequests = details.coreRequests.length;
      assert.equal(retried.state.error, null, "the error is gone");
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
      return details;
    } catch (error) {
      error.smokeDetails = details;
      throw error;
    } finally {
      page.off("request", onRequest);
      await page.setRequestInterception(false).catch(() => {});
      // Whatever opened under the name, the retried terminal or, at a red, the
      // one opened in place of the error, goes with the check.
      if (terminal) await terminal(["close", "--tab-name", NAME]).catch(() => {});
      rmSync(join(ctx.workspaceDir, FILE), { force: true });
    }
  },
};
