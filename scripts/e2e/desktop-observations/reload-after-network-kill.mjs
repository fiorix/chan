#!/usr/bin/env node
// The page-level legs of reload-after-network-kill.sh, and their verdict.
//
//   reload-after-network-kill.mjs run --inspector HOST:PORT --desktop-pid PID
//       --desktop-bin PATH --chan PATH --ws DIR --window ID --xid X-ID
//       --output DIR --webkit VERSION
//   reload-after-network-kill.mjs verdict --results JSONL --webkit VERSION
//
// `run` drives two local workspace windows of one chan-desktop through the
// engine's remote inspector, X input (xdotool, so XTEST) and `chan shell`,
// and appends one JSON record per leg to DIR/results.jsonl: window A's
// fixture, a Reload by Ctrl+Shift+R with nothing killed, the two readings
// of a Reload with the page's token intact (Search open; a tab opened under
// a second before), a kill of WebKit's network process and what session
// storage says after it, a Reload by the key; then window B, opened after
// that, with its own fixture, a second kill and a Reload by the page's
// `app.window.reload` command. It exits 0 once the legs have run, whatever
// they saw, and 3 when it cannot reach window A's page.
//
// Facts the records rest on, all read from the page or from /proc:
// - Which load a page came from: its Navigation Timing entry, `reload` for
//   the page's own location.reload() and `navigate` for the desktop's
//   navigation to the window's tokened URL. The fixture's first load is a
//   navigation, so every run reads that value once before it is relied on.
// - Whether the page holds its token where a reload looks for it:
//   sessionStorage `chan.token`, read for presence only.
// - Whether a reloaded page works: it shows its panes and not the
//   missing-token cover, a request for the shells list sent from the page
//   with the token the page holds answers 200, and keys typed by X input
//   into its terminal reach the shell the terminal had (the shell answers
//   with its own pid) on the server session it had.
// - The network process: a descendant of the desktop's pid whose
//   executable is WebKitNetworkProcess in a webkit2gtk-4.1 directory, never
//   one in this driver's own ancestor chain, killed by pid. With more than
//   one, the one holding a TCP connection to the page's port is chosen, or
//   none.
// No record holds a token, a URL or a fragment: the output directory is
// kept unmasked.
//
// `verdict` judges the records and prints one line per leg, held, failed
// or unavailable, and a result line. It exits 0 when every leg held, 10
// when a leg failed, and 3 otherwise.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TERMINAL_SURFACE } from "../browser-smoke/lib/terminal-attach.mjs";

export const NETWORK_PROCESS = "WebKitNetworkProcess";
export const ENGINE_DIR = "webkit2gtk-4.1";
// A key Reload must reach its chord within this long of the tab it follows.
export const QUICK_TAB_BOUND_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);

// The same masks as lib.sh's obs_masked, for error text that may quote a
// page or a command.
export function mask(text) {
  return String(text)
    .replace(/([?&]t=)[^&\s"]+/g, "$1<token>")
    .replace(/([?&]h=)[^&#\s"]+/g, "$1<holder>")
    .replace(/(#s=)[^&\s"]+/g, "$1<state>")
    .replace(/(CHAN_DEVSERVER_TOKEN=)\S+/g, "$1<token>")
    .replace(/("(devserver_)?token"\s*:\s*")[^"]*"/g, '$1<token>"');
}

// ------------------------------------------------------- the process tree

export function parseStatus(text) {
  const field = (name) => text.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? null;
  const ppid = /^\d+$/.test(field("PPid") ?? "") ? Number(field("PPid")) : null;
  return { state: field("State")?.[0] ?? null, ppid };
}

// pid itself, its parent, and so on up to the first pid the table lacks.
export function ancestorChain(pid, rows) {
  const chain = [];
  const seen = new Set();
  while (Number.isInteger(pid) && pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    chain.push(pid);
    pid = rows.get(pid)?.ppid;
  }
  return chain;
}

export function descendantsOf(root, rows) {
  const children = new Map();
  for (const [pid, row] of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(pid);
  }
  const found = [];
  const seen = new Set([root]);
  const queue = [...(children.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

// The engine's network process by its executable, which a process cannot
// rename the way it can its argv or comm. A replaced binary reads
// "... (deleted)" and is not taken.
export function isNetworkProcessPath(exe) {
  return typeof exe === "string" && exe.startsWith("/")
    && basename(exe) === NETWORK_PROCESS && basename(dirname(exe)) === ENGINE_DIR;
}

export function networkCandidates({ rows, desktopPid, skip }) {
  return descendantsOf(desktopPid, rows)
    .filter((pid) => !skip.has(pid) && isNetworkProcessPath(rows.get(pid)?.exe))
    .map((pid) => ({ pid, ppid: rows.get(pid).ppid, exe: rows.get(pid).exe }));
}

// /proc/<pid>/net/tcp and tcp6: one row per socket, ports in hex.
export function parseTcpTable(text) {
  const rows = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const port = (address) => Number.parseInt(address.split(":").at(-1), 16);
    rows.push({ localPort: port(cols[1]), remotePort: port(cols[2]), state: cols[3], inode: cols[9] });
  }
  return rows;
}

// The inodes of established connections to `port` (state 01 is
// TCP_ESTABLISHED).
export function connectionInodes(rows, port) {
  return new Set(rows.filter((row) => row.state === "01" && row.remotePort === port).map((row) => row.inode));
}

export function pickNetworkProcess(candidates, holdsPagePort) {
  if (candidates.length === 0) return { pick: null, reason: `no ${NETWORK_PROCESS} in a ${ENGINE_DIR} directory among the desktop's descendants` };
  if (candidates.length === 1) return { pick: candidates[0], by: "only" };
  const holding = candidates.filter((candidate) => holdsPagePort.get(candidate.pid));
  if (holding.length === 1) return { pick: holding[0], by: "connection" };
  return { pick: null, reason: `${candidates.length} network processes, ${holding.length} of them holding a connection to the page's port` };
}

function processTable() {
  const rows = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = parseStatus(readFileSync(`/proc/${entry}/status`, "utf8"));
      let exe = null;
      try { exe = readlinkSync(`/proc/${entry}/exe`); } catch { /* a kernel thread or a process gone */ }
      rows.set(Number(entry), { ppid: status.ppid, state: status.state, exe });
    } catch { /* processes can exit while /proc is read */ }
  }
  return rows;
}

function holdsConnectionTo(pid, port) {
  try {
    const inodes = new Set();
    for (const table of ["tcp", "tcp6"]) {
      try {
        for (const inode of connectionInodes(parseTcpTable(readFileSync(`/proc/${pid}/net/${table}`, "utf8")), port)) inodes.add(inode);
      } catch { /* no such table */ }
    }
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const socket = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (socket && inodes.has(socket[1])) return true;
      } catch { /* fds come and go */ }
    }
  } catch { /* the process is gone */ }
  return false;
}

// Gone once /proc has no such pid, it is a zombie, or the pid now runs
// another executable.
function processGone(pid, exe) {
  try {
    if (parseStatus(readFileSync(`/proc/${pid}/status`, "utf8")).state === "Z") return true;
    return readlinkSync(`/proc/${pid}/exe`) !== exe;
  } catch {
    return true;
  }
}

// ------------------------------------------------------ page expressions
// Each runs in the page by its source text, so it closes over nothing.

export function pageState() {
  const fingerprint = (text) => {
    if (typeof text !== "string") return null;
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${text.length}:${hash.toString(16)}`;
  };
  const nav = typeof performance.getEntriesByType === "function" ? performance.getEntriesByType("navigation")[0] : undefined;
  let entryHadToken = null;
  try { entryHadToken = nav ? new URL(nav.name).searchParams.has("t") : null; } catch { entryHadToken = null; }
  let stored = null;
  let storageError = null;
  try { stored = window.sessionStorage.getItem("chan.token"); } catch (error) { storageError = String((error && error.name) || error); }
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const hash = new URLSearchParams(raw);
  const dialog = document.querySelector('[role="dialog"][aria-label="Search"]');
  return {
    ready: document.readyState,
    mark: window.__reloadKillMark ?? null,
    workspace: Boolean(document.querySelector(".pane[data-pane-id]")),
    missingToken: Boolean(document.querySelector('[data-cover="missing-token"]')),
    urlHasToken: new URL(location.href).searchParams.has("t"),
    navType: nav ? nav.type : null,
    legacyNavType: performance.navigation ? performance.navigation.type : null,
    entryHadToken,
    tokenStored: typeof stored === "string" && stored.length > 0,
    storageError,
    hashKeys: [...hash.keys()],
    layout: fingerprint(hash.get("s")),
    searchParam: hash.get("search"),
    search: dialog ? { open: true, query: dialog.querySelector("input")?.value ?? null } : { open: false, query: null },
    port: Number(location.port) || null,
  };
}

export function terminalDom(tabId, surface) {
  const tab = [...document.querySelectorAll(".terminal-tab")].find((el) => el.getAttribute("data-terminal-tab-id") === tabId) ?? null;
  const host = tab?.querySelector(".terminal-host") ?? null;
  const box = tab?.querySelector(surface)?.getBoundingClientRect();
  const hostBox = host?.getBoundingClientRect();
  const active = document.activeElement;
  return {
    tab: Boolean(tab),
    active: Boolean(tab?.classList.contains("active")),
    canvas: Boolean(box && box.width > 0 && box.height > 0),
    center: hostBox && hostBox.width > 0 && hostBox.height > 0
      ? { x: Math.round(hostBox.left + hostBox.width / 2), y: Math.round(hostBox.top + hostBox.height / 2) } : null,
    focused: Boolean(host && active && typeof active.closest === "function" && active.closest(".terminal-host") === host),
  };
}

// The shells list, asked with the token the page keeps in session storage,
// which is the token every request of a loaded page carries: the page reads
// it from there, or puts it there from its URL, as it loads.
export async function shellsProbe() {
  const meta = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content")?.trim() ?? "";
  const prefix = meta.startsWith("/") ? meta.replace(/\/+$/, "") : "";
  let token = null;
  try { token = window.sessionStorage.getItem("chan.token"); } catch { token = null; }
  const response = await fetch(`${prefix}/api/terminal/shells`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, sentToken: Boolean(token) };
}

export function fileTab(path) {
  const tab = [...document.querySelectorAll(".tab")].find((el) => el.getAttribute("title") === path) ?? null;
  return { open: Boolean(tab), active: Boolean(tab?.querySelector('[role="tab"][aria-selected="true"]')) };
}

// Where X input lands on the page: screen minus client point, read at two
// points that must agree.
export function offsetFrom(seen) {
  const offsets = seen.map((point) => point.client ? [point.sx - point.client.x, point.sy - point.client.y] : null);
  const agree = offsets.length > 0 && offsets.every((o) => o && o[0] === offsets[0][0] && o[1] === offsets[0][1]);
  return agree ? { dx: offsets[0][0], dy: offsets[0][1] } : null;
}

// ---------------------------------------------------------------- verdict

export function fixtureHeld(r) {
  return Boolean(r && !r.error && r.loaded && r.state?.workspace && !r.state.missingToken && r.state.tokenStored
    && !r.state.urlHasToken && r.calibration?.offset && r.attach?.typed && Number.isInteger(r.attach.shellPid) && r.attach.sessionId);
}

function fixtureProblem(r) {
  if (!r) return "no record";
  if (r.error) return r.error;
  if (!r.loaded) return "the page did not load into its workspace or onto the missing-token page in 60 s";
  if (r.state.missingToken || !r.state.workspace) return "the window did not open in its workspace";
  if (!r.state.tokenStored) return `session storage holds no token${r.state.storageError ? ` (${r.state.storageError})` : ""}`;
  if (r.state.urlHasToken) return "the URL still carries t";
  if (!r.calibration?.offset) return "X input cannot be placed on the page: the calibration's two points disagreed or the page saw no pointer move";
  if (!r.attach?.ready) return "its terminal did not come up attached to the window in 20 s";
  if (!r.attach.typed) return `keys typed into its terminal reached no shell (${JSON.stringify(r.attach.attempts)})`;
  return "its terminal named no shell pid or session";
}

const pathOf = (state) => state?.navType === "navigate" ? `navigated (a fresh load${state.entryHadToken ? " with t" : ""})`
  : state?.navType === "reload" ? "reloaded in page" : `loaded with navigation type ${state?.navType}`;

// Why a reloaded page cannot be read, or null.
function landingUnreadable(r) {
  if (r.error) return r.error;
  if (!r.state) return "the reloaded page never answered the inspector";
  if (r.settled && !r.late) return "the reloaded page stopped answering the inspector";
  if (r.attach?.ready && !r.attach.typed && !r.attach.focused) return "a click did not give its terminal the keyboard";
  return null;
}

// Why a reloaded page did not land with a working token on the session it
// had, or null.
function landingFault(r) {
  if (r.late?.missingToken || r.state.missingToken) return "it landed on the missing-token page";
  if (!r.settled || !r.late?.workspace) return "it reloaded but did not come back in its workspace in 60 s";
  if (r.shells?.status !== 200) return `the shells request answered ${r.shells?.status ?? r.shells?.error ?? "nothing"}`;
  if (!r.attach?.ready) return "its terminal did not come back attached to the window in 20 s";
  if (r.attach.sameSession === false) return `its terminal is on session ${r.attach.sessionId}, not the one it had`;
  if (!r.attach.typed) return "keys typed into its terminal reached no shell";
  if (r.attach.samePid === false) return `keys typed into its terminal reached shell ${r.attach.shellPid}, not the one it had`;
  return null;
}

function landedText(r) {
  return `${pathOf(r.state)}; it is in its workspace, the shells request answered 200 and its terminal is on the session it had (shell ${r.attach.shellPid})`;
}

export function judge(records) {
  const find = (leg, extra = {}) => records.find((r) => r.leg === leg && Object.entries(extra).every(([k, v]) => r[k] === v)) ?? null;
  const lines = [];
  const states = {};
  const say = (id, name, state, text) => {
    states[id] = state;
    lines.push(`leg ${name}: ${state.toUpperCase()}: ${text}`);
  };
  const webkit = find("run")?.webkit ?? "unknown";

  // 1. Window A's fixture.
  const fixtureA = find("fixture", { window: "a" });
  if (fixtureHeld(fixtureA)) {
    say("fixture", "1 fixture", "held", `window A is in its workspace with its token in session storage and none in its URL; its terminal is attached (session ${fixtureA.attach.sessionId}, shell ${fixtureA.attach.shellPid}); its first load read as navigation type ${fixtureA.state.navType}${fixtureA.state.entryHadToken ? " with t" : ""}`);
  } else {
    say("fixture", "1 fixture", "unavailable", fixtureProblem(fixtureA));
  }
  const fixtureOk = states.fixture === "held";
  const navReadable = fixtureOk && fixtureA.state.navType === "navigate";

  // A Reload judged by where it landed: `needs` names what must have held
  // for its reading to count, `noReload` what it means when the window
  // kept its page.
  const reloadLeg = (id, name, r, needs, noReload) => {
    if (needs) return say(id, name, "unavailable", needs);
    if (!r) return say(id, name, "unavailable", "no record");
    if (r.skipped) return say(id, name, "unavailable", r.skipped);
    if (r.error) return say(id, name, "unavailable", r.error);
    if (!r.reloaded) return say(id, name, noReload.state, noReload.text);
    const unreadable = landingUnreadable(r);
    if (unreadable) return say(id, name, "unavailable", unreadable);
    const fault = landingFault(r);
    return fault ? say(id, name, "failed", `${pathOf(r.state)}: ${fault}`) : say(id, name, "held", landedText(r));
  };

  // 2. The control: a key Reload with nothing killed.
  const control = find("control");
  reloadLeg("control", "2 control", control, fixtureOk ? null : "the fixture did not hold",
    { state: "unavailable", text: "the window did not reload by Ctrl+Shift+R; X input that did not land cannot be told from a Reload that did nothing" });
  const keyReloads = states.control === "held";

  // 7. Contract 2: two key Reloads with the token intact land in page.
  const contractNeeds = !fixtureOk ? "the fixture did not hold"
    : !navReadable ? "the first load did not read as a navigation, so a navigation cannot be told from an in-page reload"
      : !keyReloads ? "the control did not hold" : null;
  const fragment = find("fragment");
  if (contractNeeds) say("fragment", "7 Search open", "unavailable", contractNeeds);
  else if (!fragment) say("fragment", "7 Search open", "unavailable", "no record");
  else if (fragment.skipped || fragment.error) say("fragment", "7 Search open", "unavailable", fragment.skipped ?? fragment.error);
  else if (!fragment.setup?.queryInHash) say("fragment", "7 Search open", "unavailable", `Search did not take the typed query into the fragment (${JSON.stringify(fragment.setup)})`);
  else if (!fragment.reloaded) say("fragment", "7 Search open", "failed", "the window did not reload by Ctrl+Shift+R with Search open, though it did with nothing open");
  else if (!fragment.state) say("fragment", "7 Search open", "unavailable", "the reloaded page never answered the inspector");
  else {
    const late = fragment.late ?? fragment.state;
    const fault = late.missingToken ? "it landed on the missing-token page"
      : fragment.state.navType !== "reload" ? `it ${pathOf(fragment.state)}, not an in-page reload`
        : !late.search?.open || late.search.query !== fragment.query ? `Search came back ${late.search?.open ? `holding ${JSON.stringify(late.search.query)}` : "closed"}, not open on ${JSON.stringify(fragment.query)}`
          : late.searchParam !== fragment.before.searchParam ? "the fragment's search key changed"
            : null;
    if (fault) say("fragment", "7 Search open", "failed", fault);
    else say("fragment", "7 Search open", "held", `reloaded in page: Search is open on its query and the fragment's search key is unchanged; the layout key is ${late.layout === fragment.before.layout ? "unchanged" : "rewritten"}`);
  }
  const quick = find("quick-tab");
  if (contractNeeds) say("quick", "7 new tab", "unavailable", contractNeeds);
  else if (!quick) say("quick", "7 new tab", "unavailable", "no record");
  else if (quick.skipped || quick.error) say("quick", "7 new tab", "unavailable", quick.skipped ?? quick.error);
  else if (!quick.shown) say("quick", "7 new tab", "unavailable", `the tab ${quick.file} did not show in 5 s after cs open (status ${quick.openStatus})`);
  else if (!(quick.timing?.shownToPressMs <= QUICK_TAB_BOUND_MS)) say("quick", "7 new tab", "unavailable", `the chord went ${quick.timing?.shownToPressMs} ms after the tab showed, not within ${QUICK_TAB_BOUND_MS} ms`);
  else if (!quick.reloaded) say("quick", "7 new tab", "failed", "the window did not reload by Ctrl+Shift+R just after a tab opened, though it did with nothing new");
  else if (!quick.state) say("quick", "7 new tab", "unavailable", "the reloaded page never answered the inspector");
  else {
    const late = quick.late ?? quick.state;
    const fault = late.missingToken ? "it landed on the missing-token page"
      : quick.state.navType !== "reload" ? `it ${pathOf(quick.state)}, not an in-page reload`
        : !late.workspace ? "it did not come back in its workspace" : null;
    const tab = `the new tab ${quick.tabKept ? "is there" : "is NOT there"} after the reload`;
    if (fault) say("quick", "7 new tab", "failed", `Ctrl+Shift+R ${quick.timing.shownToPressMs} ms after the tab showed: ${fault}; ${tab}`);
    else say("quick", "7 new tab", "held", `Ctrl+Shift+R ${quick.timing.shownToPressMs} ms after the tab showed reloaded in page; ${tab}`);
  }

  // 3 and 4, then 5: the kill on window A, what storage said, a key Reload.
  const killLeg = (id, name, r, needs) => {
    if (needs) return say(id, name, "unavailable", needs);
    if (!r) return say(id, name, "unavailable", "no record");
    if (r.error || r.unavailable) return say(id, name, "unavailable", r.error ?? r.unavailable);
    if (!r.killed) return say(id, name, "unavailable", `${NETWORK_PROCESS} ${r.target.pid} outlived SIGKILL for 10 s`);
    const chosen = r.target.by === "only" ? "the desktop's only one" : "the one holding the page's connection";
    const relaunch = r.relaunch ? `WebKit started ${r.relaunch.pid} (${r.relaunch.exe}) ${r.relaunch.afterMs} ms after the kill` : "WebKit started no new network process within 30 s";
    return say(id, name, "held", `killed ${r.target.pid} (${r.target.exe}, ${chosen}) by pid; it was gone in ${r.goneAfterMs} ms; ${relaunch}`);
  };
  const storageLeg = (id, name, r) => {
    const read = r?.beforeReload;
    if (!r || !read) return say(id, name, "unavailable", r?.readError ?? "session storage was not read after the kill");
    const first = r.immediate && r.immediate.tokenStored !== read.tokenStored ? ` (read ${r.immediate.tokenStored ? "kept" : "lost"} right after the kill)` : "";
    return say(id, name, "held", `the page ${read.tokenStored ? "still reads its token" : "reads no token"} in session storage after the kill${read.storageError ? ` (${read.storageError})` : ""}: ${read.tokenStored ? "kept" : "lost"}${first}`);
  };
  const killA = find("kill", { n: 1 });
  killLeg("killA", "3 kill", killA, fixtureOk ? null : "the fixture did not hold");
  const storageA = find("storage", { n: 1 });
  if (states.killA === "held") storageLeg("storageA", "4 storage", storageA);
  else say("storageA", "4 storage", "unavailable", "nothing was killed");
  reloadLeg("key", "5 reload by the key", find("reload-key"),
    !keyReloads ? "the control did not hold" : states.killA !== "held" ? "nothing was killed" : null,
    { state: "failed", text: "the window did not reload by Ctrl+Shift+R after the kill, though it did with nothing killed" });

  // 6: window B, a second kill, a Reload by the page's command.
  const fixtureB = find("fixture", { window: "b" });
  if (fixtureHeld(fixtureB)) say("fixtureB", "6 fixture", "held", `window B is in its workspace with its token in session storage and none in its URL; its terminal is attached (session ${fixtureB.attach.sessionId}, shell ${fixtureB.attach.shellPid})`);
  else say("fixtureB", "6 fixture", "unavailable", fixtureProblem(fixtureB));
  killLeg("killB", "6 kill", find("kill", { n: 2 }), states.fixtureB === "held" ? null : "window B's fixture did not hold");
  const storageB = find("storage", { n: 2 });
  if (states.killB === "held") storageLeg("storageB", "6 storage", storageB);
  else say("storageB", "6 storage", "unavailable", "nothing was killed");
  reloadLeg("page", "6 reload by the page", find("reload-page"),
    states.killB !== "held" ? "nothing was killed" : null,
    { state: "failed", text: "the window did not reload by the page's app.window.reload command after the kill" });

  // What the engine did with session storage decides what legs 5 and 6 say.
  const reads = [["storageA", storageA], ["storageB", storageB]]
    .filter(([id]) => states[id] === "held").map(([, r]) => r.beforeReload.tokenStored);
  const kept = reads.includes(true);
  const lost = reads.includes(false);
  const reloadsHeld = states.key === "held" && states.page === "held";
  const reloadFailed = states.key === "failed" || states.page === "failed";
  let note;
  if (!reads.length) note = "session storage was not read after a kill";
  else if (kept && lost) note = "the two kills read differently: one kept the token in session storage and one lost it";
  else if (kept) {
    note = reloadsHeld
      ? "WebKitGTK kept session storage across the kill: legs 5 and 6 hold at the base as well, so this run does not show the fix"
      : reloadFailed
        ? "the page still read its token after the kill, yet a reload did not land: the read came from a copy the engine did not keep"
        : "WebKitGTK kept session storage across the kill";
  } else {
    note = reloadsHeld
      ? "WebKitGTK lost session storage with its network process, as WKWebView did, and both reloads landed: legs 5 and 6 show the fix"
      : reloadFailed
        ? "WebKitGTK lost session storage with its network process, as WKWebView did, and a reload did not land: the fault the row names"
        : "WebKitGTK lost session storage with its network process, as WKWebView did";
  }
  const values = Object.values(states);
  const count = (state) => values.filter((v) => v === state).length;
  const status = count("failed") ? 10 : count("unavailable") ? 3 : 0;
  lines.push(`result: ${count("held")} held, ${count("failed")} failed, ${count("unavailable")} unavailable; ${note}; WebKitGTK ${webkit}`);
  return { lines, states, status };
}

function verdict(args) {
  let records;
  try {
    records = readFileSync(args.results, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    console.log(`result: the records cannot be read: ${mask(String(error))}`);
    process.exit(3);
  }
  const { lines, status } = judge(records);
  for (const line of lines) console.log(line);
  process.exit(status);
}

// ------------------------------------------------------------------- run

async function run(args) {
  const desktopPid = Number(args["desktop-pid"]);
  const results = join(args.output, "results.jsonl");
  const shots = join(args.output, "shots");
  mkdirSync(shots, { recursive: true });
  const record = (row) => appendFileSync(results, `${JSON.stringify(row)}\n`);
  const shot = (name) => spawnSync("import", ["-window", "root", join(shots, `${name}.png`)], { timeout: 20000 });
  const log = (text) => console.error(`reload-after-network-kill: ${mask(text)}`);
  const xdo = (...words) => spawnSync("xdotool", words.map(String), { encoding: "utf8", timeout: 10000 });
  const cs = (words, windowId = null) => {
    const env = { ...process.env };
    if (windowId) env.CHAN_WINDOW_ID = windowId;
    else delete env.CHAN_WINDOW_ID;
    return spawnSync(args.chan, ["shell", ...words], { cwd: args.ws, env, encoding: "utf8", timeout: 20000 });
  };
  const poll = async (read, done, bound, every = 150) => {
    const start = now();
    for (;;) {
      const value = await read();
      if (done(value)) return { met: true, value, waitedMs: now() - start };
      if (now() - start > bound) return { met: false, value, waitedMs: now() - start };
      await sleep(every);
    }
  };
  const stamp = Date.now().toString(36);
  record({ leg: "run", webkit: args.webkit, desktopPid, stamp });

  // ---- the inspector: one connection per page, found by the window id
  // its URL carries.
  const held = new Set();
  async function listing() {
    const html = await (await fetch(`http://${args.inspector}/`, { signal: AbortSignal.timeout(5000) })).text();
    const rows = [];
    for (const [, cells] of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)) {
      const path = /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0];
      if (path) rows.push({ socket: `ws://${args.inspector}${path}`, text: cells.replace(/<[^>]+>/g, " ") });
    }
    return rows;
  }
  function connect(socket) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(socket);
      let target = null;
      let next = 1;
      const waiting = new Map();
      const timer = setTimeout(() => { ws.close(); reject(new Error("the inspector named no page target in 5 s")); }, 5000);
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && !target) {
          target = message.params.targetInfo.targetId;
          clearTimeout(timer);
          resolve({
            evaluate(expression) {
              const id = next++;
              const inner = JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } });
              return new Promise((done, fail) => {
                const bound = setTimeout(() => { waiting.delete(id); fail(new Error("the page did not answer in 8 s")); }, 8000);
                waiting.set(id, { done, fail, bound });
                ws.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId: target, message: inner } }));
              });
            },
            close: () => new Promise((done) => { ws.onclose = done; ws.close(); setTimeout(done, 500); }),
          });
        } else if (message.method === "Target.dispatchMessageFromTarget") {
          const inner = JSON.parse(message.params.message);
          const pending = waiting.get(inner.id);
          if (!pending) return;
          waiting.delete(inner.id);
          clearTimeout(pending.bound);
          if (inner.error || inner.result?.wasThrown) pending.fail(new Error(JSON.stringify(inner).slice(0, 400)));
          else pending.done(inner.result.result.value);
        }
      };
      ws.onclose = () => {
        for (const pending of waiting.values()) { clearTimeout(pending.bound); pending.fail(new Error("the inspector closed the page's connection")); }
        waiting.clear();
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`cannot reach ${socket}`)); };
    });
  }
  async function findPage(windowId) {
    const rows = await listing();
    const named = rows.filter((row) => row.text.includes(`w=${windowId}`));
    for (const row of named.length ? named : rows.filter((r) => !held.has(r.socket))) {
      let conn = null;
      try {
        conn = await connect(row.socket);
        if ((await conn.evaluate(`new URLSearchParams(location.search).get("w")`)) === windowId) return { conn, socket: row.socket };
      } catch { /* a page that does not answer is not this window's */ }
      await conn?.close();
    }
    return null;
  }
  const makeWindow = (label, id, xid) => ({
    label, id, xid, offset: null, conn: null, socket: null,
    async open() {
      if (this.conn) return this.conn;
      const found = await findPage(this.id);
      if (!found) throw new Error(`no inspectable page belongs to window ${this.id}`);
      this.conn = found.conn;
      this.socket = found.socket;
      held.add(found.socket);
      return this.conn;
    },
    async close() {
      if (this.conn) {
        held.delete(this.socket);
        await this.conn.close();
      }
      this.conn = null;
      this.socket = null;
    },
    async eval(expression) {
      try {
        return await (await this.open()).evaluate(expression);
      } catch (error) {
        await this.close();
        throw error;
      }
    },
    state() { return this.eval(`(${pageState})()`); },
    terminal(tabId) { return this.eval(`(${terminalDom})(${JSON.stringify(tabId)}, ${JSON.stringify(TERMINAL_SURFACE)})`); },
  });
  const tryState = async (win) => { try { return await win.state(); } catch { return null; } };

  // Async work in the page: the WebKitGTK inspector does not await a
  // promise, so the page keeps the answer and the driver polls for it.
  let asyncId = 0;
  async function settle(win, expression, bound = 15000) {
    const id = `a${++asyncId}`;
    await win.eval(`(() => {
      const box = (window.__reloadKillAsync ||= {});
      box[${JSON.stringify(id)}] = { done: false };
      Promise.resolve().then(() => (${expression})).then(
        (value) => { box[${JSON.stringify(id)}] = { done: true, value }; },
        (error) => { box[${JSON.stringify(id)}] = { done: true, error: String((error && error.message) || error) }; });
      return true;
    })()`);
    const answer = await poll(() => win.eval(`window.__reloadKillAsync[${JSON.stringify(id)}]`), (box) => box?.done, bound);
    if (!answer.met) throw new Error(`the page did not settle ${id} in ${bound} ms`);
    if (answer.value.error) throw new Error(answer.value.error);
    return answer.value.value;
  }

  // ---- X input
  const geometry = (xid) => {
    const geo = Object.fromEntries((xdo("getwindowgeometry", "--shell", xid).stdout || "").trim().split("\n").map((l) => l.split("=")));
    return { x: Number(geo.X), y: Number(geo.Y), w: Number(geo.WIDTH), h: Number(geo.HEIGHT) };
  };
  async function calibrate(win) {
    await win.eval(`(() => {
      if (!window.__reloadKillMoves) {
        window.__reloadKillMoves = true;
        window.addEventListener("mousemove", (e) => { window.__reloadKillMove = { x: e.clientX, y: e.clientY, trusted: e.isTrusted }; }, true);
      }
      return true;
    })()`);
    xdo("windowactivate", "--sync", win.xid);
    const geo = geometry(win.xid);
    const seen = [];
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.35]]) {
      const sx = Math.round(geo.x + geo.w * fx);
      const sy = Math.round(geo.y + geo.h * fy);
      await win.eval("window.__reloadKillMove = null; true");
      xdo("mousemove", sx - 7, sy - 7);
      await sleep(120);
      xdo("mousemove", sx, sy);
      const move = await poll(() => win.eval("window.__reloadKillMove"), (m) => m && m.trusted, 3000);
      await sleep(120);
      seen.push({ sx, sy, client: move.met ? await win.eval("window.__reloadKillMove") : null });
    }
    return { window: geo, seen, offset: offsetFrom(seen) };
  }
  async function clickAt(win, point) {
    xdo("windowactivate", "--sync", win.xid);
    xdo("mousemove", point.x + win.offset.dx, point.y + win.offset.dy);
    await sleep(150);
    return xdo("click", "1").status;
  }
  const windowCenter = (win) => win.eval("({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })");

  // ---- the terminal
  const terminalRow = (name) => {
    const out = cs(["terminal", "list", "--json"]);
    if (out.status !== 0) return null;
    try { return Object.values(JSON.parse(out.stdout).groups ?? {}).flat().find((row) => row.name === name) ?? null; } catch { return null; }
  };
  const scrollbackOf = (name) => {
    const out = cs(["terminal", "scrollback", "--tab-name", name]);
    return out.status === 0 ? out.stdout.replace(/\r/g, "") : "";
  };
  // Keys typed by X input into the terminal must reach a shell, which
  // answers with its own pid: only the shell computes 42 and $$. Up to three
  // tries, each with its own marker, for a terminal still reattaching.
  async function typedProbe(win, name, tag, expect) {
    const out = { tag, attempts: [] };
    const ready = await poll(async () => {
      const row = terminalRow(name);
      let dom = null;
      if (row?.tab) { try { dom = await win.terminal(row.tab); } catch { dom = null; } }
      return { row, dom };
    }, (v) => v.row?.window === win.id && v.dom?.canvas && v.dom.active && v.dom.center, 20000, 250);
    const row = ready.value.row;
    Object.assign(out, { ready: ready.met, readyWaitedMs: ready.waitedMs, sessionId: row?.session_id ?? null, tab: row?.tab ?? null,
      window: row?.window ?? null, windowStatus: row?.window_status ?? null, dom: ready.value.dom });
    if (expect) out.sameSession = out.sessionId === expect.sessionId;
    if (!ready.met) return out;
    for (let attempt = 1; attempt <= 3 && !out.typed; attempt++) {
      const mark = `${tag}${attempt}`;
      const dom = await win.terminal(row.tab);
      if (dom.center) await clickAt(win, dom.center);
      const focused = await poll(async () => (await win.terminal(row.tab).catch(() => null))?.focused, Boolean, 3000);
      const step = { mark, focused: focused.met };
      out.attempts.push(step);
      if (!focused.met) { await sleep(1000); continue; }
      step.typeStatus = xdo("type", "--delay", "12", `echo RK${mark}x$((40+2))-$$`).status;
      xdo("key", "Return");
      const pattern = new RegExp(`RK${mark}x42-(\\d+)`);
      const seen = await poll(async () => scrollbackOf(name), (text) => pattern.test(text), 5000, 250);
      Object.assign(step, { seen: seen.met, waitedMs: seen.waitedMs });
      if (seen.met) {
        out.typed = true;
        out.shellPid = Number(pattern.exec(seen.value)[1]);
      }
    }
    out.typed = Boolean(out.typed);
    out.focused = out.attempts.some((step) => step.focused);
    if (expect) out.samePid = out.shellPid === expect.shellPid;
    return out;
  }

  // ---- reloads
  const setMark = async (win, label) => {
    const mark = `${label}-${stamp}-${now()}`;
    await win.eval(`window.__reloadKillMark = ${JSON.stringify(mark)}; true`);
    return mark;
  };
  // The window has reloaded once its page no longer carries the mark set
  // before the Reload, and has settled once it shows its panes or the
  // missing-token cover. No reload within 15 s is read as none.
  async function awaitReload(win, mark, bound = 60000) {
    await win.close();
    const start = now();
    let last = null;
    let replaced = false;
    while (now() - start <= bound) {
      const state = await tryState(win);
      if (state) {
        last = state;
        if (state.mark !== mark) replaced = true;
        if (replaced && state.ready === "complete" && (state.workspace || state.missingToken)) {
          return { reloaded: true, settled: true, waitedMs: now() - start, state };
        }
        if (!replaced && now() - start > 15000) break;
      }
      await sleep(250);
    }
    return { reloaded: replaced, settled: false, waitedMs: now() - start, state: replaced ? last : null };
  }
  // A reloaded page, read as it landed and again once it has settled, then
  // its token and its terminal.
  async function landing(win, mark, name, expect, tag) {
    const back = await awaitReload(win, mark);
    const out = { reloaded: back.reloaded, settled: back.settled, reloadWaitedMs: back.waitedMs, state: back.state };
    if (!back.settled) return out;
    await sleep(1500);
    out.late = await tryState(win);
    try { out.shells = await settle(win, `(${shellsProbe})()`); } catch (error) { out.shells = { error: mask(String(error)) }; }
    if (name && out.late && !out.late.missingToken) out.attach = await typedProbe(win, name, tag, expect);
    out.final = await tryState(win);
    return out;
  }
  async function pressReloadKey(win) {
    let point = null;
    try { point = (await win.terminal(win.terminalTab))?.center ?? null; } catch { point = null; }
    point ??= await windowCenter(win);
    await win.close();
    await clickAt(win, point);
    return { clickedAt: point, keyStatus: xdo("key", "--clearmodifiers", "ctrl+shift+r").status };
  }
  const networkNow = () => {
    const rows = processTable();
    return networkCandidates({ rows, desktopPid, skip: new Set(ancestorChain(process.pid, rows)) }).map((c) => c.pid);
  };

  // ---- legs
  async function fixture(win, name) {
    const loaded = await poll(() => tryState(win), (s) => s && s.ready === "complete" && (s.workspace || s.missingToken), 60000, 250);
    if (!loaded.met) return { loaded: false, state: loaded.value };
    const out = { loaded: true, state: loaded.value };
    out.calibration = await calibrate(win);
    win.offset = out.calibration.offset;
    if (!win.offset) return out;
    const made = cs(["terminal", "new", "--tab-name", name], win.id);
    out.terminalNew = { status: made.status, output: mask(`${made.stdout}${made.stderr}`.trim().slice(0, 200)) };
    out.attach = await typedProbe(win, name, `f${win.label}`, null);
    win.terminalTab = out.attach.tab;
    out.after = await tryState(win);
    shot(`fixture-${win.label}`);
    return out;
  }

  async function killNetwork(win, n, name, expect) {
    const kill = { leg: "kill", n, window: win.label };
    const storage = { leg: "storage", n, window: win.label };
    kill.pre = await typedProbe(win, name, `p${n}`, expect);
    kill.preState = await tryState(win);
    if (!(kill.pre.typed && kill.pre.samePid && kill.preState?.tokenStored && kill.preState.workspace && !kill.preState.missingToken)) {
      kill.unavailable = "before the kill the window was not in its workspace with its token in session storage and its terminal on its shell";
      return { kill, storage };
    }
    const expected = realpathSync(args["desktop-bin"]);
    let running = null;
    try { running = readlinkSync(`/proc/${desktopPid}/exe`); } catch { running = null; }
    kill.desktop = { pid: desktopPid, exe: running };
    if (running !== expected) {
      kill.unavailable = `pid ${desktopPid} runs ${running}, not the built chan-desktop ${expected}`;
      return { kill, storage };
    }
    const before = processTable();
    const skip = new Set(ancestorChain(process.pid, before));
    kill.skipped = [...skip];
    const candidates = networkCandidates({ rows: before, desktopPid, skip });
    const holds = new Map(candidates.map((c) => [c.pid, holdsConnectionTo(c.pid, kill.preState.port)]));
    kill.candidates = candidates.map((c) => ({ ...c, holdsPagePort: holds.get(c.pid) }));
    const choice = pickNetworkProcess(candidates, holds);
    if (!choice.pick) {
      kill.unavailable = choice.reason;
      return { kill, storage };
    }
    kill.target = { ...choice.pick, by: choice.by };
    // Read again just before the signal, so a pid that changed hands is
    // never signalled.
    const again = processTable();
    if (again.get(choice.pick.pid)?.exe !== choice.pick.exe || !descendantsOf(desktopPid, again).includes(choice.pick.pid)) {
      kill.unavailable = `${choice.pick.pid} changed before the kill`;
      return { kill, storage };
    }
    const killedAt = now();
    try {
      process.kill(choice.pick.pid, "SIGKILL");
    } catch (error) {
      kill.unavailable = `SIGKILL to ${choice.pick.pid} failed: ${error.code}`;
      return { kill, storage };
    }
    const gone = await poll(async () => processGone(choice.pick.pid, choice.pick.exe), Boolean, 10000, 50);
    Object.assign(kill, { killed: gone.met, goneAfterMs: gone.waitedMs });
    log(`killed ${NETWORK_PROCESS} ${choice.pick.pid} (${choice.pick.exe}) of window ${win.label}`);
    shot(`kill-${n}`);
    const read = async () => {
      const state = await tryState(win);
      return state ? { tokenStored: state.tokenStored, storageError: state.storageError, workspace: state.workspace, missingToken: state.missingToken } : null;
    };
    storage.immediate = await read();
    const known = new Set(candidates.map((c) => c.pid));
    const relaunch = await poll(async () => {
      const rows = processTable();
      return networkCandidates({ rows, desktopPid, skip }).find((c) => !known.has(c.pid)) ?? null;
    }, Boolean, 30000, 250);
    kill.relaunch = relaunch.met ? { pid: relaunch.value.pid, exe: relaunch.value.exe, afterMs: now() - killedAt } : null;
    storage.beforeReload = await read();
    if (!storage.beforeReload) storage.readError = "the page did not answer the inspector after the kill";
    return { kill, storage };
  }

  // 1. Window A.
  const A = makeWindow("a", args.window, args.xid);
  const termA = `rk-a-${stamp}`;
  let fixtureA;
  try {
    fixtureA = await fixture(A, termA);
  } catch (error) {
    record({ leg: "fixture", window: "a", error: mask(String(error)) });
    log(`window A's page cannot be read: ${error}`);
    process.exit(3);
  }
  record({ leg: "fixture", window: "a", ...fixtureA });
  if (!fixtureHeld(fixtureA)) {
    log(`the fixture did not hold: ${fixtureProblem(fixtureA)}`);
    return;
  }
  const expectA = { sessionId: fixtureA.attach.sessionId, shellPid: fixtureA.attach.shellPid };
  const inWorkspace = async (win) => {
    const state = await tryState(win);
    return state && state.workspace && !state.missingToken;
  };

  // 2. The control.
  try {
    const mark = await setMark(A, "control");
    const pressed = await pressReloadKey(A);
    record({ leg: "control", ...pressed, ...(await landing(A, mark, termA, expectA, "c")) });
  } catch (error) {
    record({ leg: "control", error: mask(String(error)) });
  }
  shot("control");

  // 7. Search open, then a Reload by the key.
  try {
    const query = `rk${stamp}`;
    const row = { leg: "fragment", query };
    if (!(await inWorkspace(A))) {
      row.skipped = "window A was not in its workspace before the leg";
    } else {
      xdo("windowactivate", "--sync", A.xid);
      await A.eval(`window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.search.toggle" } })); true`);
      const input = `document.querySelector('[role="dialog"][aria-label="Search"] input')`;
      const focused = await poll(() => A.eval(`(() => { const i = ${input}; return Boolean(i) && document.activeElement === i; })()`), Boolean, 5000);
      row.setup = { opened: focused.met };
      if (focused.met) {
        row.setup.typeStatus = xdo("type", "--delay", "12", query).status;
        const inHash = await poll(() => tryState(A), (s) => s?.search.query === query && Boolean(s.searchParam?.endsWith(`:${query}`)), 5000);
        row.setup.queryInHash = inHash.met;
        row.before = inHash.value;
        shot("fragment-before");
        if (inHash.met) {
          const mark = await setMark(A, "fragment");
          await A.close();
          row.keyStatus = xdo("key", "--clearmodifiers", "ctrl+shift+r").status;
          Object.assign(row, await landing(A, mark, null, null, null));
          shot("fragment-after");
        }
      }
      // Search closes again, so the legs after this one start without it.
      const open = await tryState(A);
      if (open?.search.open) {
        await A.eval(`window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.search.toggle" } })); true`);
        row.closed = (await poll(() => tryState(A), (s) => s && !s.search.open, 5000)).met;
      }
    }
    record(row);
  } catch (error) {
    record({ leg: "fragment", error: mask(String(error)) });
  }

  // 7. A tab opened, then a Reload by the key within a second.
  try {
    const rel = `notes/quick-${stamp}.md`;
    writeFileSync(join(args.ws, rel), "# Quick\n");
    const row = { leg: "quick-tab", file: rel };
    if (!(await inWorkspace(A))) {
      row.skipped = "window A was not in its workspace before the leg";
    } else {
      const dom = await A.terminal(A.terminalTab).catch(() => null);
      await clickAt(A, dom?.center ?? await windowCenter(A));
      const mark = await setMark(A, "quick");
      const opened = cs(["open", rel], A.id);
      const openedAt = now();
      row.openStatus = opened.status;
      const shown = await poll(() => A.eval(`(${fileTab})(${JSON.stringify(rel)}).open`).catch(() => false), Boolean, 5000, 40);
      const shownAt = now();
      row.shown = shown.met;
      if (shown.met) {
        await sleep(200);
        row.keyStatus = xdo("key", "--clearmodifiers", "ctrl+shift+r").status;
        const pressedAt = now();
        row.timing = { openToShownMs: shownAt - openedAt, shownToPressMs: pressedAt - shownAt };
        Object.assign(row, await landing(A, mark, null, null, null));
        row.tabKept = Boolean((await A.eval(`(${fileTab})(${JSON.stringify(rel)})`).catch(() => null))?.open);
        shot("quick-after");
      }
      // The file tab closes again, so the terminal is the active tab.
      const tab = await A.eval(`(${fileTab})(${JSON.stringify(rel)})`).catch(() => null);
      if (tab?.open && tab.active) {
        await A.eval(`window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } })); true`);
        row.closed = (await poll(() => A.eval(`(${fileTab})(${JSON.stringify(rel)}).open`).catch(() => true), (open) => !open, 5000)).met;
      }
    }
    record(row);
  } catch (error) {
    record({ leg: "quick-tab", error: mask(String(error)) });
  }

  // 3, 4 and 5: the kill on window A, then a Reload by the key.
  let killedA = false;
  try {
    const { kill, storage } = await killNetwork(A, 1, termA, expectA);
    record(kill);
    record(storage);
    killedA = Boolean(kill.killed);
  } catch (error) {
    record({ leg: "kill", n: 1, window: "a", error: mask(String(error)) });
  }
  if (killedA) {
    try {
      const mark = await setMark(A, "key");
      const pressed = await pressReloadKey(A);
      const landed = await landing(A, mark, termA, expectA, "k");
      record({ leg: "reload-key", ...pressed, ...landed, networkAfter: networkNow() });
    } catch (error) {
      record({ leg: "reload-key", error: mask(String(error)) });
    }
    shot("reload-key");
  }
  await A.close();

  // 6. Window B, opened now, so window A's state after its Reload cannot
  // decide this leg.
  let B = null;
  try {
    const fragment = ` local / ${basename(args.ws)} Window`;
    const xWindows = () => (xdo("search", "--onlyvisible", "--name", fragment).stdout || "").split("\n").filter(Boolean);
    const before = new Set(xWindows());
    const made = cs(["window", "new"]);
    const id = made.stdout.trim();
    const row = { leg: "fixture", window: "b", windowNew: { status: made.status, id } };
    if (made.status !== 0 || !id) {
      row.error = `cs window new failed: ${mask(`${made.stdout}${made.stderr}`.trim().slice(0, 200))}`;
    } else {
      const takes = await poll(async () => cs(["pane", "list", "--window", id, "--json"]).status === 0, Boolean, 30000, 250);
      const xid = await poll(async () => xWindows().find((x) => !before.has(x)) ?? null, Boolean, 60000, 250);
      if (!takes.met) row.error = `the window id ${id} that cs window new printed never addressed a window`;
      else if (!xid.met) row.error = "no new native window of the workspace appeared in 60 s";
      else {
        B = makeWindow("b", id, xid.value);
        Object.assign(row, await fixture(B, `rk-b-${stamp}`));
      }
    }
    record(row);
    if (fixtureHeld(row)) {
      B.expect = { sessionId: row.attach.sessionId, shellPid: row.attach.shellPid };
    } else {
      await B?.close();
      B = null;
    }
  } catch (error) {
    record({ leg: "fixture", window: "b", error: mask(String(error)) });
    await B?.close();
    B = null;
  }
  if (B) {
    const termB = `rk-b-${stamp}`;
    let killedB = false;
    try {
      const { kill, storage } = await killNetwork(B, 2, termB, B.expect);
      record(kill);
      record(storage);
      killedB = Boolean(kill.killed);
    } catch (error) {
      record({ leg: "kill", n: 2, window: "b", error: mask(String(error)) });
    }
    if (killedB) {
      try {
        const mark = await setMark(B, "page");
        const dispatched = await B.eval(`window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.window.reload" } }))`);
        await B.close();
        const landed = await landing(B, mark, termB, B.expect, "r");
        record({ leg: "reload-page", dispatched, ...landed, networkAfter: networkNow() });
      } catch (error) {
        record({ leg: "reload-page", error: mask(String(error)) });
      }
      shot("reload-page");
    }
    await B.close();
  }
}

async function main() {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      inspector: { type: "string" }, "desktop-pid": { type: "string" }, "desktop-bin": { type: "string" },
      chan: { type: "string" }, ws: { type: "string" }, window: { type: "string" }, xid: { type: "string" },
      output: { type: "string" }, results: { type: "string" }, webkit: { type: "string" },
    },
  });
  if (positionals[0] === "run") {
    await run(args);
    process.exit(0);
  }
  if (positionals[0] === "verdict") verdict(args);
  console.error("usage: reload-after-network-kill.mjs run|verdict [options]");
  process.exit(3);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
