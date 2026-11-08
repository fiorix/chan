// Page lifecycle probe for a Chan desktop window on macOS, pasted into that
// window's Web Inspector console
// (`pbcopy < scripts/e2e/wkwebview-wake-probe.js`, then Cmd+V in the
// console). It answers what the page itself sees across a display sleep, a
// system sleep or an occlusion in WKWebView, which no headless engine can
// show.
//
// Each row carries the wall clock (Date.now(), lined up against the macOS
// unified log) and performance.now(), and records one of:
//   visibilitychange     with document.visibilityState in the vis column
//   pageshow, pagehide   with event.persisted
//   focus, blur          on window
//   freeze, resume       if the engine fires them
//   native-repaint       the desktop's wake repaint script ran in this page
//                        (its #chan-wake-repaint element appeared)
//   late-tick            a one-second interval fired more than 2.5 s after its
//                        previous tick: timers were frozen or throttled
//   mark, install        rows of the reader's own
//
// It only listens. No handler cancels or stops an event, it schedules no
// animation frame, so it asks for no rendering update, and it touches no app
// state, so the window behaves as it does without it. The log lives in memory
// and in sessionStorage under one key, so a sleep, a closed inspector or a
// reload keeps it. Pasting it again stops the running copy and keeps its log.
//
// Console commands:
//   wakevis.table()        every row as a table; wakevis.table(n) from row n
//   copy(wakevis.text())   the rows as tab-separated text
//   wakevis.mark("label")  add a row of your own
//   wakevis.logArgs(n)     --start/--end for `log show`, row n to now
//   wakevis.clear()        empty the log
//   wakevis.stop()         remove every listener, the interval and the observer
(() => {
  "use strict";
  const KEY = "chan.wakevis.probe";
  const TICK_MS = 1000;
  const LATE_MS = 2500;
  // wakeGap.ts samples every 2000 ms and calls a gap over 6000 ms a wake; a
  // late row says whether this gap is over that line. The app's own gap is
  // this one plus up to one of its 2 s ticks.
  const WAKE_GAP_MS = 6000;
  const MAX_ROWS = 5000;
  const REPAINT_ID = "chan-wake-repaint";

  const previous = window.wakevis;
  if (previous && typeof previous.stop === "function") previous.stop();

  let rows = previous && Array.isArray(previous.rows) ? previous.rows : null;
  if (!rows) {
    try {
      rows = JSON.parse(sessionStorage.getItem(KEY) || "[]");
    } catch {
      rows = [];
    }
    if (!Array.isArray(rows)) rows = [];
  }
  const kept = rows.length;

  const save = () => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(rows));
    } catch {
      // Storage refused (quota, private mode): the in-memory log still holds.
    }
  };

  const record = (event, detail = "") => {
    rows.push({
      n: rows.length ? rows[rows.length - 1].n + 1 : 1,
      wall: Date.now(),
      perf: Math.round(performance.now() * 10) / 10,
      event,
      vis: document.visibilityState,
      focus: document.hasFocus(),
      detail: String(detail),
    });
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
    save();
  };

  const undo = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    undo.push(() => target.removeEventListener(type, handler));
  };
  listen(document, "visibilitychange", () => record("visibilitychange"));
  listen(window, "pageshow", (e) => record("pageshow", `persisted=${e.persisted}`));
  listen(window, "pagehide", (e) => record("pagehide", `persisted=${e.persisted}`));
  // Element focus does not bubble, so a bubbling listener on window hears the
  // window's own focus and blur; the target check keeps it to those.
  listen(window, "focus", (e) => e.target === window && record("focus"));
  listen(window, "blur", (e) => e.target === window && record("blur"));
  listen(document, "freeze", () => record("freeze"));
  listen(document, "resume", () => record("resume"));

  let lastWall = Date.now();
  let lastPerf = performance.now();
  const timer = setInterval(() => {
    const wall = Date.now();
    const perf = performance.now();
    const wallGap = wall - lastWall;
    const perfGap = Math.round(perf - lastPerf);
    lastWall = wall;
    lastPerf = perf;
    if (wallGap > LATE_MS) {
      const over = wallGap > WAKE_GAP_MS ? "yes" : "no";
      record("late-tick", `wall gap ${wallGap} ms, perf gap ${perfGap} ms, over 6 s: ${over}`);
    }
  }, TICK_MS);
  undo.push(() => clearInterval(timer));

  // wake_repaint.js appends its element to <html> itself, so the direct
  // children are the whole watch.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.id === REPAINT_ID) record("native-repaint");
      }
    }
  });
  observer.observe(document.documentElement, { childList: true });
  undo.push(() => observer.disconnect());

  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const localTime = (ms, withMs = true) => {
    const d = new Date(ms);
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return withMs ? `${day} ${time}.${pad(d.getMilliseconds(), 3)}` : `${day} ${time}`;
  };
  const view = (from = 0) =>
    rows
      .filter((row) => row.n >= from)
      .map((row, i, list) => ({
        n: row.n,
        local: localTime(row.wall),
        utc: new Date(row.wall).toISOString(),
        perf: row.perf,
        "+ms": i ? row.wall - list[i - 1].wall : 0,
        event: row.event,
        vis: row.vis,
        focus: row.focus,
        detail: row.detail,
      }));
  const COLUMNS = ["n", "local", "utc", "perf", "+ms", "event", "vis", "focus", "detail"];

  window.wakevis = {
    rows,
    table(from = 0) {
      console.table(view(from), COLUMNS);
    },
    text(from = 0) {
      const lines = view(from).map((row) => COLUMNS.map((c) => row[c]).join("\t"));
      return [COLUMNS.join("\t"), ...lines].join("\n");
    },
    mark(label = "mark") {
      record("mark", label);
      return rows[rows.length - 1].n;
    },
    logArgs(from = 0) {
      const first = rows.find((row) => row.n >= from);
      const start = (first ? first.wall : Date.now()) - 60_000;
      return `--start "${localTime(start, false)}" --end "${localTime(Date.now() + 5_000, false)}"`;
    },
    clear() {
      rows.length = 0;
      save();
    },
    stop() {
      while (undo.length) undo.pop()();
    },
  };

  const origin = localTime(performance.timeOrigin);
  const how = previous ? "pasted again" : "pasted";
  record("install", `${how}, ${kept} rows kept, page loaded ${origin}`);
  console.info(`wakevis: recording, ${rows.length} rows; wakevis.table() prints them`);
})();
