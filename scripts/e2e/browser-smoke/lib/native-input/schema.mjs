import { FIELDS as DOM_FIELDS } from "./page.mjs";

const STATUSES = ["ok", "witnessed", "unavailable", "not-driven", "failed"];

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateCaseFile(fixture) {
  const errors = [];
  if (!isObject(fixture)) return ["fixture is not an object"];
  const { header, setup, steps, domEvents, observed, contract, verdict } = fixture;
  if (!isObject(header)) errors.push("missing header");
  else {
    for (const k of ["case", "title", "family", "engine", "engineVersion", "worktreeSha",
      "producedBy", "seam", "derivation", "recorder", "platform", "layout"]) {
      if (typeof header[k] !== "string" || !header[k]) errors.push(`header.${k} missing`);
    }
    if (header.isTrustedAll !== true) errors.push("header.isTrustedAll not true");
    if (header.injected !== undefined && !Array.isArray(header.injected)) errors.push("header.injected not an array");
  }
  if (!isObject(setup)) errors.push("missing setup");
  if (!Array.isArray(steps)) errors.push("steps not an array");
  if (!Array.isArray(domEvents)) errors.push("domEvents not an array");
  else {
    for (const [i, e] of domEvents.entries()) {
      if (!isObject(e) || typeof e.type !== "string") { errors.push(`domEvents[${i}] malformed`); continue; }
      if (e.isTrusted !== true) errors.push(`domEvents[${i}] isTrusted not true`);
      if (typeof e.t !== "number") errors.push(`domEvents[${i}] t not numeric`);
      for (const f of DOM_FIELDS) {
        if (!(f in e)) errors.push(`domEvents[${i}] missing ${f}`);
      }
    }
  }
  if (!isObject(observed) || !isObject(contract)) errors.push("observed/contract missing");
  else {
    for (const k of ["widget", "pty"]) {
      for (const side of [observed, contract]) {
        const v = side[k];
        if (v !== null && typeof v !== "string") errors.push(`${side === observed ? "observed" : "contract"}.${k} not string|null`);
      }
    }
  }
  if (!isObject(verdict)) errors.push("missing verdict");
  else {
    if (!STATUSES.includes(verdict.status)) errors.push(`verdict.status not one of ${STATUSES.join("|")}`);
    if (typeof verdict.reason !== "string") errors.push("verdict.reason not a string");
    if (verdict.status !== "ok" && !verdict.reason) errors.push("non-ok verdict missing reason");
    if (verdict.status === "ok" && isObject(observed) && isObject(contract)) {
      for (const layer of ["widget", "pty"]) {
        if ((observed[layer] ?? "") !== (contract[layer] ?? "")) errors.push(`${layer} differs from contract`);
      }
    }
  }
  return errors;
}

export function validateRunSummary(summary, caseIds) {
  const errors = [];
  if (!isObject(summary)) return ["summary is not an object"];
  for (const k of ["engine", "engineVersion", "worktreeSha", "started", "finished"]) {
    if (typeof summary[k] !== "string" || !summary[k]) errors.push(`summary.${k} missing`);
  }
  if (!isObject(summary.cases)) return [...errors, "summary.cases missing"];
  for (const id of caseIds) {
    if (!["ok", "witnessed", "unavailable", "not-driven", "failed"].includes(summary.cases[id])) errors.push(`summary.cases[${id}] bad status`);
  }
  if (!isObject(summary.counts) || typeof summary.counts.preconditions !== "number" || typeof summary.counts.properties !== "number") {
    errors.push("summary.counts missing");
  }
  if (!isObject(summary.notDriven)) errors.push("summary.notDriven missing");
  else {
    for (const id of caseIds) {
      if (summary.cases[id] === "not-driven" && (typeof summary.notDriven[id] !== "string" || !summary.notDriven[id])) {
        errors.push(`summary.notDriven[${id}] missing reason`);
      }
    }
  }
  if (!isObject(summary.boot) || typeof summary.boot.retried !== "boolean" || !Array.isArray(summary.boot.attempts) ||
      !isObject(summary.boot.prefs) || typeof summary.boot.prefs.wrote !== "boolean") {
    errors.push("summary.boot missing");
  }
  return errors;
}

export function validateCopiedRun(dir, readJson, fileExists = () => true) {
  const errors = [];
  let summary = null;
  try {
    summary = readJson(`${dir}/run-summary.json`);
  } catch (err) {
    return [`cannot read run-summary.json: ${String(err && err.message || err).slice(0, 120)}`];
  }
  const ids = Object.keys(summary.cases || {});
  errors.push(...validateRunSummary(summary, ids).map((e) => `summary: ${e}`));
  for (const id of ids) {
    if (summary.cases[id] === "not-driven") continue;
    if (summary.cases[id] === "failed") {
      if (!fileExists(`${dir}/${id}.error.txt`)) errors.push(`${id}: failed without an error file`);
      continue;
    }
    let fixture = null;
    try {
      fixture = readJson(`${dir}/${id}.json`);
    } catch (err) {
      errors.push(`${id}: cannot read fixture: ${String(err && err.message || err).slice(0, 120)}`);
      continue;
    }
    errors.push(...validateCaseFile(fixture).map((e) => `${id}: ${e}`));
  }
  return errors;
}
