// Hybrid Nav in a tmux window. tmux owns the window's layout, so the
// transaction stages what tmux will do: a split shows a staged pane and sends
// tmux the split on Enter, a divider move by key or mouse drag sends a pane
// resize on Enter, Escape sends nothing, and the layouts tmux sends during the
// transaction (here from a split and a kill made outside chan) never mark it
// stale. A window resize during the transaction reaches tmux once it ends. A
// tmux window has no A/B sides: Hybrid Nav's Tab and the flip command leave
// the side alone, and the cheatsheet lists neither Tab nor the keys that would
// stage a local tab or swap tiles.
//
// Skips when tmux is not installed or the launcher bundle is missing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWindows, goto, killChild, openRow, poll, spawnDevserver, wait } from "../lib/launcher-devserver.mjs";

const SOCKET = "chan-smoke-198";
const SESSION = "smoke198";
/// Long enough for a request, tmux's answer and the page's apply.
const SETTLE_MS = 2_000;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function tmux(...args) {
  return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" }).trim();
}

function tmuxInstalled() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/// The tmux window's panes, left to right and top to bottom.
const tmuxPanes = () =>
  tmux("list-panes", "-t", `${SESSION}:0`, "-F", "#{pane_id} #{pane_left} #{pane_width}")
    .split("\n")
    .map((line) => {
      const [id, left, width] = line.split(" ");
      return { id, left: Number(left), width: Number(width) };
    })
    .sort((a, b) => a.left - b.left);

async function popupFrom(page, action, label) {
  const popup = new Promise((resolve) => page.once("popup", resolve));
  await action();
  return Promise.race([popup, wait(30_000).then(() => { throw new Error(`${label}: no popup within 30s`); })]);
}

/// What the tmux page shows: Hybrid Nav, its stale warning and previews, each
/// pane's side and whether its active terminal has a box, and the cheatsheet.
const pageState = (page) =>
  page.evaluate(() => ({
    paneMode: !!document.querySelector(".app.pane-mode"),
    stale: !!document.querySelector(".pane-mode-stale-warning"),
    previews: [...document.querySelectorAll(".pane-mode-preview")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
    sides: [...document.querySelectorAll(".pane-card-inner")].map((el) => el.getAttribute("data-side-label")),
    panes: [...document.querySelectorAll(".pane")].map((pane) => {
      const box = pane.querySelector(".terminal-tab.active .terminal.xterm .xterm-screen, .terminal-tab.active .terminal-host canvas")?.getBoundingClientRect();
      return !!box && box.width > 0 && box.height > 0;
    }),
    terminals: document.querySelectorAll(".terminal-tab").length,
    help: [...document.querySelectorAll(".pane-mode-help [aria-label]")].map((el) => el.getAttribute("aria-label")),
    status: document.querySelector(".status-msg")?.textContent ?? null,
  }));

/// Drag the page's one vertical divider `dx` pixels with the mouse; answers
/// its value (the left pane's share, in percent) before and after.
async function dragDivider(page, dx) {
  const divider = () =>
    page.evaluate(() => {
      const el = document.querySelector(".split.row > .divider");
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, value: Number(el.getAttribute("aria-valuenow")) };
    });
  const from = await divider();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y, { steps: 5 });
  await page.mouse.up();
  return { before: from.value, after: (await divider()).value };
}

async function dispatchCommand(page, name) {
  await page.evaluate((command) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: command } })), name);
}

export default {
  name: "hybrid-nav-tmux",
  async run(ctx) {
    if (!existsSync(join(ctx.repoRoot, "web-launcher/dist/index.html"))) {
      ctx.skip("launcher dist missing; build the web bundles before this check");
    }
    if (!tmuxInstalled()) ctx.skip("tmux is not installed");
    try { tmux("kill-server"); } catch {}
    const chanHome = mkdtempSync(join(tmpdir(), "chan-tmux-198-"));
    execFileSync(ctx.chanBin, ["config", "set", "terminal.tmux.enabled", "true"], {
      env: { ...process.env, CHAN_HOME: chanHome },
      stdio: "ignore",
    });
    const devserver = spawnDevserver(ctx.chanBin, chanHome);
    const pages = [];
    const steps = [];
    let page = null;
    const step = (label) => steps.push(label);
    try {
      const launchUrl = await devserver.url;
      const origin = new URL(launchUrl).origin;
      const token = new URL(launchUrl).searchParams.get("t");
      check(token, "launcher URL has no management token");

      const launcher = await ctx.browser.newPage();
      pages.push(launcher);
      await goto(launcher, launchUrl);
      await launcher.waitForSelector('button[aria-label="New local terminal"]', { timeout: 30_000 });
      const source = await popupFrom(launcher, () => launcher.click('button[aria-label="New local terminal"]'), "New local terminal");
      pages.push(source);
      const screen = ".terminal-tab.active .terminal.xterm .xterm-screen, .terminal-tab.active .terminal-host canvas";
      await source.waitForSelector(screen, { visible: true, timeout: 60_000 });
      await source.click(screen);
      step("tmux -CC");
      await source.keyboard.type(`tmux -L ${SOCKET} -f /dev/null -CC new-session -s ${SESSION}\n`);
      const tmuxWindow = await poll("the tmux window's record", async () => {
        const rows = await fetchWindows(origin, token);
        return rows.find((row) => row.tmux && !row.tmux.control && row.kind === "terminal") ?? null;
      }, 60_000);
      page = await popupFrom(launcher, () => openRow(launcher, `Terminal Window ${tmuxWindow.ordinal}${tmuxWindow.label ? ` [${tmuxWindow.label.trim()}]` : ""}`), "open the tmux window");
      pages.push(page);
      await poll("the tmux window's attached pane", async () => {
        const state = await pageState(page);
        return state.panes.length === 1 && state.panes[0] ? state : null;
      }, 60_000);
      await page.bringToFront();
      const before = tmuxPanes();
      check(before.length === 1, `tmux starts with ${before.length} panes`);

      // Entering and staging a split sends tmux nothing and stays fresh.
      step("stage a split");
      await dispatchCommand(page, "app.pane.mode");
      await page.waitForSelector(".app.pane-mode", { timeout: 10_000 });
      await page.keyboard.press("/");
      await wait(SETTLE_MS);
      let state = await pageState(page);
      check(!state.stale, `staging a split marked Hybrid Nav stale: ${JSON.stringify(state)}`);
      check(state.previews.length === 2 && state.previews.some((text) => text.includes("New tmux pane")), `the staged split shows: ${JSON.stringify(state.previews)}`);
      check(state.terminals === 1, `the staged split started ${state.terminals - 1} local terminal(s)`);
      check(tmuxPanes().length === 1, "tmux split before the commit");

      // Layouts tmux sends during the transaction apply without a conflict:
      // another client splits the window and kills the new pane.
      step("tmux layouts during the transaction");
      const outside = tmux("split-window", "-d", "-t", `${SESSION}:0`, "-P", "-F", "#{pane_id}");
      await wait(SETTLE_MS);
      tmux("kill-pane", "-t", outside);
      await wait(SETTLE_MS);
      state = await pageState(page);
      check(!state.stale, `a tmux layout marked Hybrid Nav stale: ${JSON.stringify(state)}`);

      // A window resize waits for the transaction; Enter asks tmux for the
      // split, and both arrive through tmux's layout.
      step("commit the split after a window resize");
      const viewport = page.viewport() ?? { width: 1600, height: 1000 };
      await page.setViewport({ width: viewport.width - 300, height: viewport.height - 150 });
      await wait(SETTLE_MS);
      state = await pageState(page);
      check(!state.stale && tmuxPanes()[0].width === before[0].width, `the window resize reached tmux during the transaction: ${JSON.stringify(tmuxPanes())}`);
      await page.keyboard.press("Enter");
      await poll("tmux and the page with two attached panes in the smaller window", async () => {
        const now = await pageState(page);
        const panes = tmuxPanes();
        const width = panes.reduce((sum, pane) => sum + pane.width, panes.length - 1);
        return panes.length === 2 && width < before[0].width - 10 && !now.paneMode && now.panes.length === 2 && now.panes.every(Boolean) ? now : null;
      }, 30_000);
      await wait(SETTLE_MS);
      state = await pageState(page);
      check(state.panes.length === 2 && state.terminals === 2, `after the split settled: ${JSON.stringify(state)}`);

      // Escape discards a staged split without asking tmux.
      step("discard a staged split");
      await dispatchCommand(page, "app.pane.mode");
      await page.waitForSelector(".app.pane-mode", { timeout: 10_000 });
      await page.keyboard.press("?");
      await page.keyboard.press("Escape");
      await wait(SETTLE_MS);
      state = await pageState(page);
      check(tmuxPanes().length === 2 && state.panes.length === 2, `Escape left tmux ${tmuxPanes().length} and the page ${state.panes.length} panes`);

      // A divider move reaches tmux as a pane resize on Enter.
      step("resize");
      const split = tmuxPanes();
      await dispatchCommand(page, "app.pane.mode");
      await page.waitForSelector(".app.pane-mode", { timeout: 10_000 });
      await page.keyboard.press("ArrowLeft");
      for (let i = 0; i < 3; i++) await page.keyboard.press("]");
      await page.keyboard.press("Enter");
      await poll("tmux widened the left pane", () => {
        const now = tmuxPanes();
        return now.length === 2 && now[0].width > split[0].width + 3 ? now : null;
      }, 10_000);

      // A mouse drag of the divider is staged the same way: Escape leaves
      // tmux's panes alone, and Enter sends the resize.
      step("drag then Escape");
      await wait(SETTLE_MS);
      const widths = JSON.stringify(tmuxPanes());
      await dispatchCommand(page, "app.pane.mode");
      await page.waitForSelector(".app.pane-mode", { timeout: 10_000 });
      const preview = await dragDivider(page, -200);
      check(preview.after < preview.before - 5, `the drag left the draft's divider in place: ${JSON.stringify(preview)}`);
      await wait(SETTLE_MS);
      check(JSON.stringify(tmuxPanes()) === widths, `the drag reached tmux before Enter: ${widths} became ${JSON.stringify(tmuxPanes())}`);
      await page.keyboard.press("Escape");
      await wait(SETTLE_MS);
      state = await pageState(page);
      check(!state.paneMode && JSON.stringify(tmuxPanes()) === widths, `after Escape: tmux ${widths} became ${JSON.stringify(tmuxPanes())}, page ${JSON.stringify(state)}`);

      step("drag then Enter");
      await dispatchCommand(page, "app.pane.mode");
      await page.waitForSelector(".app.pane-mode", { timeout: 10_000 });
      await dragDivider(page, -200);
      await wait(SETTLE_MS);
      check(JSON.stringify(tmuxPanes()) === widths, `the drag reached tmux before Enter: ${widths} became ${JSON.stringify(tmuxPanes())}`);
      await page.keyboard.press("Enter");
      const dragged = JSON.parse(widths);
      await poll("tmux narrowed the left pane", () => {
        const now = tmuxPanes();
        return now.length === 2 && now[0].width < dragged[0].width - 5 ? now : null;
      }, 10_000);

      // No sides: Tab, the cheatsheet and the flip command.
      step("sides");
      await dispatchCommand(page, "app.pane.mode");
      await page.waitForSelector(".app.pane-mode", { timeout: 10_000 });
      await page.keyboard.press("Tab");
      await page.keyboard.press("h");
      await page.waitForSelector(".pane-mode-help", { timeout: 5_000 });
      state = await pageState(page);
      check(state.sides.every((side) => side === "A"), `Hybrid Nav Tab flipped a side: ${JSON.stringify(state.sides)}`);
      for (const missing of ["Flip side", "Swap tile", "Stage Terminal"]) {
        check(!state.help.some((label) => label.includes(missing)), `the cheatsheet lists ${missing}: ${JSON.stringify(state.help)}`);
      }
      check(state.help.some((label) => label.includes("Split right")), `the cheatsheet lacks Split right: ${JSON.stringify(state.help)}`);
      await page.keyboard.press("Escape");
      await dispatchCommand(page, "app.pane.flip");
      await wait(500);
      state = await pageState(page);
      check(state.sides.every((side) => side === "A"), `the flip command flipped a side: ${JSON.stringify(state.sides)}`);
      check(tmuxPanes().length === 2 && state.panes.length === 2, `after the side checks: tmux ${tmuxPanes().length}, page ${JSON.stringify(state)}`);
      await ctx.shot("hybrid-nav-tmux", page);
      return { steps, panes: tmuxPanes() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = page ? await pageState(page).catch((e) => String(e)) : null;
      let panes = null;
      try { panes = tmuxPanes(); } catch (e) { panes = String(e); }
      if (page) await ctx.shot("hybrid-nav-tmux-failure", page).catch(() => {});
      throw new Error(`${message}\nsteps: ${steps.join(" > ")}\npage: ${JSON.stringify(state)}\ntmux panes: ${JSON.stringify(panes)}`);
    } finally {
      for (const open of pages) await open.close().catch(() => {});
      await killChild(devserver.child);
      try { tmux("kill-server"); } catch {}
      rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
