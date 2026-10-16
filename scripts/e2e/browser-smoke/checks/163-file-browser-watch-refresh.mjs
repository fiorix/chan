import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { browserTab, request, showFileTree, waitFor } from "../lib/drafts.mjs";

const TAB = ".browser:not(.dock)";
const DOCK = ".browser.dock";

async function command(page, name) {
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: id } })), name);
}

async function row(page, surface, name) {
  for (const item of await page.$$(`${surface} [role=treeitem]`)) {
    const label = await item.$eval(".name", (node) => node.textContent?.trim() ?? "").catch(() => "");
    if (label === name || label === `${name}/`) return item;
  }
  return null;
}

/// The row in `surface` whose title, the full path the tree shows on hover with
/// any kind note after it, names `path`.
async function rowAt(page, surface, path) {
  for (const item of await page.$$(`${surface} [role=treeitem]`)) {
    const title = (await item.evaluate((node) => node.getAttribute("title") ?? "")).replace(/ \((contact|view-only)\)$/, "");
    if (title === path || title.endsWith(`/${path}`)) return item;
  }
  return null;
}

async function armDetector(page, surface, token) {
  await page.evaluate(({ surface, token }) => {
    const tree = document.querySelector(`${surface} [role=tree]`);
    const wrap = tree?.closest(".tree-wrap");
    if (!tree || !wrap) throw new Error(`no tree in ${surface}`);
    const maxScroll = wrap.scrollHeight - wrap.clientHeight;
    if (maxScroll <= 0) throw new Error("the tree is too short to test scroll preservation");
    wrap.scrollTop = Math.min(120, maxScroll);
    if (wrap.scrollTop <= 0) throw new Error("the tree did not take a non-zero scroll offset");
    const rows = [...tree.querySelectorAll("[role=treeitem]")].filter((item) => item.getClientRects().length > 0);
    const before = rows.map((item) => {
      item.__fbroot163 = token;
      return { item, title: item.getAttribute("title"), selected: item.getAttribute("aria-selected"), expanded: item.getAttribute("aria-expanded") };
    });
    const records = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(tree, { childList: true, subtree: true });
    window.__fbroot163 = { tree, wrap, before, records, observer, scrollTop: wrap.scrollTop, active: document.activeElement, token };
  }, { surface, token });
}

async function finishDetector(page, expectedAdded, expectNoRecords = false) {
  const result = await page.evaluate(() => {
    const state = window.__fbroot163;
    if (!state) throw new Error("the tree detector was not armed");
    state.observer.disconnect();
    delete window.__fbroot163;
    const now = [...state.tree.querySelectorAll("[role=treeitem]")];
    const missing = state.before.filter(({ item }) => !item.isConnected || !state.tree.contains(item)).map(({ title }) => title);
    const replaced = state.before.filter(({ item }) => item.isConnected && item.__fbroot163 !== state.token).map(({ title }) => title);
    const changed = state.before.filter(({ item, selected, expanded }) =>
      item.isConnected && (item.getAttribute("aria-selected") !== selected || item.getAttribute("aria-expanded") !== expanded),
    ).map(({ title }) => title);
    const countRows = (nodes) => nodes.reduce((sum, node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return sum;
      return sum + (node.matches("[role=treeitem]") ? 1 : 0) + node.querySelectorAll("[role=treeitem]").length;
    }, 0);
    const added = state.records.reduce((sum, record) => sum + countRows([...record.addedNodes]), 0);
    const removed = state.records.reduce((sum, record) => sum + countRows([...record.removedNodes]), 0);
    return { added, removed, records: state.records.length, missing, replaced, changed,
      scrollBefore: state.scrollTop, scrollAfter: state.wrap.scrollTop, activeSame: state.active === document.activeElement,
      retained: state.before.filter(({ item }) => now.includes(item)).length };
  });
  if (result.missing.length || result.replaced.length || result.changed.length || !result.activeSame ||
      result.scrollBefore <= 0 || result.scrollAfter !== result.scrollBefore || result.added !== expectedAdded || result.removed !== 0 ||
      (expectNoRecords && result.records !== 0)) {
    throw new Error(`file tree flickered: ${JSON.stringify(result)}`);
  }
  return result;
}

async function settlePaint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export default {
  name: "file-browser-watch-refresh",
  async run(ctx) {
    const { page } = ctx;
    const stamp = Date.now().toString(36);
    const prefix = `fbroot163-${stamp}`;
    const folder = `${prefix}-folder`;
    const unseen = `${prefix}-unseen`;
    const nested = `${prefix}-nested.md`;
    const rootSelected = `${prefix}-selected.md`;
    const rootClear = `${prefix}-clear.md`;
    const rootHidden = `${prefix}-hidden.md`;
    const rootDock = `${prefix}-dock.md`;
    const renamed = `${prefix}-renamed`;
    const afterRemoval = `${prefix}-after-removal.md`;
    const filler = Array.from({ length: 80 }, (_, index) => `${prefix}-fill-${String(index).padStart(2, "0")}.md`);
    const files = [...filler, rootSelected, rootClear, rootHidden, rootDock];
    const cdp = await page.target().createCDPSession();
    const frames = [];
    const listings = [];
    const completedListings = [];
    const workspaceResponses = [];
    // The filesystem frames and the shared graph's fetches, both stamped by
    // the browser's network clock (CDP's monotonic seconds).
    const frameStamps = [];
    const graphStarts = [];
    const graphSteps = [];
    let openedLeftDock = false;
    cdp.on("Network.webSocketFrameReceived", ({ response, timestamp }) => {
      try {
        const frame = JSON.parse(response.payloadData);
        if (frame.type === "watch" || frame.type === "fs") {
          frames.push(frame);
          frameStamps.push(timestamp);
        }
      } catch { /* Other socket traffic is not a filesystem frame. */ }
    });
    cdp.on("Network.requestWillBeSent", ({ request, timestamp }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/graph")) graphStarts.push(timestamp);
      if (url.pathname.endsWith("/api/fs") && url.searchParams.has("dir")) listings.push({ dir: url.searchParams.get("dir"), at: Date.now() });
    });
    cdp.on("Network.responseReceived", ({ response }) => {
      const url = new URL(response.url);
      if (url.pathname.endsWith("/api/workspace")) workspaceResponses.push(Date.now());
      if (url.pathname.endsWith("/api/fs") && url.searchParams.has("dir")) completedListings.push(url.searchParams.get("dir"));
    });
    await cdp.send("Network.enable");
    const awaitFrame = async (type, path, from) => waitFor(`${type} frame for ${path}`, 20_000,
      () => frames.slice(from).find((frame) => frame.type === type && frame.event?.path === path));
    const rootListingsSince = (from) => listings.slice(from).filter(({ dir }) => dir === "").length;
    // A step of the arm: one change made outside chan and the frames it
    // brings. With a File Browser open the store fetches the shared graph
    // once the frames have been quiet for 250 ms, so a step ends only when a
    // fetch has started after its last frame, and each fetch is its step's.
    const graphStep = (label) => {
      const step = { label, frameAt: frameStamps.length, graphAt: graphStarts.length };
      graphSteps.push(step);
      return step;
    };
    const graphFetched = (step) => waitFor(`the shared graph's fetch after the frames of ${step.label}`, 20_000, () => {
      const last = frameStamps.slice(step.frameAt).at(-1);
      return last !== undefined && graphStarts.slice(step.graphAt).some((at) => at > last);
    });
    const created = async (name, surface) => {
      const frameAt = frames.length;
      const listAt = listings.length;
      const start = Date.now();
      const step = graphStep(`created ${name}`);
      writeFileSync(join(ctx.workspaceDir, name), `outside chan ${name}\n`);
      await awaitFrame("watch", name, frameAt);
      try {
        await waitFor(`${name} in ${surface}`, 20_000, () => row(page, surface, name));
      } catch {
        throw new Error(`root row ${name} missing after its watch frame in ${surface}`);
      }
      const report = { name, elapsedMs: Date.now() - start, rootListings: rootListingsSince(listAt) };
      console.log(`[fbroot163] ${JSON.stringify(report)}`);
      await graphFetched(step);
      return report;
    };
    const report = { engine: await page.evaluate(() => navigator.userAgent), created: [] };
    try {
      mkdirSync(join(ctx.workspaceDir, folder));
      mkdirSync(join(ctx.workspaceDir, unseen));
      writeFileSync(join(ctx.workspaceDir, folder, nested), "nested\n");
      for (const name of filler) writeFileSync(join(ctx.workspaceDir, name), "fill\n");

      await showFileTree(page);
      const folderRow = await waitFor(`folder ${folder}`, 20_000, () => row(page, TAB, folder));
      await (await folderRow.$("button.twirl")).click();
      const nestedRow = await waitFor(`nested row ${nested}`, 20_000, () => row(page, TAB, nested));
      await (await nestedRow.$(".name")).click();
      await page.waitForFunction((name, surface) => [...document.querySelectorAll(`${surface} [role=treeitem][aria-selected=true] .name`)]
        .some((item) => item.textContent?.trim() === name), { timeout: 5_000 }, nested, TAB);

      await settlePaint(page);
      await armDetector(page, TAB, `${prefix}-created`);
      report.created.push(await created(rootSelected, TAB));
      report.createdDetector = await finishDetector(page, 1);

      await armDetector(page, TAB, `${prefix}-modified`);
      const modifiedFrameAt = frames.length;
      const modifiedListAt = listings.length;
      const modifiedDoneAt = completedListings.length;
      const modifiedRootInFlight = rootListingsSince(0) - completedListings.filter((dir) => dir === "").length;
      const modifiedWorkspaceAt = workspaceResponses.length;
      const modifiedStep = graphStep("modified");
      writeFileSync(join(ctx.workspaceDir, rootSelected), "modified outside chan\n");
      await awaitFrame("watch", rootSelected, modifiedFrameAt);
      await waitFor("root listing after modification", 20_000, () => rootListingsSince(modifiedListAt) > 0);
      await waitFor("completed root listing after modification", 20_000,
        () => completedListings.slice(modifiedDoneAt).filter((dir) => dir === "").length >= modifiedRootInFlight + rootListingsSince(modifiedListAt));
      await waitFor("workspace refresh after modification", 20_000, () => workspaceResponses.length > modifiedWorkspaceAt);
      await settlePaint(page);
      report.modifiedDetector = await finishDetector(page, 0, true);
      await graphFetched(modifiedStep);

      await armDetector(page, TAB, `${prefix}-unrelated`);
      const unrelatedFrameAt = frames.length;
      const unrelatedListAt = listings.length;
      const unrelatedWorkspaceAt = workspaceResponses.length;
      const unseenFile = `${prefix}-inside.md`;
      const unrelatedStep = graphStep("unopened directory");
      writeFileSync(join(ctx.workspaceDir, unseen, unseenFile), "unseen\n");
      await awaitFrame("watch", `${unseen}/${unseenFile}`, unrelatedFrameAt);
      await waitFor("workspace refresh after unopened-directory frame", 20_000,
        () => workspaceResponses.length > unrelatedWorkspaceAt);
      await settlePaint(page);
      if (rootListingsSince(unrelatedListAt) !== 0 || listings.length !== unrelatedListAt) {
        throw new Error(`unopened directory caused a listing: ${JSON.stringify(listings.slice(unrelatedListAt))}`);
      }
      if (await row(page, TAB, unseenFile)) throw new Error("unopened directory's file was rendered before expansion");
      report.unrelatedDetector = await finishDetector(page, 0, true);
      await graphFetched(unrelatedStep);
      const unseenRow = await row(page, TAB, unseen);
      await (await unseenRow.$("button.twirl")).click();
      await waitFor(`file ${unseenFile} after expansion`, 20_000, () => row(page, TAB, unseenFile));
      if (!listings.slice(unrelatedListAt).some(({ dir }) => dir === unseen)) {
        throw new Error("the listing counter missed expansion's request");
      }
      report.expansionListings = listings.length - unrelatedListAt;

      await page.keyboard.down("Control");
      try { await (await (await row(page, TAB, nested)).$(".name")).click(); }
      finally { await page.keyboard.up("Control"); }
      await page.waitForFunction((surface) => !document.querySelector(`${surface} [role=treeitem][aria-selected=true]`), { timeout: 5_000 }, TAB);
      report.created.push(await created(rootClear, TAB));

      await (await (await row(page, TAB, nested)).$(".name")).click();
      await command(page, "app.dashboard.open");
      await page.waitForFunction(() => !document.querySelector(".tabs .tab.active .lucide-folder"), { timeout: 10_000 });
      const hiddenFrameAt = frames.length;
      const hiddenListAt = listings.length;
      const hiddenStart = Date.now();
      const hiddenStep = graphStep("hidden tab");
      writeFileSync(join(ctx.workspaceDir, rootHidden), "hidden outside chan\n");
      await awaitFrame("watch", rootHidden, hiddenFrameAt);
      await (await browserTab(page)).click();
      await waitFor(`hidden-tab root row ${rootHidden}`, 20_000, () => row(page, TAB, rootHidden));
      const hiddenReport = { name: rootHidden, elapsedMs: Date.now() - hiddenStart, rootListings: rootListingsSince(hiddenListAt) };
      console.log(`[fbroot163] ${JSON.stringify(hiddenReport)}`);
      report.created.push(hiddenReport);
      await graphFetched(hiddenStep);

      if (!(await page.$(`${DOCK} [role=tree]`))) {
        await page.$eval(TAB, (surface) => surface.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, clientX: 200, clientY: 200,
        })));
        const stick = await waitFor("Stick to left menu action", 10_000, async () => {
          for (const button of await page.$$("button[role=menuitem]")) {
            if ((await button.evaluate((node) => node.textContent?.trim())) === "Stick to left") return button;
          }
          return null;
        });
        await stick.click();
        openedLeftDock = true;
      }
      await page.waitForSelector(`${DOCK} [role=tree]`, { timeout: 15_000 });
      const dockFolder = await waitFor(`dock folder ${folder}`, 20_000, () => row(page, DOCK, folder));
      if ((await dockFolder.evaluate((item) => item.getAttribute("aria-expanded"))) !== "true") {
        await (await dockFolder.$("button.twirl")).click();
      }
      const dockNested = await waitFor(`dock nested row ${nested}`, 20_000, () => row(page, DOCK, nested));
      await (await dockNested.$(".name")).click();
      await page.waitForFunction((name, surface) => [...document.querySelectorAll(`${surface} [role=treeitem][aria-selected=true] .name`)]
        .some((item) => item.textContent?.trim() === name), { timeout: 5_000 }, nested, DOCK);
      report.created.push(await created(rootDock, DOCK));
      // The dock expands the directory the rename takes too, so its child has
      // a row there for the rename to leave behind.
      const dockUnseen = await waitFor(`dock directory ${unseen}`, 20_000, () => row(page, DOCK, unseen));
      if ((await dockUnseen.evaluate((item) => item.getAttribute("aria-expanded"))) !== "true") {
        await (await dockUnseen.$("button.twirl")).click();
      }
      await waitFor(`dock row ${unseen}/${unseenFile}`, 20_000, () => rowAt(page, DOCK, `${unseen}/${unseenFile}`));

      // A loaded, expanded directory renamed outside chan, and one removed,
      // leave the tree with their cached rows. Each waits on a row that only a
      // root listing answering after the change brings, then reads the old
      // paths' rows in the tab's tree and the dock's; both readings are taken
      // before either is judged.
      await (await browserTab(page)).click();
      await page.waitForSelector(`${TAB} [role=tree]`, { timeout: 15_000 });
      const renamedFrameAt = frames.length;
      const renameStep = graphStep("rename");
      renameSync(join(ctx.workspaceDir, unseen), join(ctx.workspaceDir, renamed));
      await awaitFrame("watch", unseen, renamedFrameAt);
      await waitFor(`renamed row ${renamed} in ${TAB}`, 20_000, () => row(page, TAB, renamed));
      await settlePaint(page);
      const leftAt = async (paths) => Object.fromEntries(await Promise.all(Object.entries(paths).flatMap(([key, path]) => [
        rowAt(page, TAB, path).then((item) => [key, Boolean(item)]),
        rowAt(page, DOCK, path).then((item) => [`dock-${key}`, Boolean(item)]),
      ])));
      const renamedLeft = await leftAt({ oldName: unseen, oldChild: `${unseen}/${unseenFile}` });
      console.log(`[fbroot163] ${JSON.stringify({ renamedLeft })}`);
      await graphFetched(renameStep);
      const removedFrameAt = frames.length;
      const removalStep = graphStep("removal");
      rmSync(join(ctx.workspaceDir, folder), { recursive: true, force: true });
      writeFileSync(join(ctx.workspaceDir, afterRemoval), "after the removal\n");
      await awaitFrame("watch", folder, removedFrameAt);
      await waitFor(`row ${afterRemoval} in ${TAB}`, 20_000, () => row(page, TAB, afterRemoval));
      await settlePaint(page);
      const removedLeft = await leftAt({ folder, nested: `${folder}/${nested}` });
      report.leftTree = { renamed: renamedLeft, removed: removedLeft };
      if ([...Object.values(renamedLeft), ...Object.values(removedLeft)].some(Boolean)) {
        throw new Error(`a directory that left kept its cached rows: ${JSON.stringify(report.leftTree)}`);
      }
      await graphFetched(removalStep);
      // Each step fetches the shared graph once or twice, and its last fetch
      // starts at least 200 ms after its last frame. Only the last is judged:
      // a frame still on its way to the page, or queued behind the quiet
      // timer's task, when the timer fires yields a fetch a few milliseconds
      // after that frame's stamp, and the late frame's own fetch is then the
      // step's last.
      report.graph = graphSteps.map((step, index) => {
        const next = graphSteps[index + 1];
        const stamps = frameStamps.slice(step.frameAt, next?.frameAt);
        const fetches = graphStarts.slice(step.graphAt, next?.graphAt);
        return {
          step: step.label, frames: stamps.length, fetches: fetches.length,
          lastGapMs: stamps.length && fetches.length ? Math.round((fetches.at(-1) - stamps.at(-1)) * 1000) : null,
        };
      });
      console.log(`[fbroot163] ${JSON.stringify({ graph: report.graph })}`);
      const fetchedInBurst = report.graph.filter(({ fetches, lastGapMs }) => fetches < 1 || fetches > 2 || lastGapMs === null || lastGapMs < 200);
      if (fetchedInBurst.length) {
        throw new Error(`the shared graph was fetched inside a burst or more than twice for one: ${JSON.stringify(fetchedInBurst)}`);
      }
      // That race is one step's accident. A page that fetches twice for every
      // burst passes each step, and holds two fetches in every step, or in all
      // but one when its second fetch lands after the next step's mark.
      const twoFetchSteps = report.graph.filter(({ fetches }) => fetches === 2);
      if (twoFetchSteps.length > 3) {
        throw new Error(`the shared graph was fetched twice for ${twoFetchSteps.length} of ${report.graph.length} bursts, more than the race allows: ${JSON.stringify(report.graph)}`);
      }
      return report;
    } finally {
      try {
        if (openedLeftDock) {
          const dockState = async (open) => {
            const config = await request(ctx, "/api/config");
            if (config.status !== 200) throw new Error(`GET /api/config -> ${config.status}`);
            return config.json?.preferences?.browser_side_panes?.left === open && Boolean(await page.$(DOCK)) === open;
          };
          try {
            await waitFor("left dock persisted open", 15_000, () => dockState(true));
          } finally {
            await page.$eval(DOCK, (surface) => surface.dispatchEvent(new MouseEvent("contextmenu", {
              bubbles: true, cancelable: true, clientX: 200, clientY: 200,
            })));
            const unstick = await waitFor("Unstick left menu action", 10_000, async () => {
              for (const button of await page.$$("button[role=menuitem]")) {
                if ((await button.evaluate((node) => node.textContent?.trim())) === "Unstick left") return button;
              }
              return null;
            });
            await unstick.click();
            await waitFor("left dock restored in config and DOM", 15_000, () => dockState(false));
          }
        }
      } finally {
        await page.evaluate(() => { window.__fbroot163?.observer.disconnect(); delete window.__fbroot163; }).catch(() => {});
        await cdp.detach().catch(() => {});
        rmSync(join(ctx.workspaceDir, folder), { recursive: true, force: true });
        rmSync(join(ctx.workspaceDir, unseen), { recursive: true, force: true });
        rmSync(join(ctx.workspaceDir, renamed), { recursive: true, force: true });
        for (const name of [...files, afterRemoval]) rmSync(join(ctx.workspaceDir, name), { force: true });
      }
    }
  },
};
