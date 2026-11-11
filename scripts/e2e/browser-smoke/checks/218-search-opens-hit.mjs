// A search hit opens what it found: a content hit opens its file in the
// editor, a tag hit opens the tag's graph.
//
// Engine: headless Chrome through puppeteer-core; the result names the
// browser's version. It says nothing about WebKit.
//
// In a window of its own, a document holding a token found nowhere else is
// written to the workspace (its name does not hold the token), and the check
// waits until the server's content search answers the token with it, so the
// index is ready before the panel is asked. The Search panel
// (app.search.toggle) is given the token by typing; the document's hit must
// be the first row and the active one, and Enter must close the panel and
// leave an editor tab on that path, holding the token. The panel is then given
// the seed document's tag, `#graph-smoke`; its tag row must be the first row,
// and a double-click on it must open the tag-scoped graph tab, drawn as check
// 110 reads it: a canvas with extent, a status line counting visible nodes,
// and no error placeholder. Enter and the double-click are the panel's two
// ways to open a row; a single click only selects.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "../lib/drafts.mjs";

const RUN = Date.now().toString(36);
const PANEL = '[role="dialog"][aria-label="Search"]';
const TAG = "#graph-smoke";

const command = (page, name) =>
  page.evaluate((id) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: id } })), name);

/// The panel's rows as drawn: each row's label and whether it is active.
function readRows(page) {
  return page.evaluate((panel) =>
    [...document.querySelectorAll(`${panel} .hits li`)].map((li) => ({
      label: li.querySelector(".row1 .path")?.textContent?.trim() ?? "",
      active: li.getAttribute("data-active") === "true",
    })), PANEL);
}

async function openPanelWith(page, query) {
  await command(page, "app.search.toggle");
  await page.waitForSelector(`${PANEL} .search input`, { visible: true, timeout: 15_000 });
  await page.click(`${PANEL} .search input`, { count: 3 });
  await page.keyboard.press("Backspace");
  await page.type(`${PANEL} .search input`, query);
}

/// Wait for `label` to be the first row and the active one.
async function waitFirstRow(page, label, what) {
  let rows = [];
  await waitFor(`${what} as the first, active row`, 30_000, async () => {
    rows = await readRows(page);
    return rows[0]?.label === label && rows[0].active ? rows : null;
  }).catch((error) => {
    throw new Error(`${error.message}; the panel lists ${JSON.stringify(rows.slice(0, 8))}`);
  });
  return rows;
}

function activeTabTitle(page) {
  return page.evaluate(() => document.querySelector(".tabs .tab.active")?.getAttribute("title") ?? "");
}

export default {
  name: "search-opens-hit",
  async run(ctx) {
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const seedDoc = readFileSync(join(ctx.workspaceDir, "doc.md"), "utf8");
    if (!seedDoc.includes(TAG)) throw new Error(`the seed document doc.md no longer carries ${TAG}`);
    const word = `zq218${RUN}`;
    const dir = `smoke-search-${RUN}`;
    const doc = `${dir}/notes.md`;
    const page = await ctx.browser.newPage();
    const result = { browser: await ctx.browser.browser().version(), doc, word };
    let primary = null;
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.bringToFront();
      mkdirSync(join(ctx.workspaceDir, dir));
      writeFileSync(join(ctx.workspaceDir, doc), `# Search smoke\n\nThe word ${word} appears in this document only.\n`);
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", `search-218-${RUN}`);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });

      // The index answers the word with the new document before the panel is asked.
      const indexed = Date.now();
      result.searchAnswer = await waitFor("the content search answering the word with the document", 60_000, () =>
        page.evaluate(async ({ authToken, q, path }) => {
          const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
          const response = await fetch(`/api/search/content?q=${encodeURIComponent(q)}`, { headers });
          if (!response.ok) return null;
          const hits = (await response.json()).hits ?? [];
          return hits.some((hit) => hit.path === path) ? hits.map((hit) => hit.path) : null;
        }, { authToken: token, q: word, path: doc }));
      result.indexedAfterMs = Date.now() - indexed;

      // A content hit, opened by Enter.
      await openPanelWith(page, word);
      result.contentRows = await waitFirstRow(page, doc, `the hit on ${doc}`);
      await ctx.shot("218-content-hit", page);
      await page.keyboard.press("Enter");
      await page.waitForSelector(PANEL, { hidden: true, timeout: 10_000 });
      await waitFor(`an editor tab on ${doc} holding the word`, 20_000, async () =>
        (await activeTabTitle(page)) === doc &&
        page.evaluate((w) => (document.querySelector(".editor-tab.active .cm-content")?.textContent ?? "").includes(w), word),
      ).catch(async (error) => {
        throw new Error(`${error.message}; the active tab is ${JSON.stringify(await activeTabTitle(page))}`);
      });
      await ctx.shot("218-content-opened", page);

      // A tag hit, opened by a double-click.
      await openPanelWith(page, TAG);
      result.tagRows = await waitFirstRow(page, TAG, `the tag row ${TAG}`);
      await ctx.shot("218-tag-hit", page);
      const row = await page.$(`${PANEL} .hits li[data-active="true"]`);
      await row.click({ count: 2 });
      await page.waitForSelector(PANEL, { hidden: true, timeout: 10_000 });
      await page.waitForSelector(".graph-tab canvas", { timeout: 30_000 });
      await waitFor(`the graph tab tag=${TAG} active`, 15_000, () =>
        page.evaluate((title) => [...document.querySelectorAll(".tab.active")].some((tab) => tab.textContent?.includes(title)), `tag=${TAG}`),
      );
      const graph = await page.waitForFunction(() => {
        const host = document.querySelector(".graph-tab");
        const canvas = host?.querySelector("canvas");
        const stat = host?.querySelector(".statusbar .stat")?.textContent ?? "";
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
      }, { timeout: 30_000, polling: 250 }).then((handle) => handle.jsonValue());
      if (graph.width === 0 || graph.height === 0) throw new Error(`the tag graph's canvas has no extent: ${graph.width}x${graph.height}`);
      if (await page.$(".graph-tab .placeholder.error")) throw new Error("the tag graph drew its error placeholder");
      result.graph = graph;
      await ctx.shot("218-tag-graph", page);
      console.log(`[smoke]   ${result.browser}; indexed after ${result.indexedAfterMs}ms; content rows ${JSON.stringify(result.contentRows.slice(0, 3))}; tag rows ${JSON.stringify(result.tagRows.slice(0, 3))}; graph ${JSON.stringify(graph)}`);
      return result;
    } catch (error) {
      primary = error;
      await ctx.shot("218-failure", page).catch(() => {});
      throw error;
    } finally {
      try {
        if (await page.$(PANEL)) await page.keyboard.press("Escape");
        for (let i = 0; i < 2; i++) await command(page, "app.tab.close");
        await page.close();
      } catch (error) {
        if (primary) console.log(`[smoke]   cleanup also failed: ${error?.message ?? error}`);
        else throw error;
      } finally {
        rmSync(join(ctx.workspaceDir, dir), { recursive: true, force: true });
      }
    }
  },
};
