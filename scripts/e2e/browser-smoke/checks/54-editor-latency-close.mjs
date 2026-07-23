// Closing a just-edited doc over a slow network must not raise the
// conflict modal. The save funnel used to degrade on a fixed 4s wall
// clock under RTT-scale delays and fall through to a CAS PUT with a
// stale token; the server answered 409 for content it already had and
// the editor blamed a phantom external edit. This check types through
// a 1500ms-one-way TCP delay proxy (WebSockets included; CDP network
// emulation cannot delay them), closes the tab, and asserts no modal
// appears and the disk converges to exactly one marker.

const DOC = "latency-doc.md";

async function openFile(page, filename) {
  await page.bringToFront();
  if (!(await page.$(".file-tree, [role=tree]"))) {
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
      );
    });
    await page.waitForSelector('[role="treeitem"]', { timeout: 30_000 });
  }
  const clicked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[role="treeitem"] button.name')].find(
      (b) => b.textContent?.trim() === name,
    );
    if (!row) return false;
    row.click();
    return true;
  }, filename);
  if (!clicked) throw new Error(`tree row not found: ${filename}`);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Open"),
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Open")
      ?.click();
  });
  await page.waitForSelector(".cm-content", { timeout: 60_000 });
}

export default {
  name: "editor-latency-close",
  async run(ctx) {
    const { browser } = ctx;
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    // Load fast, then slow the pipe for the scenario itself.
    const proxy = await ctx.latencyProxy(100);
    const page = await browser.newPage();
    try {
      await page.goto(`${proxy.url}&w=smoke-latency`, {
        waitUntil: "networkidle2",
        timeout: 120_000,
      });
      await page.waitForSelector(".pane", { timeout: 60_000 });
      await openFile(page, DOC);
      await new Promise((r) => setTimeout(r, 1500));

      proxy.setLatency(1500);
      const marker = `SMOKE-LAT-${Date.now()}`;
      await page.click(".cm-content");
      await page.keyboard.down("Control");
      await page.keyboard.press("Home");
      await page.keyboard.up("Control");
      await page.keyboard.type(`${marker} `, { delay: 15 });
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("chan:command", { detail: { name: "app.tab.close" } }),
        );
      });

      // Hunt for the modal over the whole window in which the funnel,
      // fallback, and their round trips can raise it.
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        const modal = await page.evaluate(() =>
          [...document.querySelectorAll('[role="dialog"]')].some((d) =>
            d.textContent?.includes("External edit detected"),
          ),
        );
        if (modal) {
          await ctx.shot("conflict-modal", page);
          throw new Error("conflict modal raised by a close under latency");
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      proxy.setLatency(50);
      await new Promise((r) => setTimeout(r, 5_000));
      const disk = readFileSync(join(ctx.workspaceDir, DOC), "utf8");
      const hits = disk.split(marker).length - 1;
      if (hits !== 1) {
        throw new Error(`disk must hold the marker exactly once, found ${hits}`);
      }
      return { marker, hits };
    } finally {
      if (!page.isClosed()) await page.close().catch(() => {});
      await proxy.close().catch(() => {});
    }
  },
};
