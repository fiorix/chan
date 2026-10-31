// Item 7 regression guard: the editor doc-collab path still converges
// with scene sessions in the tree (the tabs delegate slots are shared
// infrastructure). Two clients on one markdown doc: text typed on each
// side lands in the other's editor through the doc session, no PUT.

import { openFile } from "../lib/files.mjs";

const DOC = "doc.md";

async function openDoc(page) {
  await openFile(page, DOC);
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
