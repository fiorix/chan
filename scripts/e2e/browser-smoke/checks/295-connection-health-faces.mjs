// Show the healthy, slow, stalled, reconnecting and recovered connection faces
// through a relay per pass that delays or silences every HTTP and WebSocket flow.
// The bar pass stubs a macOS desktop window to receive its native title; the
// status pass uses a desktop stub with no title bar. Each pass takes about a
// minute because the reconnect cover waits for the 45 s read deadline.

import { startRelay } from "../lib/flow-relay.mjs";
import {
  readTerminalPrefs,
  restoreTerminalPrefs,
  writeTerminalPrefs,
} from "../lib/terminal-prefs.mjs";

// api/transport.ts and api/connectionProbe.ts. Keep waits tied to the UI's clocks.
const FAST_PING_MS = 3_000;
const FAST_READ_DEADLINE_MS = 15_000;
const READ_DEADLINE_MS = 45_000;
const SLOW_WAIT_MS = 1_000;
const STALLED_MS = 4_000;
const RECONNECT_BACKOFF_MS = 500;
const RECONNECT_BACKOFF_MAX_MS = 8_000;
const CONNECT_DEADLINE_MS = 10_000;
const DELAY_EACH_WAY_MS = 650;
const SHORT_STALL_MARGIN_MS = 3_000;
const POLL_MS = 100;
const PILL_LAYOUT_RETRY_MS = 50;
const PILL_EDGE_TOLERANCE_PX = 10;
const PILL_BELOW_GAP_MAX_PX = 12;
const BAR_SELECTOR = ".app > .window-tab-bar";
const DESKTOP_TITLE = "Test host -> remote / chan Window 1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminalFramesByPage = new WeakMap();

async function face(page, bar) {
  const seen = await page.evaluate(({ withBar, barSelector }) => {
    const indicator = document.querySelector(withBar
      ? `${barSelector} > .connection-indicator`
      : ".connection-section .connection-indicator");
    const pill = document.querySelector(".terminal-tab.active [data-terminal-connection-pill]");
    const terminalMain = document.querySelector(".terminal-tab.active .terminal-main");
    const statusBar = document.querySelector("[data-app-status-pill]");
    const cover = document.querySelector('[data-cover="reconnect"]');
    const band = document.querySelector(barSelector);
    const barTitle = band?.querySelector(".bar-title");
    const coveredTitle = band?.querySelector(".covered-band .window-title");
    const popover = document.querySelector('.connection-popover[aria-label="Connection details"]');
    const active = document.activeElement;
    const rect = (node) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const focus = active
      ? `${active.tagName.toLowerCase()}${typeof active.className === "string" && active.className
        ? "." + active.className.trim().replaceAll(" ", ".") : ""}${active.getAttribute("data-cover")
        ? `[data-cover=${active.getAttribute("data-cover")}]` : ""}`
      : null;
    return {
      indicator: indicator ? {
        state: indicator.getAttribute("data-state"),
        text: indicator.textContent?.trim() ?? "",
        name: indicator.getAttribute("aria-label"),
        placement: indicator.getAttribute("data-placement"),
      } : null,
      connectionSectionPresent: !!document.querySelector(".connection-section"),
      panePresent: !!document.querySelector(".pane"),
      popoverPresent: !!popover,
      popoverText: popover?.textContent?.trim().replace(/\s+/g, " ") ?? null,
      popoverLatest: popover?.querySelector(".figures span:first-child strong")?.textContent?.trim() ?? null,
      pill: pill?.textContent?.trim() ?? null,
      pillBox: rect(pill),
      terminalMainBox: rect(terminalMain),
      statusBarBox: rect(statusBar),
      cover: cover ? {
        text: cover.querySelector(".title")?.textContent?.trim(),
        box: rect(cover),
        actions: [...cover.querySelectorAll(".actions button")].map((button) => button.textContent?.trim()),
        actionNote: cover.querySelector(".action-note")?.textContent?.trim() ?? null,
      } : null,
      band: band ? {
        box: rect(band),
        title: coveredTitle?.textContent?.trim() ?? null,
        ordinaryTitle: barTitle?.textContent?.trim() ?? null,
        ordinaryTitleHidden: barTitle?.hidden ?? true,
        titleVisible: !!coveredTitle && getComputedStyle(coveredTitle).visibility !== "hidden",
      } : null,
      titleListenerTarget: window.__health295Targets?.["titlebar-window-title"] ?? null,
      viewport: { width: innerWidth, height: innerHeight },
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      focus,
      terminalInputFocused: !!active?.matches(".terminal-tab.active .xterm-helper-textarea"),
      terminalInputPresent: !!document.querySelector(".terminal-tab.active .xterm-helper-textarea"),
      marker: window.__health295Marker ?? null,
      shortCoverSeen: window.__health295CoverSeen ?? null,
    };
  }, { withBar: bar, barSelector: BAR_SELECTOR });
  const frames = terminalFramesByPage.get(page) ?? [];
  return {
    ...seen,
    terminalReceivedFrames: frames.length,
    lastTerminalFrameAt: frames.at(-1)?.at ?? null,
  };
}

async function waitFace(page, bar, label, predicate, deadlineAt, relay) {
  let last;
  do {
    last = await face(page, bar);
    if (await predicate(last)) return { at: Date.now(), seen: last };
    if (Date.now() >= deadlineAt) break;
    await sleep(POLL_MS);
  } while (true);
  throw new Error(`${label} did not appear: face=${JSON.stringify(last)} relay=${JSON.stringify(relay.summary())}`);
}

function requireFace(condition, label, seen, relay) {
  if (!condition) throw new Error(`${label}: face=${JSON.stringify(seen)} relay=${JSON.stringify(relay.summary())}`);
}

function boxesIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function terminalPillLayoutProblem(seen, requireStatus) {
  const pill = seen.pillBox;
  const main = seen.terminalMainBox;
  const status = seen.statusBarBox;
  if (!pill || !main) return "missing terminal pill or main box";
  if (requireStatus && !status) return "status pill was not found";

  const inside = pill.left >= main.left - 2 && pill.top >= main.top - 2 &&
    pill.right <= main.right + 2 && pill.bottom <= main.bottom + 2;
  const atRight = main.right - pill.right >= 0 &&
    main.right - pill.right <= PILL_EDGE_TOLERANCE_PX;
  const atTop = Math.abs(pill.top - main.top) <= PILL_EDGE_TOLERANCE_PX;
  const naturalTop = main.top + 5;
  const natural = {
    left: pill.left,
    right: pill.right,
    top: naturalTop,
    bottom: naturalTop + pill.height,
  };
  const shouldDrop = status && boxesIntersect(natural, status);
  const belowStatus = status && pill.top >= status.bottom &&
    pill.top - status.bottom <= PILL_BELOW_GAP_MAX_PX;
  const clearOfStatus = !status || !boxesIntersect(pill, status);
  const positionValid = requireStatus || shouldDrop ? belowStatus : atTop;
  if (!inside || !atRight || !clearOfStatus || !positionValid) {
    return `layout inside=${inside} atRight=${atRight} clearOfStatus=${clearOfStatus} ` +
      `shouldDrop=${!!shouldDrop} atTop=${atTop} belowStatus=${!!belowStatus}`;
  }
  return null;
}

async function assertTerminalPillLayout(page, bar, seen, label, relay, requireStatus = false) {
  if (!terminalPillLayoutProblem(seen, requireStatus)) return;
  // A state change can place the terminal notice on the next frame.
  await sleep(PILL_LAYOUT_RETRY_MS);
  const retry = await face(page, bar);
  const problem = terminalPillLayoutProblem(retry, requireStatus);
  if (!problem) return;
  requireFace(false,
    `${label}: ${problem}; terminal pill box=${JSON.stringify(retry.pillBox)} ` +
      `status pill box=${JSON.stringify(retry.statusBarBox)} ` +
      `terminal main box=${JSON.stringify(retry.terminalMainBox)}`,
    retry, relay);
}

async function focusTerminal(page, bar, relay) {
  await page.click(".terminal-tab.active .terminal-host");
  await waitFace(page, bar, "real terminal input focus", (seen) => seen.terminalInputFocused,
    Date.now() + 5_000, relay);
}

async function runPass(ctx, bar, relay) {
  const name = bar ? "bar" : "status";
  const windowId = `smoke-health-295-${name}`;
  const terminalName = `health295-${name}`;
  const page = await ctx.browser.newPage();
  const cdp = await page.createCDPSession();
  const inputFrames = [];
  const terminalFrames = [];
  terminalFramesByPage.set(page, terminalFrames);
  const watcherPongs = [];
  const watcherFrames = [];
  const socketPaths = new Map();
  const terminalSocketNames = new Map();
  const transitions = [];
  let silenceAt = null;
  const record = (state, at) => {
    transitions.push({ state, at });
    if (silenceAt !== null) ctx.mark("connection-transition", { pass: name, state, msFromSilence: at - silenceAt });
  };
  const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
  const terminal = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
    cwd: ctx.workspaceDir, env, timeout: 30_000,
  });
  try {
    if (bar) {
      await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    }
    await page.evaluateOnNewDocument((withBar, ownLabel) => {
      localStorage.setItem("chan.windowTabBar", withBar ? "1" : "0");
      const chrome = {
        active: true, insetLeft: 78, insetRight: 0, controlsCenterY: 16,
        fullscreen: false, drawControls: false, maximized: false, menus: [],
      };
      const invoke = async (command) => {
        if (withBar && command === "native_vocabulary") {
          return { version: "1", build: "health295", commands: ["set_titlebar_tabs"] };
        }
        if (withBar && command === "titlebar_tabs_preference") return false;
        if (withBar && ["set_titlebar_tabs", "titlebar_chrome"].includes(command)) return chrome;
        return null;
      };
      if (withBar) {
        window.__health295Listeners = Object.create(null);
        window.__health295Targets = Object.create(null);
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: ownLabel }, currentWebview: { label: ownLabel } },
          invoke,
        };
        window.__TAURI__ = { event: { listen: async (event, handler, options) => {
          window.__health295Listeners[event] = handler;
          window.__health295Targets[event] = options?.target ?? null;
          return () => { delete window.__health295Listeners[event]; delete window.__health295Targets[event]; };
        } } };
      } else window.__TAURI__ = { core: { invoke } };
    }, bar, `lib-health-295::${windowId}`);
    cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
      const socketUrl = new URL(url);
      socketPaths.set(requestId, socketUrl.pathname);
      if (socketUrl.pathname.endsWith("/api/terminal/ws")) {
        terminalSocketNames.set(requestId, socketUrl.searchParams.get("tab_name"));
      }
    });
    cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
      const path = socketPaths.get(requestId);
      if (path?.endsWith("/api/terminal/ws")) {
        if (terminalSocketNames.get(requestId) !== terminalName) return;
        terminalFrames.push({ at: Date.now(), opcode: response.opcode });
        return;
      }
      if (!path?.endsWith("/ws") || path.includes("/api/") || response.opcode !== 1) return;
      watcherFrames.push(Date.now());
      try {
        if (JSON.parse(response.payloadData).type === "pong") watcherPongs.push(Date.now());
      } catch { /* Other watcher frames are not pongs. */ }
    });
    cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
      if (terminalSocketNames.get(requestId) !== terminalName || response.opcode !== 1) return;
      try {
        const frame = JSON.parse(response.payloadData);
        if (frame.type === "input") inputFrames.push({ at: Date.now(), data: frame.data });
      } catch { /* Other terminal frames are not input. */ }
    });
    await cdp.send("Network.enable");
    const url = new URL(ctx.serverUrl);
    url.port = String(relay.port);
    url.searchParams.set("w", windowId);
    url.searchParams.set("lib", "lib-health-295");
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.bringToFront();
    await waitFace(page, bar, "workspace pane", (seen) => seen.panePresent, Date.now() + 30_000, relay);
    await ctx.waitWindowLive(windowId);
    await waitFace(page, bar, "watcher answered its opening ping", () => watcherPongs.length > 0,
      Date.now() + 5_000, relay);
    if (bar) {
      await waitFace(page, bar, "targeted desktop title listener", (seen) =>
        seen.titleListenerTarget?.kind === "WebviewWindow" &&
        seen.titleListenerTarget.label === `lib-health-295::${windowId}`, Date.now() + 8_000, relay);
      await page.evaluate((title) =>
        window.__health295Listeners["titlebar-window-title"]({ payload: { title } }), DESKTOP_TITLE);
      await waitFace(page, bar, "desktop title in the rendered band", (seen) =>
        seen.band?.ordinaryTitle === DESKTOP_TITLE && !seen.band.ordinaryTitleHidden,
      Date.now() + 8_000, relay);
    }
    await terminal(["new", "--tab-name", terminalName]);
    await waitFace(page, bar, "xterm textarea and terminal attach frame", (seen) =>
      seen.terminalInputPresent && seen.terminalReceivedFrames > 0, Date.now() + 30_000, relay);
    await focusTerminal(page, bar, relay);
    // Healthy has no terminal notice or cover; status mode keeps its quiet indicator hidden.
    const healthy = await waitFace(page, bar, "healthy connection", (seen) =>
      bar ? seen.indicator?.state === "ok" && !seen.indicator.text : !seen.indicator,
    Date.now() + FAST_PING_MS + 5_000, relay);
    requireFace(!healthy.seen.pill && !healthy.seen.cover && healthy.seen.terminalInputFocused &&
      (bar ? healthy.seen.indicator?.placement === "tab-bar" :
        !healthy.seen.band && !healthy.seen.connectionSectionPresent),
    "healthy face", healthy.seen, relay);
    record("quiet", healthy.at);
    await ctx.shot(`${name}-healthy`, page);

    relay.setDelay(DELAY_EACH_WAY_MS);
    // Delayed traffic makes the indicator slow while the terminal stays uncovered.
    const slow = await waitFace(page, bar, "slow connection", (seen) =>
      seen.indicator?.state === "slow" && /\d+(?:\.\d+)? (?:ms|s)/.test(seen.indicator.text),
    Date.now() + FAST_PING_MS + 2 * DELAY_EACH_WAY_MS + SLOW_WAIT_MS + 5_000, relay);
    requireFace(!slow.seen.pill && !slow.seen.cover &&
      slow.seen.indicator.placement === (bar ? "tab-bar" : "status"),
    "slow face", slow.seen, relay);
    record("slow", slow.at);
    await ctx.shot(`${name}-slow`, page);
    // The slow popover reports recent latency without stealing terminal focus.
    await page.click(bar ? `${BAR_SELECTOR} > .connection-indicator` : ".connection-section .connection-indicator");
    await waitFace(page, bar, "connection popover opened", (seen) => seen.popoverPresent, Date.now() + 3_000, relay);
    const popover = await page.$eval(".connection-popover", (node) => ({
      chart: !!node.querySelector(".sparkline"),
      figures: node.querySelector(".figures")?.textContent ?? "",
      contact: node.querySelector(".contact")?.textContent ?? "",
    }));
    const popoverFace = await face(page, bar);
    requireFace(popover.chart &&
      ["Latest", "Median", "Worst"].every((text) => popover.figures.includes(text)) &&
      popover.contact.includes("Last contact") && popoverFace.terminalInputFocused,
    "slow popover and preserved focus", { ...popoverFace, popover }, relay);
    ctx.mark("slow-popover", { pass: name, phase: "opened", text: popoverFace.popoverText });
    const popoverReady = await waitFace(page, bar, "slow popover with a completed delayed round trip", (seen) => {
      const latest = /^(\d+(?:\.\d+)?) s$/.exec(seen.popoverLatest ?? "");
      return !!latest && Number(latest[1]) >= 1;
    }, Date.now() + 2 * FAST_PING_MS + 2 * DELAY_EACH_WAY_MS + 3_000, relay);
    ctx.mark("slow-popover", { pass: name, phase: "captured", text: popoverReady.seen.popoverText });
    await ctx.shot(`${name}-slow-popover`, page);
    await page.keyboard.press("Escape");
    await waitFace(page, bar, "connection popover closed by Escape", (seen) => !seen.popoverPresent,
      Date.now() + 3_000, relay);
    const terminalPoint = await page.evaluate(() => {
      const host = document.querySelector(".terminal-tab.active .terminal-host");
      if (!host) return null;
      const box = host.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    requireFace(!!terminalPoint, "terminal pointer target missing", await face(page, bar), relay);
    await page.mouse.move(terminalPoint.x, terminalPoint.y);
    const pointerFace = await face(page, bar);
    requireFace(pointerFace.terminalInputFocused,
      "moving pointer off indicator changed terminal focus", pointerFace, relay);
    relay.setDelay(0);
    // Removing delay briefly shows recovery before the healthy indicator returns.
    let recoveringShot = false;
    const quiet = await waitFace(page, bar, "quiet after delay", async (seen) => {
      if (!recoveringShot && seen.indicator?.state === "slow" && !seen.indicator.text) {
        recoveringShot = true;
        record("recovering", Date.now());
        await ctx.shot(`${name}-recovering`, page);
      }
      return bar ? seen.indicator?.state === "ok" && !seen.indicator.text : !seen.indicator;
    }, Date.now() + 4 * FAST_PING_MS + 5_000, relay);
    record("quiet-after-delay", quiet.at);
    requireFace(!quiet.seen.cover && !quiet.seen.pill, "quiet after delay", quiet.seen, relay);

    await focusTerminal(page, bar, relay);
    await page.evaluate(() => { window.__health295Marker = "page-survived-outage"; });
    const lastWatcherFrameAt = watcherFrames.at(-1);
    requireFace(!!lastWatcherFrameAt, "no watcher frame before silence", await face(page, bar), relay);
    relay.silence();
    silenceAt = Date.now();
    for (const transition of transitions) {
      ctx.mark("connection-transition", {
        pass: name, state: transition.state, msFromSilence: transition.at - silenceAt,
      });
    }
    await page.keyboard.type("loss295");
    // Stalled shows both the connection indicator and a terminal notice before the cover.
    const stalled = await waitFace(page, bar, "stalled connection and terminal", (seen) =>
      seen.indicator?.state === "stalled" && /^stalled \d+ s$/.test(seen.indicator.text) &&
      seen.pill?.includes("No response for"),
    silenceAt + FAST_PING_MS + STALLED_MS + SLOW_WAIT_MS + 6_000, relay);
    requireFace(!stalled.seen.cover, "stalled terminal without cover", stalled.seen, relay);
    await assertTerminalPillLayout(page, bar, stalled.seen, "stalled terminal pill", relay, !bar);
    record("stalled", stalled.at);
    await ctx.shot(`${name}-stalled`, page);

    // The 15 s fast read deadline starts redialing; terminal input stays available before the cover.
    const reconnecting = await waitFace(page, bar, "reconnecting without cover", (seen) =>
      seen.indicator?.state === "down" && seen.indicator.text === "reconnecting" && !seen.cover,
    silenceAt + FAST_READ_DEADLINE_MS + RECONNECT_BACKOFF_MS + 5_000, relay);
    record("reconnecting", reconnecting.at);
    const beforeInput = inputFrames.length;
    await page.keyboard.type("x");
    const uncovered = await waitFace(page, bar, "uncovered terminal accepted a key", (seen) =>
      seen.terminalInputFocused && !seen.cover && inputFrames.length > beforeInput &&
      inputFrames.slice(beforeInput).some((frame) => frame.data.includes("x")),
    Date.now() + 3_000, relay);
    await assertTerminalPillLayout(page, bar, uncovered.seen,
      "reconnecting-uncovered terminal pill", relay, !bar);
    await ctx.shot(`${name}-reconnecting-uncovered`, page);

    // The cover appears after 45 s of watcher silence and keeps its actions reachable.
    const covered = await waitFace(page, bar, "reconnecting cover", (seen) => !!seen.cover,
      lastWatcherFrameAt + READ_DEADLINE_MS + 5_000, relay);
    record("cover-up", covered.at);
    const coveredReady = await waitFace(page, bar, "cover focus and actions", (seen) =>
      seen.cover?.actions.includes("Restart connection") && seen.cover.actions.includes("Abandon") &&
      seen.focus?.includes("[data-cover=reconnect]"), Date.now() + 3_000, relay);
    requireFace(covered.at >= lastWatcherFrameAt + READ_DEADLINE_MS - 2_000 &&
      coveredReady.seen.cover.text === "reconnecting to the chan server" &&
      coveredReady.seen.cover.actionNote === "Restart closes and reopens the windows served by this connection." &&
      !coveredReady.seen.focus.startsWith("button"),
    "covered deadline, content and focus", coveredReady.seen, relay);
    if (bar) {
      requireFace(coveredReady.seen.band?.titleVisible && !!coveredReady.seen.band.title &&
        Math.abs(coveredReady.seen.cover.box.top - coveredReady.seen.band.box.bottom) <= 2 &&
        coveredReady.seen.indicator?.state === "down",
      "cover leaves title band visible", coveredReady.seen, relay);
    } else {
      requireFace(!coveredReady.seen.band && Math.abs(coveredReady.seen.cover.box.top) <= 2 &&
        Math.abs(coveredReady.seen.cover.box.width - coveredReady.seen.viewport.width) <= 2 &&
        Math.abs(coveredReady.seen.cover.box.height - coveredReady.seen.viewport.height) <= 2,
      "cover fills viewport", coveredReady.seen, relay);
    }
    await ctx.shot(`${name}-covered`, page);

    relay.resume();
    const resumeAt = Date.now();
    const pillTexts = [];
    const observePill = (seen) => {
      if (pillTexts.at(-1) === seen.pill) return;
      pillTexts.push(seen.pill);
      ctx.mark("terminal-pill-after-resume", { pass: name, msFromResume: Date.now() - resumeAt, text: seen.pill });
    };
    // Recovery clears the cover, restores terminal focus, and leaves at most a short notice.
    const gone = await waitFace(page, bar, "cover cleared after relay resume", (seen) => {
      observePill(seen);
      return !seen.cover;
    }, resumeAt + RECONNECT_BACKOFF_MAX_MS + CONNECT_DEADLINE_MS + 3_000, relay);
    record("cover-gone", gone.at);
    const recovered = await waitFace(page, bar, "quiet and terminal focus restored", (seen) => {
      observePill(seen);
      return (bar ? seen.indicator?.state === "ok" && !seen.indicator.text : !seen.indicator) &&
        seen.terminalInputFocused && seen.marker === "page-survived-outage";
    }, Date.now() + 4 * FAST_PING_MS + 5_000, relay);
    record("quiet", recovered.at);
    // Let the terminal's brief lost/reconnected notice settle before capturing recovery.
    await sleep(2_000);
    const settled = await waitFace(page, bar, "terminal pill settled after recovery", (seen) => {
      observePill(seen);
      return !seen.cover && (!seen.pill || seen.pill.startsWith("Reconnected.")) &&
        seen.terminalInputFocused && seen.marker === "page-survived-outage";
    }, resumeAt + READ_DEADLINE_MS + RECONNECT_BACKOFF_MAX_MS + CONNECT_DEADLINE_MS + 5_000, relay);
    const recoveredFace = settled.seen;
    ctx.mark("terminal-pill-history", { pass: name, texts: pillTexts });
    requireFace(!recoveredFace.cover &&
      (!recoveredFace.pill || recoveredFace.pill.startsWith("Reconnected.")) &&
      recoveredFace.terminalInputFocused && recoveredFace.marker === "page-survived-outage",
    "recovered face", recoveredFace, relay);
    if (recoveredFace.pill) {
      await assertTerminalPillLayout(page, bar, recoveredFace, "recovered terminal pill", relay);
    }
    await ctx.shot(`${name}-recovered`, page);

    try {
      const scrollback = (await terminal(["scrollback", "--tab-name", terminalName])).stdout;
      ctx.mark("long-outage-input", { pass: name, reachedPty: scrollback.includes("loss295x") });
    } catch (error) {
      ctx.mark("long-outage-input", { pass: name, reachedPty: null, readError: error.message });
    }
    const beforeInterrupt = inputFrames.length;
    await page.keyboard.down("Control");
    try { await page.keyboard.press("c"); }
    finally { await page.keyboard.up("Control"); }
    await waitFace(page, bar, "Control+C sent terminal interrupt", () =>
      inputFrames.slice(beforeInterrupt).some((frame) => frame.data.includes("\u0003")),
    Date.now() + 3_000, relay);
    await page.evaluate(() => {
      window.__health295CoverSeen = 0;
      window.__health295CoverObserver = new MutationObserver(() => {
        if (document.querySelector('[data-cover="reconnect"]')) window.__health295CoverSeen++;
      });
      window.__health295CoverObserver.observe(document.documentElement, { childList: true, subtree: true });
    });
    // A shorter outage reaches stalled, heals before the 15 s socket deadline, and replays input.
    const shortLastWatcherFrameAt = watcherFrames.at(-1);
    requireFace(!!shortLastWatcherFrameAt, "no watcher frame before short stall",
      await face(page, bar), relay);
    relay.silence();
    const shortAt = Date.now();
    const shortResumeAt = shortLastWatcherFrameAt + FAST_READ_DEADLINE_MS - SHORT_STALL_MARGIN_MS;
    requireFace(shortResumeAt > shortAt, "short stall has no time before resume",
      await face(page, bar), relay);
    const marker = `SHORT295_${name.toUpperCase()}`;
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    let shortStalled = false;
    while (Date.now() < shortResumeAt) {
      const seen = await face(page, bar);
      shortStalled ||= seen.indicator?.state === "stalled";
      requireFace(!seen.cover && seen.shortCoverSeen === 0 && seen.indicator?.state !== "down",
        "short stall covered or redialed before resume", seen, relay);
      await sleep(Math.min(POLL_MS, Math.max(0, shortResumeAt - Date.now())));
    }
    const shortBeforeResume = await face(page, bar);
    shortStalled ||= shortBeforeResume.indicator?.state === "stalled";
    requireFace(!shortBeforeResume.cover && shortBeforeResume.shortCoverSeen === 0 &&
      shortBeforeResume.indicator?.state !== "down",
    "short stall covered or redialed before resume", shortBeforeResume, relay);
    requireFace(shortStalled, "short stall never showed stalled before resume", shortBeforeResume, relay);
    requireFace(Date.now() < shortLastWatcherFrameAt + FAST_READ_DEADLINE_MS,
      "short stall missed the fast read deadline before resume", shortBeforeResume, relay);
    relay.resume();
    const shortQuiet = await waitFace(page, bar, "short stall healed", (seen) => {
      requireFace(!seen.cover && seen.shortCoverSeen === 0 && seen.indicator?.state !== "down",
        "short stall covered or redialed after resume", seen, relay);
      return bar ? seen.indicator?.state === "ok" : !seen.indicator;
    }, Date.now() + 4 * FAST_PING_MS + 5_000, relay);
    const deadline = Date.now() + 10_000;
    let scrollback = "";
    while (Date.now() < deadline && !scrollback.includes(marker)) {
      scrollback = (await terminal(["scrollback", "--tab-name", terminalName])).stdout;
      if (!scrollback.includes(marker)) await sleep(250);
    }
    requireFace(scrollback.includes(marker),
      `short stall input did not reach the PTY (${marker})`, shortQuiet.seen, relay);
    requireFace((await face(page, bar)).shortCoverSeen === 0,
      "short stall covered during recovery", await face(page, bar), relay);
    await ctx.shot(`${name}-short-stall-recovered`, page);
    ctx.mark("connection-short-stall", {
      pass: name, durationMs: Date.now() - shortAt, markerSeen: true,
      stalledSeen: shortStalled, downSeen: false, coverSeen: 0,
    });
    return {
      pass: name,
      transitions: transitions.map(({ state, at }) => ({ state, msFromSilence: at - silenceAt })),
      recoveringShot,
      relayFlows: relay.flows.length,
    };
  } catch (error) {
    error.smokeDetails = {
      pass: name,
      face: await face(page, bar).catch(() => null),
      relay: relay.summary(),
      inputFrames: inputFrames.slice(-5),
      transitions: transitions.map(({ state, at }) => ({
        state, msFromSilence: silenceAt === null ? null : at - silenceAt,
      })),
    };
    await ctx.shot(`${name}-check-failure`, page).catch(() => {});
    throw error;
  } finally {
    await terminal(["close", "--tab-name", terminalName]).catch(() => {});
    await cdp.detach().catch(() => {});
    await page.close().catch(() => {});
    terminalFramesByPage.delete(page);
  }
}

export default {
  name: "connection health faces through a silent relay",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for terminal setup");
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const originalPrefs = await readTerminalPrefs(ctx.page, token);
    const changedPrefs = originalPrefs.ghostty !== false;
    const target = new URL(ctx.serverUrl);
    const details = [];
    try {
      if (changedPrefs) await writeTerminalPrefs(ctx.page, token, { ghostty: false });
      for (const bar of [true, false]) {
        const relay = await startRelay(Number(target.port));
        try { details.push(await runPass(ctx, bar, relay)); }
        finally { await relay.close(); }
      }
    } finally {
      if (changedPrefs) await restoreTerminalPrefs(ctx, ctx.page, token, originalPrefs);
    }
    return details;
  },
};
