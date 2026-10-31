import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { request, waitFor } from "../lib/drafts.mjs";
import { FILE_LIST, fileRow, navigateFiles, readFiles, showFiles } from "../lib/files.mjs";

const TAB = FILE_LIST;
const DOCK = '[role="tree"][aria-label="Files"]';

async function command(page, name) {
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: id } })), name);
}

async function row(page, surface, name) {
  if (surface === TAB) return fileRow(page, name);
  await page.waitForSelector(surface, { visible: true, timeout: 15_000 });
  for (const item of await page.$$(`${surface} [role="treeitem"]`)) {
    const label = await item.$eval('button:not([aria-label]), [role="button"]', (node) => node.textContent?.trim() ?? "").catch(() => "");
    if (label === name || label === `${name}/`) return item;
  }
  return null;
}

/// The row in `surface` whose hover title names `path`, excluding its optional kind note.
async function rowAt(page, surface, path) {
  await page.waitForSelector(surface, { visible: true, timeout: 15_000 });
  const role = surface === TAB ? "option" : "treeitem";
  for (const item of await page.$$(`${surface} [role="${role}"]`)) {
    const title = (await item.evaluate((node) => node.getAttribute("title") ?? "")).replace(/ \((contact|view-only)\)$/, "");
    if (title === path || title.endsWith(`/${path}`)) return item;
  }
  return null;
}

async function armDetector(page, surface, token) {
  await page.evaluate(({ surface, token }) => {
    const tree = document.querySelector(surface);
    const wrap = tree?.parentElement;
    if (!tree || !wrap) throw new Error(`no file listing in ${surface}`);
    const rowSelector = tree.getAttribute("role") === "listbox" ? '[role="option"]' : '[role="treeitem"]';
    const maxScroll = wrap.scrollHeight - wrap.clientHeight;
    if (maxScroll <= 0) throw new Error("the file listing is too short to test scroll preservation");
    wrap.scrollTop = Math.min(120, maxScroll);
    if (wrap.scrollTop <= 0) throw new Error("the file listing did not take a non-zero scroll offset");
    const rows = [...tree.querySelectorAll(rowSelector)].filter((item) => item.getClientRects().length > 0);
    const before = rows.map((item) => {
      item.__fbroot163 = token;
      return { item, title: item.getAttribute("title"), selected: item.getAttribute("aria-selected"), expanded: item.getAttribute("aria-expanded") };
    });
    const records = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(tree, { childList: true, subtree: true });
    window.__fbroot163 = { tree, wrap, rowSelector, before, records, observer, scrollTop: wrap.scrollTop, active: document.activeElement, token };
  }, { surface, token });
}

async function finishDetector(page, expectedAdded, expectNoRecords = false) {
  const result = await page.evaluate(() => {
    const state = window.__fbroot163;
    if (!state) throw new Error("the file listing detector was not armed");
    state.observer.disconnect();
    delete window.__fbroot163;
    const now = [...state.tree.querySelectorAll(state.rowSelector)];
    const missing = state.before.filter(({ item }) => !item.isConnected || !state.tree.contains(item)).map(({ title }) => title);
    const replaced = state.before.filter(({ item }) => item.isConnected && item.__fbroot163 !== state.token).map(({ title }) => title);
    const changed = state.before.filter(({ item, selected, expanded }) =>
      item.isConnected && (item.getAttribute("aria-selected") !== selected || item.getAttribute("aria-expanded") !== expanded),
    ).map(({ title }) => title);
    const countRows = (nodes) => nodes.reduce((sum, node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return sum;
      return sum + (node.matches(state.rowSelector) ? 1 : 0) + node.querySelectorAll(state.rowSelector).length;
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
    throw new Error(`file listing flickered: ${JSON.stringify(result)}`);
  }
  return result;
}

async function settlePaint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/// The stamps of the watch and apply frames from the marks `from` to the
/// marks `to`, or to the latest frame without them, in order.
function stampsBetween(frameStamps, applied, from, to) {
  return [
    ...frameStamps.slice(from.frameAt, to?.frameAt),
    ...applied.slice(from.applyAt, to?.applyAt).map(({ at }) => at),
  ].sort((a, b) => a - b);
}

/// The shared graph's fetches, step by step. A step's frames are the watch
/// and apply frames from its start to the end marks taken when its fetch was
/// seen (`end`); a frame after those marks and before the next step's start
/// is the step's late frame, counted in `lateFrames` and left out of the
/// step's last gap. A step's fetches run to the next step's start, so a late
/// frame's own fetch counts here when it starts before the next step does,
/// and its quiet windows are counted on its frames to the next step's start,
/// the late frames included, grouped by gaps of 250 ms, so a late frame's
/// fetch has its window. The stamps are CDP's monotonic seconds; `at` lists
/// them in milliseconds from the step's first frame.
export function graphReport(steps, frameStamps, applied, graphStarts) {
  return steps.map((step, index) => {
    const next = steps[index + 1];
    const stamps = stampsBetween(frameStamps, applied, step, step.end);
    const late = stampsBetween(frameStamps, applied, step.end, next);
    const spanned = stampsBetween(frameStamps, applied, step, next);
    const fetches = graphStarts.slice(step.graphAt, next?.graphAt);
    const ms = (list) => list.map((at) => Math.round((at - (stamps[0] ?? 0)) * 1000));
    return {
      step: step.label, watchFrames: step.end.frameAt - step.frameAt, applyFrames: step.end.applyAt - step.applyAt,
      lateFrames: late.length, windows: spanned.filter((at, i) => i === 0 || at - spanned[i - 1] >= 0.25).length,
      fetches: fetches.length,
      lastGapMs: stamps.length && fetches.length ? Math.round((fetches.at(-1) - stamps.at(-1)) * 1000) : null,
      at: { frames: ms(stamps), late: ms(late), fetches: ms(fetches) },
    };
  });
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
    // The filesystem frames, the index's apply frames and the shared graph's
    // fetches, each stamped by the browser's network clock (CDP's monotonic
    // seconds).
    const frameStamps = [];
    // The same frames stamped on receipt by this process's clock, the clock
    // the listings carry, so a listing can be placed against a frame.
    const frameReceived = [];
    const applied = [];
    const graphStarts = [];
    const graphSteps = [];
    let openedLeftDock = false;
    cdp.on("Network.webSocketFrameReceived", ({ response, timestamp }) => {
      try {
        const frame = JSON.parse(response.payloadData);
        if (frame.type === "watch" || frame.type === "fs") {
          frames.push(frame);
          frameStamps.push(timestamp);
          frameReceived.push(Date.now());
        }
        if (frame.type === "graph_applied") {
          applied.push({ paths: Array.isArray(frame.paths) ? frame.paths : [], at: timestamp });
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
    // A step of the arm: one change made outside chan, the watch frames it
    // brings, and the apply frames the index sends once it has written the
    // change into the graph, a debounce later. With a File Browser open the
    // store re-arms the shared graph's 250 ms quiet window at each frame of
    // either kind and fetches when it passes, so a step costs a fetch after
    // its watch frames and one after its apply frames, one when they fall
    // inside one window. A step ends once an apply frame names a path it
    // changed (`applies`, every path for a step that lists several) and a
    // fetch has started after its last frame, so each fetch is its step's.
    // Its last gap is read up to the marks taken then: a late frame that
    // arrives before the next step starts is left out of it.
    const graphStep = (label, applies) => {
      const step = { label, applies, frameAt: frameStamps.length, applyAt: applied.length, graphAt: graphStarts.length };
      graphSteps.push(step);
      return step;
    };
    const graphFetched = (step, bound = 30_000) => waitFor(`the shared graph's fetch after the apply frames of ${step.label}`, bound, () => {
      const named = new Set(applied.slice(step.applyAt).flatMap(({ paths }) => paths));
      const done = typeof step.applies === "function"
        ? [...named].some(step.applies)
        : step.applies.every((path) => named.has(path));
      if (!done) return false;
      const last = stampsBetween(frameStamps, applied, step).at(-1);
      if (last === undefined || !graphStarts.slice(step.graphAt).some((at) => at > last)) return false;
      step.end = { frameAt: frameStamps.length, applyAt: applied.length };
      return true;
    });
    const created = async (name, surface) => {
      const frameAt = frames.length;
      const listAt = listings.length;
      const start = Date.now();
      const step = graphStep(`created ${name}`, [name]);
      writeFileSync(join(ctx.workspaceDir, name), `outside chan ${name}\n`);
      await awaitFrame("watch", name, frameAt);
      try {
        await waitFor(`${name} in ${surface}`, 20_000, () => row(page, surface, name));
      } catch (error) {
        const listing = surface === TAB ? await readFiles(page).catch((failure) => ({ error: failure.message })) : null;
        throw new Error(`root row ${name} missing after its watch frame in ${surface}: ${JSON.stringify(listing)} (${error.message})`);
      }
      const report = { name, elapsedMs: Date.now() - start, rootListings: rootListingsSince(listAt) };
      console.log(`[fbroot163] ${JSON.stringify(report)}`);
      await graphFetched(step);
      return report;
    };
    const report = { engine: await page.evaluate(() => navigator.userAgent), created: [] };
    try {
      // A fresh workspace's first index build takes in files written while it
      // runs without an apply frame, so the setup waits for it to finish.
      await waitFor("the workspace's first index build", 90_000, async () => {
        const status = await request(ctx, "/api/index/status");
        return status.status === 200 && status.json?.state === "idle" && status.json?.readiness?.state === "ready";
      });
      // The setup's 81 files reach the graph one apply at a time over several
      // seconds, and can run past 30 s beside a compile load, so its wait
      // takes the first build's bound; the steps start once the last is applied
      // and fetched.
      const setupStep = graphStep("setup", [...filler, `${folder}/${nested}`]);
      mkdirSync(join(ctx.workspaceDir, folder));
      mkdirSync(join(ctx.workspaceDir, unseen));
      writeFileSync(join(ctx.workspaceDir, folder, nested), "nested\n");
      for (const name of filler) writeFileSync(join(ctx.workspaceDir, name), "fill\n");

      await showFiles(page);
      await navigateFiles(page, folder);
      await waitFor(`nested row ${nested}`, 20_000, () => row(page, TAB, nested));
      await navigateFiles(page, "");
      const folderRow = await waitFor(`folder ${folder}`, 20_000, () => row(page, TAB, folder));
      await folderRow.click();
      await waitFor(`selected folder ${folder}`, 5_000, async () => (await readFiles(page)).rows.some((item) => item.name === folder && item.selected));

      await graphFetched(setupStep, 90_000);
      graphSteps.shift();
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
      const modifiedStep = graphStep("modified", [rootSelected]);
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
      const unrelatedStep = graphStep("unopened directory", [`${unseen}/${unseenFile}`]);
      writeFileSync(join(ctx.workspaceDir, unseen, unseenFile), "unseen\n");
      await awaitFrame("watch", `${unseen}/${unseenFile}`, unrelatedFrameAt);
      await waitFor("workspace refresh after unopened-directory frame", 20_000,
        () => workspaceResponses.length > unrelatedWorkspaceAt);
      await settlePaint(page);
      // Only a listing that starts at or after the unopened directory's own
      // first frame can be its: a late frame of the step before can list the
      // root just before it.
      const ownFrame = frames.findIndex((frame, index) =>
        index >= unrelatedFrameAt && frame.type === "watch" && frame.event?.path === `${unseen}/${unseenFile}`);
      const caused = listings.slice(unrelatedListAt).filter(({ at }) => at >= frameReceived[ownFrame]);
      if (caused.length !== 0) {
        const seen = frames.slice(unrelatedFrameAt).map((frame, index) =>
          ({ type: frame.type, path: frame.event?.path ?? null, at: frameReceived[unrelatedFrameAt + index] }));
        throw new Error(`unopened directory caused a listing: ${JSON.stringify({ listings: caused, ownFrameAt: frameReceived[ownFrame], frames: seen })}`);
      }
      if (await row(page, TAB, unseenFile)) throw new Error("unopened directory's file was rendered in the root listing");
      report.unrelatedDetector = await finishDetector(page, 0, true);
      await graphFetched(unrelatedStep);
      await navigateFiles(page, unseen);
      await waitFor(`file ${unseenFile} after navigation`, 20_000, () => row(page, TAB, unseenFile));
      if (!listings.slice(unrelatedListAt).some(({ dir }) => dir === unseen)) {
        throw new Error("the listing counter missed navigation's request");
      }
      report.navigationListings = listings.length - unrelatedListAt;
      await navigateFiles(page, "");

      await page.keyboard.down("Control");
      try { await (await row(page, TAB, folder)).click(); }
      finally { await page.keyboard.up("Control"); }
      await waitFor("cleared directory selection", 5_000, async () => (await readFiles(page)).rows.every((item) => !item.selected));
      report.created.push(await created(rootClear, TAB));

      await (await row(page, TAB, folder)).click();
      await command(page, "app.dashboard.open");
      await page.waitForFunction(() => ![...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
        .some((tab) => (tab.getAttribute("title") ?? "").startsWith("File Browser")), { timeout: 10_000 });
      const hiddenFrameAt = frames.length;
      const hiddenListAt = listings.length;
      const hiddenStart = Date.now();
      const hiddenStep = graphStep("hidden tab", [rootHidden]);
      writeFileSync(join(ctx.workspaceDir, rootHidden), "hidden outside chan\n");
      await awaitFrame("watch", rootHidden, hiddenFrameAt);
      await showFiles(page);
      await waitFor(`hidden-tab root row ${rootHidden}`, 20_000, () => row(page, TAB, rootHidden));
      const hiddenReport = { name: rootHidden, elapsedMs: Date.now() - hiddenStart, rootListings: rootListingsSince(hiddenListAt) };
      console.log(`[fbroot163] ${JSON.stringify(hiddenReport)}`);
      report.created.push(hiddenReport);
      await graphFetched(hiddenStep);

      if (!(await page.$(DOCK))) {
        await page.$eval(TAB, (listing) => listing.closest('[role="presentation"]').dispatchEvent(new MouseEvent("contextmenu", {
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
      await page.waitForSelector(DOCK, { visible: true, timeout: 15_000 });
      const dockFolder = await waitFor(`dock folder ${folder}`, 20_000, () => row(page, DOCK, folder));
      if ((await dockFolder.evaluate((item) => item.getAttribute("aria-expanded"))) !== "true") {
        await (await dockFolder.$('button[aria-label="expand"]')).click();
      }
      const dockNested = await waitFor(`dock nested row ${nested}`, 20_000, () => row(page, DOCK, nested));
      await (await dockNested.$("button:not([aria-label])")).click();
      await page.waitForFunction((name, surface) => [...document.querySelectorAll(`${surface} [role="treeitem"][aria-selected="true"] button:not([aria-label])`)]
        .some((item) => item.textContent?.trim() === name), { timeout: 5_000 }, nested, DOCK);
      report.created.push(await created(rootDock, DOCK));
      // The dock expands the directory the rename takes too, so its child has
      // a row there for the rename to leave behind.
      const dockUnseen = await waitFor(`dock directory ${unseen}`, 20_000, () => row(page, DOCK, unseen));
      if ((await dockUnseen.evaluate((item) => item.getAttribute("aria-expanded"))) !== "true") {
        await (await dockUnseen.$('button[aria-label="expand"]')).click();
      }
      await waitFor(`dock row ${unseen}/${unseenFile}`, 20_000, () => rowAt(page, DOCK, `${unseen}/${unseenFile}`));

      // A fresh root row proves the listing answered after the mutation. The Files tab exposes root entries; the expanded dock also materializes cached descendants.
      await showFiles(page);
      const renamedFrameAt = frames.length;
      // A directory's rename is applied as the old path's removal (naming the
      // files it held) and the new path's arrival: either names the step.
      const renameStep = graphStep("rename", (path) => [unseen, renamed].some((dir) => path === dir || path.startsWith(`${dir}/`)));
      renameSync(join(ctx.workspaceDir, unseen), join(ctx.workspaceDir, renamed));
      await awaitFrame("watch", unseen, renamedFrameAt);
      await waitFor(`renamed row ${renamed} in ${TAB}`, 20_000, () => row(page, TAB, renamed));
      await settlePaint(page);
      const leftAt = async (paths) => Object.fromEntries(await Promise.all(Object.entries(paths).flatMap(([key, path]) => [
        ...(!path.includes("/") ? [rowAt(page, TAB, path).then((item) => [key, Boolean(item)])] : []),
        rowAt(page, DOCK, path).then((item) => [`dock-${key}`, Boolean(item)]),
      ])));
      const renamedLeft = await leftAt({ oldName: unseen, oldChild: `${unseen}/${unseenFile}` });
      console.log(`[fbroot163] ${JSON.stringify({ renamedLeft })}`);
      await graphFetched(renameStep);
      const removedFrameAt = frames.length;
      const removalStep = graphStep("removal", [afterRemoval]);
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
      // A step's quiet windows are its frames grouped by gaps of 250 ms, and
      // each costs at most one fetch; fewer when a window's end waits on a
      // fetch in flight that a later end also waits on, or when a late timer
      // joins two. Its last fetch starts at least 200 ms after its last frame.
      // A frame still on its way to the page, or queued behind the quiet
      // timer's task, when the timer fires yields a fetch a few milliseconds
      // after that frame's stamp and one more after the frame: one fetch over
      // the windows, and only the last fetch is judged for its gap.
      report.graph = graphReport(graphSteps, frameStamps, applied, graphStarts);
      console.log(`[fbroot163] ${JSON.stringify({ graph: report.graph })}`);
      const fetchedInBurst = report.graph.filter(({ windows, fetches, lastGapMs }) =>
        fetches < 1 || fetches > windows + 1 || lastGapMs === null || lastGapMs < 200);
      if (fetchedInBurst.length) {
        throw new Error(`the shared graph was fetched inside a burst or more than once per quiet window: ${JSON.stringify(fetchedInBurst)}`);
      }
      // That race is one step's accident. A page that fetches twice for every
      // window passes each step by the allowance, and holds one fetch over
      // its windows in every step.
      const overSteps = report.graph.filter(({ windows, fetches }) => fetches > windows);
      if (overSteps.length > 3) {
        throw new Error(`the shared graph was fetched once more than its quiet windows in ${overSteps.length} of ${report.graph.length} steps, more than the race allows: ${JSON.stringify(report.graph)}`);
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
            await page.$eval(DOCK, (listing) => listing.closest('[role="presentation"]').dispatchEvent(new MouseEvent("contextmenu", {
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
