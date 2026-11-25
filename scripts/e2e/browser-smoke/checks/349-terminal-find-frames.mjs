// The terminal widget's own find, `term.search`, at the largest scrollback,
// read in a real browser through the widget's public API: whether it finds,
// steps and keeps the right matches (the verdict), and what its frames cost
// (recorded, not gating).
//
// Every line is numbered ("<stream>:<nnnnnn> ...") and about 1.3 times the
// terminal's width, so it takes two rows both at that width and at 0.7 of
// it, and a reflow between the two widths prunes nothing. It holds twelve
// "e" in two segments, one at its start and one at 0.8 of the width, which
// sits on the line's first row at the full width and on its second at 0.7
// of it. "e" is a dense query, and a match is identified by its line and
// its offset there. The streams print the line's tail from a shell
// variable, so every command line is short and keeps its rows at both
// widths.
//
//   FILL     -- at scrollback_mb 50 a ghostty terminal prints 60,000 such
//               lines, more than the history holds, so it is full and
//               pruning.
//   BASELINE -- with no search, 100,000 more lines stream; the frames and
//               the widget's own frame work are read.
//   SCAN     -- term.search.find("e") until the count is complete, with no
//               output. The count must equal the "e" in the buffer's plain
//               text, `search-all` must hold every match, a sample of its
//               ranges must read "e", and the active match must be the
//               buffer's last "e" with index 1, wherever the core lists it.
//               That reading counts only when the core lists another match
//               first (its instrument), since only then can it tell find's
//               position order from the core's own.
//   NEWEST   -- the stream again, find active from the newest match (the
//               stream prunes it).
//   WRAP     -- find steps to the oldest match, one echoed line follows,
//               and older, pressed while the rescan that line started is
//               partial (its instrument), must first land on the buffer's
//               last "e", in the call or within five seconds.
//   OLDEST   -- find steps to the oldest match (newer from the newest
//               wraps), and the stream again (it prunes that match too).
//   PRESS    -- a fresh find, the active match 20,000 matches up from the
//               oldest, and a slow stream of about 100 lines a second, which
//               writes in most frames and prunes little. Mid-stream a press
//               "newer" must land, before the call returns, on the next "e"
//               after the active match in the buffer as it is then, and a
//               second later a press "older" on the "e" before the active
//               match then. The slow stream's frames are their own leg.
//   REFLOW   -- with no output, a fresh find steps to a match of a line's
//               second segment at least 90 percent of the way up from the
//               newest match, so each rescan places it late. The page
//               narrows and widens back twice. The leg reads find only when
//               its instrument holds: the count and the history's rows
//               after each resize equal those before (the reflow pruned
//               nothing and no line changed its rows), the narrow
//               width moves the active match to its line's second row, and
//               1.5 s after the first narrowing the match is kept with its
//               index unplaced (the reading is past the one-second press
//               cap and ahead of placement). Then 1.5 s after each resize
//               the active match must still be highlighted on the same line
//               and offset, on the row of its line that offset falls on at
//               that width and reading "e", placed or not, and once the
//               count completes it must have the index it had before the
//               reflow. At the end the count must again equal the buffer's
//               "e".
//
// The widget's frame work is the time spent in the animation-frame
// callbacks the widget's chunk registers (its render loop, whose search work
// runs before its paint), summed per frame, so it counts search, placement,
// highlight publication and paint together; work the widget does inside a
// write, a resize or a step call is not in it (each press reports its own
// duration). BASELINE is the same stream with no search. Long animation
// frames and frame gaps come from the page.
//
// Verdict: FAIL when a correctness reading above fails, when an instrument
// above does not hold, or when a leg saw fewer than 30 frames or 30
// widget callbacks (the instrument did not see the widget). Each leg's frame
// work median, p95 and maximum, its frames over 12 and 16 ms, and whether
// its p95 is within the 12 ms target are written to 349-find-frames.json in
// the output directory and printed, and do not decide the verdict: the
// core's feed and completion units alone exceed 12 ms at this history (the
// widget's README).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureGhosttyTerminals } from "../lib/ghostty-capture.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB = "SmokeFindFrames349";
const SEGMENT = "a e i o u e e e e e";
// "<stream>:<nnnnnn> ", the fixed-width number every line opens with.
const PREFIX = 9;
const TARGET_MS = 12;
// Lines per fast stream: several seconds of output at the largest history.
const STREAM = 100_000;
const FILL = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "terminal-find-frames",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const windowId = await page.evaluate(
      () => new URL(location.href).searchParams.get("w")?.trim() || window.sessionStorage.getItem("chan.session.window")?.trim() || "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const env = { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId };
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], { cwd: ctx.workspaceDir, env, timeout: 120_000 });
    const original = await readTerminalPrefs(page, token);
    const pageViewport = page.viewport();
    if (!pageViewport) throw new Error("the page has no fixed viewport to narrow");
    const details = { legs: {}, correctness: {} };
    try {
      const chunk = await captureGhosttyTerminals(page, "__ghostty349");
      if (!chunk) throw new Error("no entry module of the page names a ghostty-web chunk");
      details.setup = await page.evaluate((chunk) => {
        const file = new URL(chunk).pathname.split("/").pop();
        const raf = window.requestAnimationFrame.bind(window);
        const probe = window.__frames349 = { frames: [], work: new Map(), callbacks: 0, loaf: [], raf };
        const loop = (t) => { probe.frames.push(t); raf(loop); };
        raf(loop);
        window.requestAnimationFrame = (callback) => {
          if (!(new Error().stack ?? "").includes(file)) return raf(callback);
          return raf((t) => {
            const started = performance.now();
            try { callback(t); } finally {
              probe.callbacks++;
              probe.work.set(t, (probe.work.get(t) ?? 0) + performance.now() - started);
            }
          });
        };
        const loaf = PerformanceObserver.supportedEntryTypes.includes("long-animation-frame");
        if (loaf) new PerformanceObserver((list) => {
          for (const e of list.getEntries()) probe.loaf.push({ startTime: e.startTime, duration: e.duration });
        }).observe({ type: "long-animation-frame" });
        return { file, loaf, ua: navigator.userAgent };
      }, chunk);
      await writeTerminalPrefs(page, token, { scrollback_mb: 50 });
      const row = await openAttachedTerminal(ctx, page, cs, windowId, TAB, "ghostty");
      const hostQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"] .terminal-host`;
      const term = await page.evaluateHandle((q) => window.__ghostty349.term(q), hostQuery);
      // Readers the page keeps for every leg, on the widget's public API.
      await term.evaluate((t) => {
        const wrapped = (row) => {
          const sb = t.getScrollbackLength();
          return row >= sb ? t.core.isRowWrapped(row - sb) : t.core.isScrollbackRowWrapped(row);
        };
        const rowText = (row) => t.core.plainText({ startRow: row, startCol: 0, endRow: row, endCol: t.cols - 1 }) ?? "";
        const isE = (c) => c === "e" || c === "E";
        window.__find349 = {
          // The "e" in the buffer's plain text, as find counts them.
          count() {
            const text = t.core.plainText() ?? "";
            let n = 0;
            for (let i = 0; i < text.length; i++) if (isE(text[i])) n++;
            return n;
          },
          // The active match by its line's number, its offset in the line
          // and the row of the line it starts on.
          identity() {
            const r = t.highlights.get("search-active")?.ranges?.[0];
            if (!r) return null;
            const lastRow = t.getScrollbackLength() + t.rows - 1;
            let first = r.start.absoluteRow;
            while (first > 0 && wrapped(first)) first--;
            let last = r.start.absoluteRow;
            while (last < lastRow && wrapped(last + 1)) last++;
            const line = t.core.plainText({ startRow: first, startCol: 0, endRow: last, endCol: t.cols - 1 }) ?? "";
            const text = t.core.plainText({ startRow: r.start.absoluteRow, startCol: r.start.col, endRow: r.end.absoluteRow, endCol: r.end.col });
            return {
              line: line.split(" ")[0], offset: (r.start.absoluteRow - first) * t.cols + r.start.col,
              rowInLine: r.start.absoluteRow - first, rows: last - first + 1, text, range: r,
            };
          },
          // The first "e" after a cell, in the buffer as it is now.
          nextAfter(row, col) {
            const lastRow = t.getScrollbackLength() + t.rows - 1;
            for (let r = row, c = col + 1; r <= lastRow; r++, c = 0) {
              const text = rowText(r);
              for (let i = c; i < text.length; i++) if (isE(text[i])) return { absoluteRow: r, col: i };
            }
            return null;
          },
          // The last "e" before a cell, in the buffer as it is now; with no
          // cell, the buffer's last "e".
          lastBefore(row = t.getScrollbackLength() + t.rows - 1, col = t.cols) {
            for (let r = row, c = col - 1; r >= 0; r--, c = Infinity) {
              const text = rowText(r);
              for (let i = Math.min(c, text.length - 1); i >= 0; i--) if (isE(text[i])) return { absoluteRow: r, col: i };
            }
            return null;
          },
        };
      });
      const screenHas = (mark) => term.evaluate((t, mark) => {
        const sb = t.getScrollbackLength();
        return (t.core.plainText({ startRow: sb, startCol: 0, endRow: sb + t.rows - 1, endCol: t.cols - 1 }) ?? "").includes(mark);
      }, mark);
      async function until(what, read, ms = 180_000) {
        const end = Date.now() + ms;
        for (;;) {
          const value = await read();
          if (value) return value;
          if (Date.now() > end) throw new Error(`timed out: ${what}`);
          await sleep(200);
        }
      }
      const cols = await term.evaluate((t) => t.cols);
      // The second segment opens at 0.8 of the width; the line ends at 1.3.
      const second = Math.round(0.8 * cols);
      const gap = second - PREFIX - SEGMENT.length - 2;
      const end = Math.round(1.3 * cols) - second - SEGMENT.length - 1;
      if (gap < 1 || end < 1) throw new Error(`a ${cols}-column terminal is too narrow for the line shape`);
      const tail = `${SEGMENT} ${"x".repeat(gap)} ${SEGMENT} ${"x".repeat(end)}`;
      details.lines = { cols, length: PREFIX + tail.length, second };
      let marks = 0;
      // The command line spells the mark with an empty quote inside, so only
      // the output's own line holds it whole.
      async function stream(lines, slow = false) {
        const k = ++marks;
        const mark = `DONE349x${k}y`;
        const body = slow
          ? `for i in $(seq 1 ${lines}); do printf '%d:%06d %s\\n' ${k} $i "$T"; sleep 0.01; done`
          : `awk -v t="$T" 'BEGIN{for(i=1;i<=${lines};i++) printf "%d:%06d %s\\n", ${k}, i, t}'`;
        await cs(["write", "--tab-name", TAB, `${body}; echo DONE349x${k}''y\n`]);
        return { mark, done: () => until(`stream ${mark}`, () => screenHas(mark)), seen: () => screenHas(mark) };
      }
      const window_ = () => page.evaluate(() => performance.now());
      const collect = (a, b) => page.evaluate(([a, b, target]) => {
        const probe = window.__frames349;
        const q = (xs, p) => {
          const s = [...xs].sort((x, y) => x - y);
          return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : null;
        };
        const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
        const frames = probe.frames.filter((t) => t >= a && t <= b);
        const gaps = frames.slice(1).map((t, i) => t - frames[i]);
        const work = [...probe.work].filter(([t]) => t >= a && t <= b).map(([, ms]) => ms);
        const loaf = probe.loaf.filter((e) => e.startTime >= a && e.startTime <= b);
        const p95 = r2(q(work, 0.95));
        return {
          ms: r2(b - a),
          frames: frames.length,
          gap: { median: r2(q(gaps, 0.5)), p95: r2(q(gaps, 0.95)), max: r2(q(gaps, 1)) },
          work: { frames: work.length, median: r2(q(work, 0.5)), p95, max: r2(q(work, 1)),
            over12: work.filter((w) => w > 12).length, over16: work.filter((w) => w > 16).length,
            withinTarget: p95 != null && p95 <= target },
          loaf: { count: loaf.length, max: r2(Math.max(0, ...loaf.map((e) => e.duration))) },
        };
      }, [a, b, TARGET_MS]);
      const search = () => term.evaluate((t) => ({
        state: t.search.state,
        active: t.highlights.get("search-active")?.ranges?.[0] ?? null,
        history: t.getScrollbackLength(),
      }));
      const complete = (what) => until(what, async () => {
        const s = await search();
        return s.state.total > 0 && !s.state.partial;
      });
      const failures = [];
      const at = (cell) => JSON.stringify(cell);
      const onCell = (range, cell) => range !== null && cell !== null &&
        range.start.absoluteRow === cell.absoluteRow && range.start.col === cell.col &&
        range.end.absoluteRow === cell.absoluteRow && range.end.col === cell.col;

      // FILL
      await cs(["write", "--tab-name", TAB, `PS1='$ '; T='${tail}'; clear\n`]);
      const fill = await stream(FILL);
      await fill.done();
      details.fill = await term.evaluate((t) => ({ cols: t.cols, rows: t.rows, history: t.getScrollbackLength() }));

      // BASELINE
      let a = await window_();
      const base = await stream(STREAM);
      await base.done();
      details.legs.baseline = await collect(a, await window_());

      // SCAN
      a = await window_();
      await term.evaluate((t) => t.search.find("e"));
      await complete("a complete count");
      details.legs.scan = { ...(await collect(a, await window_())), search: await search() };
      details.correctness.scan = await term.evaluate((t) => {
        const ranges = t.highlights.get("search-all")?.ranges ?? [];
        const step = Math.max(1, Math.floor(ranges.length / 1000));
        const wrong = [];
        for (let i = 0; i < ranges.length; i += step) {
          const r = ranges[i];
          const text = t.core.plainText({ startRow: r.start.absoluteRow, startCol: r.start.col, endRow: r.end.absoluteRow, endCol: r.end.col });
          if (text?.toLowerCase() !== "e") wrong.push({ range: r, text });
        }
        return {
          total: t.search.state.total, buffer: window.__find349.count(), all: ranges.length, sampled: Math.ceil(ranges.length / step),
          wrong: wrong.slice(0, 5), wrongCount: wrong.length,
          index: t.search.state.index, active: t.highlights.get("search-active")?.ranges?.[0] ?? null, last: window.__find349.lastBefore(),
          coreFirst: (() => {
            const raw = t.core.createSearch();
            try {
              raw.setNeedle("e");
              raw.feed();
              return raw.matchesBetween(0, Number.MAX_SAFE_INTEGER, 1)[0] ?? null;
            } finally {
              raw.free();
            }
          })(),
        };
      });
      const scan = details.correctness.scan;
      scan.newest = onCell(scan.active, scan.last) && scan.index === 1;
      const coreFirst = scan.coreFirst && { start: { absoluteRow: scan.coreFirst.startRow, col: scan.coreFirst.startCol }, end: { absoluteRow: scan.coreFirst.endRow, col: scan.coreFirst.endCol } };
      if (!coreFirst || onCell(coreFirst, scan.last)) {
        failures.push(`scan instrument: the core lists ${at(scan.coreFirst)} first, the buffer's last "e" at ${at(scan.last)} or nothing, so the newest reading cannot tell find's order from the core's`);
      }
      if (!(scan.total > 0)) failures.push("scan: no matches");
      if (scan.total !== scan.buffer) failures.push(`scan: the count ${scan.total} is not the buffer's ${scan.buffer} "e"`);
      if (scan.all !== scan.total) failures.push(`scan: search-all holds ${scan.all} ranges for ${scan.total} matches`);
      if (scan.wrongCount) failures.push(`scan: ${scan.wrongCount} of ${scan.sampled} sampled search-all ranges do not read "e": ${JSON.stringify(scan.wrong)}`);
      if (!scan.newest) failures.push(`scan: find activated ${at(scan.active)} as index ${scan.index}, not the buffer's last "e" at ${at(scan.last)} as index 1`);

      // NEWEST
      a = await window_();
      const newest = await stream(STREAM);
      await newest.done();
      await until("a complete count after the stream", async () => !(await search()).state.partial);
      details.legs.newest = { ...(await collect(a, await window_())), search: await search() };

      // WRAP
      await term.evaluate((t) => t.search.step("e", "newer"));
      details.wrapStart = await search();
      await cs(["write", "--tab-name", TAB, "echo sev''en349\n"]);
      await until("the echoed line", () => screenHas("seven349"));
      details.wrap = await term.evaluate((t) => {
        const before = t.search.state;
        t.search.step("e", "older");
        return { before, state: t.search.state };
      });
      details.wrap.after = await until("a landing after the wrap", async () => (await search()).active, 5_000).catch(() => null);
      details.wrap.expected = await term.evaluate(() => window.__find349.lastBefore());
      details.wrap.landed = onCell(details.wrap.after, details.wrap.expected);
      if (!details.wrap.before.partial) failures.push("wrap instrument: the count was complete before the press, so the press read no rescan");
      else if (!details.wrap.landed) failures.push(`wrap: older from the oldest after output landed on ${at(details.wrap.after)}, not the buffer's last "e" at ${at(details.wrap.expected)}`);
      await until("a complete count after the wrap", async () => !(await search()).state.partial);

      // OLDEST
      await term.evaluate((t) => t.search.step("e", "newer"));
      details.oldestStart = await search();
      a = await window_();
      const oldest = await stream(STREAM);
      await oldest.done();
      await until("a complete count after the stream", async () => !(await search()).state.partial);
      details.legs.oldest = { ...(await collect(a, await window_())), search: await search() };

      // PRESS
      await term.evaluate((t) => { t.search.close(); t.search.find("e"); });
      await complete("a complete count for the press");
      details.pressStart = await term.evaluate((t) => {
        t.search.step("e", "newer");
        for (let i = 0; i < 20_000; i++) t.search.step("e", "newer");
        return { state: t.search.state, identity: window.__find349.identity() };
      });
      a = await window_();
      const slow = await stream(3000, true);
      const press = (direction) => term.evaluate((t, direction) => {
        const before = t.highlights.get("search-active")?.ranges?.[0] ?? null;
        const indexBefore = t.search.state.index;
        const started = performance.now();
        t.search.step("e", direction);
        const ms = performance.now() - started;
        // No write lands inside this call, so the buffer is the one the press saw.
        const after = t.highlights.get("search-active")?.ranges ?? [];
        const expected = !before ? null : direction === "newer"
          ? window.__find349.nextAfter(before.start.absoluteRow, before.start.col)
          : window.__find349.lastBefore(before.start.absoluteRow, before.start.col);
        return { direction, before, after, expected, ms, indexBefore, state: t.search.state };
      }, direction);
      await sleep(2000);
      details.presses = [await press("newer")];
      details.presses[0].streaming = !(await slow.seen());
      await sleep(1000);
      details.presses.push(await press("older"));
      details.presses[1].streaming = !(await slow.seen());
      await slow.done();
      details.legs.pressStream = await collect(a, await window_());
      for (const p of details.presses) {
        p.landed = p.after.length === 1 && onCell(p.after[0], p.expected);
        if (!p.streaming) failures.push(`press ${p.direction}: the slow stream had ended before the press`);
        if (!p.before) failures.push(`press ${p.direction}: no active match before the press`);
        else if (!p.landed) failures.push(`press ${p.direction}: from ${at(p.before.start)} landed on ${at(p.after)}, not the "e" at ${at(p.expected)}`);
      }

      // REFLOW
      await term.evaluate((t) => { t.search.close(); t.search.find("e"); });
      await complete("a complete count for the reflow");
      details.reflowStart = await term.evaluate((t, [second, length]) => {
        // Newer from the newest wraps to the oldest; a tenth of the way down
        // from there is 90 percent up from the newest, in fewer steps. Then
        // on, newer, to a match of the line's second segment, at most 12
        // steps, which the count leaves room for.
        const steps = Math.max(1, Math.floor(t.search.state.total * 0.1) - 12);
        for (let i = 0; i < steps; i++) t.search.step("e", "newer");
        const onSecond = (id) => id !== null && id.offset >= second && id.offset < second + length;
        for (let i = 0; i < 12 && !onSecond(window.__find349.identity()); i++) t.search.step("e", "newer");
        const identity = window.__find349.identity();
        return { steps, state: t.search.state, identity, onSecond: onSecond(identity), history: t.getScrollbackLength(), cols: t.cols };
      }, [second, SEGMENT.length]);
      const start = details.reflowStart;
      // The match on its line and offset, read where that offset falls at
      // the reading's width: a highlight left on its old cell keeps the
      // offset, since lines keep their rows, but not the row or the "e".
      const same = (reading) => {
        const id = reading?.identity ?? null;
        return id !== null && start.identity !== null && id.line === start.identity.line && id.offset === start.identity.offset &&
          id.text === "e" && id.rowInLine === Math.floor(id.offset / reading.cols);
      };
      a = await window_();
      details.reflow = [];
      for (const width of [Math.round(pageViewport.width * 0.7), pageViewport.width, Math.round(pageViewport.width * 0.7), pageViewport.width]) {
        await page.setViewport({ ...pageViewport, width });
        await sleep(1500);
        const during = await term.evaluate((t) => ({ state: t.search.state, identity: window.__find349.identity(), cols: t.cols, history: t.getScrollbackLength() }));
        await until(`a complete count at width ${width}`, async () => !(await search()).state.partial);
        const settled = await term.evaluate((t) => ({ state: t.search.state, identity: window.__find349.identity(), cols: t.cols, history: t.getScrollbackLength() }));
        details.reflow.push({ width, during, settled });
      }
      details.legs.reflow = await collect(a, await window_());
      details.correctness.reflowEnd = await term.evaluate((t) => ({ total: t.search.state.total, buffer: window.__find349.count() }));
      details.reflowUnplacedAt1500 = details.reflow.filter(({ during }) => same(during) && during.state.index === null).length;
      // The instrument: what the leg needs of the buffer and of the timing
      // before its readings say anything about find.
      const instrument = [];
      if (!start.identity) instrument.push("no active match before the reflow");
      else {
        if (!start.onSecond) instrument.push(`the active match ${at(start.identity)} is not on a line's second segment`);
        if (!(start.state.index >= 0.9 * start.state.total)) instrument.push(`the active match is index ${start.state.index} of ${start.state.total}, less than 90 percent up`);
        const narrow = details.reflow[0]?.settled.cols;
        if (Math.floor(start.identity.offset / start.cols) === Math.floor(start.identity.offset / narrow)) {
          instrument.push(`offset ${start.identity.offset} is on the same row of its line at ${start.cols} and ${narrow} columns`);
        }
      }
      details.reflow.forEach(({ width, settled }, i) => {
        if (settled.state.total !== start.state.total) instrument.push(`resize ${i + 1} (${width}px) took the count from ${start.state.total} to ${settled.state.total}: the reflow pruned matches`);
        if (settled.history !== start.history) instrument.push(`resize ${i + 1} (${width}px) took the history from ${start.history} to ${settled.history} rows: a line changed its rows`);
      });
      const first = details.reflow[0]?.during;
      if (first && same(first) && first.state.index !== null) instrument.push(`1.5 s after the first narrowing the active match was placed as index ${first.state.index}, so the reading is not past the press cap ahead of placement`);
      for (const message of instrument) failures.push(`reflow instrument: ${message}`);
      if (!instrument.length) {
        details.reflow.forEach(({ width, during, settled }, i) => {
          if (!same(during)) failures.push(`reflow ${i + 1} (${width}px): 1.5 s after the resize the active match is ${at(during.identity)}, not line ${start.identity.line} offset ${start.identity.offset}`);
          if (!same(settled)) failures.push(`reflow ${i + 1} (${width}px): once counted the active match is ${at(settled.identity)}, not line ${start.identity.line} offset ${start.identity.offset}`);
          if (settled.state.index !== start.state.index) failures.push(`reflow ${i + 1} (${width}px): once counted the index is ${settled.state.index}, not ${start.state.index}`);
        });
      }
      const reflowEnd = details.correctness.reflowEnd;
      if (reflowEnd.total !== reflowEnd.buffer) failures.push(`reflow: the final count ${reflowEnd.total} is not the buffer's ${reflowEnd.buffer} "e"`);

      // Verdict: correctness readings and the instrument gates; frame numbers are recorded.
      for (const [name, leg] of Object.entries(details.legs)) {
        if (leg.frames < 30 || leg.work.frames < 30) failures.push(`${name}: the instrument saw ${leg.frames} frames and ${leg.work.frames} widget frames`);
      }
      const reflowKept = !instrument.length &&
        details.reflow.every(({ during, settled }) => same(during) && same(settled) && settled.state.index === start.state.index);
      details.verdict = failures.length ? "FAIL" : "PASS";
      details.failures = failures;
      details.frames = Object.fromEntries(Object.entries(details.legs).map(([n, l]) => [n,
        `work p50/p95/max ${l.work.median}/${l.work.p95}/${l.work.max} ms, ${l.work.withinTarget ? "within" : "over"} the ${TARGET_MS} ms target, over12 ${l.work.over12}/${l.work.frames}, over16 ${l.work.over16}, gap p95 ${l.gap.p95}, loaf ${l.loaf.count} max ${l.loaf.max}`]));
      writeFileSync(join(ctx.outDir, "349-find-frames.json"), JSON.stringify(details, null, 2) + "\n");
      console.log(`349 frames (recorded, not gating): ${JSON.stringify(details.frames)}`);
      const presses = details.presses.map((p) => `${p.direction}:${p.landed ? "neighbour" : "wrong"} ${p.ms.toFixed(2)} ms index-before=${p.indexBefore}`).join(" ");
      const wrap = !details.wrap.before.partial ? "instrument" : details.wrap.landed ? "newest" : "wrong";
      console.log(`349 verdict: ${details.verdict} count=${scan.total}/${scan.buffer} newest=${scan.newest ? "bottom-most" : "wrong"} wrap=${wrap} press=${presses} reflow=${instrument.length ? "instrument" : reflowKept ? "kept" : "lost"} unplaced-at-1.5s=${details.reflowUnplacedAt1500}/4`);
      if (failures.length) throw new Error(`349 verdict: FAIL: ${failures.join("; ")}`);
      return { verdict: details.verdict, frames: details.frames, presses: details.presses, reflow: details.reflow };
    } finally {
      if (pageViewport) await page.setViewport(pageViewport).catch(() => {});
      await cs(["close", "--tab-name", TAB]).catch(() => {});
      await page.evaluate(() => {
        if (window.__frames349) window.requestAnimationFrame = window.__frames349.raf;
        delete window.__frames349;
        delete window.__find349;
        window.__ghostty349?.restore();
      }).catch(() => {});
      await restoreTerminalPrefs(ctx, page, token, original).catch(() => {});
    }
  },
};
