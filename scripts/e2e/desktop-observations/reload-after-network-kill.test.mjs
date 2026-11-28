import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  ancestorChain, connectionInodes, descendantsOf, fileTab, fixtureHeld, isNetworkProcessPath, judge, mask,
  networkCandidates, offsetFrom, pageState, parseStatus, parseTcpTable, pickNetworkProcess, shellsProbe, terminalDom,
} from "./reload-after-network-kill.mjs";

// Offline checks of reload-after-network-kill.mjs: its /proc and page
// readers on hand-written inputs, its page expressions under stubbed
// globals, and its verdict on hand-written records, with planted failures
// the verdict must report. No desktop, no page, no process is touched.
const driver = fileURLToPath(new URL("./reload-after-network-kill.mjs", import.meta.url));
const ENGINE = "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1";

test("a /proc status gives the parent and the state", () => {
  const text = "Name:\tWebKitNetworkPr\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t102\nPid:\t102\nPPid:\t98\nTracerPid:\t0\n";
  assert.deepEqual(parseStatus(text), { state: "S", ppid: 98 });
  assert.equal(parseStatus(text.replace("S (sleeping)", "Z (zombie)")).state, "Z");
  assert.deepEqual(parseStatus("Name:\tx\n"), { state: null, ppid: null });
});

// The desktop 98 runs beside this driver (60) under one shell (50); its
// engine children sit directly under it or under a sandbox wrapper.
const rows = new Map([
  [1, { ppid: 0, exe: "/usr/lib/systemd/systemd" }],
  [50, { ppid: 1, exe: "/usr/bin/bash" }],
  [60, { ppid: 50, exe: "/usr/bin/node" }],
  [98, { ppid: 50, exe: "/work/chan/target/debug/chan-desktop" }],
  [100, { ppid: 98, exe: `${ENGINE}/WebKitWebProcess` }],
  [102, { ppid: 98, exe: `${ENGINE}/WebKitNetworkProcess` }],
  // Another app's network process: the same executable, outside the tree.
  [103, { ppid: 1, exe: `${ENGINE}/WebKitNetworkProcess` }],
  // The right name at another path, and the other engine's process.
  [104, { ppid: 98, exe: "/tmp/WebKitNetworkProcess" }],
  [105, { ppid: 98, exe: "/usr/lib/x86_64-linux-gnu/webkitgtk-6.0/WebKitNetworkProcess" }],
  // A replaced binary.
  [108, { ppid: 98, exe: `${ENGINE}/WebKitNetworkProcess (deleted)` }],
  [106, { ppid: 98, exe: "/usr/bin/bwrap" }],
  [107, { ppid: 106, exe: `${ENGINE}/WebKitNetworkProcess` }],
]);

test("the ancestor chain and the descendants follow the parent links", () => {
  assert.deepEqual(ancestorChain(60, rows), [60, 50, 1]);
  assert.deepEqual(descendantsOf(98, rows).sort((a, b) => a - b), [100, 102, 104, 105, 106, 107, 108]);
  // A loop in a table read while processes come and go must still end.
  const looped = new Map([[5, { ppid: 6 }], [6, { ppid: 5 }]]);
  assert.deepEqual(ancestorChain(5, looped), [5, 6]);
  assert.deepEqual(descendantsOf(5, looped), [6]);
});

test("the network process is the desktop's descendant whose executable is the engine's", () => {
  assert.ok(isNetworkProcessPath(`${ENGINE}/WebKitNetworkProcess`));
  assert.ok(!isNetworkProcessPath("/tmp/WebKitNetworkProcess"));
  assert.ok(!isNetworkProcessPath("WebKitNetworkProcess"));
  assert.ok(!isNetworkProcessPath(null));
  const skip = new Set(ancestorChain(60, rows));
  const found = networkCandidates({ rows, desktopPid: 98, skip }).map((c) => c.pid).sort((a, b) => a - b);
  // A match by name across the host would take 103, another app's.
  assert.deepEqual(found, [102, 107]);
  // A pid in the driver's own ancestor chain is never a candidate.
  assert.deepEqual(networkCandidates({ rows, desktopPid: 98, skip: new Set([102, 107]) }), []);
});

test("with more than one network process, the one holding the page's port is chosen, or none", () => {
  const two = [{ pid: 102 }, { pid: 107 }];
  assert.deepEqual(pickNetworkProcess([{ pid: 102 }], new Map()), { pick: { pid: 102 }, by: "only" });
  assert.deepEqual(pickNetworkProcess(two, new Map([[102, false], [107, true]])), { pick: { pid: 107 }, by: "connection" });
  assert.equal(pickNetworkProcess(two, new Map([[102, true], [107, true]])).pick, null);
  assert.equal(pickNetworkProcess(two, new Map()).pick, null);
  assert.match(pickNetworkProcess([], new Map()).reason, /no WebKitNetworkProcess/);
});

test("the TCP table names the established connections to a port by inode", () => {
  const head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const line = (n, local, remote, st, inode) => `   ${n}: ${local} ${remote} ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 4 30 10 -1\n`;
  const table = head
    + line(0, "0100007F:0FA0", "00000000:0000", "0A", "11111") // the server listening on 4000
    + line(1, "0100007F:D431", "0100007F:0FA0", "01", "22222") // a client connected to it
    + line(2, "0100007F:0FA0", "0100007F:D431", "01", "33333") // the server's end of that
    + line(3, "0100007F:D432", "0100007F:0FA0", "06", "44444"); // a closed one in TIME_WAIT
  const parsed = parseTcpTable(table);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[1], { localPort: 0xd431, remotePort: 4000, state: "01", inode: "22222" });
  assert.deepEqual([...connectionInodes(parsed, 4000)], ["22222"]);
  const six = head + line(0, "0000000000000000FFFF00000100007F:D433", "0000000000000000FFFF00000100007F:0FA0", "01", "55555");
  assert.deepEqual([...connectionInodes(parseTcpTable(six), 4000)], ["55555"]);
});

test("the masker hides a token, a holder and a fragment's state", () => {
  assert.equal(mask("GET /w/index.html?t=abc&w=1&h=hold#s=%7B%7D"), "GET /w/index.html?t=<token>&w=1&h=<holder>#s=<state>");
  assert.equal(mask('{"token": "abc"}'), '{"token": "<token>"}');
});

test("the calibration agrees only when both points give one offset", () => {
  assert.deepEqual(offsetFrom([{ sx: 110, sy: 220, client: { x: 100, y: 200 } }, { sx: 60, sy: 90, client: { x: 50, y: 70 } }]), { dx: 10, dy: 20 });
  assert.equal(offsetFrom([{ sx: 110, sy: 220, client: { x: 100, y: 200 } }, { sx: 60, sy: 90, client: { x: 50, y: 71 } }]), null);
  assert.equal(offsetFrom([{ sx: 110, sy: 220, client: null }, { sx: 60, sy: 90, client: { x: 50, y: 70 } }]), null);
});

// ---------------------------------------------------- page expressions

// Runs a page expression by its source text, as the inspector does, in a
// context holding only the globals given.
function inPage(fn, globals, ...params) {
  const context = vm.createContext({ URL, URLSearchParams, ...globals });
  return vm.runInContext(`(${fn})(...${JSON.stringify(params)})`, context);
}
const storage = (value) => ({ getItem: (key) => (key === "chan.token" ? value : null) });
const selectors = (map) => ({ readyState: "complete", querySelector: (q) => map[q] ?? null, querySelectorAll: () => [] });

test("the page state reads the load's type, the token's presence and the fragment, and holds no token", () => {
  const search = { querySelector: () => ({ value: "rkq" }) };
  const globals = {
    window: { sessionStorage: storage("secret-token"), __reloadKillMark: "m1" },
    location: { href: "http://127.0.0.1:4000/ws/index.html?w=W1&h=H#s=%7B%22a%22%3A1%7D&search=0%3Arkq", hash: "#s=%7B%22a%22%3A1%7D&search=0%3Arkq", port: "4000" },
    document: selectors({ ".pane[data-pane-id]": {}, '[role="dialog"][aria-label="Search"]': search }),
    performance: { getEntriesByType: () => [{ type: "navigate", name: "http://127.0.0.1:4000/ws/index.html?t=secret-token&w=W1" }], navigation: { type: 0 } },
  };
  const state = inPage(pageState, globals);
  assert.equal(state.navType, "navigate");
  assert.equal(state.legacyNavType, 0);
  assert.equal(state.entryHadToken, true);
  assert.equal(state.tokenStored, true);
  assert.equal(state.urlHasToken, false);
  assert.equal(state.workspace, true);
  assert.equal(state.missingToken, false);
  assert.equal(state.mark, "m1");
  assert.deepEqual([...state.hashKeys], ["s", "search"]);
  assert.equal(state.searchParam, "0:rkq");
  assert.deepEqual({ ...state.search }, { open: true, query: "rkq" });
  assert.match(state.layout, /^7:[0-9a-f]+$/);
  assert.equal(state.port, 4000);
  assert.ok(!JSON.stringify(state).includes("secret-token"), "the state carries no token");
  assert.ok(!JSON.stringify(state).includes("%7B"), "the state carries no fragment");

  // The missing-token page, a token left in the URL, storage that throws.
  const lost = inPage(pageState, {
    ...globals,
    window: { sessionStorage: { getItem: () => { const e = new Error("denied"); e.name = "SecurityError"; throw e; } } },
    location: { href: "http://127.0.0.1:4000/ws/index.html?t=x", hash: "", port: "4000" },
    document: selectors({ '[data-cover="missing-token"]': {} }),
    performance: { getEntriesByType: () => [{ type: "reload", name: "http://127.0.0.1:4000/ws/index.html" }] },
  });
  assert.equal(lost.tokenStored, false);
  assert.equal(lost.storageError, "SecurityError");
  assert.equal(lost.missingToken, true);
  assert.equal(lost.workspace, false);
  assert.equal(lost.urlHasToken, true);
  assert.equal(lost.navType, "reload");
  assert.equal(lost.entryHadToken, false);
  assert.equal(lost.mark, null);
  assert.equal(lost.layout, null);
  // An empty stored value is no token.
  assert.equal(inPage(pageState, { ...globals, window: { sessionStorage: storage("") } }).tokenStored, false);
});

test("the terminal reading finds its tab by id and says whether its host holds the keyboard", () => {
  const box = (w, h) => ({ left: 10, top: 20, width: w, height: h });
  const host = { getBoundingClientRect: () => box(200, 100) };
  const canvas = { getBoundingClientRect: () => box(200, 100) };
  const tab = (id, active) => ({
    getAttribute: () => id,
    classList: { contains: (name) => name === "active" && active },
    querySelector: (q) => (q === ".terminal-host" ? host : q === ".terminal-host > canvas" ? canvas : null),
  });
  const focusedIn = (el) => ({ closest: (q) => (q === ".terminal-host" ? el : null) });
  const document = { querySelectorAll: () => [tab("t-other", false), tab("t-1", true)], activeElement: focusedIn(host) };
  assert.deepEqual({ ...inPage(terminalDom, { document }, "t-1", ".terminal-host > canvas"), center: null },
    { tab: true, active: true, canvas: true, center: null, focused: true });
  assert.deepEqual({ ...inPage(terminalDom, { document }, "t-1", ".terminal-host > canvas").center }, { x: 110, y: 70 });
  assert.equal(inPage(terminalDom, { document: { ...document, activeElement: focusedIn({}) } }, "t-1", ".terminal-host > canvas").focused, false);
  assert.equal(inPage(terminalDom, { document: { ...document, activeElement: null } }, "t-1", ".terminal-host > canvas").focused, false);
  const missing = inPage(terminalDom, { document }, "t-gone", ".terminal-host > canvas");
  assert.equal(missing.tab, false);
  assert.equal(missing.canvas, false);
});

test("the file tab reading finds the tab by its path", () => {
  const selected = { getAttribute: () => "notes/q.md", querySelector: () => ({}) };
  const other = { getAttribute: () => "notes/other.md", querySelector: () => null };
  const document = { querySelectorAll: () => [other, selected] };
  assert.deepEqual({ ...inPage(fileTab, { document }, "notes/q.md") }, { open: true, active: true });
  assert.deepEqual({ ...inPage(fileTab, { document }, "notes/none.md") }, { open: false, active: false });
});

test("the shells probe asks under the page's prefix with the token in session storage", async () => {
  const sent = [];
  const fetch = async (url, init) => { sent.push({ url, init }); return { status: 200 }; };
  const meta = { getAttribute: () => "/ws-1/" };
  const answer = await inPage(shellsProbe, { fetch, window: { sessionStorage: storage("tok") }, document: selectors({ 'meta[name="chan-prefix"]': meta }) });
  assert.deepEqual({ ...answer }, { status: 200, sentToken: true });
  assert.equal(sent[0].url, "/ws-1/api/terminal/shells");
  assert.equal(sent[0].init.headers.authorization, "Bearer tok");
  const bare = await inPage(shellsProbe, { fetch: async () => ({ status: 401 }), window: { sessionStorage: storage(null) }, document: selectors({}) });
  assert.deepEqual({ ...bare }, { status: 401, sentToken: false });
});

// ------------------------------------------------------------- verdict

const ok = (over = {}) => ({ ready: "complete", mark: null, workspace: true, missingToken: false, urlHasToken: false, navType: "reload",
  legacyNavType: 1, entryHadToken: false, tokenStored: true, storageError: null, hashKeys: ["s"], layout: "9:1a2b",
  searchParam: null, search: { open: false, query: null }, port: 4000, ...over });
const attached = (session, pid, over = {}) => ({ ready: true, sessionId: session, tab: `t-${session}`, typed: true, shellPid: pid,
  focused: true, attempts: [{ mark: "x1", focused: true, seen: true }], sameSession: true, samePid: true, ...over });
const fixture = (window, session, pid) => ({ leg: "fixture", window, loaded: true, state: ok({ navType: "navigate", entryHadToken: true }),
  calibration: { offset: { dx: 0, dy: 0 } }, attach: attached(session, pid, { sameSession: undefined, samePid: undefined }) });
const landed = (navType, session, pid, over = {}) => ({ reloaded: true, settled: true, state: ok({ navType }), late: ok({ navType }),
  shells: { status: 200, sentToken: true }, attach: attached(session, pid), ...over });
const onMissingToken = (navType) => ({ reloaded: true, settled: true, state: ok({ navType, missingToken: true, tokenStored: false }),
  late: ok({ navType, missingToken: true, tokenStored: false }), shells: { status: 401, sentToken: false } });
const kill = (n) => ({ leg: "kill", n, window: n === 1 ? "a" : "b", target: { pid: 200 + n, ppid: 98, exe: `${ENGINE}/WebKitNetworkProcess`, by: "only" },
  killed: true, goneAfterMs: 12, relaunch: { pid: 300 + n, exe: `${ENGINE}/WebKitNetworkProcess`, afterMs: 800 } });
const stored = (n, kept) => ({ leg: "storage", n, window: n === 1 ? "a" : "b", immediate: { tokenStored: kept },
  beforeReload: { tokenStored: kept, storageError: null, workspace: true, missingToken: false } });
const fragment = (navType, over = {}) => ({ leg: "fragment", query: "rkq", setup: { opened: true, queryInHash: true },
  before: ok({ searchParam: "0:rkq", search: { open: true, query: "rkq" } }), reloaded: true, settled: true, state: ok({ navType }),
  late: navType === "reload" ? ok({ navType, searchParam: "0:rkq", search: { open: true, query: "rkq" } }) : ok({ navType }), ...over });
const quick = (navType, over = {}) => ({ leg: "quick-tab", file: "notes/quick.md", openStatus: 0, shown: true,
  timing: { openToShownMs: 300, shownToPressMs: 210 }, reloaded: true, settled: true, state: ok({ navType }), late: ok({ navType }), tabKept: true, ...over });

// One run's records, in the order the driver writes them. `kept` is what
// the engine did with session storage; `fixed` whether the tree navigates a
// page that lost its token; `navigatesAll` whether every local Reload
// navigates.
function runOf({ kept = false, fixed = true, navigatesAll = false } = {}) {
  const inPageNav = navigatesAll ? "navigate" : "reload";
  const afterKill = (session, pid) => kept ? landed(inPageNav, session, pid) : fixed || navigatesAll ? landed("navigate", session, pid) : onMissingToken("reload");
  return [
    { leg: "run", webkit: "2.50.1", desktopPid: 98, stamp: "x" },
    fixture("a", "sa", 111),
    { leg: "control", clickedAt: { x: 1, y: 1 }, keyStatus: 0, ...landed(inPageNav, "sa", 111) },
    fragment(inPageNav),
    quick(inPageNav),
    kill(1), stored(1, kept),
    { leg: "reload-key", keyStatus: 0, ...afterKill("sa", 111) },
    fixture("b", "sb", 222),
    kill(2), stored(2, kept),
    { leg: "reload-page", dispatched: true, ...afterKill("sb", 222) },
  ];
}
const line = (lines, leg) => lines.find((text) => text.startsWith(`leg ${leg}:`));

test("a tip on an engine that loses session storage: every leg holds and the result says the fix shows", () => {
  const { lines, states, status } = judge(runOf());
  assert.equal(status, 0, lines.join("\n"));
  assert.equal(Object.keys(states).length, 11, "one state per leg, none merged");
  assert.ok(Object.values(states).every((state) => state === "held"));
  assert.match(line(lines, "4 storage"), /lost/);
  assert.match(line(lines, "5 reload by the key"), /^leg 5 reload by the key: HELD: navigated/);
  assert.match(line(lines, "3 kill"), /killed 201 .*WebKitNetworkProcess, the desktop's only one\) by pid.*WebKit started 301/);
  assert.match(lines.at(-1), /^result: 11 held, 0 failed, 0 unavailable; .*lost session storage.*legs 5 and 6 show the fix; WebKitGTK 2\.50\.1$/);
});

test("planted: the base on an engine that loses session storage fails legs 5 and 6 on the missing-token page", () => {
  const { lines, states, status } = judge(runOf({ fixed: false }));
  assert.equal(status, 10, lines.join("\n"));
  assert.equal(states.key, "failed");
  assert.equal(states.page, "failed");
  assert.match(line(lines, "5 reload by the key"), /FAILED: reloaded in page: it landed on the missing-token page/);
  assert.match(lines.at(-1), /2 failed.*a reload did not land: the fault the row names/);
});

test("an engine that keeps session storage: legs 5 and 6 hold at the base too, and the result says so", () => {
  for (const fixed of [true, false]) {
    const { lines, status } = judge(runOf({ kept: true, fixed }));
    assert.equal(status, 0, lines.join("\n"));
    assert.match(line(lines, "4 storage"), /still reads its token.*kept/);
    assert.match(line(lines, "5 reload by the key"), /HELD: reloaded in page/);
    assert.match(lines.at(-1), /kept session storage across the kill: legs 5 and 6 hold at the base as well, so this run does not show the fix/);
  }
});

test("planted: storage read kept, yet the reload lands on the missing-token page", () => {
  const records = runOf({ kept: true });
  records[7] = { leg: "reload-key", keyStatus: 0, ...onMissingToken("reload") };
  const { lines, status } = judge(records);
  assert.equal(status, 10);
  assert.match(lines.at(-1), /still read its token after the kill, yet a reload did not land/);
});

test("planted: a tree that navigates every local Reload fails both contract-2 legs", () => {
  const { lines, states, status } = judge(runOf({ navigatesAll: true }));
  assert.equal(status, 10, lines.join("\n"));
  assert.equal(states.control, "held");
  assert.equal(states.fragment, "failed");
  assert.equal(states.quick, "failed");
  assert.match(line(lines, "7 Search open"), /it navigated \(a fresh load\), not an in-page reload/);
  assert.match(line(lines, "7 new tab"), /210 ms after the tab showed: it navigated.*not an in-page reload/);
});

test("planted: Search back closed after an in-page reload fails its leg", () => {
  const records = runOf();
  records[3] = fragment("reload", { late: ok({ navType: "reload" }) });
  const { lines, states } = judge(records);
  assert.equal(states.fragment, "failed");
  assert.match(line(lines, "7 Search open"), /Search came back closed, not open on "rkq"/);
});

test("planted: a terminal that reaches another shell, or no session, fails the reload", () => {
  const records = runOf();
  records[7] = { leg: "reload-key", keyStatus: 0, ...landed("navigate", "sa", 111, { attach: attached("sa", 999, { samePid: false }) }) };
  records[11] = { leg: "reload-page", dispatched: true, ...landed("navigate", "sx", 222, { attach: attached("sx", 222, { sameSession: false }) }) };
  const { lines, states } = judge(records);
  assert.equal(states.key, "failed");
  assert.match(line(lines, "5 reload by the key"), /reached shell 999, not the one it had/);
  assert.equal(states.page, "failed");
  assert.match(line(lines, "6 reload by the page"), /on session sx, not the one it had/);
  const shells = runOf();
  shells[7] = { leg: "reload-key", ...landed("navigate", "sa", 111, { shells: { status: 401, sentToken: true } }) };
  assert.match(line(judge(shells).lines, "5 reload by the key"), /FAILED: .*the shells request answered 401/);
});

test("no reload after the kill fails the leg; no reload in the control leaves the rest unavailable", () => {
  const records = runOf();
  records[7] = { leg: "reload-key", keyStatus: 0, reloaded: false, settled: false, state: null };
  assert.match(line(judge(records).lines, "5 reload by the key"), /FAILED: the window did not reload by Ctrl\+Shift\+R after the kill/);
  const control = runOf();
  control[2] = { leg: "control", keyStatus: 0, reloaded: false, settled: false, state: null };
  const { lines, states, status } = judge(control);
  assert.equal(status, 3, lines.join("\n"));
  assert.equal(states.control, "unavailable");
  assert.equal(states.fragment, "unavailable");
  assert.equal(states.key, "unavailable");
  assert.match(line(lines, "5 reload by the key"), /the control did not hold/);
});

test("what the instrument cannot read is unavailable, never held or failed", () => {
  // No fixture: every leg unavailable.
  const none = judge([{ leg: "run", webkit: "2.50.1" }]);
  assert.equal(none.status, 3);
  assert.ok(Object.values(none.states).every((state) => state === "unavailable"));
  assert.equal(Object.keys(none.states).length, 11);
  // A first load that does not read as a navigation cannot tell the two.
  const blind = runOf();
  blind[1] = { ...fixture("a", "sa", 111), state: ok({ navType: "reload" }) };
  const read = judge(blind);
  assert.equal(read.states.fragment, "unavailable");
  assert.match(line(read.lines, "7 new tab"), /cannot be told from an in-page reload/);
  // A chord pressed more than a second after the tab showed.
  const late = runOf();
  late[4] = quick("reload", { timing: { openToShownMs: 300, shownToPressMs: 1500 } });
  assert.match(line(judge(late).lines, "7 new tab"), /UNAVAILABLE: the chord went 1500 ms after the tab showed/);
  // Two network processes and none holding the page: nothing killed.
  const twoNet = runOf();
  twoNet[5] = { leg: "kill", n: 1, window: "a", unavailable: "2 network processes, 0 of them holding a connection to the page's port" };
  const unkilled = judge(twoNet);
  assert.equal(unkilled.states.killA, "unavailable");
  assert.equal(unkilled.states.storageA, "unavailable");
  assert.equal(unkilled.states.key, "unavailable");
  assert.equal(unkilled.status, 3);
  // A click that never gave the terminal the keyboard.
  const unfocused = runOf();
  unfocused[7] = { leg: "reload-key", ...landed("navigate", "sa", 111, { attach: attached("sa", 111, { typed: false, focused: false, shellPid: undefined, samePid: false }) }) };
  assert.match(line(judge(unfocused).lines, "5 reload by the key"), /UNAVAILABLE: a click did not give its terminal the keyboard/);
  // A page that settled and then stopped answering.
  const silent = runOf();
  silent[11] = { leg: "reload-page", dispatched: true, ...landed("navigate", "sb", 222, { late: null, shells: { error: "x" }, attach: undefined }) };
  assert.match(line(judge(silent).lines, "6 reload by the page"), /UNAVAILABLE: the reloaded page stopped answering the inspector/);
  // Window B never opened.
  const noB = runOf();
  noB[8] = { leg: "fixture", window: "b", error: "cs window new failed: refused" };
  const b = judge(noB);
  assert.equal(b.states.fixtureB, "unavailable");
  assert.equal(b.states.killB, "unavailable");
  assert.equal(b.states.page, "unavailable");
});

test("the fixture holds only with its token stored, none in its URL and a shell answering its terminal", () => {
  assert.ok(fixtureHeld(fixture("a", "sa", 111)));
  assert.ok(!fixtureHeld({ ...fixture("a", "sa", 111), state: ok({ urlHasToken: true }) }));
  assert.ok(!fixtureHeld({ ...fixture("a", "sa", 111), state: ok({ tokenStored: false }) }));
  assert.ok(!fixtureHeld({ ...fixture("a", "sa", 111), calibration: { offset: null } }));
  assert.ok(!fixtureHeld({ ...fixture("a", "sa", 111), attach: attached("sa", undefined, { typed: false }) }));
});

test("the verdict command exits 0, 10 and 3 by the records", () => {
  const dir = mkdtempSync(join(tmpdir(), "reload-kill-verdict-"));
  try {
    const verdictOf = (records) => {
      const file = join(dir, `r${Math.random().toString(36).slice(2)}.jsonl`);
      writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      return spawnSync(process.execPath, [driver, "verdict", "--results", file, "--webkit", "2.50.1"], { encoding: "utf8" });
    };
    const held = verdictOf(runOf());
    assert.equal(held.status, 0, held.stdout + held.stderr);
    assert.equal(held.stdout.trim().split("\n").length, 12);
    const failed = verdictOf(runOf({ fixed: false }));
    assert.equal(failed.status, 10, failed.stdout);
    assert.match(failed.stdout, /FAILED: reloaded in page: it landed on the missing-token page/);
    assert.equal(verdictOf([{ leg: "run" }]).status, 3);
    const unreadable = spawnSync(process.execPath, [driver, "verdict", "--results", join(dir, "absent.jsonl")], { encoding: "utf8" });
    assert.equal(unreadable.status, 3);
    assert.equal(spawnSync(process.execPath, [driver], { encoding: "utf8" }).status, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
