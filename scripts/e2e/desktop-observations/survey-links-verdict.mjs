// The verdicts of survey-links-native.mjs, apart from the desktop so
// survey-links-verdict.test.mjs can read them against made observations.
//
// A leg's observation is what the driver read, in the order it read it;
// a field the driver never reached is absent, and a line over an absent
// field is unread. Each judge returns its lines in that order: a
// precondition (`need`) says whether the leg could put its question, a
// property (`prop`) is the answer. A property that failed before any
// precondition failed is an observed fault; a precondition that failed
// first leaves the leg inconclusive, whatever was read after it; an unread
// line or an instrument error leaves it inconclusive too.

/// The legs, in the order a run reads them. The path leg is last because
/// it moves pane A to a note tab and its cleanup moves it back.
export const LEGS = ["press", "click", "row-url", "tab-enter", "tab-mod-enter", "footer", "tab-answer", "row-path"];

export const URL_TARGET = "https://example.com/notes/survey-native";
export const NOTE = "survey-native-notes/a.md";
export const NOTE_TEXT = "SURVEYNATIVE note opened from a survey body";
/// One body serves every leg: the URL link first, so Tab from the card
/// reaches it before the path link.
export const BODY = `Pane B keeps the keyboard; read [the notes](${URL_TARGET}) or [the note](${NOTE}) first.`;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lineOf = (kind) => (name, expected, actual, pass) => ({
  kind,
  name,
  expected,
  actual: actual === undefined ? "unread" : actual,
  pass: actual === undefined ? null : Boolean(pass),
});
const need = lineOf("precondition");
const prop = lineOf("property");

/// A leg's status from its lines in reading order and the instrument's
/// error, if one ended the leg early.
export function legStatus(lines, error = null) {
  const blocked = lines.findIndex((l) => l.kind === "precondition" && l.pass === false);
  const read = blocked < 0 ? lines : lines.slice(0, blocked);
  if (read.some((l) => l.kind === "property" && l.pass === false)) return "fail";
  if (blocked >= 0 || error || lines.some((l) => l.pass === null)) return "inconclusive";
  return "pass";
}

/// The window's reading of a click the app cancels, as the bubble-phase
/// probe records it after the app's own listeners.
const cancelled = (mods = {}) => [{ prevented: true, ctrl: Boolean(mods.ctrl), meta: false, button: 0 }];
const rowsOf = (dropDowns) => dropDowns?.map((d) => d.rows);
const at = (obj, key) => (obj === undefined || obj === null ? undefined : obj[key]);
const nothingOpened = (opened) => opened === undefined ? undefined : opened.xdg.length === 0 && opened.window.length === 0;
const openedOnce = (opened) => opened === undefined ? undefined : same(opened.xdg, [URL_TARGET]) && opened.window.length === 0;
const inCard = (keyboard) => keyboard === "survey" || (typeof keyboard === "string" && keyboard.startsWith("link:"));

function appeared(lines, obs) {
  const s = obs.appeared;
  lines.push(need("the survey shows over A's terminal", true, at(s, "surveyOpen"), s?.surveyOpen === true));
  lines.push(need("pane B is focused with the keyboard on its terminal when the survey shows",
    "pane B, away", s && { focusedPane: s.focusedPane, keyboard: s.keyboard },
    s && s.focusedPane === s.awayPane && s.keyboard === "away"));
  lines.push(need("no drop-down shows when the survey shows", 0, at(s, "dropDowns"), s?.dropDowns === 0));
}

/// A plain click on the body link `href`: cancelled, pane A focused, the
/// drop-down under the link with its one OPEN row, nothing opened, the
/// survey up and unanswered.
function plainClick(lines, obs, href, copy) {
  lines.push(need("the link's centre hit-tests to the link", true, at(obs.linkPoint, "ok"), obs.linkPoint?.ok === true));
  lines.push(prop("the app cancels the click", cancelled(), obs.clicks, same(obs.clicks, cancelled())));
  lines.push(prop("the click makes pane A the focused one", "pane A", at(obs.afterClick, "focusedPane"),
    obs.afterClick && obs.afterClick.focusedPane === obs.afterClick.targetPane));
  lines.push(prop("one drop-down shows with the row OPEN and the href as written", [[["OPEN", href]]], rowsOf(obs.dropDowns),
    same(rowsOf(obs.dropDowns), [[["OPEN", href]]])));
  lines.push(prop(`the drop-down ${copy ? "carries" : "carries no"} copy button`, copy, at(obs.dropDowns?.[0], "copy"),
    obs.dropDowns?.[0]?.copy === copy));
  lines.push(prop("the drop-down sits under the link", true, at(obs.dropDowns?.[0], "underLink"), obs.dropDowns?.[0]?.underLink === true));
  lines.push(prop("the click opens nothing", { xdg: [], window: [] }, obs.openedByClick, nothingOpened(obs.openedByClick)));
}

function unanswered(lines, label, value) {
  lines.push(prop(`${label} leaves the survey up and unanswered`, { reply: null, surveyOpen: true }, value,
    value && value.reply === null && value.surveyOpen === true));
}

function stays(lines, obs) {
  const where = obs.where;
  lines.push(prop("the page stays on the app", { at: obs.startAt, probed: true }, where,
    where && where.at === obs.startAt && where.probed === true));
  const bytes = obs.ptyBytes;
  lines.push(prop("no key reaches a PTY", { target: [], away: [] }, bytes,
    bytes && bytes.target.length === 0 && bytes.away.length === 0));
}

function besideCard(lines, obs) {
  lines.push(need("the point beside the card hit-tests to the overlay over A's terminal", true,
    obs.point && { hit: obs.point.hit, onOverlay: obs.point.onOverlay, inTerminal: obs.point.inTerminal },
    obs.point?.onOverlay === true && obs.point.inTerminal === true));
}

function tabToLink(lines, obs) {
  besideCard(lines, obs);
  lines.push(need("after the press beside the card pane A is focused with the keyboard on the card", "pane A, survey",
    obs.onCard && { focusedPane: obs.onCard.focusedPane, keyboard: obs.onCard.keyboard },
    obs.onCard && obs.onCard.focusedPane === obs.onCard.targetPane && obs.onCard.keyboard === "survey"));
  lines.push(need("Tab from the card reaches the URL link", `link:${URL_TARGET}`, obs.onLink, obs.onLink === `link:${URL_TARGET}`));
}

const JUDGES = {
  press(lines, obs) {
    appeared(lines, obs);
    besideCard(lines, obs);
    const after = obs.afterPress;
    lines.push(prop("the survey stays up after the press", true, at(after, "surveyOpen"), after?.surveyOpen === true));
    lines.push(prop("the press makes pane A the focused one", "pane A", at(after, "focusedPane"),
      after && after.focusedPane === after.targetPane));
    lines.push(prop("the keyboard is on the card after the press", "survey", at(after, "keyboard"), after?.keyboard === "survey"));
    lines.push(prop("the 2 answers the survey with Beta", { code: 0, stdout: "Beta" }, obs.reply,
      obs.reply && obs.reply.code === 0 && obs.reply.stdout === "Beta"));
    stays(lines, obs);
  },

  click(lines, obs) {
    appeared(lines, obs);
    plainClick(lines, obs, URL_TARGET, true);
    unanswered(lines, "the click", obs.afterWait);
    stays(lines, obs);
  },

  "row-url"(lines, obs) {
    appeared(lines, obs);
    plainClick(lines, obs, URL_TARGET, true);
    lines.push(need("the row's target hit-tests to the row", true, at(obs.rowPoint, "ok"), obs.rowPoint?.ok === true));
    lines.push(prop("the press on the row opens the URL once through the system opener", { xdg: [URL_TARGET], window: [] },
      obs.openedByRow, openedOnce(obs.openedByRow)));
    lines.push(prop("the drop-down closes", 0, obs.dropDownsAfter, obs.dropDownsAfter === 0));
    unanswered(lines, "the press on the row", obs.afterWait);
    stays(lines, obs);
  },

  "tab-enter"(lines, obs) {
    appeared(lines, obs);
    tabToLink(lines, obs);
    lines.push(prop("Enter on the focused link makes one click, which the app cancels", cancelled(), obs.clicks,
      same(obs.clicks, cancelled())));
    lines.push(prop("the first Enter shows the drop-down with the row OPEN and the URL", [[["OPEN", URL_TARGET]]],
      rowsOf(obs.dropDowns), same(rowsOf(obs.dropDowns), [[["OPEN", URL_TARGET]]])));
    lines.push(prop("the first Enter opens nothing", { xdg: [], window: [] }, obs.openedByFirst, nothingOpened(obs.openedByFirst)));
    lines.push(prop("the second Enter opens the URL once through the system opener", { xdg: [URL_TARGET], window: [] },
      obs.openedBySecond, openedOnce(obs.openedBySecond)));
    lines.push(prop("the drop-down closes", 0, obs.dropDownsAfter, obs.dropDownsAfter === 0));
    unanswered(lines, "Enter on the focused link", obs.afterWait);
    stays(lines, obs);
  },

  "tab-mod-enter"(lines, obs) {
    appeared(lines, obs);
    tabToLink(lines, obs);
    lines.push(prop("Ctrl+Enter on the focused link makes one Ctrl click, which the app cancels", cancelled({ ctrl: true }),
      obs.clicks, same(obs.clicks, cancelled({ ctrl: true }))));
    lines.push(prop("Ctrl+Enter opens the URL once through the system opener", { xdg: [URL_TARGET], window: [] },
      obs.opened, openedOnce(obs.opened)));
    lines.push(prop("Ctrl+Enter shows no drop-down", 0, obs.dropDownsAfter, obs.dropDownsAfter === 0));
    unanswered(lines, "Ctrl+Enter on the focused link", obs.afterWait);
    stays(lines, obs);
  },

  footer(lines, obs) {
    appeared(lines, obs);
    plainClick(lines, obs, URL_TARGET, true);
    lines.push(need("the keyboard is in the card after the click", "survey or link", at(obs.beforePress, "keyboard"),
      inCard(obs.beforePress?.keyboard)));
    lines.push(need("the footer's centre hit-tests to the footer", true, at(obs.footerPoint, "ok"), obs.footerPoint?.ok === true));
    lines.push(prop("the press on the footer leaves the keyboard where it was", at(obs.beforePress, "keyboard"),
      at(obs.afterPress, "keyboard"), obs.afterPress && obs.afterPress.keyboard === obs.beforePress?.keyboard));
    lines.push(prop("the drop-down stays open after the press on the footer", [[["OPEN", URL_TARGET]]],
      rowsOf(obs.dropDownsAfterPress), same(rowsOf(obs.dropDownsAfterPress), [[["OPEN", URL_TARGET]]])));
    lines.push(prop("1 then answers the survey with Alpha", { code: 0, stdout: "Alpha" }, obs.reply,
      obs.reply && obs.reply.code === 0 && obs.reply.stdout === "Alpha"));
    lines.push(prop("the press on the footer and 1 open nothing", { xdg: [], window: [] }, obs.openedAfterPress,
      nothingOpened(obs.openedAfterPress)));
    stays(lines, obs);
  },

  "tab-answer"(lines, obs) {
    appeared(lines, obs);
    plainClick(lines, obs, URL_TARGET, true);
    lines.push(need("Tab moves the keyboard to the first answer", "answer:Alpha", obs.tabStops,
      obs.tabStops && obs.tabStops.at(-1) === "answer:Alpha"));
    lines.push(prop("the drop-down closes once the keyboard is on the answer", 0, obs.dropDownsOnAnswer, obs.dropDownsOnAnswer === 0));
    lines.push(prop("Enter answers the survey with Alpha", { code: 0, stdout: "Alpha" }, obs.reply,
      obs.reply && obs.reply.code === 0 && obs.reply.stdout === "Alpha"));
    lines.push(prop("Tab and Enter open nothing", { xdg: [], window: [] }, obs.openedAfterTab, nothingOpened(obs.openedAfterTab)));
    stays(lines, obs);
  },

  "row-path"(lines, obs) {
    appeared(lines, obs);
    plainClick(lines, obs, NOTE, false);
    lines.push(need("the row's target hit-tests to the row", true, at(obs.rowPoint, "ok"), obs.rowPoint?.ok === true));
    lines.push(prop("the press on the row opens the note as pane A's active tab", true, obs.note, obs.note === true));
    const after = obs.afterOpen;
    lines.push(prop("pane A no longer shows the survey's terminal tab", false, at(after, "targetTabActive"), after?.targetTabActive === false));
    lines.push(prop("pane B keeps its terminal", true, at(after, "awayTabActive"), after?.awayTabActive === true));
    lines.push(prop("the survey is hidden with its tab", false, at(after, "surveyOpen"), after?.surveyOpen === false));
    lines.push(prop("the drop-down closes", 0, at(after, "dropDowns"), after?.dropDowns === 0));
    lines.push(prop("the press on the row opens nothing outside the app", { xdg: [], window: [] }, obs.openedByRow,
      nothingOpened(obs.openedByRow)));
    lines.push(prop("opening the note answers nothing", null, obs.replyAfterOpen, obs.replyAfterOpen === null));
    stays(lines, obs);
  },
};

/// One leg's lines and status from its observation.
export function judgeLeg(name, obs) {
  const judge = JUDGES[name];
  if (!judge) throw new Error(`no leg ${name}`);
  const lines = [];
  judge(lines, obs);
  return { status: legStatus(lines, obs.error ?? null), lines };
}

/// The run's exit status from its judged legs and the recorders' control
/// after the last leg: 10 when a leg observed a fault, 3 when a leg is
/// inconclusive, when no leg ran, or when a recorder did not answer after
/// the legs (a silent PTY then proves nothing, so no leg can pass), and 0
/// when every leg held.
export function runVerdict(legs, afterLegs) {
  const faults = legs.filter((leg) => leg.status === "fail").map((leg) => leg.name);
  const inconclusive = legs.filter((leg) => leg.status === "inconclusive").map((leg) => leg.name);
  if (faults.length) return { code: 10, faults, inconclusive };
  if (!afterLegs) {
    return { code: 3, faults, inconclusive: legs.map((leg) => leg.name), reason: "a recorder did not answer after the legs" };
  }
  if (inconclusive.length || legs.length === 0) {
    return { code: 3, faults, inconclusive, reason: legs.length ? "a leg is inconclusive" : "no leg ran" };
  }
  return { code: 0, faults, inconclusive };
}
