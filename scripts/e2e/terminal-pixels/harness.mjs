/// The page under test for terminal-pixels.py: one real terminal, built the
/// way TerminalTab.svelte builds it, painting a fixed pattern whose ink the
/// driver measures, or one of the reference patterns (PATTERNS below) whose
/// PNG a later run is compared with byte for byte.
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
/// tracks TerminalTab.start() and backend.ts: the same core under the same
/// binding, same options, same post-open() alignment, same custom-glyph and
/// overlay-scrollbar installs.

import { Terminal as XtermTerminal } from "/vendor/xterm/lib/xterm.mjs";
import { WebglAddon } from "/vendor/addon-webgl/lib/addon-webgl.mjs";
import { Terminal as GhosttyTerminal } from "/vendor/ghostty-web-ng/ghostty-web.js";
import { GhosttyVt } from "/vendor/ghostty-web-ng/vt.js";
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

/// One run of cells in an SGR, then back to the defaults.
function sgr(params, text) {
  return `\x1b[${params}m${text}\x1b[0m`;
}

/// A labelled row of SGR samples, a default-coloured space between them.
function sampleRow(row, label, samples) {
  return (
    cup(0, row) +
    label +
    samples.map(([params, text]) => sgr(params, text)).join(" ")
  );
}

/// History for the scrollback pattern: more lines than the screen holds,
/// one of them long enough to soft-wrap, viewed scrolled back far enough
/// that history rows fill the top of the view and screen rows the bottom.
const SCROLLBACK_LINES = 40;
const SCROLLBACK_WRAP_LINE = 14;
const SCROLLBACK_SHOWN = 12;

/// Where the cursor patterns park the cursor: on the W of row 2, or on a
/// cell of row 6 nothing is written to.
const CURSOR_GLYPH = { col: 21, row: 2 };
const CURSOR_BLANK = { col: 30, row: 6 };

/// The reference patterns, by the scenario's `pattern`. The grid pattern
/// above is the one the ink measures read; these paint the paths it never
/// reaches (cell colours and attributes, wide and combined glyphs, each
/// cursor style, history rows, the selection), so that a change to the
/// renderer can be held to byte-identical PNGs against a run before it. They
/// record what the renderer paints, not what it ought to: each declares only
/// where it wrote, which must carry ink so that a page that drew nothing
/// cannot pass for a match, and a region nothing writes. Every one starts on
/// a fresh terminal and hides the cursor unless the cursor is its subject.
const PATTERNS = {
  // Colours and attributes. Row 1 sets explicit black backgrounds beside
  // default ones: the palette's black and RGB (1,1,1), which the renderer
  // paints, and the 256-colour table's black (16) and RGB black, which it
  // leaves unpainted as if they were the default. Rows 10 and 11 give cells
  // a background and no character, by erasing in a colour.
  attrs: {
    bytes() {
      return [
        "\x1b[?25l",
        sampleRow(1, "blk ", [
          ["0", "Ab"], ["40", "Ab"], ["0", "Ab"], ["48;5;0", "Ab"],
          ["48;5;16", "Ab"], ["48;2;0;0;0", "Ab"], ["48;2;1;1;1", "Ab"],
          ["40", "  "], ["48;2;0;0;0", "  "], ["7;40", "Ab"],
          ["30;40", "Ab"], ["30", "Ab"],
        ]),
        sampleRow(2, "bg  ", [41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103, 104, 105, 106, 107].map((n) => [String(n), "A"])),
        sampleRow(3, "fg  ", [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97].map((n) => [String(n), "Ab"])),
        cup(0, 4) +
          "256 " +
          [1, 9, 17, 52, 88, 124, 160, 196, 202, 214, 226, 46, 51, 93, 201, 232, 240, 250, 255]
            .map((n) => sgr(`38;5;${n}`, "A") + sgr(`48;5;${n}`, " "))
            .join(""),
        sampleRow(5, "rgb ", [
          ["38;2;255;0;0", "Ab"], ["38;2;0;255;0", "Ab"], ["38;2;0;0;255", "Ab"],
          ["38;2;255;160;0", "Ab"], ["38;2;1;1;1", "Ab"], ["38;2;254;254;254", "Ab"],
          ["48;2;255;0;0", "Ab"], ["48;2;0;128;0", "Ab"], ["48;2;40;80;120", "Ab"],
          ["48;2;250;250;250", "Ab"], ["38;2;255;255;0;48;2;80;0;80", "Ab"],
        ]),
        sampleRow(6, "sgr ", [
          ["1", "Bd"], ["2", "Fa"], ["3", "It"], ["4", "Ul"], ["4:2", "U2"],
          ["4:3", "U3"], ["4:4", "U4"], ["4:5", "U5"], ["5", "Bl"], ["7", "In"],
          ["8", "Iv"], ["9", "St"], ["53", "Ov"],
        ]),
        sampleRow(7, "mix ", [
          ["1;3", "BI"], ["1;4", "BU"], ["2;9", "FS"], ["3;4;9", "IUS"],
          ["7;31", "r7"], ["7;41", "b7"], ["7;38;5;196;48;5;21", "x7"],
          ["8;44", "hid"], ["2;31", "fr"], ["1;2", "bf"], ["4;31", "ur"],
          ["9;32;48;5;236", "sg"], ["7", "   "],
        ]),
        sampleRow(8, "box ", [
          ["31", "█"], ["2", "█"], ["2;33", "▀▄"], ["7", "█"], ["8;41", "█"],
          ["33;44", "─│┼"], ["2;36", "═║╬"], ["7;35", "▌▐"], ["1", "░▒▓"],
          ["4;32", "──"], ["9", "││"], ["38;2;255;128;0;48;2;0;0;0", "█─"],
        ]),
        cup(0, 10) + "el  \x1b[45m\x1b[K\x1b[0m",
        cup(0, 11) + "ech \x1b[48;2;40;80;120m\x1b[6X",
        cup(12, 11) + "\x1b[48;5;22m\x1b[4X",
        cup(18, 11) + "\x1b[40m\x1b[5X",
        cup(25, 11) + "\x1b[48;2;0;0;0m\x1b[5X",
        cup(32, 11) + "\x1b[48;5;16m\x1b[5X\x1b[0m",
      ].join("");
    },
    regions: () => ({
      painted: { firstCol: 0, lastCol: COLS - 1, firstRow: 1, lastRow: 11 },
      blank: { firstCol: 0, lastCol: COLS - 1, firstRow: 13, lastRow: ROWS - 1 },
    }),
  },

  // Widths: wide characters with and without attributes, emoji with
  // variation selectors, a skin tone and ZWJ sequences, combining marks and
  // clusters, a wide character that does not fit in the last column (it
  // leaves a spacer there and wraps), and a row that soft-wraps.
  glyphs: {
    bytes() {
      return [
        "\x1b[?25l",
        cup(0, 1) + "cjk 漢字かなカナ한글 " +
          [["31;44", "漢"], ["7", "字"], ["4", "下"], ["9", "線"], ["1;3", "強"]]
            .map(([p, t]) => sgr(p, t)).join(" "),
        cup(0, 3) + "emo 😀 👍🏽 👨‍👩‍👧 🏳️‍🌈 ❤️ ✈️ " + sgr("44", "😀") + " " + sgr("7", "👍🏽"),
        cup(0, 5) + "cmb é à̖ ñ ȫ कि क्ष 각 " +
          sgr("4", "é") + " " + sgr("33;41", "à"),
        cup(0, 7) + "w".repeat(COLS - 1) + "漢tail",
        cup(0, 10) + "soft wrap: " + "0123456789".repeat(6) + "+continued",
        cup(0, 13) + "mix ┌漢┐ █漢█ " + sgr("31", "▀漢▄") + " é█",
      ].join("");
    },
    regions: () => ({
      painted: { firstCol: 0, lastCol: COLS - 1, firstRow: 1, lastRow: 13 },
      blank: { firstCol: 0, lastCol: COLS - 1, firstRow: 15, lastRow: ROWS - 1 },
    }),
  },

  // Rows read from history while the view is scrolled back, among them a
  // row that soft-wrapped, with the attributes of the attrs pattern, above
  // rows of the screen.
  scrollback: {
    bytes() {
      const styles = ["0", "1;31", "2", "3;4", "7", "40", "48;2;0;0;0", "38;5;208;48;5;24", "9;32", "8;43"];
      const lines = [];
      for (let i = 0; i < SCROLLBACK_LINES; i += 1) {
        const n = String(i).padStart(2, "0");
        if (i === SCROLLBACK_WRAP_LINE) {
          lines.push(sgr("36", `history ${n} wraps: `) + "abcdefghij".repeat(6));
          continue;
        }
        lines.push(
          sgr(styles[i % styles.length], `history ${n}`) +
            " ─│█▀ " +
            (i % 3 === 0 ? "漢字 " : "") +
            (i % 4 === 0 ? "é " : "") +
            "end",
        );
      }
      return "\x1b[?25l" + lines.join("\r\n");
    },
    async settle(term) {
      term.scrollLines(-SCROLLBACK_SHOWN);
      if (term.getViewportY() !== SCROLLBACK_SHOWN) {
        throw new Error(
          `scrolled back ${term.getViewportY()} rows, not ${SCROLLBACK_SHOWN}`,
        );
      }
      // A scroll shows the widget's overlay scrollbar, which fades in and
      // then hides itself on a timer. A frame taken mid-fade would not
      // reproduce, so the snapshot waits for it to be gone.
      const deadline = performance.now() + 10000;
      while (term.scrollbarVisible !== false) {
        if (typeof term.scrollbarVisible !== "boolean") {
          throw new Error("the widget's scrollbar state is unreadable");
        }
        if (performance.now() > deadline) {
          throw new Error("the overlay scrollbar never hid");
        }
        await nextFrame();
      }
    },
    regions: () => ({
      painted: { firstCol: 0, lastCol: 39, firstRow: 0, lastRow: ROWS - 1 },
      blank: { firstCol: 40, lastCol: 55, firstRow: 7, lastRow: ROWS - 1 },
    }),
  },

  // A selection from inside row 2 to inside row 5 (the first, a middle and
  // the last row of a selection are painted by separate branches) over
  // cells with colours, attributes, wide and combined characters and box
  // glyphs.
  selection: {
    bytes() {
      return [
        "\x1b[?25l",
        cup(0, 2) + "select: plain text " +
          [["40", "blk"], ["7", "inv"], ["44", "bg"], ["4;31", "ul"]].map(([p, t]) => sgr(p, t)).join(" "),
        cup(0, 3) + "漢字 é " + sgr("1", "bold") + " ─│┼ █▀▄ " +
          sgr("33;48;2;0;0;0", "rgb0") + " " + sgr("8", "hid") + " end",
        cup(0, 4) + "a full row: " + "0123456789".repeat(4),
        cup(0, 5) + sgr("38;5;208;48;5;24", "256 colours") + " " + sgr("2", "faint") + " " +
          sgr("9", "strike") + " 漢",
        cup(0, 6) + "below the selection",
      ].join("");
    },
    async settle(term) {
      // From column 8 of row 2 to column 20 of row 5.
      term.select(8, 2, (COLS - 8) + COLS * 2 + 21);
    },
    regions: () => ({
      painted: { firstCol: 0, lastCol: COLS - 1, firstRow: 2, lastRow: 6 },
      blank: { firstCol: 0, lastCol: COLS - 1, firstRow: 8, lastRow: ROWS - 1 },
    }),
  },

  // A visible cursor parked on a glyph or on a blank cell; the scenario's
  // cursorStyle picks the shape the renderer draws.
  "cursor-glyph": cursorPattern(CURSOR_GLYPH),
  "cursor-blank": cursorPattern(CURSOR_BLANK),
};

function cursorPattern(at) {
  return {
    bytes() {
      return [
        "\x1b[?25h",
        cup(2, 2) + "cursor on a glyph: W",
        cup(2, 4) + "and on a blank cell below",
        cup(2, 8) + sgr("44", " a coloured row ") + " " + sgr("1;31", "bold"),
        cup(at.col, at.row),
      ].join("");
    },
    regions: () => ({
      painted: { firstCol: 0, lastCol: COLS - 1, firstRow: 2, lastRow: 8 },
      blank: { firstCol: 0, lastCol: COLS - 1, firstRow: 10, lastRow: ROWS - 1 },
    }),
  };
}

/// TerminalTab's terminalTheme() at its dark-theme fallbacks, read from the
/// same CSS variables it reads. The reference patterns also carry its dark
/// palette, which the driver reads out of TerminalTab.svelte; the grid
/// pattern paints default colours only and takes none.
function terminalTheme(host, palette) {
  const styles = getComputedStyle(host);
  return {
    background: styles.getPropertyValue("--bg").trim() || "#1c1c1e",
    foreground: styles.getPropertyValue("--text").trim() || "#ebebf0",
    cursor: styles.getPropertyValue("--link").trim() || "#58a6ff",
    selectionBackground: "rgba(88, 166, 255, 0.35)",
    ...palette,
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

/// The vendored libghostty-vt core, compiled once per page like the module
/// behind loadGhosttyKit's cached promise. Every chan terminal instantiates
/// it into a memory of its own, through chan's binding (backend.ts's
/// ghosttyKitFrom), so the second-tab arm's two terminals do not share an
/// instance either.
const GHOSTTY_CORE = "/vendor/ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
let ghosttyModule = null;

function compileGhostty() {
  if (!ghosttyModule) {
    ghosttyModule = (async () => {
      const response = await fetch(GHOSTTY_CORE);
      if (!response.ok) {
        throw new Error(`fetching ${GHOSTTY_CORE}: ${response.status}`);
      }
      return WebAssembly.compile(await response.arrayBuffer());
    })();
  }
  return ghosttyModule;
}

async function startGhostty(host, scenario, warnings, bytes, settle) {
  // TerminalTab's instance host: replies the core generates outside a write
  // (a resize report) go to the PTY, which this page does not have.
  let term = null;
  const ghostty = new GhosttyVt(
    await WebAssembly.instantiate(await compileGhostty(), {}),
    {
      cellSize: () => term?.renderer?.getMetrics(),
      onResizeReply: () => {},
    },
  );
  term = new GhosttyTerminal({
    allowTransparency: false,
    cols: COLS,
    cursorBlink: false,
    cursorStyle: scenario.cursorStyle ?? "block",
    fontFamily: scenario.fontFamily,
    fontSize: scenario.fontSize,
    ghostty,
    rows: ROWS,
    scrollback: 1000,
    smoothScrollDuration: 0,
    theme: terminalTheme(host, scenario.palette),
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
  if (settle) {
    await settle(term);
    await nextFrame();
  }

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

  // A reference pattern settles through the ghostty widget's own API and
  // its scrollbar's timing, so it is painted on ghostty alone.
  const pattern = scenario.pattern ? PATTERNS[scenario.pattern] : null;
  if (scenario.pattern && !pattern) {
    throw new Error(`no pattern named ${scenario.pattern}`);
  }
  if (pattern && (scenario.backend !== "ghostty" || scenario.newTab)) {
    throw new Error(`the ${scenario.pattern} pattern paints one ghostty tab`);
  }

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

  const bytes = pattern
    ? pattern.bytes()
    : scenario.newTab
      ? promptBytes()
      : patternBytes();
  const grid = await start(host, scenario, warnings, bytes, pattern?.settle);

  // The title is the whole channel back to the driver: it is readable
  // without a JavaScriptCore binding and it arrives on an event the driver
  // is already watching.
  document.title = `chan-pixels ${JSON.stringify({
    ...grid,
    devicePixelRatio: window.devicePixelRatio,
    faceLoaded,
    regions: pattern
      ? pattern.regions()
      : scenario.newTab
        ? newTabRegions()
        : regions(),
    warnings,
  })}`;
}

main().catch((err) => {
  document.title = `chan-pixels-error ${err && err.message ? err.message : err}`;
});
