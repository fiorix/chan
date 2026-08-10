// Item 7 regression guard: the editor doc-collab path still converges
// with scene sessions in the tree (the tabs delegate slots are shared
// infrastructure). Two clients on one markdown doc: text typed on each
// side lands in the other's editor through the doc session, no PUT.

const DOC = "doc.md";

async function openFileBrowser(page) {
  const open = await page.$(".file-tree, [role=tree]");
  if (open) return;
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
    );
  });
  await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
}

async function selectTreeFile(page, filename) {
  const clicked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[role="treeitem"] button.name')].find(
      (b) => b.textContent?.trim() === name,
    );
    if (!row) return false;
    row.click();
    return true;
  }, filename);
  if (!clicked) throw new Error(`tree row not found: ${filename}`);
}

// A HIDDEN tab stops delivering rAF, which hangs puppeteer's raf-based
// waits and scroll-into-view; foreground a page before driving it and
// poll waits on an interval.

async function openDoc(page) {
  await page.bringToFront();
  await openFileBrowser(page);
  await selectTreeFile(page, DOC);
  // A tree click selects into the Details inspector; the Open button
  // is what mounts the tab.
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Open",
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error("inspector Open button not found");
  await page.waitForSelector(".cm-content", { timeout: 30_000 });
}

/// Type a marker at the top of the doc through the real editor.
async function typeAtTop(page, marker) {
  await page.bringToFront();
  await page.click(".cm-content");
  await page.keyboard.down("Control");
  await page.keyboard.press("Home");
  await page.keyboard.up("Control");
  await page.keyboard.type(`${marker} `, { delay: 10 });
}

async function waitForText(page, marker, timeoutMs = 20_000) {
  await page.bringToFront();
  await page.waitForFunction(
    (m) => {
      const el = document.querySelector(".cm-content");
      return el !== null && (el.textContent ?? "").includes(m);
    },
    { timeout: timeoutMs, polling: 250 },
    marker,
  );
}

export default {
  name: "editor-collab-regression",
  async run(ctx) {
    const { page, browser, serverUrl } = ctx;
    await openDoc(page);

    const page2 = await browser.newPage();
    try {
      await page2.goto(`${serverUrl}&w=smoke-editor-w2`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page2.waitForSelector(".pane", { timeout: 30_000 });
      await openDoc(page2);

      const markerA = `SMOKE-DOC-A-${Date.now()}`;
      await typeAtTop(page, markerA);
      await waitForText(page2, markerA);
      await ctx.shot("marker-a-on-client-b", page2);

      const markerB = `SMOKE-DOC-B-${Date.now()}`;
      await typeAtTop(page2, markerB);
      await waitForText(page, markerB);
      await ctx.shot("marker-b-on-client-a");

      return { markerA, markerB };
    } finally {
      if (!page2.isClosed()) await page2.close().catch(() => {});
    }
  },
};
