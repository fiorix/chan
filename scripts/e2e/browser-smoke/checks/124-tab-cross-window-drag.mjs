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
//
// Two terminal arms move a terminal with no session: one whose shell exited,
// and one opened while the check's own server is paused (SIGSTOP on its pid,
// SIGCONT in a finally), which has no session yet when it moves. Each arrives
// under its name with a new shell and a status naming what did not move, and
// the source lets it go without asking; the ended one's new shell runs in the
// carried group and directory. After the server continues, the source window
// holds no session and the target one more.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installProgramStatusRecord } from "../lib/program-status.mjs";

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
  // Records each terminal socket's session and exit frames.
  await page.evaluateOnNewDocument(installProgramStatusRecord);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label, read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read().catch((error) => ({ error: error.message }));
    if (last && !last.error) return last;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}: ${JSON.stringify(last)}`);
    await sleep(200);
  }
}

const statusText = (page) =>
  page.evaluate(() => document.querySelector(".app-statusbar")?.innerText ?? "");

const confirmText = (page) =>
  page.evaluate(() => {
    const title = document.getElementById("confirm-title");
    return title ? (title.closest('[role="dialog"], [role="alertdialog"]') ?? title.parentElement)?.innerText ?? "" : null;
  });

/// The session ids this page's terminal sockets saw a frame of `type` for.
const frameSessions = (page, type) =>
  page.evaluate((wanted) => window.__programStatusTrace.frames
    .filter((frame) => frame.type === wanted)
    .map((frame) => (wanted === "exit" ? frame.session_id : frame.id)), type);

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
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const cs = (args, windowId) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
        cwd: ctx.workspaceDir,
        env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
        timeout: 30_000,
      });
    const rows = async () =>
      Object.entries(JSON.parse((await cs(["list", "--json"], SRC_WINDOW)).stdout).groups ?? {}).flatMap(
        ([group, entries]) => entries.map((row) => ({ ...row, group })),
      );
    const dirName = `xwmove124-${Date.now()}`;
    const dir = join(ctx.workspaceDir, dirName);
    const moved = [];
    const targetTerminals = [];
    let paused = false;
    let src;
    let dst;
    try {
      src = await openWindow(ctx, SRC_WINDOW);
      dst = await openWindow(ctx, DST_WINDOW);

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

      // A terminal with no session, moved: drag the source's active tab, drop
      // it in the target, end the drag, and read both windows.
      const moveTerminal = async (kind, label, serverPaused) => {
        const beforeDst = await tabLabels(dst);
        const payload = await startDragOnActiveTab(src);
        const parsed = JSON.parse(payload[CROSS_TAB_MIME] ?? "{}");
        check(parsed.kind === "terminal" && !parsed.terminalSessionId,
          `${kind}: the payload is a terminal with no session: ${payload[CROSS_TAB_MIME]}`);
        const accepted = await dropOnTabStrip(dst, payload);
        check(accepted, `${kind}: the target refused the terminal`);
        await dst.waitForFunction((n) => document.querySelectorAll(".tabs .tab").length === n + 1,
          { timeout: 20_000, polling: 100 }, beforeDst.length);
        const arrived = (await tabLabels(dst)).filter((title, i) => title !== beforeDst[i]);
        targetTerminals.push(...arrived);
        check(arrived.length === 1 && arrived[0] === label,
          `${kind}: the target's new tab is ${JSON.stringify(arrived)}, expected "${label}"`);
        const status = await statusText(dst);
        const words = `Moved terminal ${label} opened a new shell here; its session did not move`;
        check(status.includes(words), `${kind}: the target's status reads ${JSON.stringify(status)}`);
        await finishDrag(src, label);
        // A close that asks waits for its answer; give it the time to ask.
        await sleep(1_000);
        const asked = await confirmText(src);
        check(asked === null, `${kind}: the source asked ${JSON.stringify(asked)}`);
        await waitForLabelCount(src, label, 0);
        moved.push({ kind, label, payloadKeys: Object.keys(parsed).sort(), status, serverPaused });
      };

      // Ended: a shell in a group and a directory of its own, then `exit`.
      mkdirSync(dir);
      const ended = "XwEnded124";
      await cs(["new", dirName, "--tab-name", ended, "--tab-group", "xwgroup124"], SRC_WINDOW);
      const endedRow = await until("the ended terminal's session", async () =>
        (await rows()).find((row) => row.name === ended && row.window === SRC_WINDOW));
      await waitForLabelCount(src, ended, 1);
      await until("the ended terminal's attach", async () =>
        (await frameSessions(src, "session")).includes(endedRow.session_id) || null);
      await cs(["write", "--tab-name", ended, "exit\n"], SRC_WINDOW);
      await until("the ended terminal's exit frame", async () =>
        (await frameSessions(src, "exit")).includes(endedRow.session_id) || null, 30_000);
      await moveTerminal("ended", ended, false);
      const endedShell = await until("the moved terminal's new shell", async () =>
        (await rows()).find((row) => row.name === ended && row.window === DST_WINDOW));
      check(endedShell.session_id !== endedRow.session_id, "ended: the target re-attached the exited session");
      check(endedShell.group === "xwgroup124", `ended: the new shell's group is ${endedShell.group}`);
      check(String(endedShell.cwd ?? "").endsWith(`/${dirName}`), `ended: the new shell's directory is ${endedShell.cwd}`);

      // Unstarted: the server paused while the source opens a terminal and it
      // moves; the target's shell starts once the server continues.
      const dstSessionsBefore = new Set((await rows()).filter((row) => row.window === DST_WINDOW).map((row) => row.session_id));
      const srcTabs = (await tabLabels(src)).length;
      let unstarted;
      try {
        process.kill(ctx.serverPid, "SIGSTOP");
        paused = true;
        await dispatchCommand(src, "app.terminal.toggle");
        await src.waitForFunction((n) => document.querySelectorAll(".tabs .tab").length === n + 1,
          { timeout: 15_000, polling: 100 }, srcTabs);
        unstarted = await activeTabLabel(src);
        await moveTerminal("unstarted", unstarted, true);
      } finally {
        if (paused) process.kill(ctx.serverPid, "SIGCONT");
        paused = false;
      }
      const after = await until("the target's one new session after the continue", async () => {
        const all = await rows();
        const fresh = all.filter((row) => row.window === DST_WINDOW && !dstSessionsBefore.has(row.session_id));
        return fresh.length >= 1 ? { all, fresh } : null;
      }, 30_000);
      // An absence is read over a window: a shell started for the source's
      // closed socket would register within it.
      await sleep(2_000);
      const all = await rows();
      const fresh = all.filter((row) => row.window === DST_WINDOW && !dstSessionsBefore.has(row.session_id));
      const leftInSource = all.filter((row) => row.window === SRC_WINDOW);
      check(fresh.length === 1 && fresh[0].name === unstarted,
        `unstarted: the target holds ${JSON.stringify(fresh.map((row) => row.name))} new, expected "${unstarted}" (first read ${after.fresh.length})`);
      check(leftInSource.length === 0, `the source window holds ${JSON.stringify(leftInSource.map((row) => row.name))}`);

      await ctx.shot("tab-cross-window-drag-source", src);
      await ctx.shot("tab-cross-window-drag-target", dst);

      return { moved };
    } finally {
      if (paused) process.kill(ctx.serverPid, "SIGCONT");
      for (const label of targetTerminals) {
        await cs(["close", "--tab-name", label], DST_WINDOW).catch(() => {});
      }
      if (dst && !dst.isClosed()) await dst.close().catch(() => {});
      if (src && !src.isClosed()) await src.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
