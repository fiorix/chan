/// The page under test for terminal-pixels.py: one real terminal, built the
/// way TerminalTab.svelte builds it, painting a fixed pattern whose ink the
/// driver measures.
///
/// WHY the pattern lives here rather than in the driver: the driver measures
/// pixels, and pixels only mean something against the cells they came from.
/// Keeping the pattern and the cell coordinates of every measured region in
/// one place means the driver never restates the layout; it reads the regions
/// back out of the readiness report and converts them through the grid origin
/// the terminal actually landed on.
///
/// The ghostty adapters are the product's own modules, compiled straight out
/// of src/terminal/ into /product/. Only the wiring is written here, and it
/// tracks TerminalTab.start(): same options, same post-open() alignment, same
/// custom-glyph and overlay-scrollbar installs.

import { Terminal as XtermTerminal } from "/vendor/xterm/lib/xterm.mjs";
import { WebglAddon } from "/vendor/addon-webgl/lib/addon-webgl.mjs";
import {
  Ghostty,
  Terminal as GhosttyTerminal,
} from "/vendor/ghostty-web/dist/ghostty-web.js";
import {
  alignGhosttyRendererToXterm,
  installGhosttyCustomGlyphs,
  installGhosttyOverlayScrollbar,
  measureXtermCellDimensions,
} from "/product/ghosttyCompat.js";

/// The grid every scenario renders on. Fixed rather than fitted: a fitted
/// grid changes with the cell size, and then two scenarios would not be
/// painting the same pattern in the same cells.
const COLS = 60;
const ROWS = 20;

/// TerminalTab's line height. Also what measureXtermCellDimensions is handed
/// when the ghostty renderer is aligned to xterm's grid.
const LINE_HEIGHT = 1.2;

/// The pattern's geometry, in cells. Every region the driver samples is
/// derived from these, so moving the pattern moves the measurements with it.
const BOX_COL = 2;
const BOX_ROW = 1;
const BOX_INNER_COLS = 10;
const BOX_INNER_ROWS = 5;
const BLOCK_COL = 2;
const BLOCK_ROW = 10;
const BLOCK_COLS = 12;
const BLOCK_ROWS = 4;
const SAMPLE_ROW = 16;

/// Rows and columns of the box's frame, derived once so the pattern writer
/// and the region report cannot disagree about where the frame is.
const BOX_LAST_COL = BOX_COL + BOX_INNER_COLS + 1;
const BOX_LAST_ROW = BOX_ROW + BOX_INNER_ROWS + 1;
const BLOCK_LAST_COL = BLOCK_COL + BLOCK_COLS - 1;
const BLOCK_LAST_ROW = BLOCK_ROW + BLOCK_ROWS - 1;

/// Move the cursor to a 0-indexed cell. CUP is 1-indexed.
function cup(col, row) {
  return `\x1b[${row + 1};${col + 1}H`;
}

/// The bytes every scenario writes.
///
/// A box frame and a solid block rectangle, because they fail differently: a
/// frame loses its joins when the glyph's ink box is shorter or narrower than
/// the cell, and a block rectangle is the strictest possible probe for the
/// same defect, since any unpainted strip inside it is a gap by definition.
/// The text row is there to be looked at, not measured.
function patternBytes() {
  const parts = [
    // A block cursor parked anywhere inside a measured region reads as ink,
    // so it is hidden for the whole run rather than parked out of the way.
    "\x1b[?25l",
    "\x1b[2J",
    cup(BOX_COL, BOX_ROW) + "┌" + "─".repeat(BOX_INNER_COLS) + "┐",
  ];
  for (let i = 0; i < BOX_INNER_ROWS; i += 1) {
    parts.push(
      cup(BOX_COL, BOX_ROW + 1 + i) +
        "│" +
        " ".repeat(BOX_INNER_COLS) +
        "│",
    );
  }
  parts.push(
    cup(BOX_COL, BOX_LAST_ROW) +
      "└" +
      "─".repeat(BOX_INNER_COLS) +
      "┘",
  );
  for (let i = 0; i < BLOCK_ROWS; i += 1) {
    parts.push(cup(BLOCK_COL, BLOCK_ROW + i) + "█".repeat(BLOCK_COLS));
  }
  parts.push(cup(BOX_COL, SAMPLE_ROW) + "AaBbGg 0123 ==> --- ### {}[]()");
  return parts.join("");
}

/// A freshly opened tab's screen: a prompt on the first row and nothing
/// else. Everything below it is background the renderer owes the user.
function promptBytes() {
  return (
    "\x1b[?25l\x1b[2J" + cup(0, 0) + "user@host ~/dev/chan $ "
  );
}

/// Where the driver samples in a new tab: the whole grid under the prompt,
/// which must be background. Any ink there is content the tab never had.
function newTabRegions() {
  return {
    blank: {
      firstCol: 0,
      lastCol: COLS - 1,
      firstRow: 2,
      lastRow: ROWS - 1,
    },
  };
}

/// Where the driver samples, in cells.
function regions() {
  return {
    // The frame's left rule: the run of `│` cells, corners excluded. A
    // corner's stroke starts at the middle of its own cell, so a corner cell
    // is half background by design and only its inner half is a join the
    // driver can hold to a continuity bar. The driver extends this span by
    // half a cell at each end to take in exactly those two halves.
    rule: {
      col: BOX_COL,
      firstRow: BOX_ROW + 1,
      lastRow: BOX_LAST_ROW - 1,
    },
    // The frame's top rule, on the same terms: the run of `─` cells, with
    // the corners' inner halves picked up by the driver's extension.
    top: {
      row: BOX_ROW,
      firstCol: BOX_COL + 1,
      lastCol: BOX_LAST_COL - 1,
    },
    // The solid rectangle: every pixel inside it must be ink.
    block: {
      firstCol: BLOCK_COL,
      lastCol: BLOCK_LAST_COL,
      firstRow: BLOCK_ROW,
      lastRow: BLOCK_LAST_ROW,
    },
    // Nothing is ever written here. It is the driver's background reference
    // and its check that a scenario did not paint outside the pattern.
    blank: {
      firstCol: 30,
      lastCol: 55,
      firstRow: 1,
      lastRow: 8,
    },
  };
}

/// TerminalTab's terminalTheme() at its dark-theme fallbacks, read from the
/// same CSS variables it reads.
function terminalTheme(host) {
  const styles = getComputedStyle(host);
  return {
    background: styles.getPropertyValue("--bg").trim() || "#1c1c1e",
    foreground: styles.getPropertyValue("--text").trim() || "#ebebf0",
    cursor: styles.getPropertyValue("--link").trim() || "#58a6ff",
    selectionBackground: "rgba(88, 166, 255, 0.35)",
  };
}

function nextFrame() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
}

async function startXterm(host, scenario, warnings, bytes) {
  const term = new XtermTerminal({
    allowProposedApi: true,
    allowTransparency: false,
    cols: COLS,
    cursorBlink: false,
    cursorStyle: "block",
    fontFamily: scenario.fontFamily,
    fontSize: scenario.fontSize,
    lineHeight: LINE_HEIGHT,
    macOptionIsMeta: true,
    rows: ROWS,
    scrollback: 1000,
    tabStopWidth: 8,
    theme: terminalTheme(host),
  });
  term.open(host);
  // The desktop app stays on the DOM renderer on Linux (see
  // shouldUseWebglRenderer). The webgl arm exists so a run can measure what
  // the renderer chan turns off there would have painted: it is the only
  // xterm renderer that fires the customGlyphs path, since @xterm/addon-canvas
  // has no release for xterm 6 and installing it pulls the core back to 5.5.
  const addons = { webgl: WebglAddon };
  const Addon = addons[scenario.renderer];
  if (Addon) {
    try {
      term.loadAddon(new Addon());
    } catch (err) {
      warnings.push(`${scenario.renderer} addon unavailable: ${err}`);
    }
  }
  await new Promise((resolve) => term.write(bytes, resolve));
  await nextFrame();

  const screen = host.querySelector(".xterm-screen");
  if (!screen) throw new Error("xterm painted no .xterm-screen");
  const rect = screen.getBoundingClientRect();
  return {
    cols: term.cols,
    rows: term.rows,
    cellWidth: rect.width / term.cols,
    cellHeight: rect.height / term.rows,
    originX: rect.x,
    originY: rect.y,
    renderer: scenario.renderer,
  };
}

/// One Ghostty per page, like loadGhosttyKit's cached promise: every chan
/// terminal shares a single WASM instance, so a harness that loaded one per
/// terminal would not be running the configuration the app ships.
let ghosttyKit = null;

function loadGhostty() {
  if (!ghosttyKit) {
    ghosttyKit = Ghostty.load("/vendor/ghostty-web/dist/ghostty-vt.wasm");
  }
  return ghosttyKit;
}

async function startGhostty(host, scenario, warnings, bytes) {
  const ghostty = await loadGhostty();
  const term = new GhosttyTerminal({
    allowTransparency: false,
    cols: COLS,
    cursorBlink: false,
    cursorStyle: "block",
    fontFamily: scenario.fontFamily,
    fontSize: scenario.fontSize,
    ghostty,
    rows: ROWS,
    scrollback: 1000,
    smoothScrollDuration: 0,
    theme: terminalTheme(host),
  });
  term.open(host);

  // TerminalTab's post-open() alignment, in the order it runs there.
  const renderer = term.renderer;
  const targetCell = measureXtermCellDimensions(
    host,
    scenario.fontFamily,
    scenario.fontSize,
    LINE_HEIGHT,
  );
  if (
    !renderer ||
    !targetCell ||
    !alignGhosttyRendererToXterm(renderer, targetCell, term.cols, term.rows)
  ) {
    warnings.push("ghostty renderer metrics unavailable; native spacing");
  }
  if (renderer && !installGhosttyCustomGlyphs(renderer)) {
    warnings.push("ghostty text hook unavailable; font-rendered box glyphs");
  }
  if (renderer && !installGhosttyOverlayScrollbar(renderer)) {
    warnings.push("ghostty scrollbar hooks unavailable");
  }

  await new Promise((resolve) => term.write(bytes, resolve));
  await nextFrame();

  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("ghostty painted no canvas");
  const rect = canvas.getBoundingClientRect();
  const metrics = renderer?.getMetrics();
  return {
    cols: term.cols,
    rows: term.rows,
    cellWidth: metrics?.width ?? rect.width / term.cols,
    cellHeight: metrics?.height ?? rect.height / term.rows,
    originX: rect.x,
    originY: rect.y,
    renderer: "ghostty-canvas",
  };
}

async function main() {
  const scenario = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  const host = document.getElementById("host");
  const warnings = [];

  // Measuring a fallback face that the real face later replaces would make
  // the numbers describe a font the user never sees. Waiting on the specific
  // face rather than document.fonts.ready keeps the product's own
  // `font-display: swap` declaration under test.
  try {
    await document.fonts.load(
      `${scenario.fontSize}px "Source Code Pro"`,
      "█─│W",
    );
  } catch (err) {
    warnings.push(`font load failed: ${err}`);
  }
  const faceLoaded = document.fonts.check(
    `${scenario.fontSize}px "Source Code Pro"`,
  );

  const start =
    scenario.backend === "ghostty" ? startGhostty : startXterm;

  // The new-tab arm reproduces chan's tab model rather than a bare second
  // terminal: the tab a user was already on stays mounted and keeps its
  // content, and the new one is a second terminal built from the same
  // process-wide backend. Parked offscreen rather than display:none,
  // because a hidden host measures zero and the renderer it holds would
  // stop being a realistic neighbour.
  if (scenario.newTab) {
    const size = host.getBoundingClientRect();
    const prior = document.createElement("div");
    prior.id = "host-prior";
    prior.style.cssText = `position:absolute;left:-${size.width + 100}px;top:0;
      width:${size.width}px;height:${size.height}px;overflow:hidden;`;
    document.body.appendChild(prior);
    await start(prior, scenario, warnings, patternBytes());
  }

  const bytes = scenario.newTab ? promptBytes() : patternBytes();
  const grid = await start(host, scenario, warnings, bytes);

  // The title is the whole channel back to the driver: it is readable
  // without a JavaScriptCore binding and it arrives on an event the driver
  // is already watching.
  document.title = `chan-pixels ${JSON.stringify({
    ...grid,
    devicePixelRatio: window.devicePixelRatio,
    faceLoaded,
    regions: scenario.newTab ? newTabRegions() : regions(),
    warnings,
  })}`;
}

main().catch((err) => {
  document.title = `chan-pixels-error ${err && err.message ? err.message : err}`;
});
