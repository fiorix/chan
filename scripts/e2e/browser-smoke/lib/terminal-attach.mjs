import { readTerminalPrefs } from "./terminal-prefs.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openAttachedTerminal(ctx, page, cs, windowId, name, backend) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const terminal = await readTerminalPrefs(page, token);
  const actual = terminal.ghostty ? "ghostty" : "xterm";
  if (actual !== backend) {
    throw new Error(`${name}: page still spawns ${actual} after ${backend} was written`);
  }
  await cs(["new", "--tab-name", name]);
  const deadline = Date.now() + 60_000;
  let row = null;
  const backendSelector = backend === "ghostty"
    ? ".terminal-host canvas"
    : ".terminal.xterm .xterm-screen";
  for (;;) {
    const listed = await cs(["list", "--json"]);
    const rows = Object.values(JSON.parse(listed.stdout).groups ?? {}).flat();
    row = rows.find((entry) => entry.name === name) ?? null;
    // A devserver's window roster marks an attached session "alive". A
    // standalone `chan serve` has no roster and calls the same tab "orphaned".
    const status = row?.window_status;
    if (row?.window === windowId && (status === "alive" || status === "orphaned") &&
        row.pane && row.tab) {
      const selector = `.pane[data-pane-id="${row.pane}"] ` +
        `.terminal-tab.active[data-terminal-tab-id="${row.tab}"] ${backendSelector}`;
      const attached = await page.evaluate((query) => {
        const element = document.querySelector(query);
        const box = element?.getBoundingClientRect();
        return !!box && box.width > 0 && box.height > 0;
      }, selector);
      if (attached) return row;
    }
    if (Date.now() > deadline) {
      const tabs = await page.evaluate(() => [...document.querySelectorAll(".terminal-tab")].map((tab) => {
        const xterm = tab.querySelector(".terminal.xterm .xterm-screen");
        const ghostty = tab.querySelector(".terminal-host canvas");
        const element = xterm ?? ghostty;
        const box = element?.getBoundingClientRect();
        return {
          tab: tab.getAttribute("data-terminal-tab-id"),
          active: tab.classList.contains("active"),
          backend: xterm ? "xterm" : ghostty ? "ghostty" : "missing",
          box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
        };
      }));
      await ctx.shot(`${name}-attach-failure`, page).catch(() => {});
      throw new Error(`${name}: terminal not attached: row=${JSON.stringify(row)} tabs=${JSON.stringify(tabs)}`);
    }
    await sleep(250);
  }
}
