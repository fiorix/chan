import assert from "node:assert/strict";
import test from "node:test";
import { EXIT, LEGS, judge } from "./tab-order-verdict.mjs";

// Offline verdict test for tab-order-native.mjs: made readings of every leg
// judged with no desktop. tipLegs() is a page where only the active pane's
// terminals are in the Tab order, after browser check 353's walks there;
// baseLegs() is a page where every terminal is, after WebKitGTK's walk on
// it, which landed on A's input two steps back from B's tab label.
//   node scripts/e2e/desktop-observations/tab-order-verdict.test.mjs

const panes = { target: "pane-1", away: "pane-3" };
const A = panes.target;
const B = panes.away;
const TYPED = ["7a", "71"];

/// One step of a walk: the element it landed on, the element's pane, the
/// active pane, and where it lies against A's terminal host.
const at = (step, name, pane, relation, { focusedPane = B, shift = false, hasFocus = true } = {}) => ({
  step, keyReached: true, shift, element: name, name, pane, focusedPane, relation, hasFocus, inTargetTab: relation === "inside",
});
const startPress = (across = false) => ({ side: "away", across, took: true, after: { focusedPane: B, inAwayHost: true } });

/// Tab from B's label meets B's own controls and then B's terminal.
const towardB = () => [at(1, "close", B, "after"), at(2, "flip", B, "after"), at(3, "menu", B, "after"), at(4, "Terminal input", B, "after")];
const backwardTip = () => [
  at(1, "DIV.divider", null, "after", { shift: true }), at(2, "menu", A, "before", { shift: true }),
  at(3, "flip", A, "before", { shift: true }), at(4, "close", A, "before", { shift: true }),
  at(5, "label A", A, "before", { shift: true, hasFocus: false }),
];
const backwardBase = () => [at(1, "DIV.divider", null, "after", { shift: true }), at(2, "TEXTAREA.", A, "inside", { shift: true })];
const fromATip = () => [
  at(1, "close", A, "before"), at(2, "flip", A, "before"), at(3, "menu", A, "before"), at(4, "DIV.divider", null, "after"),
  at(5, "label B", B, "after"), at(6, "close", B, "after"), at(7, "flip", B, "after"), at(8, "menu", B, "after"),
  at(9, "Terminal input", B, "after"),
];
const fromABase = () => [at(1, "close", A, "before"), at(2, "flip", A, "before"), at(3, "menu", A, "before"), at(4, "DIV.terminal-host", A, "inside")];

function leg(kind, fields) {
  const def = LEGS.find((entry) => entry.kind === kind);
  return { kind, key: def.key, survey: def.survey, from: def.from, observed: true, errors: [], cleanupErrors: [], ...fields };
}

function tipLegs() {
  return [
    leg("forward", { startPress: startPress(), walk: towardB(), ended: "B's terminal", targetBytes: [], awayBytes: TYPED }),
    leg("backward", { startPress: startPress(), walk: backwardTip(), ended: "left the page", targetBytes: [], awayBytes: [] }),
    leg("survey-forward", { startPress: startPress(), walk: towardB(), ended: "B's terminal", afterWalk: { surveyOpen: true }, targetBytes: [], awayBytes: TYPED }),
    leg("survey-backward", { startPress: startPress(true), walk: backwardTip(), ended: "left the page", afterWalk: { surveyOpen: true }, targetBytes: [], awayBytes: [] }),
    leg("forward-from-a", { startPress: startPress(true), walk: fromATip(), ended: "B's terminal", targetBytes: [], awayBytes: TYPED }),
    leg("survey-forward-from-a", { startPress: startPress(), walk: fromATip(), ended: "B's terminal", afterWalk: { surveyOpen: true }, targetBytes: [], awayBytes: TYPED }),
    leg("program-tab", {
      startPress: startPress(true),
      tab: { keyReached: true, shift: false, awayBytes: ["09"], targetBytes: [], after: { inAwayHost: true, focusedPane: B } },
      backtab: { keyReached: true, shift: true, awayBytes: ["1b", "5b", "5a"], targetBytes: [], after: { inAwayHost: true, focusedPane: B } },
    }),
    leg("control", {
      startPress: startPress(),
      press: { side: "target", across: true, took: true, after: { focusedPane: A, inTargetHost: true } },
      walk: [at(1, "close", A, "before", { focusedPane: A }), at(2, "flip", A, "before", { focusedPane: A }),
        at(3, "menu", A, "before", { focusedPane: A }), at(4, "DIV.terminal-host", A, "inside", { focusedPane: A })],
      ended: "A's terminal", targetBytes: TYPED, awayBytes: [],
    }),
  ];
}

/// The base: every terminal in the Tab order, so the walks that cross A's
/// place land in it and the typed keys reach A's PTY.
function baseLegs() {
  const legs = tipLegs();
  const set = (kind, fields) => Object.assign(legs.find((entry) => entry.kind === kind), fields);
  set("backward", { walk: backwardBase(), ended: "A's terminal", targetBytes: TYPED, awayBytes: [] });
  set("survey-backward", { walk: backwardBase(), ended: "A's terminal", targetBytes: TYPED, awayBytes: [] });
  set("forward-from-a", { walk: fromABase(), ended: "A's terminal", targetBytes: TYPED, awayBytes: [] });
  set("survey-forward-from-a", { walk: fromABase(), ended: "A's terminal", targetBytes: TYPED, awayBytes: [] });
  return legs;
}

const runOf = (legs, extra = {}) => ({ run: { setup: "observed", setupErrors: [], cleanupErrors: [], panes, legs, ...extra }, cleanupErrors: [] });
const statusOf = (verdict, kind) => verdict.legs.find((entry) => entry.kind === kind)?.status;
const withLeg = (legs, kind, fields) => legs.map((entry) => (entry.kind === kind ? { ...entry, ...fields } : entry));

test("the tip's readings hold every leg and the run exits 0", () => {
  const verdict = judge(runOf(tipLegs()));
  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(verdict.incomplete, []);
  assert.equal(verdict.status, "held");
  assert.equal(verdict.exit, EXIT.held);
  assert.deepEqual(verdict.legs.map((entry) => entry.status), LEGS.map(() => "held"));
});

test("the base's readings fault the four walks across A's place, each by its landing and A's PTY", () => {
  const verdict = judge(runOf(baseLegs()));
  assert.equal(verdict.status, "fault");
  assert.equal(verdict.exit, EXIT.fault);
  const faulted = verdict.legs.filter((entry) => entry.status === "fault").map((entry) => entry.kind);
  assert.deepEqual(faulted, ["backward", "survey-backward", "forward-from-a", "survey-forward-from-a"]);
  for (const entry of verdict.legs.filter((item) => item.status === "fault")) {
    assert.equal(entry.failures.length, 2, `${entry.kind}: ${JSON.stringify(entry.failures)}`);
    assert.match(entry.failures[0], /landed in pane A's terminal/);
    assert.match(entry.failures[1], /pane A's PTY read \["7a","71"\]/);
  }
});

test("an instrument error with no fault is inconclusive, and a fault outranks it", () => {
  const broken = withLeg(tipLegs(), "survey-forward", { observed: false, errors: ["timed out waiting for survey survey-forward appears"] });
  const inconclusive = judge(runOf(broken));
  assert.equal(inconclusive.status, "inconclusive");
  assert.equal(inconclusive.exit, EXIT.inconclusive);
  assert.equal(statusOf(inconclusive, "survey-forward"), "inconclusive");
  const both = judge(runOf(withLeg(baseLegs(), "survey-forward", { observed: false, errors: ["survey did not appear"] })));
  assert.equal(both.status, "fault");
  assert.ok(both.incomplete.some((reason) => reason.startsWith("survey-forward:")));
});

test("a setup that was not observed, or a run with a leg missing, is never a pass", () => {
  const setup = judge({ run: { setup: "incomplete", setupErrors: ["no native workspace page"], cleanupErrors: [], legs: [] }, cleanupErrors: [] });
  assert.equal(setup.status, "inconclusive");
  assert.deepEqual(setup.incomplete, ["setup: no native workspace page"]);
  assert.equal(judge({ run: null, cleanupErrors: [] }).status, "inconclusive");
  const short = judge(runOf(tipLegs().slice(0, -1)));
  assert.equal(short.status, "inconclusive");
  assert.match(short.incomplete[0], /7 of 8 legs ran/);
  const unread = judge(runOf(withLeg(tipLegs(), "control", { observed: false })));
  assert.deepEqual(unread.incomplete, ["control: not observed"]);
});

test("a walk toward A that ends before it passes A's place is a fault, unless a press was lost", () => {
  const stalled = withLeg(tipLegs(), "backward", { walk: [at(1, "DIV.divider", null, "after", { shift: true, hasFocus: false })], ended: "left the page" });
  const verdict = judge(runOf(stalled));
  assert.equal(statusOf(verdict, "backward"), "fault");
  assert.match(verdict.failures[0], /did not pass the place of pane A's terminal/);
  const lost = judge(runOf(withLeg(tipLegs(), "backward", { walk: [at(1, "DIV.divider", null, "after", { shift: true })], ended: "no key" })));
  assert.equal(statusOf(lost, "backward"), "inconclusive");
  assert.match(lost.incomplete[0], /never saw press 2/);
  const landedThenLost = judge(runOf(withLeg(baseLegs(), "backward", { ended: "no key", targetBytes: [] })));
  assert.equal(statusOf(landedThenLost, "backward"), "fault");
});

test("a key the page saw as the other key leaves the walk unread", () => {
  const unshifted = withLeg(tipLegs(), "backward", { walk: backwardTip().map((step) => ({ ...step, shift: false })) });
  const verdict = judge(runOf(unshifted));
  assert.equal(statusOf(verdict, "backward"), "inconclusive");
  assert.match(verdict.incomplete[0], /unshifted at step 1, step 2/);
});

test("a tip that took every terminal out of the Tab order fails the control and the walks toward B", () => {
  let legs = tipLegs();
  for (const kind of ["forward", "survey-forward"]) {
    legs = withLeg(legs, kind, { walk: towardB().slice(0, 3).concat(at(4, "DIV.divider", null, "after")), ended: "limit", awayBytes: [] });
  }
  legs = withLeg(legs, "control", {
    walk: [at(1, "close", A, "before", { focusedPane: A }), at(2, "DIV.divider", null, "after", { focusedPane: A, hasFocus: false })],
    ended: "left the page", targetBytes: [],
  });
  const verdict = judge(runOf(legs));
  assert.equal(verdict.status, "fault");
  assert.equal(statusOf(verdict, "control"), "fault");
  assert.equal(statusOf(verdict, "forward"), "fault");
  assert.ok(verdict.failures.some((reason) => /control: Tab from pane A's tab label did not end in pane A's terminal/.test(reason)));
});

test("a Tab walk that ends in B's terminal must leave exactly the typed keys on B's PTY", () => {
  const extra = judge(runOf(withLeg(tipLegs(), "forward", { awayBytes: ["09", "7a", "71"] })));
  assert.equal(statusOf(extra, "forward"), "fault");
  assert.match(extra.failures[0], /pane B's PTY read \["09","7a","71"\]/);
});

test("the active pane moving during a walk, or the survey going, is a fault", () => {
  const moved = judge(runOf(withLeg(tipLegs(), "forward-from-a", {
    walk: fromATip().map((step) => (step.step >= 2 ? { ...step, focusedPane: A } : step)),
  })));
  assert.equal(statusOf(moved, "forward-from-a"), "fault");
  assert.match(moved.failures[0], /moved the active pane at step 2: pane A/);
  const gone = judge(runOf(withLeg(tipLegs(), "survey-backward", { afterWalk: { surveyOpen: false } })));
  assert.deepEqual(gone.failures, ["survey-backward: the survey over pane A was gone after the walk"]);
});

test("a press across panes that does not take is a fault and ends its leg", () => {
  const start = judge(runOf(withLeg(tipLegs(), "forward-from-a", {
    startPress: { side: "away", across: true, took: false, after: { focusedPane: A, name: "Terminal input" } }, walk: undefined, ended: undefined,
  })));
  assert.equal(statusOf(start, "forward-from-a"), "fault");
  assert.match(start.failures[0], /a press on pane B's terminal with pane A active left the active pane pane A/);
  const control = judge(runOf(withLeg(tipLegs(), "control", {
    press: { side: "target", across: true, took: false, after: { focusedPane: B, inTargetHost: true } }, walk: undefined,
  })));
  assert.deepEqual(control.failures, ["control: a press on pane A's terminal with pane B active left the active pane pane B and the keyboard in A's terminal"]);
});

test("Tab inside a terminal that holds the keyboard must reach its program", () => {
  const program = tipLegs().find((entry) => entry.kind === "program-tab");
  const swallowed = judge(runOf(withLeg(tipLegs(), "program-tab", { tab: { ...program.tab, awayBytes: [], after: { inAwayHost: false, name: "menu", focusedPane: B } } })));
  assert.equal(statusOf(swallowed, "program-tab"), "fault");
  assert.deepEqual(swallowed.failures, [
    "program-tab: Tab inside pane B's terminal put [] on its PTY, expected [\"09\"]",
    "program-tab: Tab inside pane B's terminal moved the keyboard to menu",
  ]);
  const unseen = judge(runOf(withLeg(tipLegs(), "program-tab", { backtab: { ...program.backtab, keyReached: false, awayBytes: [] } })));
  assert.equal(statusOf(unseen, "program-tab"), "inconclusive");
});
