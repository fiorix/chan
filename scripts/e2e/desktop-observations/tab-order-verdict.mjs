// The verdicts of tab-order-native.mjs, apart from the driver so that
// tab-order-verdict.test.mjs can check them against made readings with no
// desktop: which observations of a leg are the contract failing (a fault),
// which say the leg was not read (inconclusive), and the run's exit.
//
// Pane A is the terminal the walks must not land in; pane B is the active
// pane every leg but the control keeps. The legs are browser check 353's,
// plus `program-tab`: inside a terminal that holds the keyboard, Tab and
// Shift+Tab are its program's keys.

export const TYPED_BYTES = ["7a", "71"];
export const TAB_BYTES = ["09"];
export const BACKTAB_BYTES = ["1b", "5b", "5a"];

/// Each walk starts on the tab label of pane `from`, "away" for B and
/// "target" for A, with pane B the active pane.
export const LEGS = [
  { kind: "forward", key: "Tab", survey: false, from: "away" },
  { kind: "backward", key: "Shift+Tab", survey: false, from: "away" },
  { kind: "survey-forward", key: "Tab", survey: true, from: "away" },
  { kind: "survey-backward", key: "Shift+Tab", survey: true, from: "away" },
  { kind: "forward-from-a", key: "Tab", survey: false, from: "target" },
  { kind: "survey-forward-from-a", key: "Tab", survey: true, from: "target" },
  { kind: "program-tab", key: null, survey: false, from: null },
  { kind: "control", key: "Tab", survey: false, from: "target" },
];

/// The exit status the driver ends with; the wrapper's obs_judge turns 10
/// into 1.
export const EXIT = { held: 0, fault: 10, inconclusive: 3 };

const same = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b);
const paneName = (panes, id) => (id === panes?.target ? "pane A" : id === panes?.away ? "pane B" : id ?? "no pane");
const walkLine = (walk) => walk
  .map((at) => `${at.step}:${at.name || at.element}@${at.pane ?? "-"}/${at.relation}${at.hasFocus === false ? "/unfocused" : ""}`)
  .join(" > ");

/// A press across panes (on a terminal whose pane is not the active one,
/// with both terminals attached and recording) that left its pane
/// inactive or the keyboard outside its terminal.
function pressFailure(press, panes) {
  const [pane, other] = press.side === "target" ? ["A", "B"] : ["B", "A"];
  const after = press.after ?? {};
  const inside = press.side === "target" ? after.inTargetHost : after.inAwayHost;
  return `a press on pane ${pane}'s terminal with pane ${other} active left the active pane ${paneName(panes, after.focusedPane)} and the keyboard ${inside ? `in ${pane}'s terminal` : `on ${after.name || after.element || "nothing"}`}`;
}

/// The steps of a walk whose key arrived as the other key: the instrument
/// sent what the leg did not ask for, so the walk says nothing of the leg.
function wrongKey(result, key) {
  return (result.walk ?? []).filter((at) => at.keyReached && at.shift !== (key === "Shift+Tab"));
}

/// One walk of a leg from its tab label: what it landed on, whether the
/// active pane moved, where it ended, and where the typed `zq` went.
/// `active` is the pane the walk runs with active; `crossing` the side its
/// walk must pass A's place from ("before" or "after"), or null for a walk
/// that meets B's terminal first; `endIn` the terminal a Tab walk must end
/// in ("away" or "target"), or null.
function walkReading(result, panes, { key, from, active, crossing, endIn }) {
  const failures = [];
  const incomplete = [];
  const walk = result.walk ?? [];
  const label = `${key} from pane ${from === "target" ? "A" : "B"}'s tab label`;
  const wrong = wrongKey(result, key);
  if (wrong.length) {
    incomplete.push(`${label}: the page saw the key ${key === "Shift+Tab" ? "unshifted" : "shifted"} at ${wrong.map((at) => `step ${at.step}`).join(", ")}`);
  }
  if (result.ended === "no key") {
    incomplete.push(`${label}: the page never saw press ${walk.length + 1} while it held the focus`);
  }
  const moved = walk.filter((at) => at.focusedPane !== active);
  if (moved.length) {
    failures.push(`${label} moved the active pane at ${moved.map((at) => `step ${at.step}: ${paneName(panes, at.focusedPane)}`).join(", ")}`);
  }
  const landed = from === "target" && endIn === "target" ? [] : walk.filter((at) => at.relation === "inside");
  if (landed.length) {
    failures.push(`${label} landed in pane A's terminal at ${landed.map((at) => `step ${at.step} (${at.element})`).join(", ")}`);
  }
  if (!landed.length && result.ended !== "no key") {
    if (crossing && !walk.some((at) => at.relation === crossing)) {
      failures.push(`${label} did not pass the place of pane A's terminal (ended: ${result.ended}): ${walkLine(walk)}`);
    }
    const terminal = endIn === "away" ? "B's terminal" : endIn === "target" ? "A's terminal" : null;
    if (terminal && result.ended !== terminal) {
      failures.push(`${label} did not end in pane ${endIn === "away" ? "B" : "A"}'s terminal (ended: ${result.ended}): ${walkLine(walk)}`);
    }
  }
  return { failures, incomplete };
}

/// The verdict of one leg's observations. Errors the driver met while it
/// read a leg are the leg's incomplete reading, never a fault.
export function legReading(result, panes) {
  const leg = LEGS.find((entry) => entry.kind === result.kind);
  const failures = [];
  const incomplete = [...(result.errors ?? []), ...(result.cleanupErrors ?? [])].map((error) => String(error).split("\n")[0]);
  if (!leg) return { failures, incomplete: [...incomplete, `unknown leg ${result.kind}`] };
  if (!result.observed && !incomplete.length) incomplete.push("not observed");
  for (const press of [result.startPress, result.press]) {
    if (press && press.across && !press.took) failures.push(pressFailure(press, panes));
  }
  if (failures.length) return { failures, incomplete };
  if (!result.observed) return { failures, incomplete };

  if (leg.kind === "program-tab") {
    for (const [name, key, want] of [["tab", "Tab", TAB_BYTES], ["backtab", "Shift+Tab", BACKTAB_BYTES]]) {
      const read = result[name];
      if (!read) {
        incomplete.push(`${key} inside pane B's terminal was not read`);
        continue;
      }
      if (!read.keyReached) {
        incomplete.push(`${key} inside pane B's terminal never reached the page`);
        continue;
      }
      if (read.shift !== (key === "Shift+Tab")) {
        incomplete.push(`${key} inside pane B's terminal reached the page ${read.shift ? "shifted" : "unshifted"}`);
        continue;
      }
      if (!same(read.awayBytes, want)) {
        failures.push(`${key} inside pane B's terminal put ${JSON.stringify(read.awayBytes ?? [])} on its PTY, expected ${JSON.stringify(want)}`);
      }
      if (read.targetBytes?.length) failures.push(`${key} inside pane B's terminal put ${JSON.stringify(read.targetBytes)} on pane A's PTY`);
      if (!read.after?.inAwayHost) failures.push(`${key} inside pane B's terminal moved the keyboard to ${read.after?.name || read.after?.element || "nothing"}`);
      if (read.after?.focusedPane !== panes?.away) failures.push(`${key} inside pane B's terminal moved the active pane to ${paneName(panes, read.after?.focusedPane)}`);
    }
    return { failures, incomplete };
  }

  if (leg.kind === "control") {
    const walked = walkReading(result, panes, { key: "Tab", from: "target", active: panes?.target, crossing: null, endIn: "target" });
    failures.push(...walked.failures);
    incomplete.push(...walked.incomplete);
    if (result.ended !== "no key") {
      if (!same(result.targetBytes, TYPED_BYTES)) {
        failures.push(`pane A's PTY read ${JSON.stringify(result.targetBytes ?? [])} after the typed "zq", expected ${JSON.stringify(TYPED_BYTES)}`);
      }
      if (result.awayBytes?.length) failures.push(`pane B's PTY read ${JSON.stringify(result.awayBytes)} after the control's walk`);
    }
    return { failures, incomplete };
  }

  // Where a step lies once a walk toward A's terminal has passed it: before
  // it for Shift+Tab from B, after it for Tab from A. Tab from B walks away
  // from it.
  const crossing = leg.from === "target" ? "after" : leg.key === "Shift+Tab" ? "before" : null;
  const walked = walkReading(result, panes, {
    key: leg.key, from: leg.from, active: panes?.away, crossing, endIn: leg.key === "Tab" ? "away" : null,
  });
  failures.push(...walked.failures);
  incomplete.push(...walked.incomplete);
  if (leg.survey && result.afterWalk && !result.afterWalk.surveyOpen) {
    failures.push("the survey over pane A was gone after the walk");
  }
  if (result.ended !== "no key") {
    if (result.targetBytes?.length) {
      failures.push(`pane A's PTY read ${JSON.stringify(result.targetBytes)} after the walk (ended: ${result.ended}) and the typed "zq"`);
    }
    if (leg.key === "Tab" && result.ended === "B's terminal" && !same(result.awayBytes, TYPED_BYTES)) {
      failures.push(`pane B's PTY read ${JSON.stringify(result.awayBytes ?? [])} after the walk and the typed "zq", expected ${JSON.stringify(TYPED_BYTES)}`);
    }
  }
  return { failures, incomplete };
}

/// The run's verdict: a fault outranks an incomplete reading, and an
/// incomplete reading with no fault is inconclusive, never a pass. A run
/// holds only with its setup observed and every leg read with no fault.
export function judge(report) {
  const run = report?.run ?? null;
  const failures = [];
  const incomplete = (report?.cleanupErrors ?? []).map((error) => `cleanup: ${String(error).split("\n")[0]}`);
  const legs = [];
  if (!run || run.setup !== "observed") {
    incomplete.push(...(run?.setupErrors ?? []).map((error) => `setup: ${String(error).split("\n")[0]}`));
    if (!run?.setupErrors?.length) incomplete.push("setup incomplete");
  } else if ((run.legs ?? []).length !== LEGS.length) {
    incomplete.push(`${(run.legs ?? []).length} of ${LEGS.length} legs ran`);
  }
  for (const result of run?.legs ?? []) {
    const reading = legReading(result, run.panes);
    const status = reading.failures.length ? "fault" : reading.incomplete.length ? "inconclusive" : "held";
    legs.push({ kind: result.kind, status, ...reading });
    failures.push(...reading.failures.map((reason) => `${result.kind}: ${reason}`));
    incomplete.push(...reading.incomplete.map((reason) => `${result.kind}: ${reason}`));
  }
  incomplete.push(...(run?.cleanupErrors ?? []).map((error) => `cleanup: ${String(error).split("\n")[0]}`));
  const status = failures.length ? "fault" : incomplete.length ? "inconclusive" : "held";
  return { status, exit: EXIT[status], failures, incomplete, legs };
}
