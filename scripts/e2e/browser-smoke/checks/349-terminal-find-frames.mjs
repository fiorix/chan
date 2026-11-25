// The terminal widget's own find, `term.search`, at the largest scrollback,
// read in a real browser through the widget's public API: whether it finds,
// steps and keeps the right matches (the verdict), and what its frames cost
// (recorded, not gating).
//
// Every line is numbered ("<stream>:<n> ...") and about one and a half
// times the terminal's width, so it takes two rows and rewraps to three when
// the page narrows, with twelve "e" in it, six to a row: "e" is a dense
// query, and a match is identified by its line and its offset there.
//
//   FILL     -- at scrollback_mb 50 a ghostty terminal prints 60,000 such
//               lines, more than the history holds, so it is full and
//               pruning.
//   BASELINE -- with no search, 100,000 more lines stream; the frames and
//               the widget's own frame work are read.
//   SCAN     -- term.search.find("e") until the count is complete, with no
//               output. The count must equal the "e" in the buffer's plain
//               text, `search-all` must hold every match, and a sample of
//               its ranges must read "e".
//   NEWEST   -- the stream again, find active from the newest match (the
//               stream prunes it).
//   OLDEST   -- find steps to the oldest match (newer from the newest
//               wraps), and the stream again (it prunes that match too).
//   PRESS    -- a fresh find, the active match 20,000 matches up from the
//               oldest, and a slow stream of about 100 lines a second, which
//               writes in most frames and prunes little. Mid-stream one press
//               "newer" must land, before the call returns, on the next "e"
//               after the active match in the buffer as it is then. The slow
//               stream's frames are their own leg.
//   REFLOW   -- with no output, a fresh find steps 70 percent of the way up
//               from the newest match, so each rescan places it late. The
//               page narrows and widens back twice. 1.5 s after each resize
//               the active match must still be highlighted on the same line
//               and offset, placed or not (the JSON and the verdict line say
//               how many of the four readings found its index unplaced);
//               once the count completes it must have the index it had
//               before the reflow. The narrow width must rewrap the active
//               match's line, and at the end the count must again equal the
//               buffer's "e".
//
// The widget's frame work is the time spent in the animation-frame
// callbacks the widget's chunk registers (its render loop, whose search work
// runs before its paint), summed per frame, so it counts search, placement,
// highlight publication and paint together; work the widget does inside a
// write, a resize or a step call is not in it (the press reports its own
// duration). BASELINE is the same stream with no search. Long animation
// frames and frame gaps come from the page.
//
// Verdict: FAIL when a correctness reading above fails, or when a leg saw
// fewer than 30 frames or 30 widget callbacks (the instrument did not see
// the widget). Each leg's frame work median, p95 and maximum, its frames over
// 12 and 16 ms, and whether its p95 is within the 12 ms target are written
// to 349-find-frames.json in the output directory and printed, and do not
// decide the verdict: the core's feed and completion units alone exceed
// 12 ms at this history (the widget's README).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureGhosttyTerminals } from "../lib/ghostty-capture.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB = "SmokeFindFrames349";
const SEGMENT = "a e i o u e e e e e";
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
        window.__find349 = {
          // The "e" in the buffer's plain text, as find counts them.
          count() {
            const text = t.core.plainText() ?? "";
            let n = 0;
            for (let i = 0; i < text.length; i++) if (text[i] === "e" || text[i] === "E") n++;
            return n;
          },
          // The active match by its line's number and its offset in the line.
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
            return { line: line.split(" ")[0], offset: (r.start.absoluteRow - first) * t.cols + r.start.col, rows: last - first + 1, text, range: r };
          },
          // The first "e" after a cell, in the buffer as it is now.
          nextAfter(row, col) {
            const lastRow = t.getScrollbackLength() + t.rows - 1;
            for (let r = row, c = col + 1; r <= lastRow; r++, c = 0) {
              const text = rowText(r);
              for (let i = c; i < text.length; i++) if (text[i] === "e" || text[i] === "E") return { absoluteRow: r, col: i };
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
      // "<stream>:<n> " takes at most nine cells; the rest puts one segment
      // at the start of the line's first row and one at the end of its
      // second.
      const tail = `${SEGMENT} ${"x".repeat(Math.max(1, Math.round(1.5 * cols) - 9 - 2 * SEGMENT.length - 2))} ${SEGMENT}`;
      details.lines = { cols, length: 9 + tail.length };
      let marks = 0;
      // The command line spells the mark with an empty quote inside, so only
      // the output's own line holds it whole.
      async function stream(lines, slow = false) {
        const k = ++marks;
        const mark = `DONE349x${k}y`;
        const body = slow
          ? `for i in $(seq 1 ${lines}); do echo "${k}:$i ${tail}"; sleep 0.01; done`
          : `awk 'BEGIN{for(i=1;i<=${lines};i++) printf "%d:%d %s\\n", ${k}, i, "${tail}"}'`;
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

      // FILL
      await cs(["write", "--tab-name", TAB, "PS1='$ '; clear\n"]);
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
        return { total: t.search.state.total, buffer: window.__find349.count(), all: ranges.length, sampled: Math.ceil(ranges.length / step), wrong: wrong.slice(0, 5), wrongCount: wrong.length };
      });
      const scan = details.correctness.scan;
      if (!(scan.total > 0)) failures.push("scan: no matches");
      if (scan.total !== scan.buffer) failures.push(`scan: the count ${scan.total} is not the buffer's ${scan.buffer} "e"`);
      if (scan.all !== scan.total) failures.push(`scan: search-all holds ${scan.all} ranges for ${scan.total} matches`);
      if (scan.wrongCount) failures.push(`scan: ${scan.wrongCount} of ${scan.sampled} sampled search-all ranges do not read "e": ${JSON.stringify(scan.wrong)}`);

      // NEWEST
      a = await window_();
      const newest = await stream(STREAM);
      await newest.done();
      await until("a complete count after the stream", async () => !(await search()).state.partial);
      details.legs.newest = { ...(await collect(a, await window_())), search: await search() };

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
      await sleep(2000);
      details.press = await term.evaluate((t) => {
        const before = t.highlights.get("search-active")?.ranges?.[0] ?? null;
        const indexBefore = t.search.state.index;
        const started = performance.now();
        t.search.step("e", "newer");
        const ms = performance.now() - started;
        // No write lands inside this call, so the buffer is the one the press saw.
        const after = t.highlights.get("search-active")?.ranges ?? [];
        const expected = before ? window.__find349.nextAfter(before.start.absoluteRow, before.start.col) : null;
        return { before, after, expected, ms, indexBefore, state: t.search.state };
      });
      details.press.streaming = !(await slow.seen());
      await slow.done();
      details.legs.pressStream = await collect(a, await window_());
      const press = details.press;
      const landed = press.after.length === 1 && press.expected !== null &&
        press.after[0].start.absoluteRow === press.expected.absoluteRow && press.after[0].start.col === press.expected.col &&
        press.after[0].end.absoluteRow === press.expected.absoluteRow && press.after[0].end.col === press.expected.col;
      press.landed = landed;
      if (!press.streaming) failures.push("press: the slow stream had ended before the press");
      if (!press.before) failures.push("press: no active match before the press");
      else if (!landed) failures.push(`press: newer from ${JSON.stringify(press.before.start)} landed on ${JSON.stringify(press.after)}, not the next "e" at ${JSON.stringify(press.expected)}`);

      // REFLOW
      await term.evaluate((t) => { t.search.close(); t.search.find("e"); });
      await complete("a complete count for the reflow");
      details.reflowStart = await term.evaluate((t) => {
        // Newer from the newest wraps to the oldest; 30 percent of the way
        // down from there is 70 percent up from the newest, in fewer steps.
        const steps = Math.floor(t.search.state.total * 0.3);
        t.search.step("e", "newer");
        for (let i = 1; i < steps; i++) t.search.step("e", "newer");
        return { steps, state: t.search.state, identity: window.__find349.identity(), history: t.getScrollbackLength(), cols: t.cols };
      });
      const start = details.reflowStart;
      const same = (id) => id !== null && start.identity !== null && id.line === start.identity.line && id.offset === start.identity.offset;
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
      if (!start.identity) failures.push("reflow: no active match before the reflow");
      details.reflow.forEach(({ width, during, settled }, i) => {
        if (!same(during.identity)) failures.push(`reflow ${i + 1} (${width}px): 1.5 s after the resize the active match is ${JSON.stringify(during.identity)}, not line ${start.identity?.line} offset ${start.identity?.offset}`);
        if (!same(settled.identity)) failures.push(`reflow ${i + 1} (${width}px): once counted the active match is ${JSON.stringify(settled.identity)}, not line ${start.identity?.line} offset ${start.identity?.offset}`);
        if (settled.state.index !== start.state.index) failures.push(`reflow ${i + 1} (${width}px): once counted the index is ${settled.state.index}, not ${start.state.index}`);
      });
      const narrow = details.reflow[0]?.settled.identity;
      if (narrow && start.identity && !(narrow.rows > start.identity.rows)) failures.push(`reflow: the narrow width did not rewrap the active match's line (${start.identity.rows} rows at ${start.cols} columns, ${narrow.rows} at ${details.reflow[0].settled.cols})`);
      const end = details.correctness.reflowEnd;
      if (end.total !== end.buffer) failures.push(`reflow: the final count ${end.total} is not the buffer's ${end.buffer} "e"`);

      // Verdict: correctness readings and the instrument gate; frame numbers are recorded.
      for (const [name, leg] of Object.entries(details.legs)) {
        if (leg.frames < 30 || leg.work.frames < 30) failures.push(`${name}: the instrument saw ${leg.frames} frames and ${leg.work.frames} widget frames`);
      }
      details.verdict = failures.length ? "FAIL" : "PASS";
      details.failures = failures;
      details.frames = Object.fromEntries(Object.entries(details.legs).map(([n, l]) => [n,
        `work p50/p95/max ${l.work.median}/${l.work.p95}/${l.work.max} ms, ${l.work.withinTarget ? "within" : "over"} the ${TARGET_MS} ms target, over12 ${l.work.over12}/${l.work.frames}, over16 ${l.work.over16}, gap p95 ${l.gap.p95}, loaf ${l.loaf.count} max ${l.loaf.max}`]));
      writeFileSync(join(ctx.outDir, "349-find-frames.json"), JSON.stringify(details, null, 2) + "\n");
      console.log(`349 frames (recorded, not gating): ${JSON.stringify(details.frames)}`);
      details.reflowUnplacedAt1500 = details.reflow.filter(({ during }) => during.state.index === null).length;
      console.log(`349 verdict: ${details.verdict} count=${scan.total}/${scan.buffer} press=${press.landed ? "neighbour" : "wrong"} ${press.ms.toFixed(2)} ms index-before=${press.indexBefore} reflow=${details.reflow.every(({ during, settled }) => same(during.identity) && same(settled.identity) && settled.state.index === start.state.index) ? "kept" : "lost"} unplaced-at-1.5s=${details.reflowUnplacedAt1500}/4`);
      if (failures.length) throw new Error(`349 verdict: FAIL: ${failures.join("; ")}`);
      return { verdict: details.verdict, frames: details.frames, press: details.press, reflow: details.reflow };
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
