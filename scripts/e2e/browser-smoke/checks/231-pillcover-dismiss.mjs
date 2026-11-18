// The index status pill must not cover a terminal notice's Dismiss button:
// while the search index rebuilds, Dismiss is clicked at its centre and the
// notice must go away. Red at the base, where the click lands on the pill's
// padding. Green with shape 2, where the notice reserves room while the pill
// overlaps it. A new check rather than a leg of 164: 164's Dismiss leg polls
// up to 90 s for an *unobstructed* point, waiting the pill out, while this
// leg needs the pill present and asserts the click lands.
//
// Engine: headless Chrome through puppeteer-core; it says nothing about WebKit.

import { rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { poll } from "../lib/launcher-devserver.mjs";

const RUN = Date.now().toString(36);
const DIR = `pc231-${RUN}`;
const RENAMED = `pc231-${RUN}-renamed`;
const WINDOW = `smoke-check-231`;
// Unique per run: the trees are reused across reruns, and a stale session
// under a fixed name reads as a session the held socket created.
const TAB = `pillcover-231-notice-${Date.now().toString(36)}`;
const COMMAND = "exec sleep 600";

function windowUrl(ctx, windowId) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  return url.href;
}

function cli(ctx, windowId, args) {
  return ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
    cwd: ctx.workspaceDir,
    env: {
      ...process.env,
      CHAN_CONTROL_SOCKET: ctx.controlSocket,
      CHAN_WINDOW_ID: windowId,
      CHAN_WORKSPACE_PATH: ctx.workspaceDir,
    },
  });
}

async function sessions(ctx, windowId, name) {
  const { stdout } = await cli(ctx, windowId, ["list", "--json"]);
  return Object.values(JSON.parse(stdout).groups ?? {}).flat()
    .filter((row) => row.window === windowId && row.name === name)
    .map((row) => ({ name: row.name, id: row.session_id }));
}

async function indexState(page, token) {
  return page.evaluate(async (bearer) => {
    const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
    const response = await fetch("/api/index/status", { headers });
    if (!response.ok) return null;
    return (await response.json()).state ?? null;
  }, token);
}

async function waitIndexIdle(page, token, what) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const state = await indexState(page, token).catch(() => null);
    if (state === "idle") return;
    if (Date.now() > deadline) throw new Error(`the index never went idle before ${what}: last state ${state}`);
    await new Promise((done) => setTimeout(done, 1000));
  }
}

/// Hold the CLI tab's first socket at CONNECTING, as the desktop driver
/// does: the page then holds no session id for the tab, so the reload
/// below opens a plain shell and owes the reload notice. Records each
/// dial's command and session for the assertion that the held socket
/// carries the requested command with no session id.
async function holdFirstDial(page) {
  await page.evaluate(() => {
    const NativeWebSocket = window.WebSocket;
    window.__pcov231 = { dials: [] };
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const url = new URL(String(args[0]));
        if (url.pathname !== "/api/terminal/ws") return Reflect.construct(target, args);
        window.__pcov231.dials.push({
          command: url.searchParams.get("command"),
          session: url.searchParams.get("session"),
        });
        return {
          readyState: NativeWebSocket.CONNECTING,
          binaryType: "arraybuffer",
          close() { this.readyState = NativeWebSocket.CLOSED; },
          send() { throw new Error("held terminal socket cannot send"); },
        };
      },
    });
  });
}

async function firstDial(page) {
  await page.waitForFunction(() => window.__pcov231.dials.length > 0, { timeout: 30_000 });
  return page.evaluate(() => window.__pcov231.dials[0]);
}

/// The pill's box while it shows an index section, or null while the status
/// bar shows none.
async function indexPillBox(page) {
  return page.evaluate(() => {
    const bar = document.querySelector(".app-statusbar");
    if (!bar) return null;
    const text = bar.textContent ?? "";
    if (!/rebuilding|reindexing|indexing|embedding/i.test(text)) return null;
    const box = bar.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, text: text.trim().slice(0, 80) };
  });
}

async function waitIndexPill(page) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const pill = await indexPillBox(page).catch(() => null);
    if (pill) return pill;
    if (Date.now() > deadline) throw new Error("the index pill never showed after the rename");
    await new Promise((done) => setTimeout(done, 1000));
  }
}

/// What sits at the centre of `selector`, for the row's Dismiss and, recorded
/// only, the find bar and the inspector close when they are present.
async function hitAt(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const cover = document.elementFromPoint(point.x, point.y);
    const describe = (n) => n ? {
      tag: n.tagName, classes: n.getAttribute("class"),
      role: n.getAttribute("role"), label: n.getAttribute("aria-label"),
      text: n.textContent?.trim().slice(0, 80),
    } : null;
    return {
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      cover: describe(cover),
      statusbar: !!cover?.closest(".app-statusbar"),
      onButton: !!cover && !!node.contains(cover),
    };
  }, selector);
}

export default {
  name: "pillcover-dismiss",
  async run(ctx) {
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const seed = join(ctx.workspaceDir, DIR);
    mkdirSync(seed, { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(seed, `note-${i}.md`), `# note ${i}\n\nRebuild trigger ${RUN}.\n`);
    const page = await ctx.browser.newPage();
    const result = { browser: await ctx.browser.browser().version(), seed: DIR };
    let opened = false;
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.bringToFront();
      await page.goto(windowUrl(ctx, WINDOW), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await ctx.waitWindowLive(WINDOW);
      await waitIndexIdle(page, token, "the CLI tab dance");

      await holdFirstDial(page);
      await cli(ctx, WINDOW, ["new", "--window", WINDOW, "--tab-name", TAB, "--command", COMMAND]);
      opened = true;
      const dial = await firstDial(page);
      if (dial.command !== COMMAND) throw new Error(`held first socket carries ${JSON.stringify(dial.command)}, not the requested command`);
      if (dial.session !== null) throw new Error(`held first socket has session id ${JSON.stringify(dial.session)}, not none`);
      const { stdout: listOut } = await cli(ctx, WINDOW, ["list", "--json"]);
      if (Object.values(JSON.parse(listOut).groups ?? {}).flat().some((row) => row.name === TAB)) {
        throw new Error("the held first socket created a server session; the reload would restore instead of owing its notice");
      }
      // The notice is owed only once the page has persisted the tab's
      // pending command to its reload marker; reloading before that
      // restores cleanly and the notice never appears. The marker must
      // name the current layout hash: a pre-tab marker goes stale at
      // the next persist.
      await page.waitForFunction(() => {
        try {
          const raw = window.sessionStorage.getItem("chan-cli-reload-bits");
          if (!raw) return false;
          const marker = JSON.parse(raw);
          const hash = new URLSearchParams(location.hash.slice(1)).get("s") ?? "";
          return marker.hash === hash && Array.isArray(marker.bits) && marker.bits.some((bit) => bit !== 0);
        } catch {
          return false;
        }
      }, { timeout: 30_000 }).catch((error) => {
        throw new Error(`the reload marker never persisted before reload: ${error.message}`, { cause: error });
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".terminal-tab", { timeout: 30_000 });
      await page.waitForSelector(".cli-reload-notice", { visible: true, timeout: 30_000 }).catch(async (error) => {
        throw new Error(`the reload notice never appeared for a tab whose first socket never connected: ${error.message}`, { cause: error });
      });

      renameSync(seed, join(ctx.workspaceDir, RENAMED));
      result.pill = await waitIndexPill(page);

      const dismiss = await hitAt(page, '.cli-reload-notice button[aria-label="Dismiss notice"]');
      result.dismissHit = dismiss;
      if (!dismiss) throw new Error("Dismiss notice button is absent");
      result.findHit = await hitAt(page, ".terminal-find");
      result.inspectorHit = await hitAt(page, ".inspector .close");
      await ctx.shot("231-pillcover-rebuild", page);

      const point = { x: (dismiss.box.left + dismiss.box.right) / 2, y: (dismiss.box.top + dismiss.box.bottom) / 2 };
      await page.mouse.click(point.x, point.y);
      await page.waitForSelector(".cli-reload-notice", { hidden: true, timeout: 10_000 }).catch(async (error) => {
        const hit = await hitAt(page, '.cli-reload-notice button[aria-label="Dismiss notice"]').catch((sampleError) => ({ sampleError: sampleError.message }));
        throw new Error(`Dismiss notice stayed visible after the centre click at ${JSON.stringify(point)}; current hit: ${JSON.stringify(hit)}; ${error.message}`, { cause: error });
      });
      result.dismissed = true;
      console.log(`[smoke]   pill ${JSON.stringify(result.pill)}; dismiss hit ${JSON.stringify(dismiss)}; dismissed`);
      return result;
    } catch (error) {
      await ctx.shot("231-failure", page).catch(() => {});
      throw error;
    } finally {
      try {
        await page.close().catch(() => {});
      } finally {
        await cli(ctx, WINDOW, ["close", "--tab-name", TAB]).catch(() => {});
        rmSync(join(ctx.workspaceDir, RENAMED), { recursive: true, force: true });
        rmSync(seed, { recursive: true, force: true });
      }
    }
  },
};
