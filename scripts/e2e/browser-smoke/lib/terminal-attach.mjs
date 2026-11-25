const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The widget draws on one canvas, a direct child of the terminal's host; a
// canvas nested deeper is not the terminal's surface.
export const TERMINAL_SURFACE = ".terminal-host > canvas";

export async function readTerminalAttachment(page, cs, matchesRow) {
  const listed = await cs(["list", "--json"]);
  const rows = Object.values(JSON.parse(listed.stdout).groups ?? {}).flat();
  const row = rows.find(matchesRow) ?? null;
  const selector = row?.pane && row.tab
    ? `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`
    : null;
  const attached = selector ? await page.evaluate((query) => {
    const box = document.querySelector(query)?.getBoundingClientRect();
    return !!box && box.width > 0 && box.height > 0;
  }, `${selector} ${TERMINAL_SURFACE}`) : false;
  return { row, selector, attached };
}

export async function openAttachedTerminal(ctx, page, cs, windowId, name, newArgs = []) {
  await cs(["new", "--tab-name", name, ...newArgs]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    // A devserver's window roster marks an attached session "alive". A
    // standalone `chan serve` has no roster and calls the same tab "orphaned".
    const { row, attached } = await readTerminalAttachment(page, cs, (entry) => entry.name === name);
    if (attached && row.window === windowId &&
        (row.window_status === "alive" || row.window_status === "orphaned")) return row;
    if (Date.now() > deadline) {
      const tabs = await page.evaluate((surface) => [...document.querySelectorAll(".terminal-tab")].map((tab) => {
        const canvas = tab.querySelector(surface);
        const box = canvas?.getBoundingClientRect();
        return {
          tab: tab.getAttribute("data-terminal-tab-id"),
          active: tab.classList.contains("active"),
          canvas: !!canvas,
          box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
        };
      }), TERMINAL_SURFACE);
      await ctx.shot(`${name}-attach-failure`, page).catch(() => {});
      throw new Error(`${name}: terminal not attached: row=${JSON.stringify(row)} tabs=${JSON.stringify(tabs)}`);
    }
    await sleep(250);
  }
}
