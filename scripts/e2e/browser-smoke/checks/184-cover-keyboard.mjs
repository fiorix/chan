import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export default {
  name: "raised covers preserve native button activation",
  async run(ctx) {
    const page = ctx.page;
    await page.evaluateOnNewDocument(() => {
      window.__coverCalls = [];
      window.__watchOpened = false;
      window.__TAURI__ = { core: { invoke: async (cmd) => {
        window.__coverCalls.push(cmd);
        return null;
      } } };
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          if (new URL(args[0], location.href).pathname.endsWith("/ws")) {
            this.addEventListener("open", () => { window.__watchOpened = true; window.__coverWatch = this; });
          }
        }
      };
    });
    const url = new URL(ctx.serverUrl);
    url.searchParams.set("lib", "lib-cover-keyboard");
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pane");
    await page.waitForFunction(() => window.__watchOpened);
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    await page.evaluate(() => window.__coverWatch.close());
    await page.waitForSelector('[data-cover="reconnect"] .reconnect');
    assert.equal(await page.$eval('[data-cover="reconnect"] .reconnect', (b) => b === document.activeElement), true);
    const observations = [];
    for (const key of ["Enter", "Space"]) {
      for (const action of ["reconnect", "abandon"]) {
        if (action === "reconnect") await page.focus('[data-cover="reconnect"] .reconnect');
        else await page.keyboard.press("Tab");
        const command = `${action}_devserver_for_window`;
        const before = await page.evaluate((cmd) => window.__coverCalls.filter((c) => c === cmd).length, command);
        await page.keyboard.press(key);
        const activated = await page.waitForFunction(
          (cmd, n) => window.__coverCalls.filter((c) => c === cmd).length === n + 1,
          { timeout: 1000 }, command, before,
        ).then(() => true, () => false);
        observations.push({ key, action, activated });
      }
    }
    ctx.mark("cover-buttons", observations);
    await ctx.shot("disconnect-keyboard");
    assert.ok(observations.every((o) => o.activated), JSON.stringify(observations));

    // A stale focus behind the cover must never activate a background button.
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "background-cover-button";
      button.onclick = () => { window.__backgroundActivated = true; };
      document.body.append(button);
      button.focus();
    });
    for (const key of ["Enter", "Space", "a"]) await page.keyboard.press(key);
    await page.keyboard.down("Control");
    await page.keyboard.press("d");
    await page.keyboard.up("Control");
    assert.equal(await page.evaluate(() => Boolean(window.__backgroundActivated)), false);
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await cdp.detach();

    const preflight = await ctx.browser.newPage();
    const decisions = [];
    const snapshot = {
      phase: "needs_decision", locked: true, readiness: { state: "recovering" }, error: null,
      steps: [{ id: "index", label: "Index", state: "needs_decision", decision: {
        prompt: "Choose", choices: [{ id: "retry", label: "Retry" }, { id: "skip", label: "Skip" }],
      } }],
    };
    try {
      await preflight.setRequestInterception(true);
      preflight.on("request", async (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/preflight")) {
          if (request.method() === "POST") decisions.push(JSON.parse(request.postData()).choice);
          await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
        } else await request.continue();
      });
      await preflight.goto(ctx.serverUrl, { waitUntil: "domcontentloaded" });
      await preflight.waitForSelector('[data-cover="preflight"] button');
      await preflight.waitForFunction(() => document.activeElement?.textContent.trim() === "Retry");
      for (const key of ["Enter", "Space"]) {
        for (const label of ["Retry", "Skip"]) {
          if (label === "Retry") await preflight.focus('[data-cover="preflight"] button');
          else await preflight.keyboard.press("Tab");
          const response = preflight.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/preflight/decision");
          await preflight.keyboard.press(key);
          await response;
          const expected = label.toLowerCase();
          await preflight.waitForFunction(() => !document.querySelector('[data-cover="preflight"] button:disabled'));
          assert.equal(decisions.at(-1), expected);
        }
      }
      assert.deepEqual(decisions, ["retry", "skip", "retry", "skip"]);
    } finally { await preflight.close(); }

    const lock = await ctx.browser.newPage();
    let verifications = 0;
    try {
      await lock.setRequestInterception(true);
      lock.on("request", async (request) => {
        const path = new URL(request.url()).pathname;
        if (path === "/api/screensaver/state" || path === "/api/screensaver/verify") {
          const state = { enabled: false, timeout_secs: 300, theme: "plain", pin_set: true };
          if (path.endsWith("/verify")) verifications++;
          await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(path.endsWith("/verify") ? { verified: false } : state) });
        } else await request.continue();
      });
      await lock.goto(ctx.serverUrl, { waitUntil: "domcontentloaded" });
      await lock.waitForSelector(".pane");
      await lock.waitForFunction(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/api/screensaver/state") && e.responseEnd > 0));
      await lock.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.screensaver.lock" } })));
      await lock.waitForSelector('[data-cover="screensaver"]');
      await lock.keyboard.press("a");
      await lock.waitForSelector(".screensaver-pin");
      for (const key of ["Enter", "Space"]) {
        await lock.type(".screensaver-pin", "1234");
        await lock.keyboard.press("Tab");
        assert.equal(await lock.evaluate(() => document.activeElement?.classList.contains("screensaver-unlock")), true);
        const before = verifications;
        const response = lock.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/screensaver/verify");
        await lock.keyboard.press(key);
        await response;
        await lock.waitForFunction(() => Boolean(document.querySelector(".screensaver-error")) && !document.querySelector(".screensaver-pin").disabled);
        assert.equal(verifications, before + 1);
      }
    } finally { await lock.close(); }

    // Serve the actual connecting page, with failed probes and only its retry
    // delay shortened, so reaching the give-up state needs no wall-clock wait.
    const connecting = await ctx.browser.newPage();
    try {
      await connecting.setRequestInterception(true);
      connecting.on("request", async (request) => {
        const pathname = new URL(request.url()).pathname;
        const name = pathname.split("/").pop();
        if (["connecting.html", "connecting.js", "connecting.css", "styles.css"].includes(name)) {
          const body = await readFile(join(ctx.repoRoot, "desktop/src", name));
          await request.respond({ status: 200, contentType: name.endsWith("js") ? "text/javascript" : name.endsWith("css") ? "text/css" : "text/html", body });
        } else await request.continue();
      });
      await connecting.evaluateOnNewDocument(() => {
        window.__probes = 0;
        window.__TAURI__ = { core: { invoke: async (cmd) => {
          if (cmd === "probe_url") { window.__probes++; return { reachable: false }; }
          return null;
        } } };
        const timeout = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 2000 ? 0 : ms, ...args);
      });
      await connecting.goto(`${new URL(ctx.serverUrl).origin}/connecting.html?url=http://unreachable.test`, { waitUntil: "domcontentloaded" });
      await connecting.waitForSelector("body.is-gaveup");
      assert.equal(await connecting.evaluate(() => document.activeElement?.id), "retry");
      for (const key of ["Enter", "Space"]) {
        const before = await connecting.evaluate(() => window.__probes);
        await connecting.keyboard.press(key);
        await connecting.waitForFunction((n) => window.__probes >= n + 20 && document.body.classList.contains("is-gaveup"), {}, before);
      }
    } finally {
      await connecting.close();
    }
    return { disconnect: observations, connecting: ["Enter", "Space"] };
  },
};
