// Clicking the heading after a table must place the caret ON that
// heading. Rendered tables are CM6 block widgets; a vertical margin on
// the widget root shifts the height map short of the visual layout, so
// clicks below tables used to resolve one or more blocks too far down
// (and could collapse the next table into pipe source). The guard: on a
// doc with four table+heading pairs, click each heading mid-line, type
// a marker, and assert the marker landed on that heading's line while
// every table stayed rendered.

const DOC = "tables.md";
const TABLES = 4;

async function openFile(page, filename) {
  await page.bringToFront();
  if (!(await page.$(".file-tree, [role=tree]"))) {
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } }),
      );
    });
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
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
    { timeout: 15_000, polling: 200 },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Open")
      ?.click();
  });
  await page.waitForSelector(".cm-content", { timeout: 30_000 });
}

export default {
  name: "table-click-heading",
  async run(ctx) {
    const { page } = ctx;
    await openFile(page, DOC);
    await page.waitForFunction(
      (n) => document.querySelectorAll(".cm-md-table-wrap").length === n,
      { timeout: 30_000, polling: 250 },
      TABLES,
    );

    for (let i = 0; i < TABLES; i++) {
      const heading = `Head ${i}`;
      const rect = await page.evaluate((text) => {
        const line = [...document.querySelectorAll(".cm-line")].find(
          (l) => l.textContent?.trim() === text,
        );
        if (!line) return null;
        const r = line.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, heading);
      if (!rect) throw new Error(`heading line not found in DOM: ${heading}`);

      // Mid-line vertical band: exactly where the drift used to resolve
      // into the following paragraph or the next table's range.
      await page.mouse.click(rect.x + 40, rect.y + rect.height / 2);
      await page.keyboard.press("End");
      const marker = `-OK${i}`;
      await page.keyboard.type(marker, { delay: 10 });

      const landed = await page.evaluate(
        ({ text, marker }) =>
          [...document.querySelectorAll(".cm-line")].some(
            (l) => l.textContent?.includes(text) && l.textContent?.includes(marker),
          ),
        { text: heading, marker },
      );
      if (!landed) {
        await ctx.shot(`miss-${i}`);
        throw new Error(`click on "${heading}" did not land on it (marker ${marker} elsewhere)`);
      }

      const wraps = await page.evaluate(
        () => document.querySelectorAll(".cm-md-table-wrap").length,
      );
      if (wraps !== TABLES) {
        await ctx.shot(`collapsed-${i}`);
        throw new Error(
          `click on "${heading}" collapsed a table widget (${wraps}/${TABLES} rendered)`,
        );
      }
    }
    return { headingsVerified: TABLES };
  },
};
