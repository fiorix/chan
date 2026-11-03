// A terminal Hybrid Nav stages takes the server's next name, as any new
// terminal does, and settling that name leaves the transaction fresh. Window A
// holds a Terminal-1 and window B holds no terminal, so a name counted from
// B's own tabs would be Terminal-1 again, which the server settles as another
// name, and the session's rename would read as a layout change.

import { installProgramStatusRecord } from "../lib/program-status.mjs";

const WINDOW_A = "staged-name-a-199";
const WINDOW_B = "staged-name-b-199";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function poll(read, accept, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await sleep(200);
  }
  throw new Error(`${label} did not settle; last=${JSON.stringify(last)}`);
}

async function openWindow(ctx, windowId) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  const page = await ctx.browser.newPage();
  // Records each terminal socket's session frame before the app reads it.
  await page.evaluateOnNewDocument(installProgramStatusRecord);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 30_000 });
  await ctx.waitWindowLive(windowId);
  return page;
}

async function dispatchCommand(page, name) {
  await page.bringToFront();
  await page.evaluate((command) => {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: command } }));
  }, name);
}

/// The names of the workspace's live terminals, every window's.
async function liveNames(page) {
  return page.evaluate(async () => {
    const token = sessionStorage.getItem("chan.token") ?? new URLSearchParams(location.search).get("t") ?? "";
    const response = await fetch("/api/terminals/roster", { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return ((await response.json()).sessions ?? []).map((session) => session.tab_name);
  });
}

/// The window's terminal tabs, the session frames its terminals received, and
/// whether Hybrid Nav is up and stale.
async function view(page) {
  return page.evaluate(() => ({
    tabs: [...document.querySelectorAll(".tab")]
      .filter((tab) => tab.querySelector(".tab-icon.program-activity"))
      .map((tab) => ({ label: tab.querySelector(".path")?.textContent?.trim() ?? "", staged: tab.classList.contains("staged") })),
    sessions: window.__programStatusTrace.frames.filter((frame) => frame.type === "session").map((frame) => frame.name),
    mode: !!document.querySelector(".app.pane-mode"),
    stale: !!document.querySelector(".pane-mode-stale-warning"),
  }));
}

export default {
  name: "hybrid nav staged terminal name",
  async run(ctx) {
    const pageA = await openWindow(ctx, WINDOW_A);
    await dispatchCommand(pageA, "app.terminal.toggle");
    await poll(() => view(pageA), (state) => state.sessions.length === 1, "window A's terminal");
    await poll(() => liveNames(pageA), (names) => names.includes("Terminal-1"), "a live Terminal-1");

    const pageB = await openWindow(ctx, WINDOW_B);
    check((await view(pageB)).tabs.length === 0, "window B opened with a terminal tab");
    await dispatchCommand(pageB, "app.pane.mode");
    await pageB.waitForSelector(".app.pane-mode", { timeout: 10_000 });
    await pageB.keyboard.press("t");

    const staged = await poll(() => view(pageB), (state) => state.sessions.length === 1, "window B's staged terminal session");
    await ctx.shot("staged", pageB);
    const [name] = staged.sessions;
    check(!staged.stale, `settling the staged terminal's name made the transaction stale: ${JSON.stringify(staged)}`);
    check(/^Terminal-\d+$/.test(name), `the staged terminal settled as ${JSON.stringify(name)}, not the server's next name`);
    check(staged.tabs.length === 1 && staged.tabs[0].staged && staged.tabs[0].label === name, `window B's staged tab is not ${JSON.stringify(name)}: ${JSON.stringify(staged)}`);

    await pageB.keyboard.press("Enter");
    const committed = await poll(() => view(pageB), (state) => !state.mode, "the commit");
    check(committed.tabs.length === 1 && !committed.tabs[0].staged && committed.tabs[0].label === name, `window B's committed terminal is not ${JSON.stringify(name)}: ${JSON.stringify(committed)}`);
    return { name, staged, committed };
  },
};
