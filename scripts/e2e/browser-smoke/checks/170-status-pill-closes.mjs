// The status pill sits at the window's top right, over whichever pane is
// rightmost, and its sections can be closed. Two controls it is known to
// cover are raised under it: the terminal's find box and the file browser's
// Details close. For each, expanded and then collapsed, the check first reads
// that the pill covers the control (the precondition: without it a green
// proves nothing), closes the pill's sections, and reads that the control is
// the topmost element at every probe point.
//
// The pill is raised by `chan shell upload`, which adds an upload request to
// the Transfers launcher and writes a short "upload to" confirmation that
// clears itself. Every page action goes through Runtime.evaluate with no user
// gesture: a gesture inside the last few seconds makes the upload open the
// file chooser instead of queueing a request.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { request } from "../lib/drafts.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB = "SmokePill170";
const DIR = "pill170";

export default {
  name: "status-pill-closes",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("raising the pill needs the server's control socket");
    const { page } = ctx;
    await page.setViewport({ width: 1280, height: 800 });
    await page.bringToFront();
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    assert.ok(windowId, "the page's window id");
    await ctx.waitWindowLive(windowId);
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
    const shell = (args) => ctx.exec(ctx.chanBin, ["shell", ...args], { cwd: ctx.workspaceDir, env, timeout: 60_000 });
    const terminal = (args) => shell(["terminal", ...args]);
    mkdirSync(join(ctx.workspaceDir, DIR), { recursive: true });

    const cdp = await page.createCDPSession();
    async function read(expression) {
      const response = await cdp.send("Runtime.evaluate", { expression: `JSON.stringify(${expression})`, returnByValue: true, userGesture: false });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return JSON.parse(response.result.value);
    }
    async function wait(expression, label, timeoutMs = 30_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const value = await read(expression);
        if (value) return value;
        if (Date.now() > end) {
          const pill = await read("document.querySelector('.app-statusbar')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null");
          throw new Error(`waiting for ${label}; the pill reads ${JSON.stringify(pill)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const click = (selector) => read(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error(${JSON.stringify(`no ${selector}`)});
      element.click();
      return true;
    })()`);

    async function waitIndexerIdle() {
      const end = Date.now() + 90_000;
      for (;;) {
        const response = await request(ctx, "/api/index/status");
        if (response.status !== 200) throw new Error(`GET /api/index/status -> ${response.status}`);
        const indexSection = await read("Boolean(document.querySelector('.app-statusbar [aria-label=\"open indexing dashboard\"]'))");
        if (response.json?.state === "idle" && !indexSection) return;
        if (Date.now() > end) throw new Error(`waiting for the indexer to be idle; state=${JSON.stringify(response.json?.state)}, pill section=${indexSection}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Probe points every 8px across a control's middle row, and whether
    // the control or the pill is topmost at each.
    async function probe(selector) {
      return read(`(() => {
        const control = document.querySelector(${JSON.stringify(selector)});
        if (!control) throw new Error(${JSON.stringify(`no ${selector}`)});
        const box = control.getBoundingClientRect();
        const y = box.top + box.height / 2;
        const points = [];
        for (let x = box.left + 2; x <= box.right - 2; x += 8) {
          const hit = document.elementFromPoint(x, y);
          const at = hit ? hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/).join('.') : '') : null;
          points.push({ x: Math.round(x), y: Math.round(y), control: control.contains(hit), pill: !!hit?.closest('.app-statusbar'), at });
        }
        return points;
      })()`);
    }
    // Raise the expanded pill with the Transfers launcher alone in it.
    async function raisePill() {
      await waitIndexerIdle();
      // A gesture still live (Puppeteer's own evaluate grants one) would
      // turn the upload into an immediate file chooser.
      await wait("navigator.userActivation.isActive === false", "user activation to lapse", 15_000);
      await shell(["upload", DIR]);
      await wait("Boolean(document.querySelector('.app-statusbar'))", "the pill");
      if (await read("Boolean(document.querySelector('.app-statusbar.collapsed'))")) await click(".app-statusbar .collapse");
      await wait("Boolean(document.querySelector('[aria-label=\"show file transfers\"]'))", "the Transfers launcher");
      await wait("document.querySelector('[aria-label=\"status message\"]') === null", "the upload confirmation to clear", 15_000);
      const sections = await read("Array.from(document.querySelectorAll('.app-statusbar .row .section')).map((section) => section.getAttribute('aria-label'))");
      assert.deepEqual(sections, ["show file transfers"], `the pill holds the Transfers launcher alone: ${JSON.stringify(sections)}`);
    }
    async function pillGone() {
      // The upload's own confirmation clears itself; the closed sections do not come back.
      await wait("document.querySelector('.app-statusbar') === null", "the pill to leave");
    }
    async function leg(label, selector) {
      const observed = {};
      await raisePill();
      const expanded = await probe(selector);
      assert.ok(expanded.some((point) => point.pill), `${label}: the expanded pill covers the control (${JSON.stringify(expanded)})`);
      await ctx.shot(`${label}-covered`);
      await click('[aria-label="hide file transfers"]');
      await pillGone();
      await ctx.shot(`${label}-closed`);
      observed.expanded = { covered: expanded, closed: await probe(selector) };
      assert.ok(observed.expanded.closed.every((point) => point.control), `${label}: the control is topmost once the pill is closed (${JSON.stringify(observed.expanded.closed)})`);

      await raisePill();
      await click(".app-statusbar .collapse");
      await wait("Boolean(document.querySelector('.app-statusbar.collapsed'))", "the collapsed chip");
      const collapsed = await probe(selector);
      assert.ok(collapsed.some((point) => point.pill), `${label}: the collapsed chip covers the control (${JSON.stringify(collapsed)})`);
      await ctx.shot(`${label}-chip`);
      await click('[aria-label="close all status"]');
      await pillGone();
      observed.collapsed = { covered: collapsed, closed: await probe(selector) };
      assert.ok(observed.collapsed.closed.every((point) => point.control), `${label}: the control is topmost once the chip is closed (${JSON.stringify(observed.collapsed.closed)})`);
      return observed;
    }

    const originalPrefs = await readTerminalPrefs(page, token);
    const observations = {};
    try {
      await writeTerminalPrefs(page, token, { ghostty: false });
      await openAttachedTerminal(ctx, page, terminal, windowId, TAB, "xterm");
      // The find box opens from the terminal's own menu.
      await read(`(() => {
        const tab = document.querySelector('.terminal-tab.active');
        const box = tab.getBoundingClientRect();
        tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
        return true;
      })()`);
      await wait("[...document.querySelectorAll('.mbtn .mbtn-label')].some((label) => label.textContent.trim() === 'Find')", "the terminal menu's Find");
      await read("([...document.querySelectorAll('.mbtn')].find((button) => button.querySelector('.mbtn-label')?.textContent.trim() === 'Find').click(), true)");
      await wait("Boolean(document.querySelector('.terminal-find input.find'))", "the terminal find box");
      observations.findBox = await leg("find-box", ".terminal-find input.find");

      await shell(["open", DIR]);
      await wait("Boolean(document.querySelector('aside.inspector.right .title button.close'))", "the file browser's Details close");
      observations.details = await leg("details-close", "aside.inspector.right .title button.close");
      return observations;
    } finally {
      await cdp.detach().catch(() => {});
      await terminal(["close", "--tab-name", TAB]).catch(() => {});
      // Wait for the tab to leave before the context closes, so its session
      // is not respawned by a saved layout.
      await page.waitForFunction(() => !document.querySelector(".terminal-tab"), { timeout: 15_000 }).catch(() => {});
      await restoreTerminalPrefs(ctx, page, token, originalPrefs);
    }
  },
};
