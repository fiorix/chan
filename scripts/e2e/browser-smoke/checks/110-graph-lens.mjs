// Workspace-search graph compatibility guard. Open the existing SPA graph
// through a real tag reference, proving the tag lens still uses /api/graph,
// renders a non-empty scoped canvas, and preserves the established view.

import { fileRow, navigateFiles, selectFile, showFiles } from "../lib/files.mjs";

const DOC = "doc.md";
const TAG = "#graph-smoke";

export default {
  name: "graph-lens",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    await showFiles(page);
    await navigateFiles(page, "");
    if (!(await fileRow(page, DOC))) ctx.skip(`graph fixture document not present: ${DOC}`);
    await selectFile(page, DOC, { details: true });

    // The lens button is this check's subject, not one of its preconditions.
    // Catching the wait and calling ctx.skip turned "the tag lens stopped
    // rendering", the regression this check exists to catch, into an absent
    // environment, and the suite printed ALL GREEN over it. Neighbour 111
    // awaits the identical predicate with no catch. The catch here only
    // renames the timeout after what was being waited for.
    try {
      await page.waitForFunction(
        (tag) =>
          [...document.querySelectorAll('button[title="open in graph (scoped to this tag)"]')]
            .some((button) => button.textContent?.trim() === tag),
        { timeout: 30_000, polling: 250 },
        TAG,
      );
    } catch (e) {
      throw new Error(
        `tag lens button never rendered for ${TAG} on ${DOC}: ${e.message}`,
      );
    }

    const opened = await page.evaluate((tag) => {
      const button = [
        ...document.querySelectorAll('button[title="open in graph (scoped to this tag)"]'),
      ].find((candidate) => candidate.textContent?.trim() === tag);
      if (!button) return false;
      button.click();
      return true;
    }, TAG);
    if (!opened) throw new Error(`tag lens button vanished: ${TAG}`);

    await page.waitForSelector(".graph-tab canvas", { timeout: 30_000 });
    await page.waitForFunction(
      (title) =>
        [...document.querySelectorAll(".tab")].some(
          (tab) => tab.textContent?.includes(title) && tab.classList.contains("active"),
        ),
      { timeout: 15_000, polling: 250 },
      `tag=${TAG}`,
    );
    const rendered = await page.waitForFunction(
      () => {
        const graph = document.querySelector(".graph-tab");
        const canvas = graph?.querySelector("canvas");
        const stat = graph?.querySelector(".statusbar .stat")?.textContent ?? "";
        const match = stat.match(/(\d+)\/(\d+) nodes\s+·\s+(\d+)\/(\d+) edges/);
        if (!canvas || !match || Number(match[1]) === 0) return false;
        return {
          width: canvas.width,
          height: canvas.height,
          visibleNodes: Number(match[1]),
          totalNodes: Number(match[2]),
          visibleEdges: Number(match[3]),
          totalEdges: Number(match[4]),
        };
      },
      { timeout: 30_000, polling: 250 },
    );
    const details = await rendered.jsonValue();
    if (details.width === 0 || details.height === 0) {
      throw new Error(`graph canvas has zero extent: ${details.width}x${details.height}`);
    }
    if (await page.$(".graph-tab .placeholder.error")) {
      throw new Error("tag lens rendered the graph error placeholder");
    }
    await ctx.shot("tag-graph-lens");
    return { lens: TAG, ...details };
  },
};
