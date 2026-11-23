const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const TERMINAL_SURFACES = {
  // Xterm's WebGL canvas is nested inside its screen, not directly in the host.
  ghostty: ".terminal-host > canvas",
};

export function requireGhosttyBackend(backend) {
  if (backend !== "ghostty") {
    const description = typeof backend === "string" ? JSON.stringify(backend) : typeof backend;
    throw new Error(`retired or unsupported terminal backend ${description}; expected "ghostty"`);
  }
}

export function readTerminalAttachment(page, cs, backend, matchesRow) {
  requireGhosttyBackend(backend);
  return readGhosttyAttachment(page, cs, matchesRow);
}

async function readGhosttyAttachment(page, cs, matchesRow) {
  const listed = await cs(["list", "--json"]);
  const rows = Object.values(JSON.parse(listed.stdout).groups ?? {}).flat();
  const row = rows.find(matchesRow) ?? null;
  const selector = row?.pane && row.tab
    ? `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`
    : null;
  const attached = selector ? await page.evaluate((query) => {
    const box = document.querySelector(query)?.getBoundingClientRect();
    return !!box && box.width > 0 && box.height > 0;
  }, `${selector} ${TERMINAL_SURFACES.ghostty}`) : false;
  return { row, selector, attached };
}

export function openAttachedTerminal(ctx, page, cs, windowId, name, backend, newArgs = []) {
  requireGhosttyBackend(backend);
  return openGhosttyTerminal(ctx, page, cs, windowId, name, newArgs);
}

async function openGhosttyTerminal(ctx, page, cs, windowId, name, newArgs) {
  await cs(["new", "--tab-name", name, ...newArgs]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    // A devserver's window roster marks an attached session "alive". A
    // standalone `chan serve` has no roster and calls the same tab "orphaned".
    const { row, attached } = await readTerminalAttachment(page, cs, "ghostty", (entry) => entry.name === name);
    if (attached && row.window === windowId &&
        (row.window_status === "alive" || row.window_status === "orphaned")) return row;
    if (Date.now() > deadline) {
      const tabs = await page.evaluate((surfaces) => [...document.querySelectorAll(".terminal-tab")].map((tab) => {
        const ghostty = tab.querySelector(surfaces.ghostty);
        const box = ghostty?.getBoundingClientRect();
        return {
          tab: tab.getAttribute("data-terminal-tab-id"),
          active: tab.classList.contains("active"),
          backend: ghostty ? "ghostty" : "missing",
          box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
        };
      }), TERMINAL_SURFACES);
      await ctx.shot(`${name}-attach-failure`, page).catch(() => {});
      throw new Error(`${name}: terminal not attached: row=${JSON.stringify(row)} tabs=${JSON.stringify(tabs)}`);
    }
    await sleep(250);
  }
}
