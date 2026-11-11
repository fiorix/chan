// Names the JavaScript that draws while a chan window is blank after it comes
// back into view. Paste into the window's Web Inspector console
// (`pbcopy < scripts/e2e/wkwebview-stall-probe.js`, Cmd+Opt+I, Console, Cmd+V,
// Return), close the inspector and keep working. After a slow return:
//   copy(stallprobe.text())   then pbpaste into a file
//
// It wraps requestAnimationFrame so each callback remembers the stack that
// scheduled it, and counts Canvas 2D fillText calls. A frame whose callbacks
// take over 50 ms in total is logged with: wall clock, how many callbacks ran
// in that frame, the time and fillText count per scheduling stack. It changes
// no behaviour: callbacks run in the same order with the same arguments.
// stallprobe.stop() restores both functions.
(() => {
  "use strict";
  if (window.stallprobe) window.stallprobe.stop();
  const SLOW_FRAME_MS = 50;
  const MAX_ROWS = 400;
  const rows = [];
  const nativeRaf = window.requestAnimationFrame;
  const proto = CanvasRenderingContext2D.prototype;
  const nativeFillText = proto.fillText;
  let fillTexts = 0;
  proto.fillText = function (...args) {
    fillTexts += 1;
    return nativeFillText.apply(this, args);
  };

  // One frame's bookkeeping, keyed by the timestamp the engine hands every
  // callback of that frame.
  let frameStamp = -1;
  let frame = null;
  const flush = () => {
    if (!frame) return;
    if (frame.ms >= SLOW_FRAME_MS) {
      const sites = [...frame.sites.entries()]
        .map(([stack, s]) => ({ stack, ...s }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 6);
      rows.push({
        wall: new Date(frame.wall).toISOString(),
        ms: Math.round(frame.ms),
        callbacks: frame.callbacks,
        fillTexts: frame.fillTexts,
        vis: document.visibilityState,
        sites,
      });
      if (rows.length > MAX_ROWS) rows.shift();
    }
    frame = null;
  };

  const site = () => {
    const stack = new Error().stack || "";
    // Drop this wrapper's own frames; keep the caller chain, shortened.
    return stack
      .split("\n")
      .slice(2, 8)
      .map((line) => line.trim().replace(/https?:\/\/[^/]+\//, ""))
      .join(" < ");
  };

  window.requestAnimationFrame = function (callback) {
    const from = site();
    return nativeRaf.call(window, (stamp) => {
      if (stamp !== frameStamp) {
        flush();
        frameStamp = stamp;
        frame = { wall: Date.now(), ms: 0, callbacks: 0, fillTexts: 0, sites: new Map() };
        // A frame's row is written when the next frame starts or after it.
        setTimeout(flush, 0);
      }
      const before = fillTexts;
      const started = performance.now();
      try {
        return callback(stamp);
      } finally {
        const ms = performance.now() - started;
        const drew = fillTexts - before;
        if (frame) {
          frame.ms += ms;
          frame.callbacks += 1;
          frame.fillTexts += drew;
          const s = frame.sites.get(from) || { ms: 0, calls: 0, fillTexts: 0 };
          s.ms = Math.round((s.ms + ms) * 10) / 10;
          s.calls += 1;
          s.fillTexts += drew;
          frame.sites.set(from, s);
        }
      }
    });
  };

  window.stallprobe = {
    rows,
    text() {
      return rows
        .map(
          (r) =>
            `${r.wall} frame ${r.ms} ms, ${r.callbacks} callbacks, ${r.fillTexts} fillText, ${r.vis}\n` +
            r.sites
              .map((s) => `    ${s.ms} ms, ${s.calls} calls, ${s.fillTexts} fillText: ${s.stack}`)
              .join("\n"),
        )
        .join("\n");
    },
    clear() {
      rows.length = 0;
    },
    stop() {
      window.requestAnimationFrame = nativeRaf;
      proto.fillText = nativeFillText;
      delete window.stallprobe;
    },
  };
  console.info("stallprobe: recording slow frames; copy(stallprobe.text()) after a slow return");
})();
