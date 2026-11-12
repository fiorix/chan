// The graph opened from a tag of a document's Details. There is one graph,
// rooted at the workspace, and the tag is a selection in it: the tab is
// titled after the tag, its canvas has extent, its status line counts the
// nodes it shows and no error placeholder is drawn.
//
// Once its layout settles, the graph is framed from its root: every node the
// status line counts is painted inside the canvas, and the workspace's node
// sits halfway across, near the bottom edge, read from the node discs the
// canvas paints (lib/graph-discs.mjs). A resize of the page refits it the
// same way. Engine: headless Chrome through puppeteer-core.

import { fileRow, navigateFiles, selectFile, showFiles } from "../lib/files.mjs";
import { rootedFailures, steadyGraphDiscs, traceGraphDiscs, untraceGraphDiscs } from "../lib/graph-discs.mjs";

const GRAPH = ".graph-tab";

const DOC = "doc.md";
const TAG = "#graph-smoke";
/// The tag's button among a document's Details.
const TAG_BUTTON = "button.ref.tag";

export default {
  name: "graph-selection",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    await showFiles(page);
    await navigateFiles(page, "");
    if (!(await fileRow(page, DOC))) ctx.skip(`graph fixture document not present: ${DOC}`);
    await selectFile(page, DOC, { details: true });

    // The tag's button is this check's subject, not one of its preconditions.
    // Catching the wait and calling ctx.skip turned "the tag stopped
    // rendering", the regression this check exists to catch, into an absent
    // environment, and the suite printed ALL GREEN over it. Neighbour 111
    // awaits the identical predicate with no catch. The catch here only
    // renames the timeout after what was being waited for.
    try {
      await page.waitForFunction(
        ({ selector, tag }) =>
          [...document.querySelectorAll(selector)].some((button) => button.textContent?.trim() === tag),
        { timeout: 30_000, polling: 250 },
        { selector: TAG_BUTTON, tag: TAG },
      );
    } catch (e) {
      throw new Error(
        `tag button never rendered for ${TAG} on ${DOC}: ${e.message}`,
      );
    }

    await traceGraphDiscs(page, GRAPH);
    try {
      return await openAndRead(ctx, page);
    } finally {
      await untraceGraphDiscs(page);
    }
  },
};

async function openAndRead(ctx, page) {
  const opened = await page.evaluate(({ selector, tag }) => {
    const button = [...document.querySelectorAll(selector)].find(
      (candidate) => candidate.textContent?.trim() === tag,
    );
    if (!button) return false;
    button.click();
    return true;
  }, { selector: TAG_BUTTON, tag: TAG });
  if (!opened) throw new Error(`tag button vanished: ${TAG}`);

  await page.waitForSelector(".graph-tab canvas", { timeout: 30_000 });
  await page.waitForFunction(
    (title) =>
      [...document.querySelectorAll(".tab")].some(
        (tab) => tab.textContent?.includes(title) && tab.classList.contains("active"),
      ),
    { timeout: 15_000, polling: 250 },
    `path=${TAG}`,
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
    throw new Error("the graph opened on the tag rendered its error placeholder");
  }
  const framed = await steadyGraphDiscs(page, GRAPH);
  await ctx.shot("graph-tag-selected");
  const failures = rootedFailures(framed, details.visibleNodes);
  if (failures.length) {
    throw new Error(`the graph opened on the tag is not framed from its root: ${failures.join("; ")}; ${JSON.stringify(framed)}`);
  }

  // A resize refits it. The page is the runner's shared one, so its size
  // goes back afterwards.
  const before = page.viewport() ?? { width: 1280, height: 800 };
  const size = before.width === 900 ? { width: 1100, height: 640 } : { width: 900, height: 640 };
  let resized;
  try {
    await page.setViewport({ ...before, ...size });
    resized = await steadyGraphDiscs(page, GRAPH);
    await ctx.shot("graph-tag-selected-resized");
  } finally {
    await page.setViewport(before);
  }
  const resizedFailures = rootedFailures(resized, details.visibleNodes);
  if (resized.canvas[0] === framed.canvas[0]) resizedFailures.push(`the canvas kept its width ${framed.canvas[0]} through the resize`);
  if (resizedFailures.length) {
    throw new Error(`the graph opened on the tag is not framed from its root after a resize to ${size.width}x${size.height}: ${resizedFailures.join("; ")}; ${JSON.stringify(resized)}`);
  }
  console.log(`[smoke]   graph on ${TAG} framed ${JSON.stringify(framed)}; after the resize ${JSON.stringify(resized)}`);
  return { selected: TAG, ...details, framed, resized };
}
