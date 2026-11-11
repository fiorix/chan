// A live window switches between light and dark and must paint every surface
// as a fresh load in that theme does. Engine: headless Chrome.
//
// The window holds, in its left pane, a rich-text document with a code block,
// a Mermaid diagram and an image, a slide deck with its Outline thumbnails, an
// Excalidraw board and a Files tab; its right pane holds a ghostty terminal
// whose shell became a byte recorder (dd) while a background loop keeps
// rewriting a coloured line at the top of the screen. The live page switches
// light, dark and light by the OS appearance (Chrome's emulated
// prefers-color-scheme with the theme choice at System), then dark and back by
// the Settings choice. After each switch every surface is read: the computed
// colours of every visible element of the left pane's surface (fill, stroke,
// border, filter and opacity too, so a Mermaid node, a thumbnail and the
// board's canvas filter count), and the terminal's canvas pixels at fixed
// cells. Fresh loads of the same window in each theme come last, and each
// live reading must equal the fresh one for its theme. The terminal's shell
// must be the same process throughout, its scrollback the same apart from the
// loop's counter, and no byte may reach it.

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { showFiles } from "../lib/files.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB = "SmokeThemeSwitch221";
const DOC = "theme-switch-221.md";
const DECK = "theme-switch-221-deck.md";
const BOARD = "theme-switch-221.excalidraw";
const SURFACES = ["doc", "deck", "board", "files"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DOC_TEXT = [
  "# Theme switch",
  "",
  "```js",
  "const answer = 42; // a comment",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[light] --> B[dark]",
  "```",
  "",
  "![](wide-teal.png)",
  "",
  "After the image.",
  "",
].join("\n");

const DECK_TEXT = [
  "---",
  "chan:",
  "  kind: slides",
  "  slides:",
  '    aspect_ratio: "16:9"',
  "---",
  "",
  "# Slide one",
  "",
  "![](photo.png#w=180)",
  "",
  '<hr class="chan-page-break">',
  "",
  "# Diagram slide",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[deck] --> B[slide]",
  "```",
  "",
  '<hr class="chan-page-break">',
  "",
  "# Board slide",
  "",
  `![](${BOARD}#w=420)`,
  "",
].join("\n");

export default {
  name: "theme-switch-live",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const env = { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId, CHAN_WORKSPACE_PATH: ctx.workspaceDir };
    const shell = (args) => ctx.exec(ctx.chanBin, ["shell", ...args], { cwd: ctx.workspaceDir, env, timeout: 90_000 });
    const cs = (args) => shell(["terminal", ...args]);
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const originalTheme = await themeChoice(page, token);
    const record = join(tmpdir(), `chan-smoke-221-${process.pid}-${Date.now()}.rec`);

    writeFileSync(join(ctx.workspaceDir, DOC), DOC_TEXT);
    writeFileSync(join(ctx.workspaceDir, DECK), DECK_TEXT);
    writeFileSync(join(ctx.workspaceDir, BOARD), readFileSync(join(ctx.workspaceDir, "board.excalidraw")));

    const cdp = await page.createCDPSession();
    const emulate = async (scheme) => {
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    };
    const htmlTheme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const waitHtmlTheme = async (theme, label) => {
      const deadline = Date.now() + 15_000;
      while ((await htmlTheme()) !== theme) {
        if (Date.now() > deadline) throw new Error(`${label}: <html data-theme> never became ${theme} (${await htmlTheme()})`);
        await sleep(100);
      }
    };

    let terminalOpen = false;
    try {
      await emulate("dark");
      await waitHtmlTheme("dark", "first load");
      if (original.ghostty !== true) await writeTerminalPrefs(page, token, { ghostty: true });

      // The layout: the page's pane on the left, a new pane on the right for
      // the terminal, so the terminal stays in view through every switch.
      const panes = async () => JSON.parse((await shell(["pane", "list", "--window", windowId, "--json"])).stdout).panes ?? [];
      const left = (await panes())[0]?.id;
      if (!left) throw new Error("the window lists no pane");
      const right = (await shell(["pane", "new", "right", "--window", windowId, "--pane", left])).stdout.trim();
      if (!right) throw new Error("pane new printed no pane id");
      await openAttachedTerminal(ctx, page, cs, windowId, TAB, "ghostty", ["--pane", right]);
      terminalOpen = true;

      // The shell prints history and its pid, then becomes dd recording every
      // byte the PTY receives, while a loop it started keeps rewriting the
      // screen's first row (and ends when the recorder does).
      await cs(["write", "--tab-name", TAB,
        `PS1='$ '; printf '\\033[H\\033[2J\\033[3J'; seq 1 60; echo "PID=$$"; stty raw -echo; ` +
        `( i=0; while kill -0 $$ 2>/dev/null; do printf '\\0337\\033[1;1H\\033[41m RED \\033[0m plain \\033[44m BLUE \\033[0m %06d\\033[K\\0338' $i; i=$((i+1)); sleep 0.1; done ) & ` +
        `exec dd bs=1 status=none of=${record}\n`]);
      const deadline = Date.now() + 30_000;
      while (!existsSync(record)) {
        if (Date.now() > deadline) throw new Error(`the recorder ${record} never appeared`);
        await sleep(100);
      }
      const scrollback = async () => (await cs(["scrollback", "--tab-name", TAB])).stdout;
      const pid = /^PID=(\d+)/m.exec(await scrollback())?.[1];
      if (!pid) throw new Error("no PID line in the scrollback");
      await sleep(500);
      const recorded0 = statSync(record).size;

      for (const [path, label] of [[DOC, "document"], [DECK, "deck"], [BOARD, "board"]]) {
        await shell(["open", path, "--window", windowId, "--pane", left]);
        await waitActiveTab(page, path, label);
        if (path === DECK) await openOutline(page, DECK);
      }
      await showFiles(page, `[role="region"][data-pane-id=${JSON.stringify(left)}]`);
      await ctx.shot("setup");
      // The scrollback is the terminal's output stream. The loop only ever
      // appends its frame; with every frame (and a frame still being
      // written at the end) taken out, nothing may have been added.
      const frames = (raw) => raw
        .replace(/\x1b7\x1b\[1;1H\x1b\[41m RED \x1b\[0m plain \x1b\[44m BLUE \x1b\[0m \d{6}\x1b\[K\x1b8/g, "")
        .replace(/\x1b7(?:(?!\x1b8)[\s\S])*$/, "");
      const scrollback0 = await scrollback();

      /// Every surface's reading, each read until two in a row agree.
      const readAll = async (label) => {
        const out = {};
        for (const surface of SURFACES) {
          out[surface] = await stableReading(page, surface, `${label} ${surface}`);
          await ctx.shot(`${label}-${surface}`);
        }
        out.terminal = await stableReading(page, "terminal", `${label} terminal`);
        return out;
      };

      const live = {};
      // The OS appearance: light, dark, light.
      for (const [label, scheme] of [["os-light", "light"], ["os-dark", "dark"], ["os-light-again", "light"]]) {
        await emulate(scheme);
        await waitHtmlTheme(scheme, label);
        live[label] = await readAll(`live-${label}`);
      }
      // The Settings choice: Dark over the OS's light, then System again.
      await chooseTheme(page, "dark");
      await waitHtmlTheme("dark", "settings-dark");
      live["settings-dark"] = await readAll("live-settings-dark");
      await chooseTheme(page, "system");
      await waitHtmlTheme("light", "settings-system");
      live["settings-system"] = await readAll("live-settings-system");

      // Fresh loads of the same window in each theme.
      const reloadIn = async (label, theme) => {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(".pane", { timeout: 30_000 });
        await waitHtmlTheme(theme, label);
        await ctx.waitWindowLive(windowId);
        return readAll(label);
      };
      const fresh = {};
      fresh.light = await reloadIn("fresh-light", "light");
      await emulate("dark");
      fresh.dark = await reloadIn("fresh-dark", "dark");
      await emulate("light");
      await chooseTheme(page, "dark");
      fresh["settings-dark"] = await reloadIn("fresh-settings-dark", "dark");
      await chooseTheme(page, "system");
      await waitHtmlTheme("light", "restore system");

      const scrollback1 = await scrollback();
      const recorded1 = statSync(record).size;
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();

      const expected = {
        "os-light": fresh.light,
        "os-dark": fresh.dark,
        "os-light-again": fresh.light,
        "settings-dark": fresh["settings-dark"],
        "settings-system": fresh.light,
      };
      const failures = [];
      for (const [label, reading] of Object.entries(live)) {
        for (const surface of [...SURFACES, "terminal"]) {
          const diff = firstDifferences(reading[surface], expected[label][surface]);
          if (diff) failures.push(`${label} ${surface}: ${diff}`);
        }
      }
      for (const surface of [...SURFACES, "terminal"]) {
        if (!firstDifferences(fresh.light[surface], fresh.dark[surface])) failures.push(`${surface}: light and dark read the same`);
      }
      if (comm !== "dd") failures.push(`the terminal's process ${pid} is now ${JSON.stringify(comm)}, not the recorder`);
      if (recorded1 !== recorded0) failures.push(`${recorded1 - recorded0} byte(s) reached the terminal's program`);
      if (!scrollback1.startsWith(scrollback0)) failures.push("the scrollback before the switches is not a prefix of the scrollback after them");
      if (frames(scrollback1) !== frames(scrollback0)) {
        failures.push(`the terminal printed more than the loop's frames: ${JSON.stringify(frames(scrollback1).slice(frames(scrollback0).length - 40, frames(scrollback0).length + 160))}`);
      }
      const summary = { pid, comm, recorded: [recorded0, recorded1], scrollback: [scrollback0.length, scrollback1.length], failures };
      ctx.mark("theme-switch-live", { ...summary, live, fresh });
      console.log(`[221] ${JSON.stringify(summary)}`);
      if (failures.length > 0) throw new Error(`theme switch: ${failures.join("; ")}`);
    } finally {
      await cdp.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
      await restoreThemeChoice(page, token, originalTheme).catch(() => {});
      if (terminalOpen) await cs(["close", "--tab-name", TAB]).catch(() => {});
      if (original.ghostty !== true) await writeTerminalPrefs(page, token, { ghostty: original.ghostty }).catch(() => {});
      rmSync(record, { force: true });
    }
  },
};

async function themeChoice(page, token) {
  return page.evaluate(async (authToken) => {
    const response = await fetch("/api/config", { headers: authToken ? { authorization: `Bearer ${authToken}` } : {} });
    if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
    return (await response.json()).preferences.theme ?? "system";
  }, token);
}

/// Put the theme choice back when a leg ended with Settings still on Dark.
async function restoreThemeChoice(page, token, value) {
  if ((await themeChoice(page, token)) === value) return;
  await page.evaluate(async ({ authToken, value }) => {
    const headers = { "content-type": "application/json" };
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    const config = await (await fetch("/api/config", { headers })).json();
    const response = await fetch("/api/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ expected_revision: config.revision, preferences: { theme: value } }),
    });
    if (!response.ok) throw new Error(`PATCH /api/config -> ${response.status}`);
  }, { authToken: token, value });
}

async function command(page, name) {
  await page.evaluate((command) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: command } })), name);
}

/// Open the Outline of `path`'s tab: bring the tab forward with a click, so
/// its pane and tab are the active ones the command acts on, toggle the
/// outline and wait for the slide thumbnails.
async function openOutline(page, path) {
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tab = await page.evaluateHandle((title) => [...document.querySelectorAll('[role="tablist"] [role="tab"]')].find((el) => el.title === title) ?? null, path);
    if (!(await tab.evaluate((el) => el !== null))) throw new Error(`no tab for ${path}`);
    await tab.asElement().click();
    await tab.dispose();
    await waitActiveTab(page, path, "outline");
    await command(page, "app.editor.outline");
    const shown = await page
      .waitForFunction(() => [...document.querySelectorAll(".editor-tab.active")].some((el) => el.querySelector(".slide-miniature") && getComputedStyle(el).visibility === "visible"), { timeout: 5_000 })
      .then(() => true, () => false);
    if (shown) return attempt;
    last = await page.evaluate(() => [...document.querySelectorAll(".editor-tab.active")].map((el) => el.querySelector("aside")?.getAttribute("aria-label") ?? "no aside").join(","));
  }
  throw new Error(`${path}: the Outline's thumbnails never showed; asides ${last}`);
}

async function waitActiveTab(page, path, label) {
  await page.waitForFunction(
    (title) => [...document.querySelectorAll('[role="tablist"] [role="tab"][aria-selected="true"]')].some((tab) => tab.title === title),
    { timeout: 30_000 },
    path,
  ).catch(async () => {
    const tabs = await page.$$eval('[role="tablist"] [role="tab"]', (all) => all.map((tab) => `${tab.title}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`));
    throw new Error(`${label}: ${path} never became an active tab; tabs ${JSON.stringify(tabs)}`);
  });
}

/// Pick the app theme in Settings (its Global section opens first) and
/// close it again.
async function chooseTheme(page, value) {
  await command(page, "app.settings.open");
  const radio = `input[name="settings-theme"][value="${value}"]`;
  await page.waitForSelector(radio, { timeout: 15_000 });
  const checked = await page.$eval(radio, (input) => input.checked);
  if (!checked) {
    const saved = page.waitForResponse(
      (response) => response.request().method() === "PATCH" && response.url().includes("/api/config") && response.ok(),
      { timeout: 15_000 },
    );
    await page.$eval(radio, (input) => input.closest("label").click());
    await saved;
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[aria-label="Settings sections"]'), { timeout: 10_000 });
}

/// Bring the left pane's tab for `surface` forward (the right pane holds the
/// terminal), move the pointer off every surface, and read until two readings
/// 400 ms apart agree: a switch redraws diagrams, thumbnails and the board
/// asynchronously.
async function stableReading(page, surface, label) {
  if (surface !== "terminal") {
    const title = { doc: DOC, deck: DECK, board: BOARD, files: null }[surface];
    const tab = await page.evaluateHandle((title) => {
      const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
      return tabs.find((el) => (title ? el.title === title : el.title === "File Browser" || el.title.startsWith("File Browser: "))) ?? null;
    }, title);
    if (!(await tab.evaluate((el) => el !== null))) throw new Error(`${label}: no tab for the ${surface}`);
    if (!(await tab.evaluate((el) => el.getAttribute("aria-selected") === "true"))) await tab.asElement().click();
    await tab.dispose();
  }
  await page.mouse.move(1, 1);
  const deadline = Date.now() + 30_000;
  let previous = null;
  for (;;) {
    const reading = await page.evaluate(readSurface, surface, { doc: DOC, deck: DECK, board: BOARD });
    if (reading.ready && previous?.ready && JSON.stringify(reading) === JSON.stringify(previous)) return reading.rows;
    if (Date.now() > deadline) throw new Error(`${label}: no stable reading in 30 s; the last: ${JSON.stringify(reading).slice(0, 600)}`);
    previous = reading;
    await sleep(400);
  }
}

/// Runs in the page. The surface's rows: one per visible element with its
/// tag, classes (less scope hashes and focus state) and computed colours; for
/// the terminal, the canvas pixels at fixed cells of the loop's line and of
/// unstyled cells, and the tab's own colours.
function readSurface(surface, files) {
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility !== "visible" || s.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const rowsOf = (roots) => {
    const rows = [];
    for (const root of roots) {
      for (const el of [root, ...root.querySelectorAll("*")]) {
        if (!visible(el) || el.closest(".cm-cursorLayer, .cm-selectionLayer")) continue;
        const s = getComputedStyle(el);
        const classes = [...el.classList].filter((c) => !/^(svelte-|ͼ)/.test(c) && !/focus/i.test(c)).sort().join(".");
        rows.push(`${el.tagName.toLowerCase()}.${classes} c=${s.color} bg=${s.backgroundColor} fill=${s.fill} stroke=${s.stroke} border=${s.borderTopColor} filter=${s.filter} opacity=${s.opacity}`);
      }
    }
    return rows;
  };
  const paneOf = (title) => [...document.querySelectorAll('[role="region"][data-pane-id]')]
    .find((pane) => [...pane.querySelectorAll('[role="tablist"] [role="tab"]')].some((tab) => tab.title === title));
  const left = paneOf(files.doc);
  if (!left) return { ready: false, why: "no pane holds the document" };
  if (surface === "terminal") {
    const host = [...document.querySelectorAll(".terminal-tab.active .terminal-host")].find(visible);
    const canvas = host?.querySelector("canvas");
    if (!canvas || !canvas.width) return { ready: false, why: "no terminal canvas" };
    const tab = host.closest(".terminal-tab");
    // The loop's line fixes the cell geometry: the grid's first row starts
    // with 5 red cells, then 7 unstyled and 6 blue ones. The red run at the
    // canvas's top left is 5 cells wide and one row tall.
    const g = canvas.getContext("2d");
    const line = (y) => g.getImageData(0, y, canvas.width, 1).data;
    const column = (x) => g.getImageData(x, 0, 1, canvas.height).data;
    const rgb = (data, i) => `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]},${data[i * 4 + 3]}`;
    const top = line(1);
    const red = rgb(top, 1);
    let width = 1;
    while (width < canvas.width && rgb(top, width) === red) width++;
    const leftEdge = column(1);
    let height = 1;
    while (height < canvas.height && rgb(leftEdge, height) === red) height++;
    const cw = width / 5;
    if (cw < 3 || cw > 60 || height < 6 || height > 120 || rgb(top, Math.floor(5.5 * cw)) === red) {
      return { ready: false, why: { red, width, height } };
    }
    const at = (col, row) => rgb(g.getImageData(Math.floor(col * cw), Math.floor(row * height), 1, 1).data, 0);
    const right = canvas.width / cw - 1.5;
    return {
      ready: true,
      rows: [
        `tab bg=${getComputedStyle(tab).backgroundColor} host bg=${getComputedStyle(host).backgroundColor}`,
        `cell ${cw}x${height}`,
        `red ${at(0.5, 0.5)}`,
        `plain ${at(5.5, 0.5)}`,
        `blue ${at(12.5, 0.5)}`,
        `erased ${at(right, 0.5)}`,
        `history ${at(right, 2.5)}`,
      ],
    };
  }
  if (surface === "files") {
    const browser = [...left.querySelectorAll(".browser")].find(visible);
    const listed = browser?.querySelectorAll('[role="option"]').length ?? 0;
    return browser && listed > 0 ? { ready: true, rows: rowsOf([browser]) } : { ready: false, why: "no Files listing" };
  }
  const tab = [...left.querySelectorAll(".editor-tab.active")].find(visible);
  if (!tab) return { ready: false, why: `no active editor tab for the ${surface}` };
  if (surface === "doc") {
    const imgs = [...tab.querySelectorAll("img")];
    const img = imgs.find((el) => el.complete && el.naturalWidth > 0);
    const diagram = tab.querySelector(".cm-content svg");
    const keyword = [...tab.querySelectorAll(".cm-line span")].some((el) => el.textContent === "const");
    if (!img || !diagram || !keyword) {
      const title = left.querySelector('[role="tab"][aria-selected="true"]')?.title;
      return { ready: false, why: { title, imgs: imgs.map((el) => [el.getAttribute("src"), el.complete, el.naturalWidth, el.className]), diagram: !!diagram, keyword } };
    }
  }
  if (surface === "deck") {
    const minis = tab.querySelectorAll(".slide-miniature .md-slide-preview-page");
    if (minis.length !== 3 || !tab.querySelector(".slide-miniature svg")) return { ready: false, why: `thumbnails ${minis.length}` };
  }
  if (surface === "board") {
    const board = tab.querySelector(".excalidraw");
    if (!board || !board.querySelector("canvas")) return { ready: false, why: "no board canvas" };
    return { ready: true, rows: [`board.${[...board.classList].filter((c) => c.startsWith("theme")).sort().join(".")}`, ...rowsOf([board])] };
  }
  return { ready: true, rows: rowsOf([tab]) };
}

/// The first few rows where two readings differ, or null when they agree.
function firstDifferences(a, b) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left === right) return null;
  if (!Array.isArray(a) || !Array.isArray(b)) return `${left.slice(0, 300)} vs ${right.slice(0, 300)}`;
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < 3; i++) {
    if (a[i] !== b[i]) out.push(`[${i}] ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`);
  }
  return `${a.length} vs ${b.length} rows; ${out.join(" | ")}`;
}
