// Frame cost of the terminal widget's own find, `term.search`, at the
// largest scrollback, read in a real browser through the widget's public API.
//
//   FILL     -- at scrollback_mb 50 a ghostty terminal prints 400,000 lines
//               of six "e" each, more than the history holds, so it is full
//               and pruning, and "e" is a dense query.
//   BASELINE -- with no search, 200,000 more such lines stream; the frames
//               and the widget's own frame work are read.
//   SCAN     -- term.search.find("e") until the count is complete: the scan
//               and placement frames with no output.
//   NEWEST   -- the stream again, with the active match the newest.
//   OLDEST   -- the active match steps to the oldest (newer from the newest
//               wraps), and the stream again.
//   PRESS    -- a fresh find, the active match 20,000 matches up from the
//               oldest, and a slow stream of about 100 lines a second, which
//               writes in most frames and prunes little. Mid-stream one
//               press "newer" must move the active match before the call
//               returns: the match is deep in a list that placement starts
//               again after every write.
//   REFLOW   -- the page narrows and widens back twice; after each resize
//               the active match still reads "e".
//
// The widget's frame work is the time spent in the animation-frame
// callbacks the widget's chunk registers (its render loop, whose search work
// runs before its paint), summed per frame, so it counts search, placement,
// highlight publication and paint together. BASELINE is the same stream
// with no search. Long animation frames and frame gaps come from the page.
//
// Verdict: PASS when every find leg's widget frame work has a p95 of at most
// 12 ms, the PRESS moved at once while the stream ran, and REFLOW kept its
// match; each leg
// must see at least 30 frames and 30 widget callbacks, or the instrument did
// not see the widget and the check fails. The details are written to
// 349-find-frames.json in the output directory.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureGhosttyTerminals } from "../lib/ghostty-capture.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB = "SmokeFindFrames349";
const LINE = "a e i o u e e e e e";
const TARGET_MS = 12;
// Lines per fast stream: several seconds of output at the largest history.
const STREAM = 1_000_000;
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
    const details = { legs: {} };
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
      let marks = 0;
      // The command line spells the mark with an empty quote inside, so only
      // the output's own line holds it whole.
      async function stream(lines, slow = false) {
        const mark = `DONE349x${++marks}y`;
        const body = slow
          ? `for i in $(seq 1 ${lines}); do echo '${LINE}'; sleep 0.01; done`
          : `yes '${LINE}' | head -n ${lines}`;
        await cs(["write", "--tab-name", TAB, `${body}; echo DONE349x${marks}''y\n`]);
        return { mark, done: () => until(`stream ${mark}`, () => screenHas(mark)), seen: () => screenHas(mark) };
      }
      const window_ = () => page.evaluate(() => performance.now());
      const collect = (a, b) => page.evaluate(([a, b]) => {
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
        return {
          ms: r2(b - a),
          frames: frames.length,
          gap: { median: r2(q(gaps, 0.5)), p95: r2(q(gaps, 0.95)), max: r2(q(gaps, 1)) },
          work: { frames: work.length, median: r2(q(work, 0.5)), p95: r2(q(work, 0.95)), max: r2(q(work, 1)),
            over12: work.filter((w) => w > 12).length, over16: work.filter((w) => w > 16).length },
          loaf: { count: loaf.length, max: r2(Math.max(0, ...loaf.map((e) => e.duration))) },
        };
      }, [a, b]);
      const search = () => term.evaluate((t) => ({
        state: t.search.state,
        active: t.highlights.get("search-active")?.ranges?.[0] ?? null,
        history: t.getScrollbackLength(),
      }));
      const activeText = () => term.evaluate((t) => {
        const r = t.highlights.get("search-active")?.ranges?.[0];
        return r ? t.core.plainText({ startRow: r.start.absoluteRow, startCol: r.start.col, endRow: r.end.absoluteRow, endCol: r.end.col }) : null;
      });

      // FILL
      await cs(["write", "--tab-name", TAB, "PS1='$ '; clear\n"]);
      const fill = await stream(400_000);
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
      await until("a complete count", async () => {
        const s = await search();
        return s.state.total > 0 && !s.state.partial;
      });
      details.legs.scan = { ...(await collect(a, await window_())), search: await search() };

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
      await until("a complete count for the press", async () => {
        const s = await search();
        return s.state.total > 0 && !s.state.partial;
      });
      details.pressStart = await term.evaluate((t) => {
        t.search.step("e", "newer");
        for (let i = 0; i < 20_000; i++) t.search.step("e", "newer");
        return { state: t.search.state, active: t.highlights.get("search-active")?.ranges?.[0] ?? null };
      });
      const slow = await stream(3000, true);
      await sleep(2000);
      details.press = await term.evaluate((t) => {
        const read = () => JSON.stringify(t.highlights.get("search-active")?.ranges ?? []);
        const before = read();
        const started = performance.now();
        t.search.step("e", "newer");
        return { before, after: read(), ms: performance.now() - started, state: t.search.state };
      });
      details.press.streaming = !(await slow.seen());
      details.press.moved = details.press.after !== details.press.before && details.press.after !== "[]";
      await slow.done();

      // REFLOW
      a = await window_();
      details.reflow = [];
      for (const width of [Math.round(pageViewport.width * 0.7), pageViewport.width, Math.round(pageViewport.width * 0.7), pageViewport.width]) {
        await page.setViewport({ ...pageViewport, width });
        await sleep(1500);
        details.reflow.push({ width, text: await activeText(), search: await search() });
      }
      details.legs.reflow = await collect(a, await window_());
      details.reflowKept = details.reflow.every((r) => r.text?.toLowerCase() === "e");

      // Verdict
      const failures = [];
      for (const [name, leg] of Object.entries(details.legs)) {
        if (leg.frames < 30 || leg.work.frames < 30) failures.push(`${name}: the instrument saw ${leg.frames} frames and ${leg.work.frames} widget frames`);
        if (name !== "baseline" && leg.work.p95 > TARGET_MS) failures.push(`${name}: widget frame work p95 ${leg.work.p95} ms over ${TARGET_MS} ms`);
      }
      if (!(details.legs.scan.search.state.total > 0)) failures.push("scan: no matches");
      if (!details.press.streaming) failures.push("press: the slow stream had ended before the press");
      if (!details.press.moved) failures.push(`press: the press during the stream did not move the active match (${details.press.before})`);
      if (!details.reflowKept) failures.push(`reflow: the active match did not stay on the needle: ${JSON.stringify(details.reflow.map((r) => r.text))}`);
      details.verdict = failures.length ? "FAIL" : "PASS";
      details.failures = failures;
      const summary = Object.fromEntries(Object.entries(details.legs).map(([n, l]) => [n, `work p50/p95/max ${l.work.median}/${l.work.p95}/${l.work.max} ms, over12 ${l.work.over12}/${l.work.frames}, gap p95 ${l.gap.p95}, loaf ${l.loaf.count}`]));
      details.summary = summary;
      writeFileSync(join(ctx.outDir, "349-find-frames.json"), JSON.stringify(details, null, 2) + "\n");
      console.log(`349 verdict: ${details.verdict} ${JSON.stringify(summary)} press=${details.press.moved ? "moved" : "waited"} ${details.press.ms.toFixed(2)} ms reflow=${details.reflowKept ? "kept" : "lost"}`);
      if (failures.length) throw new Error(`349 verdict: FAIL: ${failures.join("; ")}`);
      return { verdict: details.verdict, summary, press: details.press, reflowKept: details.reflowKept };
    } finally {
      if (pageViewport) await page.setViewport(pageViewport).catch(() => {});
      await cs(["close", "--tab-name", TAB]).catch(() => {});
      await page.evaluate(() => {
        if (window.__frames349) window.requestAnimationFrame = window.__frames349.raf;
        delete window.__frames349;
        window.__ghostty349?.restore();
      }).catch(() => {});
      await restoreTerminalPrefs(ctx, page, token, original).catch(() => {});
    }
  },
};
