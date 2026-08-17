// Closing a just-edited doc over a slow network must not raise the
// conflict modal. The save funnel used to degrade on a fixed 4s wall
// clock under RTT-scale delays and fall through to a CAS PUT with a
// stale token; the server answered 409 for content it already had and
// the editor blamed a phantom external edit. This check types through
// a 1500ms-one-way TCP delay proxy (WebSockets included; CDP network
// emulation cannot delay them), closes the tab, and asserts no modal
// appears and the disk converges to exactly one marker.

const DOC = "latency-doc.md";

async function openFile(ctx, page, windowId, filename) {
  await page.bringToFront();
  const socket = ctx.controlSocket;
  if (!socket) throw new Error("control socket not found for the server pid");
  await ctx.waitWindowLive(windowId, 60_000);
  await ctx.exec(ctx.chanBin, ["shell", "open", filename], {
    cwd: ctx.workspaceDir,
    env: {
      ...process.env,
      CHAN_CONTROL_SOCKET: socket,
      CHAN_WINDOW_ID: windowId,
    },
    timeout: 30_000,
  });
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll(".pane")].some((pane) => {
        const activeTab = [...pane.querySelectorAll(".tab.active")].find((tab) =>
          tab.textContent?.includes(name),
        );
        const editor = pane.querySelector(".editor-tab.active");
        return (
          activeTab !== undefined &&
          editor !== null &&
          editor.querySelector(".cm-content") !== null &&
          editor.querySelector(".loading-toolbar") === null
        );
      }),
    { timeout: 60_000, polling: 200 },
    filename,
  );
  const handle = await page.evaluateHandle((name) => {
    const pane = [...document.querySelectorAll(".pane")].find((candidate) =>
      [...candidate.querySelectorAll(".tab.active")].some((tab) =>
        tab.textContent?.includes(name),
      ),
    );
    return pane?.querySelector(".editor-tab.active .cm-content") ?? null;
  }, filename);
  const editor = handle.asElement();
  if (!editor) {
    await handle.dispose();
    throw new Error(`active editor missing for ${filename}`);
  }
  await editor.click();
  await editor.dispose();
  await page.waitForFunction(
    (name) => {
      const pane = [...document.querySelectorAll(".pane")].find((candidate) =>
        [...candidate.querySelectorAll(".tab.active")].some((tab) =>
          tab.textContent?.includes(name),
        ),
      );
      const content = pane?.querySelector(".editor-tab.active .cm-content");
      return content !== null && content !== undefined && content.contains(document.activeElement);
    },
    { timeout: 5_000, polling: 100 },
    filename,
  );
  await page.keyboard.down("Control");
  await page.keyboard.press("Home");
  await page.keyboard.up("Control");
  // The initial document-session attach can replace the editor state and move
  // the selection. Start the scenario only after the caret remains at offset 0.
  let stableCaretReads = 0;
  for (const deadline = Date.now() + 10_000; ; ) {
    const caretOffset = await page.evaluate((name) => {
      const pane = [...document.querySelectorAll(".pane")].find((candidate) =>
        [...candidate.querySelectorAll(".tab.active")].some((tab) =>
          tab.textContent?.includes(name),
        ),
      );
      const content = pane?.querySelector(".editor-tab.active .cm-content");
      const selection = getSelection();
      if (
        !content ||
        !selection?.anchorNode ||
        !content.contains(selection.anchorNode)
      ) {
        return -1;
      }
      const range = document.createRange();
      range.selectNodeContents(content);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      return range.toString().length;
    }, filename);
    if (caretOffset === 0) {
      stableCaretReads += 1;
      if (stableCaretReads === 6) break;
    } else {
      stableCaretReads = 0;
      await page.keyboard.down("Control");
      await page.keyboard.press("Home");
      await page.keyboard.up("Control");
    }
    if (Date.now() > deadline) {
      throw new Error(`editor caret did not settle at document start (offset ${caretOffset})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
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
      const windowId = "smoke-latency";
      const windowUrl = new URL(proxy.url);
      windowUrl.searchParams.set("w", windowId);
      await page.goto(windowUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
      await page.waitForSelector(".pane", { timeout: 60_000 });
      await openFile(ctx, page, windowId, DOC);

      proxy.setLatency(1500);
      const marker = `SMOKE-LAT-${Date.now()}`;
      await page.keyboard.type(`${marker} `, { delay: 15 });
      await page.waitForFunction(
        ({ name, marker }) =>
          [...document.querySelectorAll(".pane")].some((pane) => {
            const activeTab = [...pane.querySelectorAll(".tab.active")].find((tab) =>
              tab.textContent?.includes(name),
            );
            const content = pane.querySelector(".editor-tab.active .cm-content");
            return activeTab !== undefined && content?.textContent?.includes(marker);
          }),
        { timeout: 5_000, polling: 100 },
        { name: DOC, marker },
      );
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
