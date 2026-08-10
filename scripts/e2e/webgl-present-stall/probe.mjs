/// The page under test for webgl-present-stall.py: one real terminal that
/// writes into an otherwise idle page, on a schedule the driver only watches.
///
/// WHY the page drives itself: the fault under test is that a write is drawn
/// into the GL canvas but not PRESENTED to screen until some later event wakes
/// the compositor. Anything the driver does to the engine to trigger or read a
/// write -- run_javascript, get_snapshot, a synthetic key event -- is itself
/// such an event, and would mask exactly what it was called to observe. So the
/// page runs the whole schedule off its own timers, reports only through
/// document.title (a property notify, which asks the engine to render nothing),
/// and the driver reads pixels from the display server instead of from WebKit.
///
/// WHY a timer is the faithful trigger: in the app the write arrives on a
/// websocket message carrying PTY output while the user sits still. A timer
/// callback is the same shape of event -- a task on the event loop that ends in
/// term.write() with no input event anywhere near it.
///
/// The terminal is built the way terminal-pixels/harness.mjs builds it, at the
/// same grid, font size and line height, so the two harnesses describe the same
/// terminal and a number from one can be read next to a number from the other.

import { Terminal as XtermTerminal } from "/vendor/xterm/lib/xterm.mjs";
import { WebglAddon } from "/vendor/addon-webgl/lib/addon-webgl.mjs";

/// The grid, matching terminal-pixels/harness.mjs.
const COLS = 60;
const ROWS = 20;
const LINE_HEIGHT = 1.2;

/// Row 0 carries a marker the driver checks in every capture. It is not the
/// measurement: it is how the driver knows it is looking at this window and
/// not at whatever the window manager stacked on top of it. A stall reported
/// from a capture of somebody else's window would be a fabricated result.
const MARKER_ROW = 0;
const MARKER_COL = 2;
const MARKER_COLS = 12;

/// Where a trial's ink goes. One row per trial, cycling, so a trial never has
/// to distinguish its own ink from the previous trial's.
const FIRST_PROBE_ROW = 2;
const LAST_PROBE_ROW = ROWS - 2;
const PROBE_COL = 2;
const PROBE_COLS = 40;

/// Move the cursor to a 0-indexed cell. CUP is 1-indexed.
function cup(col, row) {
  return `\x1b[${row + 1};${col + 1}H`;
}

/// Clear everything and repaint the marker. Written at the top of every trial,
/// immediately after the previous trial's wake event, which is the one moment
/// in the cycle when the compositor is known to be awake. The driver captures
/// after this and before the idle write, so a trial whose own clear did not
/// reach the screen is detected rather than counted.
function armBytes() {
  return (
    "\x1b[?25l" +
    "\x1b[2J" +
    cup(MARKER_COL, MARKER_ROW) +
    "█".repeat(MARKER_COLS)
  );
}

/// The trial's ink: a solid run of U+2588 on its own row. Solid block rather
/// than text because the driver thresholds ink against the background, and a
/// full-cell fill is the least ambiguous thing a renderer can put on a row.
function probeBytes(row) {
  return cup(PROBE_COL, row) + "█".repeat(PROBE_COLS);
}

/// TerminalTab's terminalTheme(), from the same CSS variables it reads.
function terminalTheme(host) {
  const styles = getComputedStyle(host);
  return {
    background: styles.getPropertyValue("--bg").trim() || "#1c1c1e",
    foreground: styles.getPropertyValue("--text").trim() || "#ebebf0",
    cursor: styles.getPropertyValue("--link").trim() || "#58a6ff",
    selectionBackground: "rgba(88, 166, 255, 0.35)",
  };
}

/// Two frames, as in the pixels harness: one to schedule the render and one to
/// let it complete. After this resolves the bytes are drawn into the canvas,
/// which is the state whose PRESENTATION is the whole question.
function nextFrame() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(term, bytes) {
  return new Promise((resolve) => term.write(bytes, resolve));
}

/// Signal the driver. The title is the only channel out of this page: it
/// arrives on an event the driver already watches and costs no render.
function signal(text) {
  document.title = `stall-probe ${text}`;
}

async function main() {
  const config = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  const host = document.getElementById("host");
  const warnings = [];

  // Measuring against a fallback face the real face later replaces would move
  // the cell metrics under the driver's regions mid-run.
  try {
    await document.fonts.load(`${config.fontSize}px "Source Code Pro"`, "█");
  } catch (err) {
    warnings.push(`font load failed: ${err}`);
  }

  const term = new XtermTerminal({
    allowProposedApi: true,
    allowTransparency: false,
    cols: COLS,
    // A blinking cursor is an animation, and an animating page is not an idle
    // one. The fault only exists while nothing else is asking for frames.
    cursorBlink: false,
    cursorStyle: "block",
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    lineHeight: LINE_HEIGHT,
    rows: ROWS,
    scrollback: 1000,
    theme: terminalTheme(host),
  });
  term.open(host);

  // The arm under test. The DOM arm is the control: it paints through normal
  // DOM mutation and has no GL layer to leave unpresented, so a stall reported
  // on BOTH arms means the harness or the capture is wrong, not the renderer.
  let webglLoaded = false;
  if (config.renderer === "webgl") {
    try {
      term.loadAddon(new WebglAddon());
      webglLoaded = true;
    } catch (err) {
      warnings.push(`webgl addon unavailable: ${err}`);
    }
  }

  await write(term, armBytes());
  await nextFrame();

  const screen = host.querySelector(".xterm-screen");
  if (!screen) throw new Error("xterm painted no .xterm-screen");
  const rect = screen.getBoundingClientRect();

  // Everything the driver needs to turn a cell into a pixel, plus what it must
  // record about the arm it actually got. `webglLoaded` is reported rather
  // than assumed: an arm that asked for WebGL and silently did not get it
  // would otherwise be counted as a clean WebGL run.
  signal(
    `ready ${JSON.stringify({
      cols: term.cols,
      rows: term.rows,
      cellWidth: rect.width / term.cols,
      cellHeight: rect.height / term.rows,
      originX: rect.x,
      originY: rect.y,
      devicePixelRatio: window.devicePixelRatio,
      renderer: config.renderer,
      webglLoaded,
      marker: {
        row: MARKER_ROW,
        firstCol: MARKER_COL,
        lastCol: MARKER_COL + MARKER_COLS - 1,
      },
      probe: { firstCol: PROBE_COL, lastCol: PROBE_COL + PROBE_COLS - 1 },
      warnings,
    })}`,
  );

  // The driver needs to see `ready` and set up before the first trial starts.
  await sleep(config.leadInMs);

  const usableRows = LAST_PROBE_ROW - FIRST_PROBE_ROW + 1;
  for (let trial = 0; trial < config.trials; trial += 1) {
    const row = FIRST_PROBE_ROW + (trial % usableRows);

    // Arm: wipe the screen and repaint the marker, then tell the driver which
    // row this trial will ink so it can confirm that row is background BEFORE
    // the idle write puts ink there.
    await write(term, armBytes());
    await nextFrame();
    signal(`armed ${trial} ${row}`);

    // The idle window. Nothing is scheduled, nothing animates, no input
    // arrives. This is the state the fault requires, and its length is the
    // variable the driver sweeps: "while the page is idle" is a claim about
    // duration, and nobody has ever established how long idle has to be.
    await sleep(config.idleMs);

    await write(term, probeBytes(row));
    await nextFrame();
    signal(`wrote ${trial} ${row}`);

    // Slack for the driver's two captures and its wake event. It is not part
    // of the measurement; it only has to be longer than the driver needs.
    await sleep(config.tailMs);
  }

  signal("done");
}

main().catch((err) => {
  document.title = `stall-probe-error ${err && err.message ? err.message : err}`;
});
