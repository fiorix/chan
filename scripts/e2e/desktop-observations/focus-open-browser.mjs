#!/usr/bin/env node
// One Chrome, kept open for a whole run of focus-open.sh, that makes a
// launcher's and a window deck's gestures the way a person at a browser
// does: a pointer click on a row's button, the deck raised by its shortcut
// and its rows clicked. It reads one command per line on stdin and answers
// each with one JSON line on stdout, so the shell driver can read X and the
// devserver between two gestures. It judges nothing.
//
//   launcher <url>              open the launcher page; answers its page
//                               number, which `deck` takes
//   row <workspace>             the workspace card's lone window row: its
//                               buttons, as the page offers them
//   click <workspace> <button>  a pointer click on the row's button whose
//                               title or label holds <button>
//   newterm                     a pointer click on the launcher's New local
//                               terminal button
//   terms                       the machine's terminal rows, in order: name
//                               and buttons
//   termclick <n> <button>      a pointer click on a button of the n-th
//                               terminal row, from 0
//   deck <page> <step>|<step>   raise that page's command deck and take the
//                               steps in order: a step that is the title
//                               of a row on show is clicked; any other
//                               text is typed as a filter and the single
//                               row left is clicked. A last step of `?`
//                               clicks nothing: the rows then on show are
//                               answered as `shown` and the deck is closed
//   pages                       every page of the browser, its URL masked
//   requests                    terminal and window-list request outcomes,
//                               without query values
//   close <page>                close a page
//   quit
//
// Every answer holds `ok`. A gesture's answer also holds `popups`: the
// pages that appeared within three seconds of it, with holder and fragment
// removed from the masked URL, since a window the browser opens is half of
// what the driver is after. A step the
// page explicitly lacks or disables an action is an answer (`ok: false`,
// `notOffered: true`). Instrument errors use `error` or `threw` instead.
//
// The selectors are the components' own, read at 3508b079f:
// web/packages/launcher/src/components/Library.svelte (.ws-card, .ws-head
// .row-name, button.chevron, .ws-windows .row), WindowRow.svelte (the
// buttons' title and aria-label), and
// web/packages/web-shared/src/components/CommandDeck.svelte (the dialog,
// its combobox and its rows), raised with Ctrl+Alt+K as the smoke's
// check 80 does.
//
// Needs CHROME_BIN and puppeteer-core under the browser smoke's
// node_modules; OBS_SMOKE_DIR names the smoke's directory when this runs
// from a copy that is not its sibling.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const smoke = resolve(process.env.OBS_SMOKE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../browser-smoke"));
const chromeBin = process.env.CHROME_BIN;
if (!chromeBin) {
  console.error("focus-open-browser: CHROME_BIN is not set");
  process.exit(2);
}
let puppeteer;
let mask;
try {
  puppeteer = createRequire(join(smoke, "package.json"))("puppeteer-core");
  ({ maskTokens: mask } = await import(pathToFileURL(join(smoke, "lib/token-mask.mjs")).href));
} catch (error) {
  console.error(`focus-open-browser: cannot load the smoke's modules from ${smoke}: ${error?.message ?? error}`);
  process.exit(2);
}

const DECK = '[role="dialog"][aria-label="Command launcher"]';
const DECK_INPUT = `${DECK} input[role="combobox"]`;
const DECK_ROW = `${DECK} [role="option"]`;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const browser = await puppeteer.launch({
  executablePath: chromeBin,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1600,1000"],
  defaultViewport: { width: 1600, height: 1000 },
});
// Pages in the order they appeared; a page keeps its index once closed.
// The launcher's page is kept by name: it is not page 0, which is the page
// the browser starts with.
const pages = [];
let launcherPage = null;
const requestOutcomes = [];
const watchedPages = new WeakSet();
function watchRequests(page) {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  const note = (request, status) => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (!url.pathname.startsWith("/api/terminal/") && !url.pathname.startsWith("/api/library/windows")) return;
    requestOutcomes.push({ page: pages.indexOf(page), method: request.method(), path: url.pathname, window: url.searchParams.get("w"), status });
    if (requestOutcomes.length > 100) requestOutcomes.shift();
  };
  page.on("response", (response) => note(response.request(), response.status()));
  page.on("requestfailed", (request) => note(request, "failed"));
}
// The page the browser starts with is listed first, so that it can never
// be taken for one a gesture opened.
for (const first of await browser.pages()) { pages.push(first); watchRequests(first); }
browser.on("targetcreated", async (target) => {
  if (target.type() !== "page") return;
  const page = await target.page().catch(() => null);
  if (page) {
    if (!pages.includes(page)) pages.push(page);
    watchRequests(page);
  }
});

const publicUrl = (raw) => {
  const url = new URL(raw);
  url.searchParams.delete("h");
  url.hash = "";
  return mask(url.toString());
};
const describe = (page) => ({
  index: pages.indexOf(page),
  closed: page.isClosed(),
  url: page.isClosed() ? null : publicUrl(page.url()),
});

// Run a gesture and report the pages that appear within three seconds.
async function withPopups(gesture) {
  const before = pages.length;
  const answer = await gesture();
  await wait(3000);
  return { ...answer, popups: pages.slice(before).map(describe) };
}

// The lone window row of a workspace's card, with the card expanded.
async function rowOf(page, workspace) {
  const found = await page.evaluateHandle((name) => {
    const card = [...document.querySelectorAll(".ws-card")].find((c) =>
      (c.querySelector(".ws-head .row-name")?.textContent ?? "").includes(name),
    );
    if (!card) return null;
    const chevron = card.querySelector('button.chevron[aria-expanded="false"]');
    if (chevron) chevron.click();
    return card;
  }, workspace);
  const card = found.asElement();
  if (!card) return { error: `no workspace card names ${workspace}` };
  await wait(300);
  const rows = await card.$$(".ws-windows .row");
  if (rows.length !== 1) return { error: `the card of ${workspace} shows ${rows.length} window rows, not one` };
  return { row: rows[0] };
}

const buttonsOf = (row) =>
  row.$$eval("button", (buttons) =>
    buttons.map((b) => ({
      title: b.getAttribute("title") ?? "",
      label: b.getAttribute("aria-label") ?? "",
      disabled: b.disabled,
    })),
  );

async function clickRowButton(page, workspace, wanted) {
  const { row, error } = await rowOf(page, workspace);
  if (error) return { ok: false, error };
  return clickButtonOf(page, row, wanted);
}

const TERM_ROW = "section.machine .term-list .row";

async function clickButtonOf(page, row, wanted) {
  const buttons = await row.$$("button");
  for (const button of buttons) {
    const [title, label, disabled] = await button.evaluate((b) => [b.getAttribute("title") ?? "", b.getAttribute("aria-label") ?? "", b.disabled]);
    if (!title.includes(wanted) && !label.includes(wanted)) continue;
    if (disabled) return { ok: false, notOffered: true, disabled: true, title, label };
    // A pointer click at the button's centre, as the smoke's openRow makes
    // it: a popup needs the gesture, and an element click can wait on a
    // backgrounded page.
    const box = await button.boundingBox();
    if (!box) return { ok: false, error: `the ${wanted} button is not on screen` };
    await page.bringToFront();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return { ok: true, title, label };
  }
  return { ok: false, notOffered: true, absent: wanted, buttons: await buttonsOf(row) };
}

const deckRows = (page) =>
  page.$$eval(DECK_ROW, (rows) =>
    rows.map((r) => ({
      title: r.querySelector(".deck-result-title")?.textContent?.trim() ?? "",
      path: r.querySelector(".deck-result-path")?.textContent?.trim() ?? "",
      disabled: r.disabled === true,
    })),
  );

async function clickDeckRow(page, index) {
  const row = (await page.$$(DECK_ROW))[index];
  const box = await row.boundingBox();
  if (!box) throw new Error("a deck row is not on screen");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function deck(page, steps) {
  await page.bringToFront();
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  try {
    await page.waitForSelector(DECK_INPUT, { timeout: 10_000 });
  } catch {
    return { ok: false, error: "the command deck did not open" };
  }
  const done = [];
  const list = steps.at(-1) === "?";
  if (list) steps = steps.slice(0, -1);
  for (const step of steps) {
    await wait(400);
    let rows = await deckRows(page);
    let at = rows.findIndex((r) => r.title === step);
    if (at < 0) {
      // Not a title on show: a filter. It must leave one row, or one row
      // whose title is the text itself.
      await page.type(DECK_INPUT, step);
      await wait(600);
      rows = await deckRows(page);
      const titled = rows.map((r, i) => (r.title === step ? i : -1)).filter((i) => i >= 0);
      if (titled.length === 1) {
        at = titled[0];
      } else if (rows.length === 1) {
        at = 0;
      } else {
        await page.keyboard.press("Escape");
        if (rows.length === 0) return { ok: false, notOffered: true, done, failedAt: step, offered: [] };
        return { ok: false, error: `the filter for ${step} left ${rows.length} rows`, done, failedAt: step, offered: rows.slice(0, 12) };
      }
    }
    if (rows[at].disabled) {
      await page.keyboard.press("Escape");
      return { ok: false, notOffered: true, done, failedAt: step, disabled: true, offered: rows.slice(0, 12) };
    }
    done.push({ step, took: rows[at] });
    await clickDeckRow(page, at);
  }
  if (!list) return { ok: true, done };
  // A listing: what the deck offers here, then the deck closed again. A
  // gesture's deck is left alone, since its action may still be running.
  await wait(600);
  const shown = (await page.$(DECK)) ? (await deckRows(page)).slice(0, 30) : [];
  for (let i = 0; i < 4 && (await page.$(DECK)); i++) {
    await page.keyboard.press("Escape");
    await wait(200);
  }
  return { ok: true, done, shown };
}

async function answer(line) {
  const [command, ...rest] = line.trim().split(" ");
  const page = () => {
    const found = pages[Number(rest[0])];
    if (!found || found.isClosed()) throw new Error(`no open page ${rest[0]}`);
    return found;
  };
  if (!launcherPage && !["launcher", "pages"].includes(command)) {
    return { ok: false, error: "no launcher page yet" };
  }
  switch (command) {
    case "launcher": {
      const launcher = await browser.newPage();
      if (!pages.includes(launcher)) pages.push(launcher);
      watchRequests(launcher);
      await launcher.goto(rest[0], { waitUntil: "domcontentloaded", timeout: 60_000 });
      await launcher.waitForSelector("section.machine", { timeout: 30_000 });
      launcherPage = launcher;
      return { ok: true, page: pages.indexOf(launcher) };
    }
    case "row": {
      const { row, error } = await rowOf(launcherPage, rest[0]);
      if (error) return { ok: false, error };
      return { ok: true, buttons: await buttonsOf(row) };
    }
    case "click":
      return withPopups(() => clickRowButton(launcherPage, rest[0], rest.slice(1).join(" ")));
    case "newterm":
      return withPopups(async () => {
        const button = await launcherPage.$('button[aria-label="New local terminal"]');
        if (!button) return { ok: false, error: "the launcher has no New local terminal button" };
        const box = await button.boundingBox();
        if (!box) return { ok: false, error: "the New local terminal button is not on screen" };
        await launcherPage.bringToFront();
        await launcherPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return { ok: true };
      });
    case "terms": {
      const rows = await launcherPage.$$(TERM_ROW);
      const listed = [];
      for (const row of rows) {
        listed.push({
          name: await row.$eval(".row-name", (el) => el.textContent.trim()).catch(() => ""),
          buttons: await buttonsOf(row),
        });
      }
      return { ok: true, rows: listed };
    }
    case "termclick": {
      const row = (await launcherPage.$$(TERM_ROW))[Number(rest[0])];
      if (!row) return { ok: false, error: `no terminal row ${rest[0]}` };
      return withPopups(() => clickButtonOf(launcherPage, row, rest.slice(1).join(" ")));
    }
    case "deck": {
      const target = page();
      return withPopups(() => deck(target, rest.slice(1).join(" ").split("|")));
    }
    case "pages":
      return { ok: true, pages: pages.map(describe) };
    case "requests":
      return { ok: true, requests: requestOutcomes };
    case "close":
      await page().close();
      return { ok: true };
    default:
      return { ok: false, error: `unknown command ${command}` };
  }
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === "quit") break;
  let reply;
  try {
    reply = await answer(line);
  } catch (error) {
    // The instrument failed; the driver reads this as inconclusive.
    reply = { ok: false, threw: mask(String(error?.message ?? error)) };
  }
  console.log(JSON.stringify(reply));
}
await browser.close().catch(() => {});
