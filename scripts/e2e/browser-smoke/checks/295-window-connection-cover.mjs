// The window keeps no connection display of its own and keeps its
// reconnecting cover. Each pass puts a relay between the page and its server
// that delays, silences, closes and refuses the page's flows. Through it a
// slow and a stalled connection draw nothing in the window tab bar, the
// status pill or over a terminal, and the cover still shows 600 ms after the
// watcher's socket closes and 45 s after the watcher's last contact. Two
// passes are a plain browser page, with the tab bar on and off, whose cover
// offers no Restart connection, Abandon or Show in Computers; typing into a
// terminal through an outage gives the Reconnected note once its socket is
// back, for its 12 s, and with the tab bar off the note moves below a status
// pill raised over its place. A third stubs a devserver window of the desktop, whose watcher
// retires a silent socket after 15 s while its cover waits for 45 s. The bar
// and desktop passes each wait about 45 s for a cover; the three take about
// four minutes.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startRelay } from "../lib/flow-relay.mjs";
import { openAttachedTerminal, TERMINAL_SURFACE } from "../lib/terminal-attach.mjs";

// api/transport.ts, components/DisconnectOverlay.svelte,
// components/terminalConnectionHealth.svelte.ts and state/store.svelte.ts.
// Keep waits tied to the UI's clocks.
const FAST_PING_MS = 3_000;
const FAST_READ_DEADLINE_MS = 15_000;
const READ_DEADLINE_MS = 45_000;
const CONNECT_DEADLINE_MS = 10_000;
const RECONNECT_BACKOFF_MS = 500;
const RECONNECT_BACKOFF_MAX_MS = 8_000;
const COVER_GRACE_MS = 600;
const RECOVERY_ACTION_DELAY_MS = 8_000;
const NOTE_MIN_MS = 4_000;
const NOTE_MAX_MS = 12_000;
const TRANSIENT_STATUS_MS = 3_000;
const NOTE_TEXT = "Reconnected. Input typed while disconnected may not have been sent.";

const DELAY_EACH_WAY_MS = 650;
// Long enough for a window that drew faces to have read slow: a ping every
// 3 s, a reply 1.3 s late, slow from a 1 s wait.
const SLOW_HOLD_MS = FAST_PING_MS + 2 * DELAY_EACH_WAY_MS + 1_000 + 3_000;
// Long enough for a window that drew faces to have read stalled (a ping
// every 3 s unanswered for 4 s) and for a terminal's note to have shown (the
// ping 1 s after a typed key unanswered for 4 s), and well inside the 45 s a
// local page's watcher waits before it retires a silent socket.
const STALL_HOLD_MS = 12_000;

// Tolerances: how far past a time the contract names a reading may land and
// still pass. The cover rises at its grace after the watcher's last status
// change, and a refused or hanging redial is one more change, half a second
// after the close or the retire; past that, 1.3 s and 2.9 s of timer slack on
// a loaded guest.
const COVER_AFTER_CLOSE_MAX_MS = COVER_GRACE_MS + RECONNECT_BACKOFF_MS + COVER_GRACE_MS + 1_300;
const COVER_LATE_MAX_MS = RECONNECT_BACKOFF_MS + COVER_GRACE_MS + 2_900;
// The note lasts its 12 s of shown time with nothing typed; the poll that
// first sees it and the one that sees it go each read up to a poll late.
const NOTE_LIFETIME_TOLERANCE_MS = 1_000;
// The early redial leaves 500 ms after the 15 s retire; past that, timer
// slack.
const REDIAL_TOLERANCE_MS = 3_000;
// The page's record and the transport read the clock for the same frame in
// the same task, so they differ by a millisecond at most.
const CLOCK_TOLERANCE_MS = 50;
// A delayed reply comes 2 x 650 ms late, less the relay's own timer slack.
const DELAY_TOLERANCE_MS = 100;
// Box edges compared across layout rounding.
const LAYOUT_TOLERANCE_PX = 2;

// Hang guards: how long a wait runs before the check fails for a step that
// never came. None of them bounds a latency the contract names: those are the
// asserts on the page's own records.
const PAGE_GUARD_MS = 30_000; // a page loading, a terminal attaching
const NAVIGATION_GUARD_MS = 60_000; // the page's first document
const STEP_GUARD_MS = 5_000; // a focus, a first pong, a cover taking focus, a shell read
// A recovery redials on the watcher's and the terminal's backoff, up to 8 s
// between dials, each dial held by its 10 s connect deadline.
const RECOVERY_GUARD_MS = CONNECT_DEADLINE_MS + RECONNECT_BACKOFF_MAX_MS + 10_000;
// A wait for something the page does on a timer or a ping gets that time plus
// this.
const TIMED_GUARD_MS = 5_000;

// Reading periods: a hold reads the page for its length, checking every
// reading; a settle period is one after a change, before the next step.
const READ_PERIOD_MS = 2_000;
const SETTLE_PERIOD_MS = 3_000;
// How long a cover is held and read: past the 8 s at which a desktop
// window's cover offers its actions, so a browser page offering none is seen
// after that time too.
const COVER_HOLD_MS = RECOVERY_ACTION_DELAY_MS + 1_000;
const POLL_MS = 100;
const SHELL_POLL_MS = 250;
// A reply with the relay's delay gone: far under the 1.3 s of a delayed one.
const FAST_REPLY_MS = 300;
const NOTE_EDGE_TOLERANCE_PX = 10;
const BAR_SELECTOR = ".app > .window-tab-bar";
// The file a refused placement names; the window opens nothing for it.
const STATUS_FILE = "cover295-status.txt";
const RECOVERY_ACTIONS = ["Restart connection", "Abandon", "Show in Computers"];
// Words of a note for a stalled or lost terminal, which no terminal shows:
// the cover stands for both. A source string, since page.evaluate passes
// its arguments as JSON.
const STALL_NOTES = "No response for|Waiting for the connection|Connection lost|not being sent until it reconnects|connection stalled";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The page's sockets and cover, recorded from inside the page: the watcher's
// dials, closes, pings, pongs and last frame, the named terminal's dials with
// the grid they declare, its opens, frames and the input and resize frames it
// sends, and each cover's rise and fall.
function instrument({ bar, desktop, terminalName }) {
  localStorage.setItem("chan.windowTabBar", bar ? "1" : "0");
  // A devserver window of the desktop that advertises no command: its
  // library (the page's `lib`) makes the watcher remote, and nothing it asks
  // is answered.
  if (desktop) window.__TAURI__ = { core: { invoke: async () => null } };
  const record = {
    watchDials: [], watchCloses: [], watchPings: [], watchPongs: [], watchFrameAt: null,
    terminalDials: [], terminalOpens: [], terminalFrameCount: 0, terminalSent: [], covers: [],
  };
  window.__c295 = record;
  const kindOf = (url) => {
    const target = new URL(url, location.href);
    if (target.pathname.endsWith("/api/terminal/ws")) {
      return target.searchParams.get("tab_name") === terminalName ? "terminal" : null;
    }
    return target.pathname.endsWith("/ws") && !target.pathname.includes("/api/") ? "watch" : null;
  };
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      this.__c295 = kindOf(url);
      if (this.__c295 === "watch") {
        record.watchDials.push(Date.now());
        this.addEventListener("close", () => record.watchCloses.push(Date.now()));
        this.addEventListener("message", (event) => {
          record.watchFrameAt = Date.now();
          try {
            if (JSON.parse(event.data).type === "pong") record.watchPongs.push(Date.now());
          } catch { /* Other watcher frames are not pongs. */ }
        });
      } else if (this.__c295 === "terminal") {
        const query = new URL(url, location.href).searchParams;
        record.terminalDials.push({
          at: Date.now(),
          cols: query.has("cols") ? Number(query.get("cols")) : null,
          rows: query.has("rows") ? Number(query.get("rows")) : null,
        });
        this.addEventListener("open", () => record.terminalOpens.push(Date.now()));
        this.addEventListener("message", () => { record.terminalFrameCount += 1; });
      }
    }
    send(data) {
      if (this.__c295 && typeof data === "string") {
        try {
          const frame = JSON.parse(data);
          if (this.__c295 === "watch" && frame.type === "ping") record.watchPings.push(Date.now());
          if (this.__c295 === "terminal" && (frame.type === "input" || frame.type === "resize")) {
            record.terminalSent.push({
              at: Date.now(), type: frame.type, data: frame.data ?? null,
              cols: frame.cols ?? null, rows: frame.rows ?? null,
            });
          }
        } catch { /* Binary-like text frames are not the app's JSON. */ }
      }
      return super.send(data);
    }
  };
  new MutationObserver(() => {
    const up = !!document.querySelector('[data-cover="reconnect"]');
    const last = record.covers.at(-1);
    if (up && (!last || last.hiddenAt !== null)) record.covers.push({ shownAt: Date.now(), hiddenAt: null });
    else if (!up && last && last.hiddenAt === null) last.hiddenAt = Date.now();
  }).observe(document, { childList: true, subtree: true });
}

// What the page shows of its connection now, with the page's record.
async function observe(page) {
  return page.evaluate(({ barSelector, stallNotes, terminalSurface }) => {
    const box = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const bar = document.querySelector(barSelector);
    const statusPill = document.querySelector("[data-app-status-pill]");
    // The window's connection display, by its markup anywhere and by its
    // names and faces in the bar and the status pill.
    const markup = [...document.querySelectorAll(".connection-indicator, .connection-section, .connection-popover")]
      .map((node) => `${node.className}: ${(node.getAttribute("aria-label") ?? node.textContent ?? "").trim()}`);
    const faces = [];
    for (const root of [bar, statusPill]) {
      if (!root) continue;
      for (const node of root.querySelectorAll("*")) {
        const name = node.getAttribute("aria-label") ?? node.getAttribute("title") ?? "";
        if (/^connection\b/i.test(name)) faces.push(name);
        const text = node.children.length === 0 ? node.textContent?.trim() ?? "" : "";
        if (/^(?:reconnecting|stalled \d+ s|\d+(?:\.\d+)? (?:ms|s))$/.test(text)) faces.push(text);
      }
    }
    const main = document.querySelector(".terminal-tab.active .terminal-main");
    const terminalInput = main?.querySelector('.terminal-host[role="textbox"][aria-label="Terminal input"]');
    const pill = main?.querySelector("[data-terminal-connection-pill]") ?? null;
    const live = main?.querySelector(':scope > [role="status"]') ?? null;
    const overTerminal = main
      ? [...main.children].filter((child) => !child.classList.contains("terminal-host"))
        .map((child) => child.textContent ?? "").join(" ")
      : "";
    const pillStyle = pill ? getComputedStyle(pill) : null;
    const cover = document.querySelector('[data-cover="reconnect"]');
    const active = document.activeElement;
    return {
      panePresent: !!document.querySelector(".pane"),
      display: { markup, faces },
      note: {
        text: pill?.textContent?.trim() ?? null,
        live: live?.textContent?.trim() ?? null,
        stall: new RegExp(stallNotes, "i").test(overTerminal) ? overTerminal.replace(/\s+/g, " ").trim() : null,
        box: box(pill),
        position: pillStyle?.position ?? null,
        pointerEvents: pillStyle?.pointerEvents ?? null,
        background: pillStyle?.backgroundColor ?? null,
      },
      terminalMainBox: box(main),
      terminalScreenBox: box(document.querySelector(`.terminal-tab.active ${terminalSurface}`)),
      statusPillBox: box(statusPill),
      statusPillText: statusPill?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      band: bar ? { box: box(bar) } : null,
      cover: cover ? {
        box: box(cover),
        title: cover.querySelector(".title")?.textContent?.trim() ?? null,
        buttons: [...cover.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? ""),
      } : null,
      viewport: { width: innerWidth, height: innerHeight },
      coverFocused: !!active?.closest('[data-cover="reconnect"]'),
      // Ghostty can focus its public host or its descendant input.
      terminalInputFocused: !!active && !!terminalInput?.contains(active),
      terminalInputPresent: !!terminalInput,
      record: JSON.parse(JSON.stringify(window.__c295 ?? null)),
    };
  }, { barSelector: BAR_SELECTOR, stallNotes: STALL_NOTES, terminalSurface: TERMINAL_SURFACE });
}

function fail(label, seen, relay) {
  const { record, ...rest } = seen ?? {};
  const brief = record ? {
    watchDials: record.watchDials.slice(-4), watchCloses: record.watchCloses.slice(-4),
    watchFrameAt: record.watchFrameAt, covers: record.covers.slice(-3),
    terminalOpens: record.terminalOpens.slice(-3), terminalSent: record.terminalSent.slice(-4),
  } : null;
  throw new Error(`${label}: seen=${JSON.stringify(rest)} record=${JSON.stringify(brief)} relay=${JSON.stringify(relay.summary())}`);
}

function ensure(condition, label, seen, relay) {
  if (!condition) fail(label, seen, relay);
}

// Poll until `predicate` holds, checking `invariant` at every reading.
async function waitFor(page, label, predicate, deadlineAt, relay, invariant = null) {
  let seen;
  for (;;) {
    seen = await observe(page);
    invariant?.(seen);
    if (predicate(seen)) return { at: Date.now(), seen };
    if (Date.now() >= deadlineAt) break;
    await sleep(POLL_MS);
  }
  fail(`${label} did not happen`, seen, relay);
}

// Poll for `ms`, checking `invariant` at every reading.
async function hold(page, ms, invariant) {
  const until = Date.now() + ms;
  let seen;
  do {
    seen = await observe(page);
    invariant(seen);
    await sleep(Math.min(POLL_MS, Math.max(0, until - Date.now())));
  } while (Date.now() < until);
  return seen;
}

// No connection display anywhere, and no note for a stalled or lost
// terminal.
function quiet(label, relay) {
  return (seen) => {
    ensure(seen.display.markup.length === 0 && seen.display.faces.length === 0,
      `${label}: the window drew a connection display`, seen, relay);
    ensure(seen.note.stall === null, `${label}: a terminal showed a stalled or lost note`, seen, relay);
  };
}

// Quiet, with no note over the terminal at all.
function silentTerminal(label, relay) {
  const base = quiet(label, relay);
  return (seen) => {
    base(seen);
    ensure(seen.note.text === null && !seen.note.live, `${label}: a terminal note showed`, seen, relay);
  };
}

// The longest a watcher ping sent after `since` waited for the next pong.
function slowestReply(record, since) {
  let slowest = 0;
  for (const pingAt of record.watchPings) {
    if (pingAt < since) continue;
    const pongAt = record.watchPongs.find((at) => at >= pingAt);
    if (pongAt !== undefined) slowest = Math.max(slowest, pongAt - pingAt);
  }
  return slowest;
}

// The covered reading's checks: the cover is up, offers none of the
// desktop's actions on a browser page, and leaves the band without a
// connection display.
function coveredInvariant(label, relay, { bar, browser }) {
  const base = quiet(label, relay);
  return (seen) => {
    base(seen);
    ensure(!!seen.cover, `${label}: the cover went down during the outage`, seen, relay);
    ensure(seen.cover.title === "reconnecting to the chan server", `${label}: the cover's title`, seen, relay);
    if (browser) {
      const offered = seen.cover.buttons.filter((text) => RECOVERY_ACTIONS.some((action) => text.startsWith(action)));
      ensure(offered.length === 0, `${label}: a browser page's cover offered ${offered.join(", ")}`, seen, relay);
    }
    if (bar) {
      ensure(!!seen.band && Math.abs(seen.cover.box.top - seen.band.box.bottom) <= LAYOUT_TOLERANCE_PX,
        `${label}: the cover does not start below the band`, seen, relay);
    } else {
      ensure(Math.abs(seen.cover.box.top) <= LAYOUT_TOLERANCE_PX &&
        Math.abs(seen.cover.box.width - seen.viewport.width) <= LAYOUT_TOLERANCE_PX &&
        Math.abs(seen.cover.box.height - seen.viewport.height) <= LAYOUT_TOLERANCE_PX,
      `${label}: the cover does not fill the viewport`, seen, relay);
    }
  };
}

function intersects(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// The Reconnected note: shown for its 12 s with nothing typed and at least
// 4 s, at the pane's top right and clear of the status pill, opaque, taking
// no pointer or focus, with the terminal's grid as it was before the outage.
// With `raiseStatusPill`, a status pill is put up over the note's place while
// it shows, and the note must move below it.
async function requireReconnectedNote(ctx, page, name, relay, readyAt, screenBefore, raiseStatusPill = null) {
  const label = `${name} Reconnected note`;
  const first = await waitFor(page, `${label} shows`, (seen) => seen.note.text !== null,
    readyAt + RECOVERY_GUARD_MS, relay, quiet(label, relay));
  const seen = first.seen;
  ensure(seen.note.text === NOTE_TEXT && seen.note.live === NOTE_TEXT, `${label}: its text`, seen, relay);
  ensure(seen.terminalInputFocused, `${label}: the terminal lost the keyboard`, seen, relay);
  ensure(seen.note.position === "absolute" && seen.note.pointerEvents === "none",
    `${label}: it is not an absolute box that takes no pointer`, seen, relay);
  ensure(/^rgb\(/.test(seen.note.background ?? ""), `${label}: its background is not opaque`, seen, relay);
  const note = seen.note.box;
  const main = seen.terminalMainBox;
  ensure(!!note && !!main, `${label}: no box for the note or the terminal`, seen, relay);
  const inside = note.left >= main.left - LAYOUT_TOLERANCE_PX && note.top >= main.top - LAYOUT_TOLERANCE_PX &&
    note.right <= main.right + LAYOUT_TOLERANCE_PX && note.bottom <= main.bottom + LAYOUT_TOLERANCE_PX;
  const atRight = main.right - note.right >= 0 && main.right - note.right <= NOTE_EDGE_TOLERANCE_PX;
  const status = seen.statusPillBox;
  const clearOfStatus = !status || note.right <= status.left || status.right <= note.left ||
    note.bottom <= status.top || status.bottom <= note.top;
  const atTop = note.top - main.top <= NOTE_EDGE_TOLERANCE_PX || (status && note.top >= status.bottom);
  ensure(inside && atRight && clearOfStatus && atTop,
    `${label}: placed inside=${inside} atRight=${atRight} clearOfStatus=${clearOfStatus} atTop=${atTop}`, seen, relay);
  const screen = seen.terminalScreenBox;
  ensure(!!screenBefore && !!screen &&
    Math.abs(screen.width - screenBefore.width) <= LAYOUT_TOLERANCE_PX && Math.abs(screen.height - screenBefore.height) <= LAYOUT_TOLERANCE_PX,
  `${label}: the terminal's screen changed size (before ${JSON.stringify(screenBefore)})`, seen, relay);
  await ctx.shot(`${name}-reconnected-note`, page);
  let placed = null;
  if (raiseStatusPill) {
    // The status pill sits at the window's top right, over the note's own
    // place (asserted below), so the note must move under it.
    await raiseStatusPill();
    const raised = await waitFor(page, `${label} sits below a status pill`, (reading) => {
      const note = reading.note.box;
      const pill = reading.statusPillBox;
      return !!note && !!pill && !intersects(note, pill) && note.top >= pill.bottom;
    }, Date.now() + TRANSIENT_STATUS_MS, relay, (reading) => {
      quiet(label, relay)(reading);
      ensure(reading.note.text === NOTE_TEXT, `${label}: gone while the status pill rose`, reading, relay);
    });
    const main = raised.seen.terminalMainBox;
    const note = raised.seen.note.box;
    const own = { left: note.left, right: note.right, top: main.top + 5, bottom: main.top + 5 + note.height };
    ensure(intersects(own, raised.seen.statusPillBox),
      `${label}: the status pill does not reach the note's own place, so the move proves nothing`, raised.seen, relay);
    ensure(main.right - note.right >= 0 && main.right - note.right <= NOTE_EDGE_TOLERANCE_PX,
      `${label}: moved off the pane's right edge`, raised.seen, relay);
    placed = { pill: raised.seen.statusPillBox, pillText: raised.seen.statusPillText, note };
    await ctx.shot(`${name}-reconnected-note-under-status`, page);
  }
  const held = await hold(page, Math.max(0, first.at + NOTE_MIN_MS - Date.now()), (reading) => {
    quiet(label, relay)(reading);
    ensure(reading.note.text === NOTE_TEXT, `${label}: gone before ${NOTE_MIN_MS} ms`, reading, relay);
  });
  const gone = await waitFor(page, `${label} ends`, (reading) => reading.note.text === null,
    first.at + NOTE_MAX_MS + TIMED_GUARD_MS, relay, quiet(label, relay));
  const shownMs = gone.at - first.at;
  ensure(shownMs >= NOTE_MAX_MS - NOTE_LIFETIME_TOLERANCE_MS && shownMs <= NOTE_MAX_MS + NOTE_LIFETIME_TOLERANCE_MS,
    `${label}: shown ${shownMs} ms with nothing typed`, gone.seen, relay);
  // Every grid the terminal declared on a dial or sent is the one it had at
  // its first: the note moves no row.
  const record = gone.seen.record;
  const grids = [...record.terminalDials, ...record.terminalSent.filter((frame) => frame.type === "resize")]
    .filter((grid) => grid.cols !== null && grid.rows !== null)
    .sort((a, b) => a.at - b.at);
  ensure(grids.length > 0, `${label}: the terminal declared and sent no grid to compare`, gone.seen, relay);
  ensure(grids.every((grid) => grid.cols === grids[0].cols && grid.rows === grids[0].rows),
    `${label}: the terminal's grid changed ${JSON.stringify(grids)}`, gone.seen, relay);
  ctx.mark("reconnected-note", {
    pass: name, shownMs, box: note, statusPillAtFirst: seen.statusPillBox, placed,
    grid: { cols: grids[0].cols, rows: grids[0].rows, readings: grids.length },
    background: held.note.background,
  });
}

async function openPass(ctx, relay, { name, bar, desktop, terminalName }) {
  const windowId = `smoke-cover-295-${name}`;
  const page = await ctx.browser.newPage();
  // The watcher pings every 3 s only while its page is visible and holds the
  // focus, which a headless page reports only once something focuses it.
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.evaluateOnNewDocument(instrument, { bar, desktop, terminalName: terminalName ?? null });
  const url = new URL(ctx.serverUrl);
  url.port = String(relay.port);
  url.searchParams.set("w", windowId);
  if (desktop) url.searchParams.set("lib", "lib-cover-295");
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_GUARD_MS });
  await page.bringToFront();
  await waitFor(page, `${name} workspace pane`, (seen) => seen.panePresent, Date.now() + PAGE_GUARD_MS, relay);
  await ctx.waitWindowLive(windowId);
  await waitFor(page, `${name} watcher answered its opening ping`, (seen) => seen.record.watchPongs.length > 0,
    Date.now() + STEP_GUARD_MS, relay);
  return { page, windowId };
}

async function focusTerminal(page, name, relay) {
  await page.click(".terminal-tab.active .terminal-host");
  await waitFor(page, `${name} terminal input focus`, (seen) => seen.terminalInputFocused, Date.now() + STEP_GUARD_MS, relay);
}

const isSocket = (flow) => flow.path?.endsWith("/ws") ?? false;

// A plain browser page, with the window tab bar on or off.
async function browserPass(ctx, bar) {
  const name = bar ? "bar" : "status";
  const terminalName = `cover295-${name}`;
  const relay = await startRelay(Number(new URL(ctx.serverUrl).port));
  let page = null;
  let windowId = null;
  const env = () => ({ ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId });
  const shell = (args) => ctx.exec(ctx.chanBin, ["shell", ...args], {
    cwd: ctx.workspaceDir, env: env(), timeout: PAGE_GUARD_MS,
  });
  const terminal = (args) => shell(["terminal", ...args]);
  const scrollbackHas = async (marker, deadlineAt) => {
    let text = "";
    do {
      text = (await terminal(["scrollback", "--tab-name", terminalName])).stdout;
      if (text.includes(marker)) return true;
      await sleep(SHELL_POLL_MS);
    } while (Date.now() < deadlineAt);
    return false;
  };
  try {
    ({ page, windowId } = await openPass(ctx, relay, { name, bar, desktop: false, terminalName }));
    if (!bar) writeFileSync(join(ctx.workspaceDir, STATUS_FILE), "the status pill's placement target\n");
    await openAttachedTerminal(ctx, page, terminal, windowId, terminalName);
    await waitFor(page, `${name} terminal attached`, (seen) =>
      seen.terminalInputPresent && seen.record.terminalFrameCount > 0, Date.now() + PAGE_GUARD_MS, relay);
    await focusTerminal(page, name, relay);

    const healthy = await hold(page, READ_PERIOD_MS, silentTerminal(`${name} healthy`, relay));
    ensure(!healthy.cover && healthy.record.covers.length === 0, `${name} healthy: a cover showed`, healthy, relay);
    const screenBefore = healthy.terminalScreenBox;
    await ctx.shot(`${name}-healthy`, page);

    // A slow link: every reply 1.3 s late, and nothing drawn for it.
    relay.setDelay(DELAY_EACH_WAY_MS);
    const slowAt = Date.now();
    const slow = await hold(page, SLOW_HOLD_MS, silentTerminal(`${name} slow`, relay));
    const slowest = slowestReply(slow.record, slowAt);
    ensure(slowest >= 2 * DELAY_EACH_WAY_MS - DELAY_TOLERANCE_MS, `${name} slow: no watcher reply was delayed (${slowest} ms)`, slow, relay);
    ctx.mark("slow-link", { pass: name, slowestReplyMs: slowest, heldMs: SLOW_HOLD_MS });
    await ctx.shot(`${name}-slow`, page);
    relay.setDelay(0);
    const fastAt = Date.now();
    await waitFor(page, `${name} replies fast again`, (seen) => seen.record.watchPings.some((pingAt) => {
      const pongAt = seen.record.watchPongs.find((at) => at >= pingAt);
      return pingAt >= fastAt && pongAt !== undefined && pongAt - pingAt < FAST_REPLY_MS;
    }), fastAt + 2 * FAST_PING_MS + 2 * DELAY_EACH_WAY_MS + TIMED_GUARD_MS, relay, silentTerminal(`${name} after slow`, relay));

    // A silent link with a key typed into it: nothing drawn for the stall.
    await focusTerminal(page, name, relay);
    relay.silence();
    const silenceAt = Date.now();
    const marker = bar ? "LONG295" : "SHORT295";
    await page.keyboard.type(bar ? marker : `echo ${marker}`);
    if (!bar) await page.keyboard.press("Enter");
    const stalled = await hold(page, STALL_HOLD_MS, (seen) => {
      silentTerminal(`${name} stalled`, relay)(seen);
      ensure(!seen.cover, `${name} stalled: covered before the watcher's read deadline`, seen, relay);
    });
    // A frame already written to the page when the relay went silent may
    // still land a moment later.
    ensure(stalled.record.watchFrameAt < silenceAt + CLOCK_TOLERANCE_MS, `${name} stalled: watcher frames still arrived`, stalled, relay);
    ensure(stalled.record.terminalSent.some((frame) => frame.type === "input" && frame.at >= silenceAt),
      `${name} stalled: the typed key was not sent`, stalled, relay);
    await ctx.shot(`${name}-stalled`, page);

    if (!bar) {
      // A stall that heals before any socket is replaced: no cover, the
      // typed line reaches the shell, and no note.
      relay.resume();
      const resumeAt = Date.now();
      await waitFor(page, `${name} short stall healed`, (seen) => seen.record.watchPongs.some((at) => at >= resumeAt),
        resumeAt + 2 * FAST_PING_MS + TIMED_GUARD_MS, relay, silentTerminal(`${name} healing`, relay));
      const reached = await scrollbackHas(marker, Date.now() + 2 * STEP_GUARD_MS);
      const healed = await hold(page, SETTLE_PERIOD_MS, silentTerminal(`${name} healed`, relay));
      ensure(reached, `${name} short stall: the typed line did not reach the shell`, healed, relay);
      ensure(healed.record.covers.length === 0, `${name} short stall: a cover showed`, healed, relay);
      ctx.mark("short-stall", { pass: name, durationMs: resumeAt - silenceAt, markerSeen: reached, covers: 0 });
    } else {
      // The silence runs on to the watcher's read deadline: the cover shows
      // 45 s after the watcher's last contact and offers nothing.
      const covered = await waitFor(page, `${name} cover after silence`, (seen) => !!seen.cover,
        silenceAt + READ_DEADLINE_MS + COVER_LATE_MAX_MS + TIMED_GUARD_MS, relay, quiet(`${name} stalling`, relay));
      const contactAt = covered.seen.record.watchFrameAt;
      const shownAt = covered.seen.record.covers[0]?.shownAt;
      ensure(shownAt - contactAt >= READ_DEADLINE_MS && shownAt - contactAt <= READ_DEADLINE_MS + COVER_LATE_MAX_MS,
        `${name} cover: ${shownAt - contactAt} ms after the last contact`, covered.seen, relay);
      await waitFor(page, `${name} cover takes focus`, (seen) => seen.coverFocused, Date.now() + STEP_GUARD_MS, relay);
      const coveredHeld = await hold(page, COVER_HOLD_MS,
        coveredInvariant(`${name} covered`, relay, { bar, browser: true }));
      ctx.mark("cover-after-silence", {
        pass: name, msAfterContact: shownAt - contactAt, buttons: coveredHeld.cover.buttons,
      });
      await ctx.shot(`${name}-covered`, page);
      relay.resume();
      const resumeAt = Date.now();
      const cleared = await waitFor(page, `${name} cover cleared`, (seen) => !seen.cover,
        resumeAt + RECOVERY_GUARD_MS, relay, quiet(`${name} recovering`, relay));
      await waitFor(page, `${name} terminal focus restored`, (seen) => seen.terminalInputFocused,
        Date.now() + STEP_GUARD_MS, relay, quiet(`${name} restoring`, relay));
      await requireReconnectedNote(ctx, page, name, relay, cleared.at, screenBefore);
      // Evidence only: whether the line typed into the stall reached the
      // shell, which the note says it may not have.
      const reached = await scrollbackHas(marker, Date.now() + STEP_GUARD_MS).catch((error) => `read failed: ${error.message}`);
      ctx.mark("long-outage-input", { pass: name, reachedPty: reached });
    }

    // A close under the page: the cover shows 600 ms after the watcher's
    // socket closes, while its redials are refused.
    await focusTerminal(page, name, relay);
    const before = await observe(page);
    ensure(before.note.text === null && !before.cover, `${name} before the close`, before, relay);
    // The status pass types a key just before the close, which no pong has
    // answered when its socket goes, so the note follows the reconnect; the
    // bar pass types nothing, and no note follows.
    if (!bar) await page.keyboard.type("c");
    const dropAt = Date.now();
    relay.refuse(true, isSocket);
    relay.drop(isSocket);
    const closed = await waitFor(page, `${name} cover after a close`, (seen) => !!seen.cover,
      dropAt + COVER_AFTER_CLOSE_MAX_MS + TIMED_GUARD_MS, relay, quiet(`${name} closing`, relay));
    const closeAt = closed.seen.record.watchCloses.find((at) => at >= dropAt);
    const closeCover = closed.seen.record.covers.at(-1);
    ensure(closeAt !== undefined && closeCover.shownAt - closeAt >= COVER_GRACE_MS &&
      closeCover.shownAt - closeAt <= COVER_AFTER_CLOSE_MAX_MS,
    `${name} cover: ${closeCover.shownAt - closeAt} ms after the close`, closed.seen, relay);
    const closeHeld = await hold(page, COVER_HOLD_MS,
      coveredInvariant(`${name} closed`, relay, { bar, browser: true }));
    ctx.mark("cover-after-close", {
      pass: name, msAfterClose: closeCover.shownAt - closeAt, buttons: closeHeld.cover.buttons,
    });
    await ctx.shot(`${name}-closed`, page);
    relay.refuse(false);
    const allowAt = Date.now();
    const reopened = await waitFor(page, `${name} cover cleared after the refusal`, (seen) => !seen.cover,
      allowAt + RECOVERY_GUARD_MS, relay, quiet(`${name} reopening`, relay));
    await waitFor(page, `${name} terminal focus restored after the close`, (seen) => seen.terminalInputFocused,
      Date.now() + STEP_GUARD_MS, relay, quiet(`${name} restoring`, relay));
    if (!bar) {
      // A placement the window refuses puts up a status pill for 3 s and
      // opens nothing, takes no focus and types nothing.
      const raiseStatusPill = async () => {
        await shell(["open", STATUS_FILE, "--window", windowId, "--pane", "pane-cover295-none", "--side", "a"]);
      };
      await requireReconnectedNote(ctx, page, name, relay, reopened.at, screenBefore, raiseStatusPill);
    } else {
      await waitFor(page, `${name} terminal reopened`, (seen) => seen.record.terminalOpens.some((at) => at >= allowAt),
        Date.now() + RECOVERY_GUARD_MS, relay, silentTerminal(`${name} reopening`, relay));
      await hold(page, SETTLE_PERIOD_MS, silentTerminal(`${name} reopened with nothing typed`, relay));
    }
    return { pass: name, relayFlows: relay.flows.length };
  } catch (error) {
    error.smokeDetails = { pass: name, relay: relay.summary(), seen: page ? await observe(page).catch(() => null) : null };
    if (page) await ctx.shot(`${name}-check-failure`, page).catch(() => {});
    throw error;
  } finally {
    if (windowId) await terminal(["close", "--tab-name", terminalName]).catch(() => {});
    if (!bar) rmSync(join(ctx.workspaceDir, STATUS_FILE), { force: true });
    await page?.close().catch(() => {});
    await relay.close();
  }
}

// A devserver window of the desktop: its watcher is remote, so a silent
// socket is retired after 15 s, and the cover still waits for 45 s.
async function remotePass(ctx) {
  const name = "remote";
  const relay = await startRelay(Number(new URL(ctx.serverUrl).port));
  let page = null;
  try {
    ({ page } = await openPass(ctx, relay, { name, bar: false, desktop: true }));
    await hold(page, READ_PERIOD_MS, quiet(`${name} healthy`, relay));
    relay.silence();
    const silenceAt = Date.now();
    const redial = await waitFor(page, `${name} early redial`, (seen) => seen.record.watchDials.some((at) => at > silenceAt),
      silenceAt + FAST_READ_DEADLINE_MS + RECONNECT_BACKOFF_MS + TIMED_GUARD_MS, relay, (seen) => {
        quiet(`${name} stalling`, relay)(seen);
        ensure(!seen.cover, `${name}: covered before the early redial`, seen, relay);
      });
    const contactAt = redial.seen.record.watchFrameAt;
    const dialAt = redial.seen.record.watchDials.find((at) => at > silenceAt);
    ensure(dialAt - contactAt >= FAST_READ_DEADLINE_MS &&
      dialAt - contactAt <= FAST_READ_DEADLINE_MS + RECONNECT_BACKOFF_MS + REDIAL_TOLERANCE_MS,
    `${name}: redialed ${dialAt - contactAt} ms after the last contact`, redial.seen, relay);
    const covered = await waitFor(page, `${name} cover after silence`, (seen) => !!seen.cover,
      contactAt + READ_DEADLINE_MS + COVER_LATE_MAX_MS + TIMED_GUARD_MS, relay, quiet(`${name} redialing`, relay));
    const shownAt = covered.seen.record.covers[0]?.shownAt;
    ensure(shownAt - contactAt >= READ_DEADLINE_MS - CLOCK_TOLERANCE_MS && shownAt - contactAt <= READ_DEADLINE_MS + COVER_LATE_MAX_MS,
      `${name} cover: ${shownAt - contactAt} ms after the last contact`, covered.seen, relay);
    ctx.mark("remote-silence", { pass: name, redialMsAfterContact: dialAt - contactAt, coverMsAfterContact: shownAt - contactAt });
    await ctx.shot(`${name}-covered`, page);
    relay.resume();
    await waitFor(page, `${name} cover cleared`, (seen) => !seen.cover, Date.now() + RECOVERY_GUARD_MS, relay,
      quiet(`${name} recovering`, relay));
    return { pass: name, relayFlows: relay.flows.length };
  } catch (error) {
    error.smokeDetails = { pass: name, relay: relay.summary(), seen: page ? await observe(page).catch(() => null) : null };
    if (page) await ctx.shot(`${name}-check-failure`, page).catch(() => {});
    throw error;
  } finally {
    await page?.close().catch(() => {});
    await relay.close();
  }
}

export default {
  name: "the window's connection cover through a slow, silent and closed relay",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for terminal setup");
    const details = [];
    for (const bar of [true, false]) details.push(await browserPass(ctx, bar));
    details.push(await remotePass(ctx));
    return details;
  },
};
