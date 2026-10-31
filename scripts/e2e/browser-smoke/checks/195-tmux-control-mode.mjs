// tmux control mode end to end, in a browser against a devserver (the server
// form that holds a window registry; a standalone `chan serve` mints no
// windows). A terminal window's shell runs `tmux -CC`; the connection then
// opens the tmux window as a chan window with a tab bound to its pane, moves
// the control terminal into a chromeless control window of its own, shows the
// connection as a card in the launcher's Computers carousel, splits the tmux
// pane on a chan split so two panes show, mints a window of its own for the
// tmux window Cmd+T and New Window each ask for, and the card's Detach closes
// every tmux window while the control window stays and becomes a plain
// terminal window again. The windows are read where the product reads them:
// the library's window records (never persisted for tmux rows), its
// connection records, and the pages the launcher's Open opens, so a tab
// arriving on a window's first socket is observed.
//
// Skips when tmux is not installed or the launcher bundle is missing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWindows, goto, killChild, openRow, poll, spawnDevserver, wait } from "../lib/launcher-devserver.mjs";

const SOCKET = "chan-smoke-195";
const SESSION = "smoke195";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function tmuxInstalled() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/// The page of this check's browser context that shows chan window
/// `windowId`, when one is open: a window the source page opened itself,
/// which a later Open from the launcher navigates instead of reopening.
async function pageForWindow(ctx, windowId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const page of await ctx.browser.pages()) {
      try {
        const url = new URL(page.url());
        // The page is on the window, or still on the launch redirect to it.
        if (url.searchParams.get("w") === windowId || url.pathname.includes(`/windows/${windowId}/launch`)) {
          return page;
        }
      } catch {}
    }
    if (Date.now() > deadline) return null;
    await wait(300);
  }
}

async function popupFrom(page, action, label) {
  const popup = new Promise((resolve) => page.once("popup", resolve));
  await action();
  return Promise.race([
    popup,
    wait(30_000).then(() => { throw new Error(`${label}: no popup within 30s`); }),
  ]);
}

/// Every console error and page error of the pages this check drives, so a
/// hang or a failure says what the pages logged.
const pageLog = [];
const step = (label) => pageLog.push(`step ${new Date().toISOString().slice(11, 19)}: ${label}`);
function watchPage(page, label) {
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warn") pageLog.push(`${label} console.${message.type()}: ${message.text().slice(0, 300)}`);
  });
  page.on("pageerror", (error) => pageLog.push(`${label} pageerror: ${String(error).slice(0, 300)}`));
  page.on("response", (response) => {
    if (response.status() >= 400) pageLog.push(`${label} http ${response.status()}: ${response.url().replace(/t=[^&]+/, "t=<token>").slice(0, 200)}`);
  });
  // A native dialog blocks the page and every protocol call to it; dismiss
  // it and say what it asked, since no check of this suite expects one.
  page.on("dialog", (dialog) => {
    pageLog.push(`${label} dialog ${dialog.type()}: ${dialog.message().slice(0, 200)}`);
    void dialog.dismiss().catch(() => {});
  });
  return page;
}

/// Wait for a page's pane to render, asking the page itself so a boot that
/// hangs the main thread is reported with its paused frames.
async function waitForPane(page, label) {
  await poll(`${label}: a pane`, () => evaluateOrDump(page, () => !!document.querySelector(".pane"), `${label} boot`), 60_000);
}

/// Evaluate on a page, and when the page does not answer within 15 s (its
/// main thread is stuck), pause its debugger and report where it stands,
/// so a hang names the code that holds the page instead of a protocol
/// timeout three minutes later.
async function evaluateOrDump(page, fn, label, ...args) {
  let timer;
  const stuck = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      let where = "no frames";
      try {
        const bounded = (promise, what) => Promise.race([promise, wait(10_000).then(() => { throw new Error(`${what} did not answer within 10s`); })]);
        const cdp = await bounded(page.createCDPSession(), "createCDPSession");
        const paused = new Promise((resolve) => cdp.once("Debugger.paused", resolve));
        await bounded(cdp.send("Debugger.enable"), "Debugger.enable");
        await bounded(cdp.send("Debugger.pause"), "Debugger.pause");
        const event = await Promise.race([paused, wait(10_000).then(() => null)]);
        if (event) {
          where = event.callFrames.slice(0, 12).map((frame) =>
            `${frame.functionName || "(anonymous)"} @ ${frame.url.split("/").pop()}:${frame.location.lineNumber}:${frame.location.columnNumber}`).join("\n  ");
        } else {
          where = "the debugger did not pause within 10s (the thread is not in JS)";
        }
        await cdp.send("Debugger.resume").catch(() => {});
        await cdp.detach().catch(() => {});
      } catch (error) {
        where = `debugger failed: ${error instanceof Error ? error.message : error}`;
      }
      reject(new Error(`${label}: the page did not answer within 15s; paused at:\n  ${where}`));
    }, 15_000);
  });
  try {
    return await Promise.race([page.evaluate(fn, ...args), stuck]);
  } finally {
    clearTimeout(timer);
  }
}

/// The attached terminal tabs of a page: each with a box behind it.
const attachedTabs = (page) =>
  evaluateOrDump(page, () =>
    [...document.querySelectorAll(".terminal-tab")].map((tab) => {
      const screen = tab.querySelector(".terminal.xterm .xterm-screen, .terminal-host canvas");
      const box = screen?.getBoundingClientRect();
      return { attached: !!box && box.width > 0 && box.height > 0, active: tab.classList.contains("active") };
    }), "attached tabs");

async function waitAttachedTabs(page, count, label) {
  return poll(`${label}: ${count} attached terminal tab(s)`, async () => {
    const tabs = await attachedTabs(page);
    return tabs.length === count && tabs.every((tab) => tab.attached) ? tabs : null;
  }, 60_000);
}

async function dispatchCommand(page, name) {
  await page.bringToFront();
  await evaluateOrDump(page, new Function("command", `window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "${name}" } }))`), `dispatch ${name}`);
}

/// The panes of a page, each with whether its active tab has a terminal box.
const panesAttached = (page) =>
  evaluateOrDump(page, () =>
    [...document.querySelectorAll(".pane")].map((pane) => {
      const screen = pane.querySelector(".terminal-tab.active .terminal.xterm .xterm-screen, .terminal-tab.active .terminal-host canvas");
      const box = screen?.getBoundingClientRect();
      return !!box && box.width > 0 && box.height > 0;
    }), "panes");

const rowName = (record) => `Terminal Window ${record.ordinal}${record.label ? ` [${record.label.trim()}]` : ""}`;

/// The card title the launcher gives a connection whose marker a local tmux
/// printed, which is also the control window's label.
const CARD_TITLE = "tmux -CC on this machine";

/// The live connection records, as the launcher reads them with the feed.
async function fetchTmux(origin, token) {
  const response = await fetch(`${origin}/api/library/tmux`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`tmux route answered ${response.status}`);
  return response.json();
}

export default {
  name: "tmux-control-mode",
  async run(ctx) {
    if (!existsSync(join(ctx.repoRoot, "web-launcher/dist/index.html"))) {
      ctx.skip("launcher dist missing; build the web bundles before this check");
    }
    if (!tmuxInstalled()) ctx.skip("tmux is not installed");
    try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch {}
    const chanHome = mkdtempSync(join(tmpdir(), "chan-tmux-195-"));
    const devserver = spawnDevserver(ctx.chanBin, chanHome);
    const pages = [];
    try {
      const launchUrl = await devserver.url;
      const origin = new URL(launchUrl).origin;
      const token = new URL(launchUrl).searchParams.get("t");
      check(token, "launcher URL has no management token");
      const windows = () => fetchWindows(origin, token);
      const connections = () => fetchTmux(origin, token);

      // A terminal window from the launcher, whose shell runs tmux -CC.
      const launcher = watchPage(await ctx.browser.newPage(), "launcher");
      pages.push(launcher);
      await goto(launcher, launchUrl);
      await launcher.waitForSelector('button[aria-label="New local terminal"]', { timeout: 30_000 });
      const source = watchPage(await popupFrom(launcher, () => launcher.click('button[aria-label="New local terminal"]'), "New local terminal"), "source");
      pages.push(source);
      step("source window");
      await waitForPane(source, "source window");
      const sourceWindow = new URL(source.url()).searchParams.get("w");
      check(sourceWindow, "the terminal window's URL names no w");
      await waitAttachedTabs(source, 1, "source window");
      const sourceTabsBefore = (await attachedTabs(source)).length;
      const before = await windows();
      check(!before.some((row) => row.tmux), "no tmux row before the connection");

      // Type the command into the shell: the marker enters at once, since a
      // local tmux is the foreground.
      await source.bringToFront();
      await source.click(".terminal-tab.active .terminal.xterm .xterm-screen, .terminal-tab.active .terminal-host canvas");
      step("typing tmux");
      await source.keyboard.type(`exec tmux -L ${SOCKET} -f /dev/null -CC new-session -s ${SESSION}\n`);

      // The connection mints a window for the tmux window and one for the
      // control terminal, both marked with the connection and neither in the
      // store; the control row is the mark's control, titled as the card is.
      const minted = await poll("the control window and the tmux window", async () => {
        const rows = (await windows()).filter((row) => row.tmux && row.kind === "terminal");
        const control = rows.find((row) => row.tmux.control);
        const tmuxWindow = rows.find((row) => row.tmux && !row.tmux.control);
        return control && tmuxWindow ? { control, tmuxWindow } : null;
      }, 60_000);
      step(`minted control ${minted.control.window_id}, tmux window ${minted.tmuxWindow.window_id}`);
      check(minted.control.tmux.connection === minted.tmuxWindow.tmux.connection, "the two rows name different connections");
      check(minted.control.title.trim() === CARD_TITLE, `the control row's title is ${JSON.stringify(minted.control.title)}`);
      const store = JSON.parse(readFileSync(join(chanHome, "devserver", "windows.json"), "utf8"));
      check(!store.some((row) => row.tmux), "a tmux row reached windows.json");
      check(!minted.tmuxWindow.hidden, "the tmux window is minted hidden");
      // The connection is a record of the feed and a card in the launcher,
      // titled for its local origin, with the control terminal as its row.
      const record = await poll("the connection record", async () => (await connections()).find((c) => c.connection === minted.control.tmux.connection) ?? null, 30_000);
      check(record.origin && record.origin.local === true, `the record's origin is not local: ${JSON.stringify(record.origin)}`);
      check(record.control_window === minted.control.window_id, "the record names another control window");
      check(record.windows.some((w) => w.chan_window === minted.tmuxWindow.window_id), "the record lacks the tmux window");
      await poll("the tmux card in the launcher", () => evaluateOrDump(launcher, (title) => document.body.textContent?.includes(title) ?? false, "launcher text", CARD_TITLE), 30_000);
      await ctx.shot("launcher-rows", launcher);
      // The control terminal's tab leaves the source window once the window
      // minted for it is open; the source opened it itself here.
      await poll("the source window let the control tab go", async () => {
        const tabs = await attachedTabs(source);
        return tabs.length < sourceTabsBefore ? tabs : null;
      }, 30_000);

      // The tmux window opens from the launcher with the pane's tab and no
      // default shell beside it; the control window is chromeless.
      const tmuxPage = watchPage(await popupFrom(launcher, () => openRow(launcher, rowName(minted.tmuxWindow)), "Open tmux window"), "tmux window");
      pages.push(tmuxPage);
      step("tmux window open");
      await waitForPane(tmuxPage, "tmux window");
      check(new URL(tmuxPage.url()).searchParams.get("seed") === "0", "the tmux window's URL carries no seed=0");
      await waitAttachedTabs(tmuxPage, 1, "tmux window");
      await wait(1500);
      check((await attachedTabs(tmuxPage)).length === 1, "a second tab appeared beside the pane's");
      await ctx.shot("tmux-window", tmuxPage);

      // In a browser the source page opens the control window itself when it
      // lets its tab go (popups are not blocked under puppeteer); when it did
      // not, the launcher's Open does, into a popup named for the window, so
      // the page is found by its window rather than awaited as a new popup.
      let controlPage = await pageForWindow(ctx, minted.control.window_id, 20_000);
      if (!controlPage) {
        await openRow(launcher, rowName(minted.control));
        controlPage = await pageForWindow(ctx, minted.control.window_id, 30_000);
      }
      check(controlPage, "no page shows the control window");
      watchPage(controlPage, "control window");
      pages.push(controlPage);
      await poll("the control page on its window", () => evaluateOrDump(controlPage, () => new URL(location.href).searchParams.has("w"), "control page url"), 30_000);
      step("control page");
      await controlPage.bringToFront();
      await poll("the control window's chromeless pane", () => evaluateOrDump(controlPage, () => !!document.querySelector(".tabs.control-hidden"), "control chrome"), 60_000);
      check(!(await evaluateOrDump(controlPage, () => !!document.querySelector(".tmux-status"), "status view")), "a status view covers the control terminal");
      await ctx.shot("control-window", controlPage);

      // A chan split in the tmux window is tmux's: the pane is split in tmux
      // and the layout comes back as two panes, each with its tab attached.
      step("split");
      await dispatchCommand(tmuxPage, "app.pane.splitRight");
      await poll("two panes, each with an attached terminal", async () => {
        const panes = await panesAttached(tmuxPage);
        return panes.length === 2 && panes.every(Boolean) ? panes : null;
      }, 60_000);
      const tmuxPanes = execFileSync("tmux", ["-L", SOCKET, "list-panes", "-t", `${SESSION}:0`], { encoding: "utf8" })
        .trim().split("\n").filter(Boolean).length;
      check(tmuxPanes === 2, `tmux has ${tmuxPanes} pane(s) in the split window, not 2`);
      await ctx.shot("tmux-window-split", tmuxPage);

      // Cmd+T and New Window in the tmux window each ask tmux for a window,
      // which opens in a chan window of its own: a chan window shows one
      // tmux window as its pane tree.
      const countBefore = (await windows()).filter((row) => row.tmux).length;
      step("new window via Cmd+T");
      await dispatchCommand(tmuxPage, "app.terminal.toggle");
      await poll("a tmux row for the window Cmd+T asked for", async () => {
        const rows = (await windows()).filter((row) => row.tmux);
        return rows.length === countBefore + 1 ? rows : null;
      }, 60_000);
      check((await attachedTabs(tmuxPage)).length === 2, "Cmd+T added a tab to the split window");
      step("new window via New Window");
      await dispatchCommand(tmuxPage, "app.tmux.newWindow");
      try {
        await poll("a tmux row for the window New Window asked for", async () => {
          const rows = (await windows()).filter((row) => row.tmux);
          return rows.length === countBefore + 2 ? rows : null;
        }, 60_000);
      } catch (error) {
        const records = JSON.stringify(await connections().catch((e) => String(e))).slice(0, 400);
        const line = await tmuxPage.$eval(".transient-status, .status-line, [data-transient-status]", (el) => el.textContent ?? "").catch(() => "(no status line)");
        const rows = (await windows()).filter((row) => row.tmux).map((row) => `${row.window_id}:${row.label}`);
        throw new Error(`${error instanceof Error ? error.message : error}; connections: ${records}; page status: ${line.slice(0, 200)}; tmux rows: ${rows.join(", ")}`);
      }

      // Detach from the card: every tmux window goes, the connection record
      // and the card go, and the control window stays as a plain terminal
      // window whose page shows its pane chrome again.
      step("detach");
      await launcher.bringToFront();
      const detachSelector = `button[aria-label="Detach ${CARD_TITLE}"]`;
      await launcher.waitForSelector(detachSelector, { timeout: 30_000 });
      await launcher.click(detachSelector);
      try {
        await poll("no tmux row and no connection record", async () => {
          const rows = (await windows()).filter((row) => row.tmux);
          const records = await connections();
          return rows.length === 0 && records.length === 0 ? rows : null;
        }, 60_000);
      } catch (error) {
        const clients = (() => { try { return execFileSync("tmux", ["-L", SOCKET, "list-clients"], { encoding: "utf8" }).trim(); } catch (e) { return `list-clients failed: ${e}`; } })();
        const status = JSON.stringify(await connections().catch((e) => String(e))).slice(0, 300);
        const rows = (await windows()).filter((row) => row.tmux).map((row) => `${row.window_id}:${row.label}`);
        const all = devserver.lines();
        const from = all.findIndex((line) => line.includes("tmux connection ending"));
        const serverLines = (from >= 0 ? all.slice(Math.max(0, from - 3)) : all.slice(-40)).slice(0, 60).join("\n  ");
        throw new Error(`${error instanceof Error ? error.message : error}; tmux clients: ${clients || "(none)"}; status view: ${status}; tmux rows: ${rows.join(", ")}\nserver log:\n  ${serverLines}`);
      }
      step("tmux rows gone");
      const released = (await windows()).find((row) => row.window_id === minted.control.window_id);
      check(released && !released.tmux && !released.control, "the control window did not become a plain terminal window");
      await poll("the control page shows its pane chrome", () => evaluateOrDump(controlPage, () => !!document.querySelector(".tabs") && !document.querySelector(".tabs.control-hidden"), "pane chrome"), 30_000);
      await poll("the card gone from the launcher", () => evaluateOrDump(launcher, (title) => !(document.body.textContent?.includes(title) ?? false), "launcher text", CARD_TITLE), 30_000);
      await ctx.shot("after-detach", controlPage);
      step("done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(pageLog.length ? `${message}\npages logged:\n${pageLog.slice(-30).join("\n")}` : message);
    } finally {
      for (const page of pages) await page.close().catch(() => {});
      await killChild(devserver.child);
      try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch {}
      rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
