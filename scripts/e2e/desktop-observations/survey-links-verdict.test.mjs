import assert from "node:assert/strict";
import test from "node:test";
import { LEGS, NOTE, URL_TARGET, judgeLeg, legStatus, runVerdict } from "./survey-links-verdict.mjs";

// Offline verdict test for survey-links-native.mjs: made observations in
// the shapes the driver records, as each leg reads at a tip that holds the
// contract and as each reads at the base its red is named for, with the
// instrument's misses that must stay inconclusive. No desktop, no page.

const A = "pane-a";
const B = "pane-b";
const START = "http://127.0.0.1:41000/workspace-ws/";
const appeared = {
  targetPane: A, awayPane: B, focusedPane: B, keyboard: "away",
  surveyOpen: true, targetTabActive: true, awayTabActive: true, dropDowns: 0,
};
const onA = (over = {}) => ({ ...appeared, focusedPane: A, ...over });
const stay = { where: { at: START, probed: true }, ptyBytes: { target: [], away: [] } };
const nothing = { xdg: [], window: [] };
const once = { xdg: [URL_TARGET], window: [] };
const dropDown = (href, copy) => [{ rows: [["OPEN", href]], copy, underLink: true }];
const cancelled = (ctrl = false) => [{ prevented: true, ctrl, meta: false, button: 0 }];
const leftAlone = (ctrl = false) => [{ prevented: false, ctrl, meta: false, button: 0 }];
const up = { reply: null, surveyOpen: true };
const alpha = { code: 0, stdout: "Alpha", stderr: "" };
const beside = { x: 400, y: 80, hit: "DIV.survey-overlay per-terminal", onOverlay: true, inTerminal: true };
const clicked = (href = URL_TARGET, copy = true) => ({
  linkPoint: { ok: true, hit: "A." },
  clicks: cancelled(),
  afterClick: onA({ keyboard: `link:${href}`, dropDowns: 1 }),
  dropDowns: dropDown(href, copy),
  openedByClick: nothing,
});
const base = (over) => ({ startAt: START, appeared, ...over });

// The readings each leg makes where the contract holds.
const TIP = {
  press: base({ point: beside, afterPress: onA({ keyboard: "survey" }), reply: { code: 0, stdout: "Beta", stderr: "" }, ...stay }),
  click: base({ ...clicked(), afterWait: up, ...stay }),
  "row-url": base({ ...clicked(), rowPoint: { ok: true }, openedByRow: once, dropDownsAfter: 0, afterWait: up, ...stay }),
  "tab-enter": base({
    point: beside, onCard: onA({ keyboard: "survey" }), onLink: `link:${URL_TARGET}`,
    clicks: cancelled(), dropDowns: dropDown(URL_TARGET, true), openedByFirst: nothing,
    openedBySecond: once, dropDownsAfter: 0, afterWait: up, ...stay,
  }),
  "tab-mod-enter": base({
    point: beside, onCard: onA({ keyboard: "survey" }), onLink: `link:${URL_TARGET}`,
    clicks: cancelled(true), opened: once, dropDownsAfter: 0, afterWait: up, ...stay,
  }),
  footer: base({
    ...clicked(), beforePress: onA({ keyboard: `link:${URL_TARGET}`, dropDowns: 1 }), footerPoint: { ok: true },
    afterPress: onA({ keyboard: `link:${URL_TARGET}`, dropDowns: 1 }), dropDownsAfterPress: dropDown(URL_TARGET, true),
    reply: alpha, openedAfterPress: nothing, ...stay,
  }),
  "tab-answer": base({
    ...clicked(), tabStops: [`link:${NOTE}`, "answer:Alpha"], dropDownsOnAnswer: 0, reply: alpha, openedAfterTab: nothing, ...stay,
  }),
  "row-path": base({
    ...clicked(NOTE, false), rowPoint: { ok: true }, note: true,
    afterOpen: onA({ keyboard: "DIV.cm-content", targetTabActive: false, surveyOpen: false, dropDowns: 0 }),
    openedByRow: nothing, replyAfterOpen: null, ...stay,
  }),
};

const failedNames = (judged) => judged.lines.filter((l) => l.pass === false).map((l) => l.name);

test("every leg has a judge and holds on the tip's readings", () => {
  assert.deepEqual(Object.keys(TIP).sort(), [...LEGS].sort());
  for (const leg of LEGS) {
    const judged = judgeLeg(leg, TIP[leg]);
    assert.equal(judged.status, "pass", `${leg}: ${JSON.stringify(failedNames(judged))}`);
    assert.ok(judged.lines.every((l) => l.pass === true), leg);
  }
});

test("the press at its red base drops the keyboard to the page and the 2 answers nothing", () => {
  // Before the overlay cancelled the press, the card lost the keyboard to
  // <body> when the press finished, on WebKitGTK as in Chrome.
  const judged = judgeLeg("press", { ...TIP.press, afterPress: onA({ keyboard: "BODY." }), reply: null });
  assert.equal(judged.status, "fail");
  assert.deepEqual(failedNames(judged), ["the keyboard is on the card after the press", "the 2 answers the survey with Beta"]);
});

test("the link legs at the links range's base: the app leaves the click its default and shows nothing", () => {
  const noMenu = { clicks: leftAlone(), dropDowns: [], afterClick: onA({ keyboard: `link:${URL_TARGET}` }) };
  const click = judgeLeg("click", { ...TIP.click, ...noMenu });
  assert.equal(click.status, "fail");
  assert.deepEqual(failedNames(click), ["the app cancels the click", "one drop-down shows with the row OPEN and the href as written"]);
  // The driver stops where the row should have been; what it read before
  // decides.
  const { rowPoint: _r, openedByRow: _o, dropDownsAfter: _d, afterWait: _w, ...rowRead } = TIP["row-url"];
  const row = judgeLeg("row-url", { ...rowRead, ...noMenu });
  assert.equal(row.status, "fail");
  const { rowPoint: _p, note: _n, afterOpen: _a, openedByRow: _b, replyAfterOpen: _c, ...pathRead } = TIP["row-path"];
  const path = judgeLeg("row-path", { ...pathRead, clicks: leftAlone(), dropDowns: [] });
  assert.equal(path.status, "fail");
  assert.ok(failedNames(path).includes("one drop-down shows with the row OPEN and the href as written"));
  const enter = judgeLeg("tab-enter", { ...TIP["tab-enter"], clicks: leftAlone(), dropDowns: [], openedBySecond: nothing });
  assert.equal(enter.status, "fail");
  assert.deepEqual(failedNames(enter), [
    "Enter on the focused link makes one click, which the app cancels",
    "the first Enter shows the drop-down with the row OPEN and the URL",
    "the second Enter opens the URL once through the system opener",
  ]);
  const mod = judgeLeg("tab-mod-enter", { ...TIP["tab-mod-enter"], clicks: leftAlone(true), opened: nothing });
  assert.equal(mod.status, "fail");
  assert.deepEqual(failedNames(mod), [
    "Ctrl+Enter on the focused link makes one Ctrl click, which the app cancels",
    "Ctrl+Enter opens the URL once through the system opener",
  ]);
});

test("an engine that makes no click from Enter on a focused link is a fault, not a pass", () => {
  const judged = judgeLeg("tab-mod-enter", { ...TIP["tab-mod-enter"], clicks: [], opened: nothing });
  assert.equal(judged.status, "fail");
  assert.deepEqual(failedNames(judged).slice(0, 1), ["Ctrl+Enter on the focused link makes one Ctrl click, which the app cancels"]);
});

test("the footer at its red base drops the keyboard and 1 answers nothing", () => {
  const judged = judgeLeg("footer", { ...TIP.footer, afterPress: onA({ keyboard: "BODY.", dropDowns: 1 }), reply: null });
  assert.equal(judged.status, "fail");
  assert.deepEqual(failedNames(judged), ["the press on the footer leaves the keyboard where it was", "1 then answers the survey with Alpha"]);
});

test("Tab to an answer at its red base keeps the drop-down, and Enter opens the link", () => {
  const judged = judgeLeg("tab-answer", { ...TIP["tab-answer"], dropDownsOnAnswer: 1, reply: null, openedAfterTab: once });
  assert.equal(judged.status, "fail");
  assert.deepEqual(failedNames(judged), [
    "the drop-down closes once the keyboard is on the answer",
    "Enter answers the survey with Alpha",
    "Tab and Enter open nothing",
  ]);
});

test("a press on the row that also answers the survey, or a stray open, is a fault", () => {
  assert.equal(judgeLeg("row-url", { ...TIP["row-url"], afterWait: { reply: alpha, surveyOpen: false } }).status, "fail");
  assert.equal(judgeLeg("row-url", { ...TIP["row-url"], openedByRow: { xdg: [URL_TARGET, URL_TARGET], window: [] } }).status, "fail");
  assert.equal(judgeLeg("click", { ...TIP.click, openedByClick: { xdg: [], window: [[URL_TARGET, "_blank", ""]] } }).status, "fail");
  assert.equal(judgeLeg("click", { ...TIP.click, where: { at: "https://example.com/notes/survey-native", probed: false } }).status, "fail");
  assert.equal(judgeLeg("press", { ...TIP.press, ptyBytes: { target: [], away: ["32"] } }).status, "fail");
});

test("a leg that cannot put its question is inconclusive, whatever it reads after", () => {
  assert.equal(judgeLeg("press", { ...TIP.press, appeared: onA({ keyboard: "survey" }) }).status, "inconclusive");
  assert.equal(judgeLeg("press", { ...TIP.press, point: { ...beside, onOverlay: false, hit: "CANVAS." } }).status, "inconclusive");
  // WebKit for macOS keeps links out of the Tab order by default; such an
  // engine cannot read the focused-link legs.
  const noLink = judgeLeg("tab-enter", { ...TIP["tab-enter"], onLink: "answer:Alpha", clicks: [], dropDowns: [] });
  assert.equal(noLink.status, "inconclusive");
  // A failed precondition outranks a property read after it.
  assert.equal(judgeLeg("footer", { ...TIP.footer, footerPoint: { ok: false }, afterPress: onA({ keyboard: "BODY." }) }).status, "inconclusive");
  assert.equal(judgeLeg("tab-answer", { ...TIP["tab-answer"], tabStops: [`link:${NOTE}`, "BUTTON.survey-followup"] }).status, "inconclusive");
});

test("a property that failed before a later precondition failed stays a fault", () => {
  const judged = judgeLeg("footer", { ...TIP.footer, clicks: leftAlone(), footerPoint: { ok: false } });
  assert.equal(judged.status, "fail");
});

test("an unread line or an instrument error never passes", () => {
  const { reply: _reply, ...noReply } = TIP.press;
  const unread = judgeLeg("press", noReply);
  assert.equal(unread.status, "inconclusive");
  assert.ok(unread.lines.some((l) => l.pass === null && l.actual === "unread"));
  assert.equal(judgeLeg("click", { ...TIP.click, error: "inspector evaluation timed out" }).status, "inconclusive");
  assert.equal(judgeLeg("click", { ...TIP.click, clicks: leftAlone(), error: "inspector socket closed" }).status, "fail");
  assert.equal(judgeLeg("click", { startAt: START }).status, "inconclusive");
  assert.equal(legStatus([], "the driver failed"), "inconclusive");
});

test("the run's status: a fault wins, then an inconclusive leg, and a silent recorder blocks every pass", () => {
  const pass = { name: "press", status: "pass" };
  const fail = { name: "click", status: "fail" };
  const unsure = { name: "footer", status: "inconclusive" };
  assert.equal(runVerdict([pass, pass], true).code, 0);
  assert.equal(runVerdict([pass, fail], true).code, 10);
  assert.deepEqual(runVerdict([pass, fail, unsure], true), { code: 10, faults: ["click"], inconclusive: ["footer"] });
  assert.equal(runVerdict([pass, unsure], true).code, 3);
  assert.equal(runVerdict([pass], false).code, 3);
  assert.equal(runVerdict([fail], false).code, 10);
  assert.equal(runVerdict([], true).code, 3);
});
