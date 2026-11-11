// A tmux -CC connection's control terminal shows on the card of the machine whose terminal ran it. Running `tmux -CC` in a local terminal buries the control terminal; This machine's card lists it as a buried row carrying the connection's detach, the connection's tmux windows stay on the connection's own card alone, and that card keeps the detach on its title. Detaching from the machine card's row ends the connection as the title's detach does: the tmux rows, the record and the connection's card go, the control window is released as a plain terminal window, and the source shell types again. The cards are read on two launcher pages: the devserver page that drives the connection lists them one under another, and a second page whose surface meta is rewritten to the desktop's deals them as chan-desktop's deck, where This machine's card is brought to the front before its row is read and its detach is clicked.
//
// Runs on headless Chrome. Skips when tmux is not installed or the launcher bundle is missing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showCarouselCard } from "../lib/carousel.mjs";
import { fetchWindows, goto, killChild, mask, poll, spawnDevserver, wait } from "../lib/launcher-devserver.mjs";

const SOCKET = "chan-smoke-219";
const SESSION = "smoke219";
/// The connection's card title; its control terminal's row on This machine's
/// card names the connection with the session once tmux announces it.
const CARD_TITLE = "tmux -CC on this machine";
const ROW_CONTEXT = `${CARD_TITLE} (${SESSION})`;
const TITLE_DETACH = `Detach ${CARD_TITLE}`;
const ROW_DETACH = `Detach ${ROW_CONTEXT}`;
const ROW_DETACH_BUTTON = `button[aria-label="${ROW_DETACH}"]`;
const CONTROL_NAME = "Control terminal";
const BURIED_NOTE = "stays buried while the connection runs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function tmuxInstalled() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/// The live connection records, as the launcher reads them with the feed.
async function fetchTmux(origin, token) {
  const response = await fetch(`${origin}/api/library/tmux`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`tmux route answered ${response.status}`);
  return response.json();
}

/// A row's name as the launcher spells it (`windowDisplayName`).
function displayName(record) {
  if (record.control || record.tmux?.control) return CONTROL_NAME;
  const generated = record.kind === "terminal" ? `Terminal Window ${record.ordinal}` : `Window ${record.ordinal}`;
  const label = record.label?.trim();
  return label ? `${generated} [${label}]` : generated;
}

const sorted = (names) => JSON.stringify([...names].sort());

/// Every machine card a launcher page shows, as the user reads it: its name,
/// the controls on its title, and each row of its lists with the row's
/// context, its buried note and its buttons. On the deck a card also says
/// whether it is the one in front.
function readCards() {
  return [...document.querySelectorAll("section.card.machine")].map((card) => {
    const header = card.querySelector(".machine-header");
    const slot = card.closest('[aria-roledescription="card"]');
    return {
      name: (header?.querySelector(".machine-name") ?? header?.querySelector(".ds-id .row-name"))?.textContent?.trim() ?? null,
      slot: slot ? { label: slot.getAttribute("aria-label"), current: slot.getAttribute("aria-current") === "true", inert: !!card.closest("[inert]") } : null,
      title: [...(header?.querySelectorAll("button[aria-label]") ?? [])].map((button) => button.getAttribute("aria-label")),
      rows: [...card.querySelectorAll(".term-list .row")].map((row) => {
        const note = row.querySelector(".row-buried");
        return {
          name: row.querySelector(".row-name")?.textContent?.trim() ?? null,
          context: row.querySelector(".row-main .row-sub")?.textContent?.trim() ?? null,
          buried: note?.textContent?.trim() ?? null,
          note: note?.getAttribute("title") ?? null,
          buttons: [...row.querySelectorAll("button[aria-label]")].map((button) => button.getAttribute("aria-label")),
        };
      }),
    };
  });
}

/// The two cards while the connection runs, read against the feed's records:
/// This machine lists the buried control terminal with the row's detach and
/// its own plain terminals, and none of the connection's other windows; the
/// connection's card keeps the title's detach and lists its windows, its
/// control terminal buried with no action of its own.
function assertRunning(cards, rows, record, label) {
  const named = (name) => cards.filter((card) => card.name === name);
  check(named("This machine").length === 1 && named(CARD_TITLE).length === 1, `${label}: ${named("This machine").length} This machine card(s) and ${named(CARD_TITLE).length} connection card(s), not one each: ${JSON.stringify(cards)}`);
  const [machine] = named("This machine");
  const [connection] = named(CARD_TITLE);

  const buried = machine.rows.filter((row) => row.buried !== null);
  check(buried.length === 1, `${label}: This machine lists ${buried.length} buried row(s), not the connection's control terminal: ${JSON.stringify(machine.rows)}`);
  const [row] = buried;
  check(row.name === CONTROL_NAME, `${label}: the buried row on This machine is ${JSON.stringify(row.name)}, not ${CONTROL_NAME}`);
  check(row.buried === "buried" && row.note?.includes(BURIED_NOTE), `${label}: the row's buried note reads ${JSON.stringify({ text: row.buried, title: row.note })}`);
  check(row.context === ROW_CONTEXT, `${label}: the row names ${JSON.stringify(row.context)}, not ${JSON.stringify(ROW_CONTEXT)}`);
  check(sorted(row.buttons) === sorted([ROW_DETACH]), `${label}: the row's controls are ${JSON.stringify(row.buttons)}, not the connection's detach alone`);
  const plain = rows.filter((w) => !w.tmux && !w.control).map(displayName);
  const others = machine.rows.filter((r) => r !== row).map((r) => r.name);
  check(sorted(others) === sorted(plain), `${label}: This machine's other rows are ${JSON.stringify(others)}, not its plain terminals ${JSON.stringify(plain)}; the connection's windows must stay on its card`);

  check(connection.title.includes(TITLE_DETACH), `${label}: the connection's card title carries ${JSON.stringify(connection.title)}, not ${JSON.stringify(TITLE_DETACH)}`);
  const own = rows.filter((w) => w.tmux?.connection === record.connection).map(displayName);
  const unopened = record.windows.filter((tw) => !tw.chan_window).map((tw) => tw.name || tw.id);
  check(sorted(connection.rows.map((r) => r.name)) === sorted([...own, ...unopened]), `${label}: the connection's card lists ${JSON.stringify(connection.rows.map((r) => r.name))}, not its windows ${JSON.stringify([...own, ...unopened])}`);
  const ownControl = connection.rows.filter((r) => r.name === CONTROL_NAME);
  check(ownControl.length === 1 && ownControl[0].buried === "buried" && ownControl[0].buttons.length === 0, `${label}: the connection's card lists its control terminal as ${JSON.stringify(ownControl)}, not one buried row with no action`);
  return { machine, connection };
}

/// The launcher after the detach: no connection card and no buried row on
/// This machine.
function assertDetached(cards, label) {
  check(!cards.some((card) => card.name === CARD_TITLE), `${label}: the connection's card is still shown`);
  const machine = cards.find((card) => card.name === "This machine");
  check(machine, `${label}: no This machine card`);
  check(!machine.rows.some((row) => row.buried !== null || row.buttons.includes(ROW_DETACH)), `${label}: This machine still lists the buried row: ${JSON.stringify(machine.rows)}`);
  return true;
}

async function copyScrollback(page) {
  const sentinel = `copy-pending-${Date.now()}`;
  await page.evaluate((text) => navigator.clipboard.writeText(text), sentinel);
  await page.click(".terminal-tab.active", { button: "right" });
  const menu = '[role="menu"][aria-label="terminal menu"]';
  await page.waitForSelector(menu, { visible: true, timeout: 10_000 });
  const buttons = await page.$$(`${menu} [role="menuitem"]`);
  try {
    const labels = [];
    for (const button of buttons) {
      const label = await button.evaluate((element) => element.textContent?.trim());
      labels.push(label);
      if (label === "Copy Scrollback") {
        await button.click();
        return await poll("the terminal's copied scrollback", async () => {
          const text = await page.evaluate(() => navigator.clipboard.readText());
          return text !== sentinel ? text : null;
        }, 10_000);
      }
    }
    throw new Error(`the terminal menu has no Copy Scrollback: ${JSON.stringify(labels)}`);
  } finally {
    await Promise.all(buttons.map((button) => button.dispose()));
  }
}

const TERMINAL_SCREEN = ".terminal-tab.active .terminal.xterm .xterm-screen, .terminal-tab.active .terminal-host canvas";

async function waitTerminal(page, label) {
  await poll(`${label}: an attached terminal`, () => page.evaluate((selector) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return !!box && box.width > 0 && box.height > 0;
  }, TERMINAL_SCREEN), 60_000);
}

/// Every console error and page error of the pages this check drives, so a
/// failure says what the pages logged.
const pageLog = [];
const step = (label) => pageLog.push(`step ${new Date().toISOString().slice(11, 19)}: ${label}`);
function watchPage(page, label) {
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warn") pageLog.push(`${label} console.${message.type()}: ${mask(message.text()).slice(0, 300)}`);
  });
  page.on("pageerror", (error) => pageLog.push(`${label} pageerror: ${mask(String(error)).slice(0, 300)}`));
  page.on("dialog", (dialog) => {
    pageLog.push(`${label} dialog ${dialog.type()}: ${dialog.message().slice(0, 200)}`);
    void dialog.dismiss().catch(() => {});
  });
  return page;
}

async function popupFrom(page, action, label) {
  const popup = new Promise((resolve) => page.once("popup", resolve));
  await action();
  return Promise.race([
    popup,
    wait(30_000).then(() => { throw new Error(`${label}: no popup within 30s`); }),
  ]);
}

/// Click a control by its box, as the user's pointer would, once the point
/// is the control's own: the deck's arrows sit beside the front card, and a
/// click that lands on one turns the deck instead.
async function clickBox(page, selector, label) {
  const handle = await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
  try {
    const box = await handle.boundingBox();
    check(box, `${label}: the control has no box`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const hit = await page.evaluate((px, py, target) => {
      const element = document.elementFromPoint(px, py);
      return element?.closest(target) ? null : element ? `${element.tagName.toLowerCase()} ${element.getAttribute("aria-label") ?? element.getAttribute("class")}` : "nothing";
    }, x, y, selector);
    check(hit === null, `${label}: the point of its box is ${hit}, not the control`);
    await page.mouse.click(x, y);
  } finally {
    await handle.dispose();
  }
}

export default {
  name: "tmux-card-machine-row",
  async run(ctx) {
    if (!existsSync(join(ctx.repoRoot, "web-launcher/dist/index.html"))) {
      ctx.skip("launcher dist missing; build the web bundles before this check");
    }
    if (!tmuxInstalled()) ctx.skip("tmux is not installed");
    try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch {}
    const chanHome = mkdtempSync(join(tmpdir(), "chan-tmux-219-"));
    // The marker is off by default; this check's devserver turns it on.
    execFileSync(ctx.chanBin, ["config", "set", "terminal.tmux.enabled", "true"], {
      env: { ...process.env, CHAN_HOME: chanHome },
      stdio: "ignore",
    });
    const devserver = spawnDevserver(ctx.chanBin, chanHome, ["--no-tunnel"]);
    const pages = [];
    const readings = {};
    try {
      const launchUrl = await devserver.url;
      const origin = new URL(launchUrl).origin;
      const token = new URL(launchUrl).searchParams.get("t");
      check(token, "launcher URL has no management token");
      await ctx.browser.overridePermissions(origin, ["clipboard-read", "clipboard-sanitized-write"]);
      const windows = () => fetchWindows(origin, token);
      const connections = () => fetchTmux(origin, token);

      // The devserver page opens the terminal whose shell runs tmux -CC.
      const launcher = watchPage(await ctx.browser.newPage(), "launcher");
      pages.push(launcher);
      readings.launcher = launcher;
      await goto(launcher, launchUrl);
      await launcher.waitForSelector('button[aria-label="New local terminal"]', { timeout: 30_000 });
      const source = watchPage(await popupFrom(launcher, () => launcher.click('button[aria-label="New local terminal"]'), "New local terminal"), "source");
      pages.push(source);
      step("source window");
      await waitTerminal(source, "source window");
      const sourceWindow = new URL(source.url()).searchParams.get("w");
      check(sourceWindow, "the terminal window's URL names no w");
      check(!(await windows()).some((row) => row.tmux), "no tmux row before the connection");

      await source.bringToFront();
      await source.click(TERMINAL_SCREEN);
      step("typing tmux");
      const shellToken = `SHELL_${Date.now()}`;
      await source.keyboard.type(`TMUX219_SHELL_TOKEN='${shellToken}'; tmux -L ${SOCKET} -f /dev/null -CC new-session -s ${SESSION}\n`);

      const minted = await poll("the control window and the tmux window", async () => {
        const rows = (await windows()).filter((row) => row.tmux && row.kind === "terminal");
        const control = rows.find((row) => row.tmux.control);
        const tmuxWindow = rows.find((row) => !row.tmux.control);
        return control && tmuxWindow ? { control, tmuxWindow } : null;
      }, 60_000);
      step(`minted control ${minted.control.window_id}, tmux window ${minted.tmuxWindow.window_id}`);
      check(minted.control.window_id !== sourceWindow, "the control record is the source window's");
      // The row names the session, so wait until tmux has announced it.
      const record = await poll("the connection record with its session and tmux window", async () => {
        const records = await connections();
        const row = records.find((c) => c.connection === minted.control.tmux.connection);
        if (!row?.session || !row.windows.some((w) => w.chan_window === minted.tmuxWindow.window_id)) throw new Error(`connection records: ${JSON.stringify(records)}`);
        return row;
      }, 30_000);
      check(record.origin?.local === true, `the record's origin is not local: ${JSON.stringify(record.origin)}`);
      check(record.session.name === SESSION, `the record's session is ${JSON.stringify(record.session)}`);
      check(record.control_window === minted.control.window_id, "the record names another control window");

      // The devserver page lists the cards one under another.
      let feed = [];
      const flat = await poll("the devserver page's cards", async () => {
        feed = await windows();
        return assertRunning(await launcher.evaluate(readCards), feed, record, "devserver page");
      }, 30_000);
      step("devserver page cards");
      await ctx.shot("devserver-page-cards", launcher);

      // The desktop surface deals the same cards as a deck; This machine's
      // card comes to the front by the row's own detach, which only that
      // card holds. The page keeps the devserver's own document and rewrites
      // its surface meta when parsing ends, which is before the launcher's
      // module script runs and reads it: a document fulfilled by
      // interception is not a loopback document to Chrome, which then
      // refuses its sockets to the devserver.
      const deck = watchPage(await ctx.browser.newPage(), "deck");
      pages.push(deck);
      readings.deck = deck;
      await deck.evaluateOnNewDocument((from, to) => {
        document.addEventListener("readystatechange", () => {
          const meta = document.querySelector('meta[name="chan-launcher-surface"]');
          if (meta?.getAttribute("content") === from) meta.setAttribute("content", to);
        });
      }, "devserver", "desktop");
      await goto(deck, launchUrl);
      await deck.bringToFront();
      await showCarouselCard(deck, ROW_DETACH_BUTTON, 30_000);
      step("deck at This machine");
      const dealt = await poll("the deck's cards", async () => {
        const rows = await windows();
        const cards = await deck.evaluate(readCards);
        const found = assertRunning(cards, rows, record, "deck");
        check(found.machine.slot?.current && !found.machine.slot.inert && found.machine.slot.label?.startsWith("This machine,"), `deck: This machine's card is not the one in front: ${JSON.stringify(cards.map((card) => ({ name: card.name, slot: card.slot })))}`);
        return found;
      }, 30_000);
      await ctx.shot("deck-this-machine-card", deck);

      // Detach from This machine's row on the deck.
      step("detach from the row");
      await clickBox(deck, ROW_DETACH_BUTTON, "the row's detach");
      await poll("no tmux row and no connection record", async () => {
        const rows = (await windows()).filter((row) => row.tmux);
        const records = await connections();
        if (rows.length || records.length) throw new Error(`tmux rows ${JSON.stringify(rows.map((row) => row.window_id))}, records ${JSON.stringify(records.map((c) => c.connection))}`);
        return true;
      }, 60_000);
      step("tmux rows gone");
      const released = (await windows()).find((row) => row.window_id === minted.control.window_id);
      check(released?.kind === "terminal" && !released.tmux && !released.control, `the control window did not become a plain terminal window: ${JSON.stringify(released)}`);
      await poll("the deck without the connection", async () => assertDetached(await deck.evaluate(readCards), "deck"), 30_000);
      await poll("the devserver page without the connection", async () => assertDetached(await launcher.evaluate(readCards), "devserver page"), 30_000);
      await ctx.shot("deck-after-detach", deck);

      // The source keeps its window and its shell takes input again.
      check(new URL(source.url()).searchParams.get("w") === sourceWindow, "the source left its window");
      await source.bringToFront();
      await source.click(TERMINAL_SCREEN);
      const expected = `TMUX219_${shellToken}`;
      // The typed command holds no complete marker, so neither a replacement shell nor echoed input can pass.
      await source.keyboard.type('printf \'TMUX219_%s\\n\' "$TMUX219_SHELL_TOKEN"\n');
      await poll("the source shell echoes after detach", async () => {
        const text = await copyScrollback(source);
        if (!text.includes(expected)) throw new Error(`source scrollback: ${JSON.stringify(text.slice(-1500))}`);
        return true;
      }, 30_000);
      await ctx.shot("source-after-detach", source);
      step("done");
      return {
        controlWindow: minted.control.window_id,
        tmuxWindow: minted.tmuxWindow.window_id,
        deckCard: dealt.machine.slot.label,
        machineRows: flat.machine.rows,
        connectionRows: flat.connection.rows,
        windows: feed.map((w) => ({ window_id: w.window_id, kind: w.kind, ordinal: w.ordinal, label: w.label, hidden: w.hidden, connected: w.connected, tmux: w.tmux ?? null, source: w.window_id === sourceWindow })),
        releasedKind: released.kind,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cards = {};
      for (const [label, page] of Object.entries(readings)) {
        cards[label] = await Promise.race([
          page.evaluate(readCards),
          wait(2_000).then(() => "no answer within 2s"),
        ]).catch((failure) => String(failure));
      }
      throw new Error(`${message}\ncards: ${mask(JSON.stringify(cards))}${pageLog.length ? `\npages logged:\n${pageLog.slice(-30).join("\n")}` : ""}`);
    } finally {
      for (const page of pages) await page.close().catch(() => {});
      await killChild(devserver.child);
      try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch {}
      rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
