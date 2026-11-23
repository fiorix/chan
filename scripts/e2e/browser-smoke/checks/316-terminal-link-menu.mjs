// A click on a link a Ghostty terminal underlines opens the link menu.
//
// A fresh terminal's shell cds into a seeded folder,
// writes `stty size` to a file there, clears the screen and prints, one a
// row from the top: a URL, an OSC 8 link to `./notes316.md` (text
// NOTES-REL), an OSC 8 `file://<uname -n>/<abs>/notes316.md` (NOTES-ABS),
// an OSC 8 `file:///<abs>/missing316.md` (MISSING), an OSC 8 `file://`
// on another host (FOREIGN) and an OSC 8 `~/link316-home.md` (HOME), a file
// the shell first writes in its $HOME. The printf's format string holds the
// escapes and its arguments the targets, so the echoed command line holds no
// link and no marker. A cell's pixels come from the surface's box and the
// grid `stty` reported; nothing reads the page's terminal objects.
// `window.open` is stubbed in the page and records what the browser would
// have opened.
//
// Before each click on a link the pointer moves to another row and then onto
// the link, as a hand does, in every leg but resting-click, which leaves
// the pointer still while the link is printed underneath it.
//
// Required legs:
//   url-menu        a click on the URL opens the menu with "Open in
//                   browser", the URL and its host on a line of its own,
//                   and the menu takes the keyboard
//                   onto that entry; pressing it reaches the opener.
//   rel-editor      a click on NOTES-REL shows the relative
//                   target and "Open in editor"; pressing it opens an editor
//                   tab on the seeded file, resolved against the shell's
//                   directory.
//   abs-editor      the same for NOTES-ABS, the file: URI on this host.
//   missing         "Open in editor" on MISSING ends disabled, "not found".
//   foreign         "Open in editor" on FOREIGN shows disabled with the host.
//   home-editor     "Open in editor" on HOME opens the file in the
//                   server's home: an editor tab, or, where the file is
//                   outside the workspace and no host serves it, the refusal
//                   naming the expanded path, never "not found".
//   escape-typing   Escape closes the menu, and typing reaches the PTY.
//   output-closes   output that clears the screen closes an open menu.
//   resting-click   a URL printed into the row under a resting
//                   pointer opens the menu with no move off the row.
//   ctrl-click      Ctrl with a click opens the URL with no menu.
//   double-click    a double click on the URL leaves no menu and opens
//                   nothing.
//   out-and-back    a drag past half a cell and back opens no menu and
//                   leaves the clipboard sentinel intact.
//   padding-release a row-zero press released just above the canvas opens
//                   no link, including one in hidden history.
// Then the shell prints a URL, turns on mouse tracking (1000, SGR 1006) and
// becomes a raw recorder of what the PTY receives:
//   tracked-click   a plain click reaches the PTY as a report; no menu, and
//                   nothing opens.
//   shift-click     Shift with a click opens the menu; the PTY reads nothing.
//   shift-drag      Shift with a drag selects (the copy chord copies it);
//                   the PTY reads nothing.
//
// Every leg runs and reports; the check fails naming each failed leg.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal, TERMINAL_SURFACES } from "../lib/terminal-attach.mjs";
import { seedPointerClipboard } from "../lib/terminal-pointer.mjs";
import { assertTerminalPrefs, readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const DIR = "linkcheck316";
const NOTES = "notes316.md";
const BODY = "LINK316 NOTES BODY";
const URL_ARG = "s://example.com/link316?q=1";
const URL_316 = `http${URL_ARG}`;
const TRACK_URL = "https://example.com/track316";
const REST_URL = "https://example.com/rest316";
const EDGE_URL = "https://example.com/edge316";
const FOREIGN = "file://elsewhere.invalid/etc/hosts";
const MENU = '.terminal-tab-menu-bubble[aria-label="terminal link menu"]';
const SENTINEL = "SMOKE316_CLIPBOARD_SENTINEL";
const ROW = { url: 0, rel: 1, abs: 2, missing: 3, foreign: 4, home: 5 };
const HOME_FILE = "link316-home.md";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  name: "terminal-link-menu",
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
    const authToken = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const origin = new URL(ctx.serverUrl).origin;
    const env = { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId };
    const cs = (args, opts = {}) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], { cwd: ctx.workspaceDir, env, timeout: 90_000, ...opts });

    const cdp = await page.createCDPSession();
    await cdp.send("Browser.grantPermissions", {
      browserContextId: ctx.browser.id,
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });

    const dir = join(ctx.workspaceDir, DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, NOTES), `# Notes\n\n${BODY}\n`);
    rmSync(join(dir, "missing316.md"), { force: true });

    // The browser's opener, recorded instead of opening a tab.
    await page.evaluate(() => {
      window.__opened316 = [];
      window.open = (url) => {
        window.__opened316.push(String(url));
        return null;
      };
    });
    const opened = () => page.evaluate(() => [...window.__opened316]);

    const originalPrefs = await readTerminalPrefs(page, authToken);
    const results = {};
    const failures = [];
    const tabs = [];
    const homeFiles = new Set();

    async function waitScrollback(tab, needle, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      let last = "";
      for (;;) {
        try {
          last = (await cs(["scrollback", "--tab-name", tab])).stdout;
          if (last.includes(needle)) return last;
        } catch {}
        if (Date.now() > deadline) {
          throw new Error(`scrollback of ${tab} never showed ${JSON.stringify(needle)}; last:\n${last.slice(-1500)}`);
        }
        await sleep(300);
      }
    }

    async function menuShown() {
      return page.evaluate((sel) => {
        const menu = document.querySelector(sel);
        if (!menu) return null;
        const rows = [...menu.querySelectorAll("[data-terminal-link-action]")].map((button) => ({
          action: button.getAttribute("data-terminal-link-action"),
          label: button.querySelector(".mbtn-label")?.textContent?.trim() ?? "",
          disabled: button.disabled,
        }));
        return {
          // The whole target; the menu may show a long one cut in the middle.
          target: menu.querySelector("[data-terminal-link-target]")?.getAttribute("data-terminal-link-target") ?? null,
          host: menu.querySelector("[data-terminal-link-host]")?.textContent ?? null,
          reason: menu.querySelector("[data-terminal-link-reason]")?.textContent ?? null,
          rows,
          focused: menu.contains(document.activeElement),
        };
      }, MENU);
    }

    async function waitMenu(label, predicate = () => true, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      for (;;) {
        last = await menuShown();
        if (last && predicate(last)) return last;
        if (Date.now() > deadline) {
          throw new Error(`${label}: no link menu${last ? ` as wanted; it showed ${JSON.stringify(last)}` : " opened"}`);
        }
        await sleep(100);
      }
    }

    async function expectNoMenu(label, settleMs = 800) {
      await sleep(settleMs);
      const shown = await menuShown();
      if (shown) throw new Error(`${label}: a link menu showed: ${JSON.stringify(shown)}`);
    }

    async function closeAnyMenu() {
      if (await menuShown()) {
        await page.keyboard.press("Escape");
        await page.waitForSelector(MENU, { hidden: true, timeout: 5_000 }).catch(() => {});
      }
    }

    async function leg(name, fn) {
      try {
        results[name] = (await fn()) ?? "pass";
      } catch (error) {
        results[name] = `FAIL: ${error.message}`;
        failures.push(name);
        await ctx.shot(`${name}-fail`).catch(() => {});
        await page.keyboard.up("Shift").catch(() => {});
        await page.keyboard.up("Control").catch(() => {});
        await closeAnyMenu().catch(() => {});
      }
    }

    /// The tab strip's tab whose title starts with `text`, clicked to the
    /// front by the pointer.
    async function activateTab(text) {
      for (const label of await page.$$('[role="tablist"] .tab [role="tab"]')) {
        const title = await label.evaluate((el) => el.closest(".tab")?.title ?? "");
        if (title.startsWith(text)) {
          await label.click();
          await label.dispose();
          return;
        }
        await label.dispose();
      }
      throw new Error(`no tab titled ${text}`);
    }

    async function editorTabOpened(label) {
      await page.waitForFunction(
        (name, body) =>
          [...document.querySelectorAll('[role="tablist"] .tab')].some((tab) => (tab.title ?? "").includes(name)) &&
          [...document.querySelectorAll(".cm-content")].some((el) => el.textContent?.includes(body)),
        { timeout: 15_000 },
        NOTES,
        BODY,
      ).catch(() => {
        throw new Error(`${label}: no editor tab on ${NOTES} showing its text`);
      });
    }

    async function runGhostty() {
      const backend = "ghostty";
      const name = "SmokeLink316G";
      const at = (leg) => `${backend}.${leg}`;
      await writeTerminalPrefs(page, authToken, { mouse_capture: true });
      await assertTerminalPrefs(ctx, { mouse_capture: true });
      const row = await openAttachedTerminal(ctx, page, cs, windowId, name, "ghostty");
      tabs.push(name);
      const surfaceQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab[data-terminal-tab-id="${row.tab}"] ${TERMINAL_SURFACES.ghostty}`;
      const sizeFile = join(dir, `size316-${backend}`);
      rmSync(sizeFile, { force: true });

      const format = String.raw`\033[H\033[2Jhttp%s\n\033]8;;%s\033\\NOTES-REL\033]8;;\033\\\n\033]8;;%s\033\\NOTES-ABS\033]8;;\033\\\n\033]8;;%s\033\\MISSING\033]8;;\033\\\n\033]8;;%s\033\\FOREIGN\033]8;;\033\\\n\033]8;;%s\033\\HOME\033]8;;\033\\\nL316_%s\n`;
      const homeRecord = join(dir, `home316-${backend}`);
      const print = `cd ${DIR} && stty size > size316-${backend} && printf '%s' "$HOME" > home316-${backend} && printf 'LINK316 HOME BODY\\n' > "$HOME/${HOME_FILE}" && printf '${format}' '${URL_ARG}' './${NOTES}' "file://$(uname -n)$PWD/${NOTES}" "file://$PWD/missing316.md" '${FOREIGN}' '~/${HOME_FILE}' READY\n`;
      await cs(["write", "--tab-name", name, print]);
      await waitScrollback(name, "L316_READY");
      if (!existsSync(sizeFile)) throw new Error(`${backend}: the shell wrote no ${sizeFile}`);
      const [rows, cols] = readFileSync(sizeFile, "utf8").trim().split(/\s+/).map(Number);
      assert.ok(Number.isInteger(rows) && rows >= 10 && Number.isInteger(cols) && cols > URL_316.length,
        "the PTY grid fits the link fixtures without wrapping");
      const home = existsSync(homeRecord) ? readFileSync(homeRecord, "utf8").trim() : "";
      if (home) homeFiles.add(join(home, HOME_FILE));
      await sleep(500);

      async function cell(col, rowIndex) {
        const box = await page.$eval(surfaceQuery, (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        });
        const w = box.width / cols;
        const h = box.height / rows;
        return { x: box.left + (col + 0.5) * w, y: box.top + (rowIndex + 0.5) * h, w, h };
      }
      // Onto a cell from another row, as a hand moves (see the header).
      const approach = async (p) => {
        await page.mouse.move(p.x, p.y + 3 * p.h);
        await page.mouse.move(p.x, p.y);
      };
      const clickRow = async (rowIndex, col = 2) => {
        const p = await cell(col, rowIndex);
        await approach(p);
        await page.mouse.click(p.x, p.y);
      };
      const press = async (action) => {
        const button = await page.$(`${MENU} [data-terminal-link-action="${action}"]`);
        if (!button) throw new Error(`the link menu has no ${action} entry`);
        await button.click();
      };

      await leg(at("url-menu"), async () => {
        const before = (await opened()).length;
        await clickRow(ROW.url);
        const menu = await waitMenu("url click with the keyboard on its entry", (m) => m.focused);
        const open = menu.rows.find((r) => r.action === "open-browser");
        if (menu.target !== URL_316 || menu.host !== "example.com" || !open || open.disabled || !menu.rows.some((r) => r.action === "copy-link")) {
          throw new Error(`menu shows ${JSON.stringify(menu)}`);
        }
        await press("open-browser");
        await page.waitForSelector(MENU, { hidden: true, timeout: 5_000 });
        const now = await opened();
        if (now.length !== before + 1 || now.at(-1) !== URL_316) throw new Error(`the opener got ${JSON.stringify(now.slice(before))}`);
        return { target: menu.target, host: menu.host, focused: menu.focused, opened: now.at(-1) };
      });

      await leg(at("foreign"), async () => {
        await clickRow(ROW.foreign);
        const menu = await waitMenu("foreign click");
        const edit = menu.rows.find((r) => r.action === "open-editor");
        if (menu.target !== "/etc/hosts" || !edit?.disabled || !menu.reason?.includes("elsewhere.invalid")) {
          throw new Error(`menu shows ${JSON.stringify(menu)}`);
        }
        await closeAnyMenu();
        return { reason: menu.reason };
      });

      await leg(at("missing"), async () => {
        await clickRow(ROW.missing);
        const menu = await waitMenu("missing click");
        if (!menu.target?.endsWith(`/${DIR}/missing316.md`)) throw new Error(`menu shows ${JSON.stringify(menu)}`);
        await press("open-editor");
        const after = await waitMenu("missing press", (m) => m.reason === "not found");
        if (!after.rows.find((r) => r.action === "open-editor")?.disabled) throw new Error(`entry not disabled: ${JSON.stringify(after)}`);
        if (existsSync(join(dir, "missing316.md"))) throw new Error("the missing file was created");
        await closeAnyMenu();
        return { reason: after.reason };
      });

      await leg(at("escape-typing"), async () => {
        await clickRow(ROW.url);
        await waitMenu("url click");
        await page.keyboard.press("Escape");
        await page.waitForSelector(MENU, { hidden: true, timeout: 5_000 });
        await page.keyboard.type("echo typed316_$((40+2))");
        await page.keyboard.press("Enter");
        await waitScrollback(name, "typed316_42", 10_000);
      });

      await leg(at("ctrl-click"), async () => {
        const before = (await opened()).length;
        const p = await cell(2, ROW.url);
        await approach(p);
        await page.keyboard.down("Control");
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up("Control");
        await expectNoMenu("ctrl click");
        const now = await opened();
        if (now.length !== before + 1 || now.at(-1) !== URL_316) throw new Error(`the opener got ${JSON.stringify(now.slice(before))}`);
      });

      await leg(at("double-click"), async () => {
        const before = (await opened()).length;
        const p = await cell(4, ROW.url);
        await approach(p);
        await page.mouse.click(p.x, p.y, { count: 2 });
        await expectNoMenu("double click");
        const now = await opened();
        if (now.length !== before) throw new Error(`the opener got ${JSON.stringify(now.slice(before))}`);
      });

      await leg(at("out-and-back"), async () => {
        const before = (await opened()).length;
        const p = await cell(4, ROW.url);
        await approach(p);
        await seedPointerClipboard(page, SENTINEL);
        await page.mouse.down();
        try {
          await page.mouse.move(p.x + p.w, p.y);
          await page.mouse.move(p.x, p.y);
        } finally { await page.mouse.up(); }
        await expectNoMenu("out-and-back drag");
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        const now = await opened();
        assert.equal(now.length, before, "out-and-back drag opens no browser tab");
        assert.equal(copied, SENTINEL, "out-and-back drag copies nothing on release");
        return { travel: p.w, threshold: p.w / 2, copied };
      });

      await leg(at("rel-editor"), async () => {
        await clickRow(ROW.rel);
        const menu = await waitMenu("relative click");
        if (menu.target !== `./${NOTES}` || !menu.rows.some((r) => r.action === "open-editor" && !r.disabled)) {
          throw new Error(`menu shows ${JSON.stringify(menu)}`);
        }
        await press("open-editor");
        await editorTabOpened("relative open");
        await activateTab(name);
        await sleep(500);
      });
      await leg(at("home-editor"), async () => {
        if (!home) throw new Error("the shell wrote no $HOME");
        await clickRow(ROW.home);
        const menu = await waitMenu("home click");
        if (menu.target !== `~/${HOME_FILE}` || !menu.rows.some((r) => r.action === "open-editor" && !r.disabled)) {
          throw new Error(`menu shows ${JSON.stringify(menu)}`);
        }
        await press("open-editor");
        const expanded = join(home, HOME_FILE);
        const deadline = Date.now() + 10_000;
        for (;;) {
          const shown = await menuShown();
          if (!shown) {
            // Opened here, or routed to the window that serves it.
            await activateTab(name).catch(() => {});
            await sleep(500);
            return { opened: expanded };
          }
          if (shown.reason) {
            if (!shown.reason.includes(expanded)) throw new Error(`the open was refused without the home path: ${JSON.stringify(shown)}`);
            await closeAnyMenu();
            return { refusedNaming: expanded };
          }
          if (Date.now() > deadline) throw new Error(`the open answered nothing: ${JSON.stringify(shown)}`);
          await sleep(100);
        }
      });

      await leg(at("abs-editor"), async () => {
        await clickRow(ROW.abs);
        const menu = await waitMenu("file: click");
        // The shell's $PWD may name the folder by another spelling than the
        // check's own path to it.
        const paths = [join(dir, NOTES), join(realpathSync(dir), NOTES)];
        if (!paths.includes(menu.target) || !menu.rows.some((r) => r.action === "open-editor" && !r.disabled)) {
          throw new Error(`menu shows ${JSON.stringify(menu)}`);
        }
        await press("open-editor");
        await editorTabOpened("file: open");
        await activateTab(name);
        await sleep(500);
      });

      await leg(at("output-closes"), async () => {
        await clickRow(ROW.url);
        await waitMenu("url click");
        await cs(["write", "--tab-name", name, "clear\n"]);
        await page.waitForSelector(MENU, { hidden: true, timeout: 10_000 }).catch(() => {
          throw new Error("the menu stayed up over a cleared screen");
        });
      });

      await leg(at("padding-release"), async () => {
        // Fill history with links so a negative click row cannot silently
        // pass merely because the wrongly mapped history row is empty.
        await cs(["write", "--tab-name", name,
          `printf '\\033[H\\033[2J'; i=0; while [ "$i" -lt ${rows + 4} ]; do printf 'http%s\\n' '${EDGE_URL.slice(4)}'; i=$((i+1)); done; printf '\\033[Hhttp%s\\nEDGE316_%s\\n' '${EDGE_URL.slice(4)}' READY\n`]);
        const output = await waitScrollback(name, "EDGE316_READY");
        const historyUrls = output.split(EDGE_URL).length - 1;
        assert.ok(historyUrls > rows, "the PTY printed more link rows than fit on the screen");
        await sleep(500);
        const p = await cell(4, 0);
        const edge = await page.$eval(surfaceQuery, (canvas) => {
          const r = canvas.getBoundingClientRect();
          const host = canvas.parentElement;
          const h = host.getBoundingClientRect();
          return { top: r.top, hostTop: h.top, padding: Number.parseFloat(getComputedStyle(host).paddingTop) };
        });
        assert.ok(edge.top - edge.hostTop >= 2 && edge.padding >= 2, "the terminal has padding above the canvas");
        assert.ok(p.w / 2 > 2, "the release is closer than the half-cell drag threshold");
        const release = { x: p.x, y: edge.top - 1 };
        assert.ok(await page.evaluate(({ query, point }) => {
          const canvas = document.querySelector(query);
          return document.elementFromPoint(point.x, point.y) === canvas.parentElement;
        }, { query: surfaceQuery, point: release }), "the release point hits host padding, outside the canvas");
        const before = (await opened()).length;
        await page.mouse.move(p.x, edge.top + 1);
        await page.mouse.down();
        try { await page.mouse.move(release.x, release.y); }
        finally { await page.mouse.up(); }
        await expectNoMenu("padding release");
        assert.equal((await opened()).length, before, "padding release opens no browser tab");
        return { edge, release, historyUrls };
      });

      // ghostty looks a link up at the click, so one printed into the row
      // under a resting pointer is clickable with no move off the row.
      await leg(at("resting-click"), async () => {
        const p = await cell(2, 0);
        await page.mouse.move(p.x, p.y);
        await cs(["write", "--tab-name", name, `printf '\\033[H\\033[2Jhttp%s\\nR316_%s\\n' '${REST_URL.slice(4)}' READY\n`]);
        await waitScrollback(name, "R316_READY");
        await sleep(300);
        await page.mouse.click(p.x, p.y);
        const menu = await waitMenu("resting click");
        if (menu.target !== REST_URL) throw new Error(`menu shows ${JSON.stringify(menu)}`);
        await closeAnyMenu();
      });

      // The shell prints a URL, turns on mouse tracking and becomes a raw
      // recorder of what the PTY receives.
      const record = join(ctx.outDir, `pty316-${backend}`);
      rmSync(record, { force: true });
      const trackFormat = String.raw`\033[H\033[2Jhttp%s\n\033[?1000h\033[?1006hT316_%s\n`;
      await cs(["write", "--tab-name", name,
        `printf '${trackFormat}' '${TRACK_URL.slice(4)}' READY && stty raw -echo && exec dd bs=1 status=none of=${record}\n`]);
      await waitScrollback(name, "T316_READY");
      const deadline = Date.now() + 15_000;
      while (!existsSync(record) && Date.now() < deadline) await sleep(100);
      if (!existsSync(record)) throw new Error(`${backend}: the recorder never started`);
      await sleep(500);
      const recorded = () => readFileSync(record).toString("latin1");

      await leg(at("tracked-click"), async () => {
        const before = recorded().length;
        const openedBefore = (await opened()).length;
        await clickRow(0);
        const deadline = Date.now() + 5_000;
        while (!recorded().slice(before).includes("\x1b[<0;") && Date.now() < deadline) await sleep(100);
        const got = recorded().slice(before);
        if (!got.includes("\x1b[<0;")) throw new Error(`the PTY read ${JSON.stringify(got)}, no press report`);
        await expectNoMenu("tracked click");
        const now = await opened();
        if (now.length !== openedBefore) throw new Error(`the opener got ${JSON.stringify(now.slice(openedBefore))}`);
        return { pty: got };
      });

      await leg(at("shift-click"), async () => {
        const before = recorded().length;
        const p = await cell(2, 0);
        await approach(p);
        await page.keyboard.down("Shift");
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up("Shift");
        const menu = await waitMenu("shift click");
        if (menu.target !== TRACK_URL) throw new Error(`menu shows ${JSON.stringify(menu)}`);
        await page.keyboard.press("Escape");
        await page.waitForSelector(MENU, { hidden: true, timeout: 5_000 });
        await sleep(500);
        const got = recorded().slice(before);
        if (got !== "") throw new Error(`the PTY read ${JSON.stringify(got)}`);
      });

      await leg(at("shift-drag"), async () => {
        const before = recorded().length;
        const from = await cell(0, 0);
        const to = await cell(14, 0);
        await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
        await page.keyboard.down("Shift");
        await page.mouse.move(from.x - from.w / 3, from.y);
        await page.mouse.down();
        for (let s = 1; s <= 6; s++) await page.mouse.move(from.x + ((to.x - from.x) * s) / 6, from.y);
        await page.mouse.up();
        await page.keyboard.up("Shift");
        await sleep(300);
        await page.keyboard.down("Control");
        await page.keyboard.down("Shift");
        await page.keyboard.press("KeyC");
        await page.keyboard.up("Shift");
        await page.keyboard.up("Control");
        await sleep(500);
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        const got = recorded().slice(before);
        if (got !== "") throw new Error(`the PTY read ${JSON.stringify(got)}`);
        if (copied === SENTINEL || !TRACK_URL.startsWith(copied.trim()) || copied.trim().length < 10) {
          throw new Error(`the drag selected ${JSON.stringify(copied)}`);
        }
        await expectNoMenu("shift drag", 200);
        return { copied };
      });
    }

    let runError = null;
    try {
      await runGhostty();
      if (failures.length > 0) {
        throw new Error(`failed legs: ${failures.join(", ")}\n${JSON.stringify(results, null, 2)}`);
      }
      const required = ["url-menu", "foreign", "missing", "escape-typing", "ctrl-click", "double-click",
        "out-and-back", "rel-editor", "home-editor", "abs-editor", "output-closes", "padding-release",
        "resting-click", "tracked-click", "shift-click", "shift-drag"]
        .map((leg) => `ghostty.${leg}`);
      assert.deepEqual(Object.keys(results).sort(), required.sort(), "all 16 Ghostty link-menu legs ran");
      return results;
    } catch (error) {
      runError = error;
      throw error;
    } finally {
      let restoreError = null;
      try {
        await restoreTerminalPrefs(ctx, page, authToken, originalPrefs);
      } catch (error) {
        restoreError = error;
      }
      for (const tab of tabs) {
        try {
          await cs(["close", "--tab-name", tab]);
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
      for (const file of homeFiles) rmSync(file, { force: true });
      await cdp.detach().catch(() => {});
      if (restoreError) {
        if (runError) console.error(`[316-terminal-link-menu] restore failed: ${restoreError.message}`);
        else throw restoreError;
      }
    }
  },
};
