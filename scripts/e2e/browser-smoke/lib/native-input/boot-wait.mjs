import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BOOT_TIMEOUT_MS = 30000;
export const WRAP_TIMEOUT_MS = 60000;

export const NAV_COUNTER_SRC = `(() => {
  window.__nativeInputNavs = 0;
  window.addEventListener("load", () => { window.__nativeInputNavs++; }, true);
  return "counting";
})()`;

export const STATE_SRC = `(() => ({
  url: (() => { const u = new URL(location.href); return u.origin + u.pathname + (u.searchParams.has("w") ? "?w=" + u.searchParams.get("w") : ""); })(),
  readyState: document.readyState,
  moduleScripts: document.querySelectorAll('script[type="module"][src]').length,
  panes: document.querySelectorAll(".pane").length,
  navs: typeof window.__nativeInputNavs === "number" ? window.__nativeInputNavs : null,
  timeOrigin: performance.timeOrigin,
}))()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function missingCondition(s) {
  if (!s || typeof s !== "object") return "no page state";
  if (s.readyState !== "complete") return `readyState ${s.readyState}`;
  if (!(s.panes > 0)) return "no .pane";
  if (!(s.moduleScripts > 0)) return "no entry module scripts";
  return "";
}

export async function waitBooted(evaluate, { timeoutMs = BOOT_TIMEOUT_MS, sleepMs = 250, label = "booted page" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      last = await evaluate(STATE_SRC);
    } catch (err) {
      last = { error: String(err && err.message ? err.message : err).slice(0, 120) };
    }
    const missing = last && !last.error ? missingCondition(last) : `state unreadable (${(last && last.error) || "no state"})`;
    if (!missing) return last;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}: missing ${missing}; last state ${JSON.stringify(last).slice(0, 200)}`);
    }
    await sleep(sleepMs);
  }
}

export async function windowLive(probe, { timeoutMs = BOOT_TIMEOUT_MS, sleepMs = 1000, label = "window" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never attempted";
  for (;;) {
    try {
      if (await probe()) return true;
      lastError = "probe answered not live";
    } catch (err) {
      lastError = String(err && err.message ? err.message : err).slice(0, 120);
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for live ${label}: ${lastError}`);
    await sleep(sleepMs);
  }
}

export async function wrapWithRetry(evaluate, wrapSrc, key, { extraNav = () => 0, timeoutMs = WRAP_TIMEOUT_MS, sleepMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const readState = async () => {
    try {
      return await evaluate(STATE_SRC);
    } catch (err) {
      return { error: String(err && err.message ? err.message : err).slice(0, 120) };
    }
  };
  const shape = (state, kind, answer, wrapError) => {
    const get = (k) => (state && typeof state === "object" ? state[k] ?? null : null);
    return { kind, t: new Date().toISOString(), url: get("url"), readyState: get("readyState"),
      moduleScripts: get("moduleScripts"), navs: get("navs"), timeOrigin: get("timeOrigin"),
      extraNav: extraNav(), answer, wrapError, navigatedSinceLast: false };
  };
  const attempts = [shape(await readState(), "baseline", null, "")];
  let prev = attempts[0];
  for (;;) {
    const state = await readState();
    let wrapped = null;
    let wrapError = "";
    try {
      wrapped = await evaluate(`(${wrapSrc})(${JSON.stringify(key)})`);
    } catch (err) {
      wrapError = String(err && err.message ? err.message : err).slice(0, 200);
    }
    const attempt = shape(state, "wrap",
      wrapped === undefined ? null : String(wrapped).slice(0, 120), wrapError);
    attempt.navigatedSinceLast =
      attempt.url !== prev.url || attempt.navs !== prev.navs || attempt.extraNav !== prev.extraNav;
    attempts.push(attempt);
    prev = attempt;
    if (wrapped === "wrapped") {
      return { attempts, retried: attempts.length > 2 || attempts.some((a) => a.navigatedSinceLast) };
    }
    if (Date.now() > deadline) {
      throw new Error(`no ghostty-web chunk found to wrap after ${attempts.length - 1} attempts; last attempt ${JSON.stringify(attempt).slice(0, 300)}`);
    }
    await sleep(sleepMs);
  }
}

export function assertBundleChunk(bundleDir) {
  const index = join(bundleDir, "index.html");
  if (!existsSync(index)) throw new Error(`bundle ${bundleDir}: no index.html`);
  const html = readFileSync(index, "utf8");
  const entries = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  if (entries.length === 0) throw new Error(`bundle ${bundleDir}: no entry module scripts in index.html`);
  const hits = [];
  for (const src of entries) {
    const file = join(bundleDir, src.split(/[?#]/)[0].replace(/^\//, ""));
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const name = /ghostty-web-[\w-]+\.js/.exec(text)?.[0];
    if (name) hits.push({ entry: src, chunk: name });
  }
  if (hits.length === 0) {
    throw new Error(`bundle ${bundleDir}: no entry module references a ghostty-web- chunk (entries: ${entries.join(", ")})`);
  }
  return hits;
}

export async function pollWrapBox(evaluate, wrapSrc, key, { extraNav = () => 0, timeoutMs = WRAP_TIMEOUT_MS, sleepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const readState = async () => {
    try {
      return await evaluate(STATE_SRC);
    } catch (err) {
      return { error: String(err && err.message ? err.message : err).slice(0, 120) };
    }
  };
  const shape = (state, value) => {
    const get = (k) => (state && typeof state === "object" ? state[k] ?? null : null);
    return { kind: "wrap", t: new Date().toISOString(), url: get("url"), readyState: get("readyState"),
      moduleScripts: get("moduleScripts"), navs: get("navs"), timeOrigin: get("timeOrigin"),
      extraNav: extraNav(), answer: value, navigatedSinceLast: false };
  };
  const attempts = [];
  const baseline = await readState();
  attempts.push({ ...shape(baseline, null), kind: "baseline" });
  let prev = attempts[0];
  await evaluate(`(${wrapSrc})(${JSON.stringify(key)})`);
  for (;;) {
    let box = null;
    try {
      box = await evaluate(`(() => { const b = window[${JSON.stringify(key + ":wrap")}]; return b ? { state: b.state ?? null, value: typeof b.value === "string" ? b.value.slice(0, 200) : null } : null; })()`);
    } catch (err) {
      box = { state: "failed", value: `failed: ${String(err && err.message ? err.message : err).slice(0, 120)}` };
    }
    const state = await readState();
    const attempt = state && state.error
      ? { ...shape(state, null), wrapError: state.error }
      : { ...shape(state, box && typeof box === "object" ? box.value : null) };
    attempt.navigatedSinceLast = attempt.url !== prev.url || attempt.navs !== prev.navs || attempt.extraNav !== prev.extraNav;
    attempts.push(attempt);
    prev = attempt;
    if (box && box.state === "wrapped") {
      return { attempts, retried: attempts.length > 2 || attempts.some((a) => a.navigatedSinceLast) };
    }
    if (box && (box.state === "missing" || box.state === "failed")) {
      throw new Error(`wrap ${box.state}: ${box.value ?? "no chunk"}`.slice(0, 300));
    }
    if (Date.now() > deadline) {
      throw new Error(`no ghostty-web chunk found to wrap after ${attempts.length - 1} polls; last attempt ${JSON.stringify(attempt).slice(0, 300)}`);
    }
    await sleep(sleepMs);
  }
}
