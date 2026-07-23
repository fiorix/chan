// An errored mermaid block's face is click-through to the failing
// source line. CM6 otherwise maps widget clicks to the nearest fence
// edge, which made the blamed line unreachable by mouse (and ArrowUp
// from the invisible opener landing exited above the diagram). The
// guard: click the echoed error row, assert the caret landed ON the
// blamed line by typing a marker there, then ArrowUp must stay inside
// the block.

const DOC = "mermaid-err.md";
const BLAMED = "B -->|no| D[Bad; label, x] - E";
const LINE_ABOVE = "A --> B";

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

async function lineWithMarker(page, text, marker) {
  return page.evaluate(
    ({ text, marker }) =>
      [...document.querySelectorAll(".cm-line")].some(
        (l) => l.textContent?.includes(text) && l.textContent?.includes(marker),
      ),
    { text, marker },
  );
}

export default {
  name: "mermaid-error-nav",
  async run(ctx) {
    const { page } = ctx;
    await openFile(page, DOC);

    // The renderer fails async; the face carries the echoed source row.
    await page.waitForSelector(".cm-md-diagram-error-src", { timeout: 30_000 });

    const rect = await page.evaluate(() => {
      const el = document.querySelector(".cm-md-diagram-error-src");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!rect) throw new Error("error-src row vanished before the click");
    await page.mouse.click(rect.x, rect.y);

    // The click de-renders the block and lands the caret on the blamed
    // line; a typed marker proves the landing in user-visible terms.
    await page.waitForFunction(
      () => !document.querySelector(".cm-md-diagram-rendered"),
      { timeout: 15_000, polling: 200 },
    );
    await page.keyboard.press("End");
    await page.keyboard.type(" %HIT%", { delay: 10 });
    if (!(await lineWithMarker(page, "D[Bad", "%HIT%"))) {
      await ctx.shot("landed-elsewhere");
      throw new Error("click on the error row did not land the caret on the blamed line");
    }

    // ArrowUp stays inside the block (the old behavior exited above the
    // opener because the caret invisibly sat at the block start).
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.type(" %UP%", { delay: 10 });
    if (!(await lineWithMarker(page, LINE_ABOVE, "%UP%"))) {
      await ctx.shot("arrowup-escaped");
      throw new Error("ArrowUp from the blamed line left the code block");
    }

    return { blamed: BLAMED };
  },
};
