// Cross-window tab drag. Two windows of ONE workspace: a tab dragged from one
// to the other must arrive AS ITSELF and leave the source.
//
// The regression this guards: Pane.svelte's cross-window payload ended in a
// catch-all that returned `{ kind: "terminal" }` for every kind it did not
// list. A dragged dashboard, file browser or graph tab therefore declared
// itself a terminal; the target read a terminal with no session id, opened a
// FRESH terminal, and the accepted drop then closed the original in the
// source. A dashboard went in and a terminal came out.
//
// What this check does and does not prove. It drives the app's REAL dragstart
// and drop handlers and carries the real DataTransfer payload between two real
// windows, so the wire contract and both ends of it are covered. It does not
// perform an OS drag: no browser automation protocol can drag between two
// top-level windows, and the desktop shells cannot be driven this way at all.
// The pointer-level gesture, and every WebView that is not Chrome, stay manual
// in `scenarios/tab-drag-and-drop.md`.

const SRC_WINDOW = "tab-dnd-src";
const DST_WINDOW = "tab-dnd-dst";
const CROSS_TAB_MIME = "application/x-chan-tab+json";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function openWindow(ctx, windowId) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  const page = await ctx.browser.newPage();
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 30_000 });
  await ctx.waitWindowLive(windowId);
  return page;
}

async function dispatchCommand(page, name) {
  await page.bringToFront();
  await page.evaluate((command) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: command } }),
    );
  }, name);
}

// A tab's rendered text carries its close control, and a spawned tab is named
// for what it opened (the file browser takes the workspace directory's name,
// not a fixed word), so the label is read from the DOM rather than assumed.
const tabLabels = (page) =>
  page.$$eval(".tabs .tab", (tabs) =>
    tabs.map((t) => (t.textContent ?? "").replace(/\s*×\s*$/, "").trim()),
  );

const activeTabLabel = (page) =>
  page.$eval(".tabs .tab.active", (t) =>
    (t.textContent ?? "").replace(/\s*×\s*$/, "").trim(),
  );

/// Fire the app's real dragstart on the ACTIVE tab and return every MIME type
/// it stamped. This is exactly what the OS would carry to the other window.
async function startDragOnActiveTab(page) {
  await page.bringToFront();
  return page.evaluate(() => {
    const tab = document.querySelector(".tabs .tab.active");
    if (!tab) throw new Error("no active tab to drag");
    const store = new Map();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type, value) => store.set(type, String(value)),
      getData: (type) => store.get(type) ?? "",
      setDragImage: () => {},
      get types() {
        return [...store.keys()];
      },
    };
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    tab.dispatchEvent(event);
    return Object.fromEntries(store);
  });
}

/// Replay a captured payload as a real drop on the target window's tab strip,
/// and report whether the app CLAIMED it. preventDefault is the acceptance
/// signal: the app only calls it once the tab is actually rebuilt.
async function dropOnTabStrip(page, payload) {
  await page.bringToFront();
  return page.evaluate((entries) => {
    const strip = document.querySelector(".tabs");
    if (!strip) throw new Error("no tab strip in target window");
    const store = new Map(Object.entries(entries));
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "move",
      setData: (type, value) => store.set(type, String(value)),
      getData: (type) => store.get(type) ?? "",
      setDragImage: () => {},
      get types() {
        return [...store.keys()];
      },
    };
    const fire = (type) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      strip.dispatchEvent(event);
      return event;
    };
    fire("dragover");
    return fire("drop").defaultPrevented;
  }, payload);
}

/// Complete the gesture on the source. `dropEffect: "move"` is what the
/// browser reports after an accepted drop, and what makes the source release.
async function finishDrag(page, label) {
  await page.bringToFront();
  await page.evaluate((wanted) => {
    const tab = [...document.querySelectorAll(".tabs .tab")].find(
      (node) =>
        (node.textContent ?? "").replace(/\s*×\s*$/, "").trim() === wanted,
    );
    if (!tab) return;
    const event = new Event("dragend", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { dropEffect: "move", types: [], getData: () => "" },
    });
    tab.dispatchEvent(event);
  }, label);
}

async function waitForLabelCount(page, label, count) {
  await page.bringToFront();
  await page.waitForFunction(
    (wanted, want) =>
      [...document.querySelectorAll(".tabs .tab")].filter(
        (node) =>
          (node.textContent ?? "").replace(/\s*×\s*$/, "").trim() === wanted,
      ).length === want,
    { timeout: 20_000, polling: 100 },
    label,
    count,
  );
}

export default {
  name: "tab-cross-window-drag",
  async run(ctx) {
    let src;
    let dst;
    try {
      src = await openWindow(ctx, SRC_WINDOW);
      dst = await openWindow(ctx, DST_WINDOW);

      const moved = [];
      // Two of the three kinds the catch-all used to swallow. Both are
      // reachable from a command, so this needs no fixture. Graph carries the
      // same payload through the same code and is covered by Pane.test.ts plus
      // the manual pack.
      for (const { command, kind } of [
        { command: "app.dashboard.open", kind: "dashboard" },
        { command: "app.files.toggle", kind: "browser" },
      ]) {
        const beforeSrc = await tabLabels(src);
        await dispatchCommand(src, command);
        await src.waitForFunction(
          (n) => document.querySelectorAll(".tabs .tab").length === n + 1,
          { timeout: 20_000, polling: 100 },
          beforeSrc.length,
        );

        // The spawn activates what it opened; its label is whatever the app
        // chose to call it.
        const label = await activeTabLabel(src);
        const beforeDst = await tabLabels(dst);
        check(
          !beforeDst.includes(label),
          `${kind}: target already holds a tab labelled "${label}"`,
        );

        const payload = await startDragOnActiveTab(src);
        const crossRaw = payload[CROSS_TAB_MIME];
        check(crossRaw, `${kind}: no cross-window payload was offered`);
        const parsed = JSON.parse(crossRaw);
        // The regression, stated directly.
        check(
          parsed.kind === kind,
          `${kind}: crossed the window boundary as "${parsed.kind}"`,
        );

        const accepted = await dropOnTabStrip(dst, payload);
        check(accepted, `${kind}: the target refused a drop it should accept`);

        // Arrived, as itself.
        await waitForLabelCount(dst, label, 1);
        const dstLabels = await tabLabels(dst);
        check(
          dstLabels.length === beforeDst.length + 1,
          `${kind}: target gained ${dstLabels.length - beforeDst.length} tabs, expected 1`,
        );
        // The old bug's signature: a fresh shell in the target instead of the
        // tab that was dragged.
        const strays = dstLabels.filter(
          (title, i) => title !== label && title !== beforeDst[i],
        );
        check(
          strays.length === 0,
          `${kind}: target gained unexpected tab(s): ${strays.join(", ")}`,
        );

        // And left the source.
        await finishDrag(src, label);
        await waitForLabelCount(src, label, 0);

        moved.push({ kind, label });
      }

      await ctx.shot("tab-cross-window-drag-source", src);
      await ctx.shot("tab-cross-window-drag-target", dst);

      return { moved };
    } finally {
      if (dst && !dst.isClosed()) await dst.close().catch(() => {});
      if (src && !src.isClosed()) await src.close().catch(() => {});
    }
  },
};
