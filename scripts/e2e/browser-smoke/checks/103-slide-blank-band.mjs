// A slide that begins after a page break must start at its heading:
// the blank separator lines around the break are page whitespace, not
// authored spacing, so no chan-slide-blank-line spacer band may render
// above the heading (it used to push the whole slide down ~50px under
// the default zoom). Interior blank runs keep their spacers; slide 3
// pins that the boundary fix did not eat them.

const DOC = "deck-blank.md";

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

async function slideState(page) {
  return page.evaluate(() => {
    const content = document.querySelector(".md-slide-preview-content");
    if (!content) return null;
    return {
      firstTag: content.firstElementChild?.tagName ?? null,
      firstText: content.firstElementChild?.textContent?.trim() ?? "",
      spacers: content.querySelectorAll(".chan-slide-blank-line").length,
    };
  });
}

export default {
  name: "slide-blank-band",
  async run(ctx) {
    const { page } = ctx;
    await openFile(page, DOC);

    // The overlay opens on the CARET's slide; pin the caret to the doc
    // start so the check always begins at slide 1.
    await page.click(".cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.press("Home");
    await page.keyboard.up("Control");
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await page.waitForSelector(".md-slide-preview-content", { timeout: 15_000 });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".md-slide-preview-counter")
          ?.textContent?.includes("1 / 3"),
      { timeout: 10_000, polling: 200 },
    );

    try {
      const first = await slideState(page);
      if (first?.firstTag !== "H1" || first.spacers !== 0) {
        await ctx.shot("slide-1");
        throw new Error(`slide 1 must open at its heading: ${JSON.stringify(first)}`);
      }

      // Slide 2 sits behind a break followed by TWO blank lines: the
      // exact pattern that used to render a spacer band above the H1.
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        () =>
          document
            .querySelector(".md-slide-preview-counter")
            ?.textContent?.includes("2 / 3"),
        { timeout: 10_000, polling: 200 },
      );
      const second = await slideState(page);
      if (second?.firstTag !== "H1" || second.spacers !== 0) {
        await ctx.shot("slide-2-band");
        throw new Error(
          `slide 2 must start at its heading with no spacer band: ${JSON.stringify(second)}`,
        );
      }

      // Slide 3 keeps its interior spacers (3 blanks -> 2 spacers).
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        () =>
          document
            .querySelector(".md-slide-preview-counter")
            ?.textContent?.includes("3 / 3"),
        { timeout: 10_000, polling: 200 },
      );
      const third = await slideState(page);
      if (third?.spacers !== 2) {
        await ctx.shot("slide-3-interior");
        throw new Error(
          `slide 3 must keep its 2 interior spacers: ${JSON.stringify(third)}`,
        );
      }
      return { second, third };
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
    }
  },
};
