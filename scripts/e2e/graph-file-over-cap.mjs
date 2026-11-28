#!/usr/bin/env node
// A graph tab opened on a file of a workspace over the listing cap, read in
// headless Chrome against a chan that is already serving that workspace.
//
// Over the cap the window's graph answer is marked `tree` and holds every
// folder but not every file. A tab opened on a file the answer does not hold
// has to read the levels of the file's folders to find it; one that drops
// its pending selection as soon as the graph is whole lands with nothing
// selected. This reading opens a graph tab from a file's row in the Files
// tab, the way a user does ("New graph here" in the row's menu), waits for
// the tab to settle and reads what it landed on.
//
// Two legs, each in a browser context and a window of its own:
//
//   subject: a file the answer does not hold (in the generated over-cap
//            tree, a bulk file no note links). It lands when the tab
//            settles with the file selected, no selection pending, and
//            Details on it; a tab that never settles has not landed.
//   control: a file the answer does hold (a note). It must land the same
//            way on any build, or a red on the subject says nothing about
//            the subject.
//
// Each leg reads, once the tab has settled: the selection and the pending
// selection the window's address carries for the tab (`gn`, `gp`), its
// opened folders (`ge`), the path Details names, the breadcrumb, the stat
// line, the labels the canvas painted in its last frame (the canvas labels
// only the selected node, its neighbours and the folders down to it, so the
// file's label and its folders' labels say whether the file and its folder
// chain are drawn: a folder is labelled by its name and a slash, a file the
// window's answer holds by its name without its extension, as the server
// labels it, and a file only the tab's own level read holds by its name),
// and every `/api/fs-graph` and `/api/graph` request the page made after the
// menu command, by path and page. Over the whole leg it keeps apart the
// page's uncaught errors, its console errors, and every response with a
// status of 400 or above, by method, route, workspace path and status.
//
// A tab has settled when its loading note is gone, no graph or level read
// has been in flight or started for 3 s, and two readings at least 3 s apart
// agree; one that still holds a pending selection must hold still for 20 s.
//
// The script never starts, stops or signals a chan, and changes nothing in
// the workspace: it reads the routes the window reads and drives one page.
//
// Inputs (a flag wins over its variable):
//   --url URL       GRAPH_OVER_CAP_URL      the window URL of the chan serving
//                                           the tree, with its token (`?t=`);
//                                           prefer the variable, which keeps
//                                           the token out of process listings
//   --file PATH     GRAPH_OVER_CAP_FILE     workspace-relative subject file
//   --control PATH  GRAPH_OVER_CAP_CONTROL  workspace-relative control file
//                                           (default notes/n000.md)
//   --out DIR       GRAPH_OVER_CAP_OUT      output directory, created; refused
//                                           when it exists and is not empty
//   --chrome PATH   CHROME_BIN              Chrome (default: the newest under
//                                           ~/.cache/puppeteer/chrome)
//   --index-timeout SECS  GRAPH_OVER_CAP_INDEX_TIMEOUT  the wait for the index
//                                           and an ungated answer (default 600)
//   --settle-timeout SECS GRAPH_OVER_CAP_SETTLE_TIMEOUT each tab's wait to
//                                           settle (default 300)
//
// puppeteer-core is the browser suite's (scripts/e2e/browser-smoke, `npm
// ci` there). Chrome keeps its profile under the system temporary directory
// (TMPDIR) and removes it on exit. Nothing printed or written holds the
// token.
//
// Preconditions, each an exit 2 when it does not hold: the index reads idle
// and ready and the window is not locked by preflight; the window's graph
// answer is ungated and carries a `tree` mark; both files are on disk as
// their folder's level reads them; the answer holds no node for the subject
// and holds one for the control.
//
// Output, in the output directory: preconditions.json; per leg
// <leg>-opened.png and <leg>-settled.png (the tab as it appeared and as it
// settled, or <leg>-failed.png when the leg stopped short) and <leg>.json
// (both readings, when the tab was asked for on the request log's clock,
// `openAtMs`, the requests, `pageErrors`, `consoleErrors`, and
// `failedResponses` with their set, `failedResponseSet`); verdict.json, which
// carries per leg the page errors and the failed-response set, so a job can
// compare one build's sets with another's. The last stdout line is the
// verdict.
//
// Exit 0: both files landed. 1: the control landed and the subject did not;
// the line names what the subject's tab selected instead.
// 2: a precondition did not hold, the reading could not be taken (no row, no
// menu entry, no tab, a tab that never finished loading or shows an error,
// an unexpected error), or the control did not land, so the subject's result
// cannot be attributed to the subject.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filePath, fileRow, navigateFiles, showFiles, waitFileRow } from "./browser-smoke/lib/files.mjs";
import { defaultChrome } from "./browser-smoke/lib/server.mjs";
import { maskTokens } from "./browser-smoke/lib/token-mask.mjs";

const NAME = "graph-file-over-cap";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const QUIET_MS = 3_000;
const STUCK_MS = 20_000;
const SAMPLE_MS = 500;
const GRAPH_FETCH_MS = 300_000;
const API_FETCH_MS = 60_000;
const VIEWPORT = { width: 1600, height: 1000 };

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => console.log(maskTokens(`${NAME}: ${line}`));
const json = (value) => maskTokens(JSON.stringify(value, null, 1));

/// Not a verdict on the subject: the reading could not be taken or could not
/// be attributed. Exits 2.
class Unavailable extends Error {}

function option(args, flag, variable, fallback = undefined) {
  const at = args.indexOf(flag);
  if (at >= 0) {
    const value = args[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Unavailable(`${flag} needs a value`);
    return value;
  }
  return process.env[variable] || fallback;
}

function seconds(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Unavailable(`${flag} must be a positive number of seconds: ${value}`);
  return n * 1000;
}

function parseInputs() {
  const args = process.argv.slice(2);
  const known = new Set(["--url", "--file", "--control", "--out", "--chrome", "--index-timeout", "--settle-timeout"]);
  for (let i = 0; i < args.length; i += 2) {
    if (!known.has(args[i])) throw new Unavailable(`unknown argument ${JSON.stringify(args[i])}`);
  }
  const url = option(args, "--url", "GRAPH_OVER_CAP_URL");
  const file = option(args, "--file", "GRAPH_OVER_CAP_FILE");
  const control = option(args, "--control", "GRAPH_OVER_CAP_CONTROL", "notes/n000.md");
  const out = option(args, "--out", "GRAPH_OVER_CAP_OUT");
  if (!url) throw new Unavailable("no window URL (--url or GRAPH_OVER_CAP_URL)");
  if (!file) throw new Unavailable("no subject file (--file or GRAPH_OVER_CAP_FILE)");
  if (!out) throw new Unavailable("no output directory (--out or GRAPH_OVER_CAP_OUT)");
  let window;
  try {
    window = new URL(url);
  } catch {
    throw new Unavailable("the window URL does not parse");
  }
  let subject;
  let held;
  try {
    subject = filePath(file);
    held = filePath(control);
  } catch (error) {
    throw new Unavailable(error.message);
  }
  if (!subject || !held) throw new Unavailable("a file path is empty");
  if (subject === held) throw new Unavailable("the subject and the control are the same file");
  return {
    window,
    token: window.searchParams.get("t") ?? "",
    subject,
    control: held,
    out: path.resolve(out),
    chrome: option(args, "--chrome", "CHROME_BIN") ?? defaultChrome(),
    indexMs: seconds(option(args, "--index-timeout", "GRAPH_OVER_CAP_INDEX_TIMEOUT", "600"), "--index-timeout"),
    settleMs: seconds(option(args, "--settle-timeout", "GRAPH_OVER_CAP_SETTLE_TIMEOUT", "300"), "--settle-timeout"),
  };
}

function prepareOut(out) {
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Unavailable(`${out} exists and is not empty`);
  }
  mkdirSync(out, { recursive: true });
}

function write(out, name, value) {
  writeFileSync(path.join(out, name), `${json(value)}\n`);
}

// --- the server's routes, read from here, never from the page --------------

/// A route of the chan the window URL names, beside the window's own path,
/// so a workspace served under a prefix reads its own routes.
function apiUrl(inputs, route, params = {}) {
  const url = new URL(route, new URL(".", inputs.window));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  if (inputs.token) url.searchParams.set("t", inputs.token);
  return url;
}

async function apiGet(inputs, route, params = {}, timeoutMs = API_FETCH_MS) {
  const response = await fetch(apiUrl(inputs, route, params), {
    headers: inputs.token ? { authorization: `Bearer ${inputs.token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  return { status: response.status, body };
}

async function apiJson(inputs, route, params = {}, timeoutMs = API_FETCH_MS) {
  const { status, body } = await apiGet(inputs, route, params, timeoutMs);
  if (status < 200 || status >= 300) return { status, value: null, body: body.slice(0, 500) };
  try {
    return { status, value: JSON.parse(body) };
  } catch {
    return { status, value: null, body: body.slice(0, 500) };
  }
}

/// The window's graph answer, as the window takes it: the stream form of
/// `/api/graph` at the window's default scope and depth.
async function graphAnswer(inputs) {
  const { status, body } = await apiGet(inputs, "api/graph", { stream: 1 }, GRAPH_FETCH_MS);
  if (status !== 200) return { status, error: body.slice(0, 500) };
  const metas = [];
  const nodes = [];
  let done = false;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "meta") metas.push(event);
    else if (event.type === "nodes") nodes.push(...event.nodes);
    else if (event.type === "done") done = true;
    else if (event.type === "error") return { status, error: String(event.error) };
  }
  const last = metas.at(-1) ?? {};
  return {
    status,
    done,
    gated: metas.some((meta) => meta.gated === true),
    tree: last.tree ?? null,
    metas: metas.map((meta) => ({ gated: meta.gated ?? null, tree: meta.tree ?? null })),
    nodes,
  };
}

const isFolder = (node) => node.kind === "directory" || node.kind === "folder";

function folderChain(file) {
  const parts = file.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/// Whether the answer holds a file node for `file`, and which of its folders
/// it holds.
function answerHolds(answer, file) {
  const fileNode = answer.nodes.find((node) => !isFolder(node) && (node.id === file || node.path === file));
  const folders = new Set(answer.nodes.filter(isFolder).map((node) => node.path));
  return {
    file: fileNode ? { id: fileNode.id, kind: fileNode.kind } : null,
    folders: folderChain(file).map((dir) => ({ dir, held: folders.has(dir) })),
  };
}

/// The file as its folder's level reads it from disk: the same filesystem
/// route the tab reads levels through.
async function onDisk(inputs, file) {
  const parent = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
  const { status, value, body } = await apiJson(inputs, "api/fs-graph", { scope: "directory", path: parent, depth: 1 });
  if (!value) return { parent, status, found: false, error: body };
  const node = (value.nodes ?? []).find((n) => n.path === file && !isFolder(n));
  return { parent, status, found: Boolean(node), kind: node?.kind ?? null, truncated: value.truncated ?? null };
}

/// A read that failed to reach the server is retried until the deadline, as
/// a status that is not yet the one waited for is.
async function reachable(read) {
  try {
    return await read();
  } catch (error) {
    return { status: null, value: null, body: `unreachable: ${maskTokens(error.cause?.message ?? error.message)}` };
  }
}

async function preconditions(inputs) {
  const start = Date.now();
  const record = { started: new Date().toISOString() };
  const deadline = start + inputs.indexMs;
  let last = {};
  for (;;) {
    const status = await reachable(() => apiJson(inputs, "api/index/status"));
    const preflight = await reachable(() => apiJson(inputs, "api/preflight"));
    last = {
      index: status.value ?? { status: status.status, body: status.body },
      preflight: preflight.value ?? { status: preflight.status, body: preflight.body },
    };
    if (status.value?.state === "error") {
      record.index = last;
      throw Object.assign(new Unavailable(`the index reads error: ${JSON.stringify(status.value).slice(0, 400)}`), { record });
    }
    const indexed = status.value?.state === "idle" && status.value?.readiness?.state === "ready";
    const unlocked = preflight.value !== null && preflight.value.locked !== true;
    if (indexed && unlocked) {
      const answer = await graphAnswer(inputs);
      if (answer.error !== undefined) {
        record.index = last;
        throw Object.assign(new Unavailable(`the window's graph answer failed (${answer.status}): ${answer.error}`), { record });
      }
      if (answer.done && !answer.gated) {
        record.index = last;
        record.buildInfo = (await apiJson(inputs, "api/build-info")).value;
        record.answer = {
          tree: answer.tree,
          metas: answer.metas,
          nodes: answer.nodes.length,
          folders: answer.nodes.filter(isFolder).length,
        };
        record.waitedMs = Date.now() - start;
        return { record, answer };
      }
      last.answer = { done: answer.done, gated: answer.gated, nodes: answer.nodes.length };
    }
    if (Date.now() > deadline) {
      record.index = last;
      const why = !indexed ? "the index did not read idle and ready" : !unlocked ? "preflight holds the window locked" : "the graph answer stayed gated or incomplete";
      throw Object.assign(new Unavailable(`${why} within ${inputs.indexMs / 1000} s: ${JSON.stringify(last).slice(0, 600)}`), { record });
    }
    await delay(2_000);
  }
}

async function checkFiles(inputs, record, answer) {
  if (record.answer.tree == null) {
    throw new Unavailable("the window's graph answer carries no `tree` mark: the workspace is not over the listing cap");
  }
  record.subject = { file: inputs.subject, disk: await onDisk(inputs, inputs.subject), answer: answerHolds(answer, inputs.subject) };
  record.control = { file: inputs.control, disk: await onDisk(inputs, inputs.control), answer: answerHolds(answer, inputs.control) };
  for (const leg of ["subject", "control"]) {
    const { file, disk } = record[leg];
    if (!disk.found) throw new Unavailable(`the ${leg} ${file} is not on disk as ${JSON.stringify(disk.parent)}'s level reads it: ${JSON.stringify(disk)}`);
  }
  if (record.subject.answer.file) {
    throw new Unavailable(`the graph answer holds the subject ${inputs.subject} (${JSON.stringify(record.subject.answer.file)}); choose a file it does not hold`);
  }
  if (!record.control.answer.file) {
    throw new Unavailable(`the graph answer does not hold the control ${inputs.control}; choose a file it holds`);
  }
}

// --- the page ---------------------------------------------------------------

/// Record the labels each graph canvas paints, per frame. GraphCanvas starts
/// each frame by clearing its canvas and labels only the selected node, its
/// neighbours and the folders down to it. The context's own methods draw;
/// the trace only reads their arguments. Installed before the page's scripts.
function installLabelTrace() {
  if (window.__graphOverCapLabels) return;
  const proto = CanvasRenderingContext2D.prototype;
  const original = { clearRect: proto.clearRect, fillText: proto.fillText };
  const frames = new WeakMap();
  proto.clearRect = function (...args) {
    if (this.canvas instanceof HTMLCanvasElement && this.canvas.closest(".graph-tab")) {
      frames.set(this.canvas, { labels: [], at: performance.now() });
    }
    return original.clearRect.apply(this, args);
  };
  proto.fillText = function (text, ...rest) {
    frames.get(this.canvas)?.labels.push(String(text));
    return original.fillText.call(this, text, ...rest);
  };
  window.__graphOverCapLabels = frames;
}

/// The `/api/graph` and `/api/fs-graph` requests a page makes, with what is
/// in flight and when the last one started or ended.
class Requests {
  constructor(page) {
    this.started = Date.now();
    this.mark = null;
    this.entries = [];
    this.inflight = new Map();
    this.lastActivity = Date.now();
    page.on("request", (request) => {
      const entry = describe(request.url());
      if (!entry) return;
      entry.atMs = Date.now() - this.started;
      entry.afterOpen = this.mark !== null;
      entry.status = null;
      this.entries.push(entry);
      this.inflight.set(request, entry);
      this.lastActivity = Date.now();
    });
    const end = (request, status) => {
      const entry = this.inflight.get(request);
      if (!entry) return;
      entry.status = status;
      entry.ms = Date.now() - this.started - entry.atMs;
      this.inflight.delete(request);
      this.lastActivity = Date.now();
    };
    page.on("requestfinished", (request) => end(request, request.response()?.status() ?? null));
    page.on("requestfailed", (request) => end(request, `failed: ${request.failure()?.errorText ?? "unknown"}`));
  }

  /// From here on requests are the tab's, and the tab is quiet only once
  /// nothing has been read for a while after it.
  open() {
    this.mark = Date.now() - this.started;
    this.lastActivity = Date.now();
  }

  quietFor() {
    return this.inflight.size > 0 ? 0 : Date.now() - this.lastActivity;
  }

  afterOpen() {
    return this.entries.filter((entry) => entry.afterOpen);
  }
}

function describe(href) {
  const url = new URL(href);
  if (url.pathname.endsWith("/api/fs-graph")) {
    return {
      route: "fs-graph",
      scope: url.searchParams.get("scope"),
      path: url.searchParams.get("path"),
      depth: url.searchParams.get("depth"),
      limit: url.searchParams.get("limit"),
      page: url.searchParams.has("cursor") ? "next" : "first",
    };
  }
  if (url.pathname.endsWith("/api/graph")) {
    return { route: "graph", stream: url.searchParams.get("stream"), scope: url.searchParams.get("scope"), path: url.searchParams.get("path") };
  }
  return null;
}

/// Every response with a status of 400 or above the page receives, in the
/// order received: its method, its route (the URL's path below the window's
/// own, `api/inspector`, or the whole URL without its query for another
/// origin or path), the workspace path its `path` parameter names, its
/// status, when its request was made (`requestAtMs`) and when it came
/// (`atMs`), both on the request log's clock, and whether its request was
/// made after the tab was asked for (`afterOpen`), by the request log's own
/// rule. A request made before the menu command whose response comes after
/// it reads as before the open, as it does in the request log; a response
/// whose request the reader had not seen when the response came reads
/// `null` for both. No other part of the query is kept, so no token is.
function watchFailedResponses(page, windowUrl, requests) {
  const base = new URL(".", windowUrl);
  const entries = [];
  const made = new WeakMap();
  page.on("request", (request) => {
    made.set(request, { atMs: Date.now() - requests.started, afterOpen: requests.mark !== null });
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    const below = url.origin === base.origin && url.pathname.startsWith(base.pathname);
    const request = response.request();
    const start = made.get(request) ?? null;
    entries.push({
      method: request.method(),
      route: maskTokens(below ? url.pathname.slice(base.pathname.length) : `${url.origin}${url.pathname}`),
      path: url.searchParams.has("path") ? maskTokens(url.searchParams.get("path")) : null,
      status,
      requestAtMs: start?.atMs ?? null,
      atMs: Date.now() - requests.started,
      afterOpen: start?.afterOpen ?? null,
    });
  });
  return entries;
}

/// The failed responses as a set to compare across builds: one key per
/// method, route, path and status, sorted, with how many times it came.
function failedResponseSet(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const key = `${entry.method} ${entry.route}${entry.path === null ? "" : ` path=${entry.path}`} ${entry.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map((key) => ({ key, count: counts.get(key) }));
}

/// The level reads a tab made, by folder in the order first asked: how many
/// times its level was read (first pages) and how many pages that took.
function levelReads(entries) {
  const byPath = new Map();
  for (const entry of entries) {
    if (entry.route !== "fs-graph") continue;
    const key = entry.path ?? "";
    const row = byPath.get(key) ?? { path: key, reads: 0, pages: 0, statuses: [] };
    if (entry.page === "first") row.reads += 1;
    row.pages += 1;
    row.statuses.push(entry.status);
    byPath.set(key, row);
  }
  return [...byPath.values()];
}

/// The active graph tab as the page shows it, and the tab as the window's
/// address carries it.
function readTab(page) {
  return page.evaluate(() => {
    const layoutTab = () => {
      let layout = null;
      try {
        layout = JSON.parse(new URLSearchParams(location.hash.slice(1)).get("s") ?? "null");
      } catch {
        return { unreadable: true };
      }
      const graphs = [];
      const walk = (node) => {
        if (!node) return;
        if (node.k === "s") {
          walk(node.a);
          walk(node.b);
          return;
        }
        for (const tab of [...(node.t ?? []), ...(node.bt ?? [])]) if (tab.k === "g") graphs.push(tab);
      };
      walk(layout);
      const tab = graphs.find((candidate) => candidate.a === 1) ?? graphs.at(-1);
      if (!tab) return null;
      return { gn: tab.gn ?? null, gp: tab.gp ?? null, ge: tab.ge ?? [], graphTabs: graphs.length };
    };
    const panel = document.querySelector(".graph-tab.active");
    if (!panel) return { tab: false, layout: layoutTab() };
    const text = (el) => el?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    const placeholder = panel.querySelector(".canvas > .placeholder");
    const placeholderText = text(placeholder);
    const statText = text(panel.querySelector(".statusbar .stat"));
    const stat = statText?.match(/(\d+)\/(\d+) nodes\s+\u00b7\s+(\d+)\/(\d+) edges/);
    const inspector = panel.querySelector('aside[aria-label="Details"]');
    const canvas = panel.querySelector("canvas");
    const frame = canvas ? window.__graphOverCapLabels?.get(canvas) : undefined;
    return {
      tab: true,
      canvas: Boolean(canvas),
      loading: Boolean(panel.querySelector(".canvas > .stream-status")) || /^loading graph/.test(placeholderText ?? ""),
      error: placeholder?.classList.contains("error") ? placeholderText : null,
      empty: placeholder && !placeholder.classList.contains("error") && !/^loading graph/.test(placeholderText ?? "") ? placeholderText : null,
      spineWarnings: [...panel.querySelectorAll(".spine-warning > div")].map(text),
      depthNote: text(panel.querySelector(".depth-note")),
      stat: stat
        ? { visibleNodes: Number(stat[1]), totalNodes: Number(stat[2]), visibleEdges: Number(stat[3]), totalEdges: Number(stat[4]) }
        : statText,
      inspector: inspector
        ? {
            subject: inspector.querySelector("h3[title]")?.getAttribute("title") ?? null,
            crumbs: [...inspector.querySelectorAll(".scope-crumbs .crumb")].map(text),
          }
        : null,
      labels: frame ? [...new Set(frame.labels)] : null,
      layout: layoutTab(),
    };
  });
}

/// The reading that decides whether the tab has settled: what it shows and
/// carries, without the painted labels, which a frame repaints at will.
function settleKey(reading) {
  const { labels: _labels, ...rest } = reading;
  return JSON.stringify(rest);
}

async function settle(page, requests, settleMs) {
  const start = Date.now();
  let key = null;
  let since = Date.now();
  let reading = null;
  for (;;) {
    reading = await readTab(page);
    const now = Date.now();
    const next = settleKey(reading);
    if (next !== key) {
      key = next;
      since = now;
    }
    const still = now - since;
    const quiet = requests.quietFor() >= QUIET_MS;
    if (reading.tab && !reading.loading && quiet) {
      const hold = reading.layout?.gp != null ? STUCK_MS : QUIET_MS;
      if (reading.error !== null || still >= hold) return { settled: true, waitedMs: now - start, reading };
    }
    if (now - start > settleMs) {
      return { settled: false, waitedMs: now - start, reading, inflight: [...requests.inflight.values()] };
    }
    await delay(SAMPLE_MS);
  }
}

/// Open the menu of the file's row in the Files tab. A listing re-rendered
/// between finding the row and pressing it (a watch event refetches it)
/// leaves a detached row or no menu; each try finds the row again.
async function openRowMenu(page, file) {
  const parent = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
  const name = path.posix.basename(file);
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await showFiles(page);
      await navigateFiles(page, parent);
      const row = (await waitFileRow(page, name, true, { timeout: 60_000 })) ?? (await fileRow(page, name));
      if (!row) throw new Error(`row ${JSON.stringify(name)} went before it could be pressed`);
      await row.click({ button: "right" });
      await row.dispose();
      await page.waitForSelector('[role="menu"][aria-label="File actions"]', { visible: true, timeout: 15_000 });
      return;
    } catch (error) {
      last = maskTokens(error.message);
      if (!/detached|went before it could be pressed|File actions/i.test(last)) {
        throw new Unavailable(`could not reach ${file}'s row menu in Files: ${last}`);
      }
    }
  }
  throw new Unavailable(`could not reach ${file}'s row menu in Files in 3 tries; the last: ${last}`);
}

/// Press the open row menu's "New graph here", as a user does.
async function pressNewGraphHere(page, file) {
  const pressed = await page.evaluate(() => {
    const item = [...document.querySelectorAll('[role="menu"][aria-label="File actions"] [role="menuitem"]')].find(
      (candidate) => candidate.querySelector(".menu-row-label")?.textContent?.trim() === "New graph here",
    );
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  });
  if (!pressed) throw new Unavailable(`${file}'s row menu offers no "New graph here"`);
}

/// What of the file and its folder chain the canvas painted, by the label
/// the canvas gives each: a folder its name and a slash; a file the window's
/// answer holds its name without the extension, as the server's label is the
/// file's stem; a file only the tab's own level read holds its whole name.
function drawn(labels, file) {
  if (labels === null) return null;
  const name = path.posix.basename(file);
  const stem = path.posix.parse(name).name;
  const fileLabel = [name, stem].find((label) => labels.includes(label)) ?? null;
  return {
    file: fileLabel !== null,
    fileLabel,
    chain: folderChain(file).map((dir) => {
      const label = `${path.posix.basename(dir)}/`;
      return { dir, label, painted: labels.includes(label) };
    }),
  };
}

async function runLeg(browser, inputs, leg, file) {
  const context = await browser.createBrowserContext();
  const record = { leg, file, windowId: `${NAME}-${leg}-${Date.now().toString(36)}` };
  const pageErrors = [];
  const consoleErrors = [];
  let failedResponses = [];
  const keep = () => {
    record.pageErrors = pageErrors;
    record.consoleErrors = consoleErrors;
    record.failedResponses = failedResponses;
    record.failedResponseSet = failedResponseSet(failedResponses);
  };
  let page = null;
  try {
    page = await context.newPage();
    await page.setViewport(VIEWPORT);
    page.on("pageerror", (error) => pageErrors.push(maskTokens(error.message)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(maskTokens(message.text()));
    });
    await page.evaluateOnNewDocument(installLabelTrace);
    const requests = new Requests(page);
    failedResponses = watchFailedResponses(page, inputs.window, requests);
    const url = new URL(inputs.window);
    url.searchParams.set("w", record.windowId);
    url.hash = "";
    try {
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 60_000 });
    } catch (error) {
      throw new Unavailable(`the window did not open: ${maskTokens(error.message)}`);
    }
    await page.bringToFront();

    await openRowMenu(page, file);
    requests.open();
    record.openAtMs = requests.mark;
    await pressNewGraphHere(page, file);
    try {
      await page.waitForSelector(".graph-tab.active canvas", { timeout: 60_000 });
    } catch {
      throw new Unavailable(`no graph tab opened from ${file}'s row menu within 60 s`);
    }
    record.opened = await readTab(page);
    await page.screenshot({ path: path.join(inputs.out, `${leg}-opened.png`) });

    const settled = await settle(page, requests, inputs.settleMs);
    await page.screenshot({ path: path.join(inputs.out, `${leg}-settled.png`) });
    const reading = settled.reading;
    record.settled = settled.settled;
    record.waitedMs = settled.waitedMs;
    if (settled.inflight) record.inflightAtDeadline = settled.inflight;
    record.reading = reading;
    record.drawn = drawn(reading.labels ?? null, file);
    record.levelReads = levelReads(requests.afterOpen());
    record.graphStreams = requests.afterOpen().filter((entry) => entry.route === "graph").length;
    record.requests = requests.entries;
    keep();

    const selected = reading.layout?.gn ?? null;
    const pending = reading.layout?.gp ?? null;
    const detailsOpen = reading.inspector != null;
    const details = reading.inspector?.subject ?? null;
    record.outcome = {
      selected,
      pending,
      detailsOpen,
      details,
      opened: reading.layout?.ge ?? [],
      // A tab that never stopped reading has not landed, whatever it shows.
      landed: settled.settled && selected === file && pending === null && details === file,
    };
    if (!reading.tab) throw new Unavailable(`the graph tab opened from ${file} is gone`);
    if (reading.loading) throw new Unavailable(`the graph tab opened from ${file} was still loading after ${inputs.settleMs / 1000} s`);
    if (reading.error !== null) throw new Unavailable(`the graph tab opened from ${file} shows an error: ${reading.error}`);
    return record;
  } catch (error) {
    keep();
    record.failure = maskTokens(error.message);
    if (error instanceof Unavailable) record.unavailable = true;
    else record.error = maskTokens(error.stack ?? String(error));
    if (page && !record.settled) {
      await page.screenshot({ path: path.join(inputs.out, `${leg}-failed.png`) }).catch(() => {});
    }
    throw Object.assign(error, { record });
  } finally {
    write(inputs.out, `${leg}.json`, record);
    await context.close().catch(() => {});
  }
}

function detailsText(o) {
  return o.detailsOpen ? `on ${o.details ?? "no file"}` : "closed";
}

/// What a leg landed on, in one phrase.
function landedOn(record) {
  const o = record.outcome;
  const still = record.settled ? "" : `, and the tab did not settle in ${(record.waitedMs / 1000).toFixed(0)} s`;
  return `selected ${o.selected ?? "none"}, pending ${o.pending ?? "none"}, Details ${detailsText(o)}${still}`;
}

function summary(record) {
  const o = record.outcome;
  const reads = record.levelReads.map((row) => `${JSON.stringify(row.path)}x${row.reads}${row.pages > row.reads ? `/${row.pages}p` : ""}`);
  let painted = "labels not traced";
  if (record.drawn) {
    const unpainted = record.drawn.chain.filter((c) => !c.painted).map((c) => c.label);
    painted =
      `file ${record.drawn.file ? `painted as ${JSON.stringify(record.drawn.fileLabel)}` : "not painted"}, ` +
      `folders ${record.drawn.chain.length - unpainted.length}/${record.drawn.chain.length} painted` +
      (unpainted.length > 0 ? ` (not ${unpainted.join(" ")})` : "");
  }
  const failed = record.failedResponseSet.map(({ key, count }) => (count > 1 ? `${key} x${count}` : key));
  return (
    `${record.leg} ${record.file}: ${o.landed ? "LANDED" : "NOT LANDED"}; ` +
    `selected ${o.selected ?? "none"}, pending ${o.pending ?? "none"}, Details ${detailsText(o)}, ` +
    `opened [${o.opened.join(", ")}], level reads [${reads.join(", ")}], graph streams ${record.graphStreams}, ` +
    `${painted}, ${record.settled ? "settled" : "NOT SETTLED"} after ${(record.waitedMs / 1000).toFixed(1)} s; ` +
    `page errors ${record.pageErrors.length}, console errors ${record.consoleErrors.length}, ` +
    `failed responses [${failed.join(", ")}]`
  );
}

/// The output directory once it is this run's, so a verdict that ends the
/// run early is written there too.
let outDir = null;

async function main() {
  const inputs = parseInputs();
  prepareOut(inputs.out);
  outDir = inputs.out;
  say(`window ${maskTokens(inputs.window.href)}, subject ${inputs.subject}, control ${inputs.control}, out ${inputs.out}`);

  let pre;
  try {
    pre = await preconditions(inputs);
    await checkFiles(inputs, pre.record, pre.answer);
  } catch (error) {
    write(inputs.out, "preconditions.json", { ...(error.record ?? pre?.record ?? {}), failure: maskTokens(error.message) });
    throw error;
  }
  write(inputs.out, "preconditions.json", pre.record);
  const { record } = pre;
  say(
    `preconditions hold: tree ${record.answer.tree}, ${record.answer.nodes} nodes (${record.answer.folders} folders); ` +
      `subject on disk, not in the answer (folders held ${record.subject.answer.folders.filter((f) => f.held).length}/${record.subject.answer.folders.length}); ` +
      `control on disk and in the answer`,
  );

  if (!inputs.chrome || !existsSync(inputs.chrome)) throw new Unavailable(`no Chrome at ${inputs.chrome ?? "~/.cache/puppeteer/chrome"} (set CHROME_BIN or --chrome)`);
  const require = createRequire(path.join(ROOT, "scripts/e2e/browser-smoke/package.json"));
  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch (error) {
    throw new Unavailable(`puppeteer-core is not installed under scripts/e2e/browser-smoke: ${error.message}`);
  }
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: inputs.chrome,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", `--window-size=${VIEWPORT.width},${VIEWPORT.height}`],
      defaultViewport: VIEWPORT,
      protocolTimeout: 120_000,
    });
  } catch (error) {
    throw new Unavailable(`Chrome could not start: ${error.message}`);
  }
  const legs = {};
  try {
    say(`chrome ${await browser.version()}`);
    for (const [leg, file] of [["subject", inputs.subject], ["control", inputs.control]]) {
      try {
        legs[leg] = await runLeg(browser, inputs, leg, file);
        say(summary(legs[leg]));
      } catch (error) {
        legs[leg] = error.record ?? { leg, file, failure: maskTokens(error.message) };
        say(`${leg} ${file}: NOT READ: ${maskTokens(error.message)}`);
      }
    }
  } finally {
    await Promise.race([browser.close().catch(() => {}), delay(30_000)]);
  }

  const read =(leg) => legs[leg]?.outcome !== undefined && legs[leg].failure === undefined;
  let verdict;
  if (!read("control")) {
    verdict = { verdict: "unavailable", exit: 2, reason: `the control was not read: ${legs.control.failure}` };
  } else if (!legs.control.outcome.landed) {
    verdict = {
      verdict: "unavailable",
      exit: 2,
      reason: `control red: ${inputs.control}, which the answer holds, did not land (${landedOn(legs.control)}); the reading cannot attribute the subject's result`,
    };
  } else if (!read("subject")) {
    verdict = { verdict: "unavailable", exit: 2, reason: `the subject was not read: ${legs.subject.failure}` };
  } else if (!legs.subject.outcome.landed) {
    verdict = { verdict: "fail", exit: 1, reason: `${inputs.subject} did not land selected: ${landedOn(legs.subject)}` };
  } else {
    verdict = { verdict: "pass", exit: 0, reason: `${inputs.subject} and ${inputs.control} landed selected with Details on them` };
  }
  // What a job compares across builds, per leg: its uncaught page errors and
  // its failed-response set.
  const errorsOf = (leg) => {
    const r = legs[leg] ?? {};
    return {
      pageErrors: r.pageErrors ?? null,
      consoleErrors: r.consoleErrors?.length ?? null,
      failedResponseSet: r.failedResponseSet ?? null,
    };
  };
  write(inputs.out, "verdict.json", {
    ...verdict,
    subject: inputs.subject,
    control: inputs.control,
    legs: { subject: errorsOf("subject"), control: errorsOf("control") },
    buildInfo: record.buildInfo,
    finished: new Date().toISOString(),
  });
  say(`verdict: ${verdict.verdict.toUpperCase()} (exit ${verdict.exit}): ${verdict.reason}`);
  return verdict.exit;
}

// The exit is explicit: a handle the browser left open must not hold the
// runner past the verdict.
main().then(
  (code) => process.exit(code),
  (error) => {
    const reason = maskTokens(error?.message ?? String(error));
    if (!(error instanceof Unavailable)) console.error(maskTokens(error?.stack ?? String(error)));
    if (outDir) {
      try {
        write(outDir, "verdict.json", { verdict: "unavailable", exit: 2, reason, finished: new Date().toISOString() });
      } catch {
        // The verdict line below still says it.
      }
    }
    say(`verdict: UNAVAILABLE (exit 2): ${reason}`);
    process.exit(2);
  },
);
