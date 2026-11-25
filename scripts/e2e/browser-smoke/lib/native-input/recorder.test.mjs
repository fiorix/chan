import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

test("native input recorder controls without a browser or server", async (t) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const kitRoot = here;
  let problems = 0;
  const fail = (msg) => { problems++; console.error(`DRY-RUN FAIL: ${msg}`); };
  const note = (msg) => console.log(`host-control: ${msg}`);
  const ok = (msg) => console.log(`host-control ok: ${msg}`);

  const WT = join(here, "../../../../..");
  const wtFile = (...segs) => join(WT, ...segs);
  const paths = {
    "chrome": "../../checks/343-native-input-record.mjs",
    "webkit": "../../../desktop-observations/native-input-record.mjs",
    "shell": "../../../desktop-observations/native-input-record.sh",
  };
  const kitFile = (file) => join(kitRoot, paths[file] ?? file);
  const scratch = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  for (const f of ["cases.mjs", "page.mjs", "schema.mjs", "boot-wait.mjs",
    "chrome", "webkit", "recorder.test.mjs"]) {
    const p = kitFile(f);
    if (!existsSync(p)) { fail(`missing ${f}`); continue; }
    try {
      execFileSync(process.argv[0], ["--check", p], { encoding: "utf8", timeout: 30_000 });
    } catch (err) {
      fail(`${f} does not parse: ${String(err.message).slice(0, 200)}`);
    }
  }
  try {
    execFileSync("bash", ["-n", kitFile("shell")], { encoding: "utf8", timeout: 30_000 });
  } catch (err) {
    fail(`native-input-record.sh does not parse: ${String(err.message).slice(0, 200)}`);
  }
  if (problems === 0) {
    ok("all kit files parse");
  } else {
    console.error(`host-control: ${problems} problem(s) found; no ports, servers or browsers touched`);
    assert.fail("recorder sources do not parse");
  }

  const { CASES } = await import("./cases.mjs");
  const page = await import("./page.mjs");
  const schema = await import("./schema.mjs");
  const boot = await import("./boot-wait.mjs");
  const chromeSrc = readFileSync(kitFile("chrome"), "utf8");
  const webkitSrc = readFileSync(kitFile("webkit"), "utf8");
  const bootSrc = readFileSync(kitFile("boot-wait.mjs"), "utf8");
  const shellSrc = readFileSync(kitFile("shell"), "utf8");
  const caseById = (id) => CASES.find((c) => c.id === id);

  const SRCS = ["INSTALL_SRC", "WRAP_OPEN_SRC", "FIND_TERM_SRC", "RESET_SRC", "READ_SRC"];
  for (const name of SRCS) {
    if (typeof page[name] !== "string" || !page[name]) { fail(`page.mjs missing ${name}`); continue; }
    try {
      new vm.Script(page[name], { filename: `${name}.js` });
    } catch (err) {
      fail(`${name} does not compile: ${String(err.message).slice(0, 200)}`);
    }
  }
  if (problems === 0) ok("in-page sources compile");

  function makeStubPage() {
    const listeners = { cap: new Map(), bub: new Map() };
    const on = (map, t, fn) => {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(fn);
    };
    const off = (map, t, fn) => {
      const arr = map.get(t) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
    const windowObj = {
      addEventListener(t, fn, cap) { on(cap ? listeners.cap : listeners.bub, t, fn); },
      removeEventListener(t, fn, cap) { off(cap ? listeners.cap : listeners.bub, t, fn); },
    };
    const mkNode = (tagName, classes) => ({
      tagName,
      classList: { contains: (n) => classes.includes(n) },
      _cap: Object.create(null),
      _bub: Object.create(null),
      addEventListener(t, fn, cap) { const m = cap ? this._cap : this._bub; (m[t] ??= []).push(fn); },
    });
    const host = mkNode("DIV", ["terminal-host"]);
    const textarea = mkNode("TEXTAREA", []);
    const outside = mkNode("DIV", []);
    const activeElement = {
      tagName: "TEXTAREA",
      getAttribute: () => "terminal",
      closest: (s) => (s === ".terminal-host" ? host : null),
    };
    const document = {
      readyState: "complete",
      activeElement,
      querySelector: (sel) => {
        if (typeof sel === "string" && sel.includes("textarea")) return textarea;
        if (typeof sel === "string" && sel.includes("terminal-host")) return host;
        if (typeof sel === "string" && sel.includes(".pane")) return host;
        return null;
      },
      querySelectorAll: (sel) => {
        if (typeof sel === "string" && sel.includes(".pane")) return [{}, {}];
        if (typeof sel === "string" && sel.includes("module")) return [];
        return [];
      },
    };
    let nowMs = 1000;
    const performance = { now: () => (nowMs += 0.5), timeOrigin: 1700000000000 };
    const location = { href: "https://chan.test/app/?w=abc123&t=SECRET-TOKEN" };
    const dispatch = (target, event) => {
      event.target = target;
      const inHost = target === host || target === textarea;
      event._path = target === outside ? [outside, windowObj]
        : target === host ? [host, windowObj] : [textarea, host, windowObj];
      event.composedPath = () => event._path;
      const runList = (list) => {
        for (const fn of list) { fn(event); if (event._stopped) return true; }
        return false;
      };
      const at = (node, cap) => runList((cap ? node._cap?.[event.type] : node._bub?.[event.type]) || []);
      if (runList(listeners.cap.get(event.type) || [])) return;
      if (inHost && runList(host._cap[event.type] || [])) return;
      if (target !== host && target !== windowObj && at(target, true)) return;
      if (target !== host && target !== windowObj && at(target, false)) return;
      if (inHost && runList(host._bub[event.type] || [])) return;
      runList(listeners.bub.get(event.type) || []);
    };
    const keyEvent = (type, fields = {}, mods = {}) => {
      const e = {
        type, key: null, code: null, keyCode: 0, location: 0,
        ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        repeat: false, isComposing: false, isTrusted: true,
        defaultPrevented: false, _stopped: false,
        preventDefault() { e.defaultPrevented = true; },
        stopPropagation() { e._stopped = true; },
        stopImmediatePropagation() { e._stopped = true; },
        getModifierState: (k) => mods[k] ?? false,
        ...fields,
      };
      return e;
    };
    return { windowObj, host, textarea, outside, document, performance, location, dispatch, keyEvent, listeners };
  }

  function stubContext(sp) {
    return vm.createContext({
      window: sp.windowObj, document: sp.document, performance: sp.performance,
      location: sp.location, URL, console: { log: () => {} }, queueMicrotask,
    });
  }
  const runSrc = (ctx, src) => vm.runInContext(src, ctx);

  {
    const sp = makeStubPage();
    const ctx = stubContext(sp);
    if (runSrc(ctx, page.INSTALL_SRC) !== "installed") fail("INSTALL did not answer installed");
    sp.host._cap.keydown = [(e) => { e.stopImmediatePropagation(); }];
    const kd = sp.keyEvent("keydown", { key: "Backspace", code: "Backspace", keyCode: 8 });
    sp.dispatch(sp.textarea, kd);
    let snap = runSrc(ctx, page.READ_SRC);
    const rows = snap.events.filter((e) => e.type === "keydown");
    if (rows.length !== 1) fail(`adapter-stopped keydown not recorded (${rows.length} rows)`);
    else {
      if (rows[0].target !== "textarea") fail(`stopped keydown target is ${rows[0].target}, want textarea`);
      if (rows[0].gotThrough !== false) fail("stopped keydown reads gotThrough true");
      if (rows[0].key !== "Backspace" || rows[0].keyCode !== 8) fail("stopped keydown lost its fields");
    }
    const ku = sp.keyEvent("keyup", { key: "Backspace", code: "Backspace", keyCode: 8 });
    sp.host._cap.keydown = [];
    sp.dispatch(sp.textarea, ku);
    snap = runSrc(ctx, page.READ_SRC);
    const ups = snap.events.filter((e) => e.type === "keyup");
    if (ups.length !== 1 || ups[0].gotThrough !== true) fail("unstopped keyup did not bubble through");
    sp.textarea._bub.keydown = [(e) => { e.preventDefault(); }];
    sp.host._cap.keydown = [];
    sp.dispatch(sp.textarea, sp.keyEvent("keydown", { key: "a", code: "KeyA", keyCode: 65 }));
    snap = runSrc(ctx, page.READ_SRC);
    const prevented = snap.events.filter((e) => e.type === "keydown" && e.key === "a");
    if (prevented.length !== 1 || prevented[0].defaultPrevented !== true) fail("preventDefault not carried to the row");
    sp.dispatch(sp.textarea, sp.keyEvent("keydown", { key: "a", code: "KeyA", keyCode: 65 }, { AltGraph: true }));
    snap = runSrc(ctx, page.READ_SRC);
    const ag = snap.events.filter((e) => e.altGraph === true);
    if (ag.length === 0) fail("getModifierState(AltGraph) not recorded");
    const before = snap.events.length;
    sp.dispatch(sp.outside, sp.keyEvent("keydown", { key: "b", code: "KeyB", keyCode: 66 }));
    snap = runSrc(ctx, page.READ_SRC);
    if (snap.events.length !== before) fail("event outside the host was recorded");
    sp.dispatch(sp.host, { ...sp.keyEvent("mousedown", { button: 0 }), button: 0 });
    snap = runSrc(ctx, page.READ_SRC);
    const md = snap.events.filter((e) => e.type === "mousedown");
    if (md.length !== 1 || md[0].target !== "host") fail("mousedown on the host not recorded with target host");
    if (md[0] && ("x" in md[0] || "clientX" in md[0])) fail("mouse row carries coordinates");
    sp.dispatch(sp.textarea, {
      ...sp.keyEvent("paste", {}),
      clipboardData: { types: ["text/plain"], getData: (t) => (t === "text/plain" ? "hi" : "") },
    });
    snap = runSrc(ctx, page.READ_SRC);
    const pastes = snap.events.filter((e) => e.type === "paste");
    if (pastes.length !== 1 || pastes[0].clipText !== "hi") fail("paste row lost its clipboard text");
    sp.dispatch(sp.textarea, sp.keyEvent("compositionstart", {}));
    snap = runSrc(ctx, page.READ_SRC);
    if (snap.composing !== true) fail("compositionstart did not set composing");
    sp.dispatch(sp.textarea, sp.keyEvent("compositionend", { data: "ni" }));
    snap = runSrc(ctx, page.READ_SRC);
    if (snap.composing !== false) fail("compositionend did not clear composing");
    if (runSrc(ctx, page.RESET_SRC) !== "reset") fail("RESET did not answer reset");
    snap = runSrc(ctx, page.READ_SRC);
    if (snap.events.length !== 0 || snap.bytes.length !== 0) fail("RESET left rows behind");
    let tapped = null;
    const termStub = { element: sp.host, onData: (cb) => { tapped = cb; return { dispose() {} }; } };
    sp.windowObj.__nativeInputTermsK = { terminals: [termStub] };
    const hooked = runSrc(ctx, `(${page.FIND_TERM_SRC})("__nativeInputTermsK", ".terminal-host .x")`);
    if (hooked !== "hooked") fail(`FIND call form answered ${JSON.stringify(hooked)}, want hooked`);
    tapped("x");
    snap = runSrc(ctx, page.READ_SRC);
    if (snap.bytes.length !== 1 || snap.bytes[0].data !== "x") fail("onData tap did not land bytes");
    if (snap.terms !== 1) fail(`terms is ${snap.terms}, want 1`);
    if (runSrc(ctx, `(${page.FIND_TERM_SRC})("__nativeInputTermsK", ".no-such-pane")`) !== null) {
      fail("FIND with no matching terminal did not answer null");
    }
    const badTerm = { element: sp.host, onData: () => { throw new Error("tap blew"); } };
    sp.windowObj.__nativeInputTermsK = { terminals: [badTerm] };
    let threw = "";
    try {
      runSrc(ctx, `(${page.FIND_TERM_SRC})("__nativeInputTermsK", ".terminal-host .x")`);
    } catch (err) { threw = String(err.message || err); }
    if (!threw) fail("throwing tap did not fail FIND");
    snap = runSrc(ctx, page.READ_SRC);
    if (!snap.hookError) fail("hook error not carried on READ");
    let threwAgain = "";
    try {
      runSrc(ctx, `(${page.FIND_TERM_SRC})("__nativeInputTermsK", ".terminal-host .x")`);
    } catch (err) { threwAgain = String(err.message || err); }
    if (!threwAgain.includes("hook failed")) fail(`FIND after a hook error misreports (got ${JSON.stringify(threwAgain)})`);
    if (snap.focused === null || snap.focused.inHost !== true) fail("READ focus row wrong");
    if (snap.textareaPresent !== true) fail("READ textarea row wrong");
  }
  if (problems === 0) ok("stub page: stopped keys recorded, bubble/preventDefault/AltGraph/mouse/paste/composition/hook paths hold");

  {
    const sp = makeStubPage();
    const ctx = stubContext(sp);
    runSrc(ctx, page.INSTALL_SRC);
    for (const [name, src] of [["FIND_TERM_SRC", page.FIND_TERM_SRC], ["WRAP_OPEN_SRC", page.WRAP_OPEN_SRC]]) {
      if (typeof runSrc(ctx, src) !== "function") fail(`bare ${name} is not an uncalled function`);
    }
    for (const name of ["INSTALL_SRC", "RESET_SRC", "READ_SRC"]) {
      if (typeof runSrc(ctx, page[name]) === "function") fail(`bare ${name} unexpectedly uncalled`);
    }
  }
  ok("bare source form never runs; nullary sources run bare");

  {
    if (!chromeSrc.includes("(${FIND_TERM_SRC})(")) fail("chrome driver lost the FIND call form");
    if (/evaluate\(\s*FIND_TERM_SRC\s*,/.test(chromeSrc)) fail("chrome driver evaluates bare FIND_TERM_SRC");
    if (/evaluate\(\s*WRAP_OPEN_SRC\s*,/.test(chromeSrc)) fail("chrome driver evaluates bare WRAP_OPEN_SRC");
    if (!chromeSrc.includes("wrapWithRetry(evaluate, WRAP_OPEN_SRC, KEY")) fail("chrome driver lost wrapWithRetry");
    if (!chromeSrc.includes("pollWrapBox") && !webkitSrc.includes("pollWrapBox")) fail("no driver polls the settle box");
    if (!webkitSrc.includes("(${FIND_TERM_SRC})(")) fail("webkit driver lost the FIND call form");
    if (/evaluate\(\s*FIND_TERM_SRC\s*,/.test(webkitSrc)) fail("webkit driver evaluates bare FIND_TERM_SRC");
    if (!webkitSrc.includes("pollWrapBox(evaluate, WRAP_OPEN_SRC, TERM_KEY")) fail("webkit driver lost pollWrapBox");
    if (!/terminal-host canvas/.test(webkitSrc)) fail("webkit driver lost the canvas wait before FIND");
    if (!webkitSrc.includes("hookedOnce.terms")) fail("webkit driver lost the one-terminal assert");
    if (!chromeSrc.includes("hookedOnce.terms")) fail("chrome driver lost the one-terminal assert");
    const built = (bootSrc.match(/`\(\$\{wrapSrc\}\)\(\$\{JSON\.stringify\(key\)\}\)`/g) || []).length;
    if (built < 2) fail(`boot-wait builds the wrap call form ${built} times, want 2`);
    if (!chromeSrc.includes("page.evaluate(READ_SRC)") && !chromeSrc.includes("readSnapshot")) fail("chrome driver lost the READ path");
    if (!webkitSrc.includes("evaluate(READ_SRC)")) fail("webkit driver lost the READ path");
  }
  if (problems === 0) ok("both drivers call keyed sources as expressions and read nullary ones bare");

  {
    const goodState = { url: "https://chan.test/app/?w=abc123", readyState: "complete", moduleScripts: 3, panes: 2, navs: 0, timeOrigin: 1700000000000 };
    let reads = 0;
    const prog = async () => (++reads < 3 ? { ...goodState, readyState: "loading", panes: 0 } : goodState);
    const st = await boot.waitBooted(prog, { timeoutMs: 2000, sleepMs: 5, label: "stub page" });
    if (st.readyState !== "complete") fail("waitBooted did not return the ready state");
    try {
      await boot.waitBooted(async () => ({ ...goodState, panes: 0 }), { timeoutMs: 60, sleepMs: 5 });
      fail("waitBooted passed with no pane");
    } catch (err) {
      if (!/no \.pane/.test(err.message)) fail(`waitBooted named the wrong condition: ${err.message.slice(0, 120)}`);
    }
    try {
      await boot.waitBooted(async () => { throw new Error("gone"); }, { timeoutMs: 60, sleepMs: 5 });
      fail("waitBooted passed on unreadable state");
    } catch (err) {
      if (!/state unreadable/.test(err.message)) fail("waitBooted did not report unreadable state");
    }
    let probes = 0;
    await boot.windowLive(async () => ++probes >= 3, { timeoutMs: 2000, sleepMs: 5 });
    try {
      await boot.windowLive(async () => false, { timeoutMs: 60, sleepMs: 5 });
      fail("windowLive passed on a dead probe");
    } catch (err) {
      if (!/live/.test(err.message)) fail("windowLive error names nothing live");
    }
    const mkWrapEval = (answers, navs) => {
      let a = 0, s = 0;
      return async (expr) => {
        if (expr.includes("ghostty-web")) return answers[Math.min(a++, answers.length - 1)];
        return { ...goodState, navs: navs[Math.min(s++, navs.length - 1)] ?? 0 };
      };
    };
    const once = await boot.wrapWithRetry(mkWrapEval(["wrapped"], [0]), page.WRAP_OPEN_SRC, "K", { timeoutMs: 2000, sleepMs: 5 });
    if (once.retried !== false) fail("single-shot wrap reads as retried");
    if (once.attempts.length !== 2 || once.attempts[0].kind !== "baseline") fail("wrap attempts lack the baseline");
    if (once.attempts[1].answer !== "wrapped") fail("wrap answer not recorded on the attempt");
    const slow = await boot.wrapWithRetry(mkWrapEval(["settling", "wrapped"], [0, 0]), page.WRAP_OPEN_SRC, "K", { timeoutMs: 2000, sleepMs: 5 });
    if (slow.retried !== true) fail("a wrap that needed a second attempt reads as unretried");
    const reloaded = await boot.wrapWithRetry(mkWrapEval(["wrapped"], [0, 1]), page.WRAP_OPEN_SRC, "K", { timeoutMs: 2000, sleepMs: 5 });
    if (!reloaded.attempts.some((a) => a.navigatedSinceLast)) fail("a nav-counter move across attempts reads as no reload");
    try {
      await boot.wrapWithRetry(mkWrapEval(["settling"], [0]), page.WRAP_OPEN_SRC, "K", { timeoutMs: 60, sleepMs: 5 });
      fail("wrapWithRetry passed on endless settling");
    } catch (err) {
      if (!/no ghostty-web chunk/.test(err.message)) fail("wrap timeout names no chunk");
    }
    const mkBoxEval = (states) => {
      let polls = 0;
      return async (expr) => {
        if (expr.includes("ghostty-web")) return "settling";
        if (expr.includes('"K:wrap"')) return { state: states[Math.min(polls++, states.length - 1)], value: null };
        return goodState;
      };
    };
    const boxed = await boot.pollWrapBox(mkBoxEval(["settling", "wrapped"]), page.WRAP_OPEN_SRC, "K", { timeoutMs: 2000, sleepMs: 5 });
    if (boxed.retried !== true) fail("settle-box wrap that polled twice reads as unretried");
    if (boxed.attempts[0].kind !== "baseline") fail("settle-box attempts lack the baseline");
    for (const [state, want] of [["missing", /wrap missing/], ["failed", /wrap failed/]]) {
      try {
        await boot.pollWrapBox(mkBoxEval([state]), page.WRAP_OPEN_SRC, "K", { timeoutMs: 500, sleepMs: 5 });
        fail(`pollWrapBox passed a ${state} box`);
      } catch (err) {
        if (!want.test(err.message)) fail(`pollWrapBox ${state} box misreported: ${err.message.slice(0, 120)}`);
      }
    }
    {
      const sp = makeStubPage();
      const ctx = stubContext(sp);
      if (runSrc(ctx, boot.NAV_COUNTER_SRC) !== "counting") fail("NAV_COUNTER_SRC did not answer counting");
      if (sp.windowObj.__nativeInputNavs !== 0) fail("load counter not planted at zero");
      for (const fn of (sp.listeners.cap.get("load") || [])) fn();
      if (sp.windowObj.__nativeInputNavs !== 1) fail("load listener did not tick the counter");
    }
    {
      const sp = makeStubPage();
      const ctx = stubContext(sp);
      const s = runSrc(ctx, boot.STATE_SRC);
      if (s.url !== "https://chan.test/app/?w=abc123") fail(`STATE url unmasked or wrong: ${s.url}`);
    }
    {
      const dir = scratch("input-bundle-");
      try {
        boot.assertBundleChunk(dir);
        fail("assertBundleChunk passed a bundle with no index");
      } catch (err) {
        if (!/no index\.html/.test(err.message)) fail("bundle assertion misnames a missing index");
      }
      writeFileSync(join(dir, "index.html"), `<script type="module" src="/assets/entry-1.js"></script>`);
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "assets", "entry-1.js"), `import("./ghostty-web-BWHbqZNZ.js")`);
      const hits = boot.assertBundleChunk(dir);
      if (hits.length !== 1 || hits[0].chunk !== "ghostty-web-BWHbqZNZ.js") fail("bundle assertion missed the chunk");
      writeFileSync(join(dir, "assets", "entry-1.js"), `console.log("no chunk here")`);
      try {
        boot.assertBundleChunk(dir);
        fail("assertBundleChunk passed a bundle with no chunk reference");
      } catch (err) {
        if (!/no entry module references/.test(err.message)) fail("bundle assertion misnames a chunkless bundle");
      }
    }
  }
  if (problems === 0) ok("boot-wait: waits name conditions, retry/box record attempts, counter plants, URL masks");

  const NATIVE_INPUT_BUNDLE = process.env.NATIVE_INPUT_BUNDLE ?? "";
  if (NATIVE_INPUT_BUNDLE) {
    try {
      const hits = boot.assertBundleChunk(NATIVE_INPUT_BUNDLE);
      note(`bundle chunk assertion: ${hits.map((h) => `${h.entry} -> ${h.chunk}`).join(", ")}`);
    } catch (err) {
      fail(`bundle chunk assertion: ${err.message}`);
    }
  } else {
    note("no NATIVE_INPUT_BUNDLE: bundle chunk assertion skipped (the operator stages a guest-built bundle for it; nothing is built on the host)");
  }

  {
    const flat = (s) => s.replace(/\s+/g, "");
    if (!flat(page.INSTALL_SRC).includes(`for(constfof${flat(JSON.stringify(page.FIELDS))})`)) {
      fail("in-page field copy drifted from the FIELDS export");
    }
    const goodRow = () => {
      const row = { t: 0, target: "host", defaultPrevented: false, gotThrough: true };
      for (const f of page.FIELDS) {
        if (f in row) continue;
        row[f] = f === "type" ? "keydown" : f === "isTrusted" ? true : f === "altGraph" ? false : null;
      }
      return row;
    };
    const goodFixture = (id) => ({
      header: {
        case: id, title: "t", family: "keys", engine: "chrome-headless", engineVersion: "v",
        worktreeSha: "s", producedBy: "p", seam: "s", derivation: "d", recorder: "r",
        platform: "linux-x64-cdp-us", layout: "cdp-us", injected: ["key"], isTrustedAll: true,
      },
      setup: {}, steps: [], domEvents: [goodRow()],
      observed: { widget: "a", pty: "a" }, contract: { widget: "a", pty: "a" },
      verdict: { status: "ok", reason: "" },
    });
    const goodSummary = (ids) => ({
      engine: "e", engineVersion: "v", worktreeSha: "s", started: "a", finished: "b",
      cases: Object.fromEntries(ids.map((id) => [id, "ok"])),
      notDriven: {}, counts: { preconditions: 0, properties: 0 },
      boot: { retried: false, attempts: [], prefs: { wrote: false } },
    });
    if (schema.validateCaseFile(goodFixture("x")).length !== 0) fail("schema rejects a good fixture");
    const bad = goodFixture("x");
    bad.domEvents[0].isTrusted = "yes";
    bad.verdict.status = "maybe";
    if (schema.validateCaseFile(bad).length < 2) fail("schema accepts a bad fixture");
    const untrusted = goodFixture("x");
    untrusted.domEvents[0].isTrusted = false;
    assert.ok(schema.validateCaseFile(untrusted).some((e) => e.includes("isTrusted")));
    const wrongBytes = goodFixture("x");
    wrongBytes.observed.pty = "wrong";
    assert.ok(schema.validateCaseFile(wrongBytes).some((e) => e.includes("differs from contract")));
    const ids = CASES.map((c) => c.id);
    if (schema.validateRunSummary(goodSummary(ids), ids).length !== 0) fail("schema rejects a good summary");
    const badSummary = goodSummary(ids);
    delete badSummary.counts;
    badSummary.notDriven = { "mouse-sgr": "" };
    badSummary.cases["mouse-sgr"] = "not-driven";
    if (schema.validateRunSummary(badSummary, ids).length < 2) fail("schema accepts a summary with no counts and an empty reason");
    const dir = scratch("input-copy-");
    const writeJson = (name, v) => writeFileSync(join(dir, name), `${JSON.stringify(v, null, 2)}\n`);
    writeJson("run-summary.json", goodSummary(ids));
    for (const id of ids) writeJson(`${id}.json`, goodFixture(id));
    const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
    if (schema.validateCopiedRun(dir, readJson, (p) => existsSync(p)).length !== 0) {
      fail("copied-run validator rejects a good copied run");
    }
    writeJson(ids[0] + ".json", { ...goodFixture(ids[0]), verdict: { status: "bogus", reason: "" } });
    const red = schema.validateCopiedRun(dir, readJson, (p) => existsSync(p));
    if (!red.some((e) => e.startsWith(`${ids[0]}:`))) fail("copied-run validator misses a bad fixture");
    const failedSummary = goodSummary(ids);
    failedSummary.cases[ids[1]] = "failed";
    writeJson("run-summary.json", failedSummary);
    writeFileSync(join(dir, `${ids[1]}.error.txt`), "masked boom\n");
    const withErr = schema.validateCopiedRun(dir, readJson, (p) => existsSync(p));
    if (withErr.some((e) => e.startsWith(`${ids[1]}:`))) fail("copied-run validator rejects a failed case with its error file");
    writeFileSync(join(dir, "run-summary.json"), JSON.stringify({ ...failedSummary, cases: { [ids[1]]: "failed" } }));
    const noErr = schema.validateCopiedRun(dir, readJson, () => false);
    if (!noErr.some((e) => e.includes(`${ids[1]}: failed without an error file`))) {
      fail("copied-run validator misses a failed case with no error file");
    }
  }
  if (problems === 0) ok("schema: good fixture/summary validate, bad ones fail, copied runs check end to end");

  {
    const handledOps = (src, leg) => {
      const i = src.indexOf("switch (step.op)");
      if (i < 0) { fail(`${leg} driver lost its step dispatch`); return new Set(); }
      const body = src.slice(i, src.indexOf("default:", i));
      return new Set([...body.matchAll(/case "(\w+)":/g)].map((m) => m[1]));
    };
    const chromeOps = handledOps(chromeSrc, "chrome");
    const webkitOps = handledOps(webkitSrc, "webkit");
    const FAMILIES = ["keys", "composition", "paste", "mouse"];
    const seen = new Set();
    for (const c of CASES) {
      if (!c.id || seen.has(c.id)) fail(`duplicate or empty case id ${JSON.stringify(c.id)}`);
      seen.add(c.id);
      if (!FAMILIES.includes(c.family)) fail(`${c.id}: bad family ${JSON.stringify(c.family)}`);
      for (const [leg, spec, ops] of [["chrome", c.chrome, chromeOps], ["webkit", c.webkit, webkitOps]]) {
        if (!spec) {
          if (!c[`${leg}Reason`] && !c.pendingReason) fail(`${c.id}: ${leg} null without a reason`);
          continue;
        }
        if (!Array.isArray(spec.steps) || spec.steps.length === 0) fail(`${c.id}: ${leg} has no steps`);
        for (const s of spec.steps) {
          if (!ops.has(s.op)) fail(`${c.id}: ${leg} step op ${JSON.stringify(s.op)} is not implemented by the ${leg} driver`);
        }
      }
      if (!c.chrome && !c.webkit && !c.pendingReason) fail(`${c.id}: undrivable without a pending reason`);
      if (!c.expect || !Array.isArray(c.expect.dom)) fail(`${c.id}: expect.dom missing`);
      for (const k of ["widget", "pty"]) {
        const v = c.expect[k];
        if (v !== null && typeof v !== "string") fail(`${c.id}: expect.${k} not string|null`);
      }
    }
    note(`case list: ${CASES.length} cases (${CASES.filter((c) => c.chrome).length} chrome, ${CASES.filter((c) => c.webkit).length} webkit)`);
    for (const [leg, src] of [["chrome", chromeSrc], ["webkit", webkitSrc]]) {
      if (!src.includes("for (const c of CASES)")) fail(`${leg} driver does not loop over every case`);
      if (!src.includes('"not-driven"')) fail(`${leg} driver never marks not-driven`);
      if (!src.includes(`summary.cases[c.id] = "not-driven"`)) fail(`${leg} driver lacks the not-driven summary row`);
      if (!src.includes(`summary.notDriven[c.id] = c.${leg}Reason ?? c.pendingReason`)) {
        fail(`${leg} driver drops the specific not-driven reason`);
      }
      if (!src.includes("mask(reason)")) fail(`${leg} driver writes unmasked failure text`);
      if (!src.includes("recorder:") || !src.includes("platform:") || !src.includes("layout:")) {
        fail(`${leg} driver fixture header lacks recorder identity`);
      }
    }
    if (!chromeSrc.includes("const recorderId")) fail("chrome driver lost its recorder identity");
    if (!webkitSrc.includes("const recorderId") || !webkitSrc.includes("const guestLayout")) {
      fail("webkit driver lost its recorder identity or layout probe");
    }
  }
  if (problems === 0) ok("cases: ids/families/reasons shape up, every step op is a driver arm, summaries list every case");

  const haveWT = true;
  {
    const files = ["chrome", "webkit", "cases.mjs", "page.mjs", "schema.mjs", "boot-wait.mjs", "identity.mjs"];
    for (const file of files) {
      const full = kitFile(file);
      const src = readFileSync(full, "utf8");
      for (const [, specifier] of src.matchAll(/(?:from |import\()["'](\.[^"']+)["']/g)) {
        if (!existsSync(join(dirname(full), specifier))) fail(`${file}: unresolved import ${specifier}`);
      }
    }
    if (/\$STAGED\//.test(shellSrc) || /\$\{STAGED/.test(shellSrc)) fail("shell names undefined $STAGED");
    for (const file of ["cases.mjs", "page.mjs", "schema.mjs", "boot-wait.mjs", "identity.mjs"]) {
      if (!shellSrc.includes(`$KIT/${file}`)) fail(`shell does not hash $KIT/${file}`);
    }
    if (!shellSrc.includes('node "$HERE/native-input-record.mjs"')) fail("shell does not run the tracked driver");
    for (const [leg, src] of [["chrome", chromeSrc], ["webkit", webkitSrc]]) {
      if (/original\.ghostty|ghostty: (?:true|false)|writeTerminalPrefs/.test(src)) fail(`${leg}: retired preference access`);
      if (!src.includes("readWorktreeSha(")) fail(`${leg}: no worktree identity`);
      if (!src.includes("c.source")) fail(`${leg}: case contract source missing`);
      if (!src.includes("drainPointerInput(transport")) fail(`${leg}: PTY setup/barrier missing`);
    }
    const { recorderIdentity, readWorktreeSha } = await import("./identity.mjs");
    assert.match(recorderIdentity("chrome"), /^[a-f0-9]{64}$/);
    assert.match(recorderIdentity("webkit"), /^[a-f0-9]{64}$/);
    assert.match(readWorktreeSha("a".repeat(40)), /^[a-f0-9]{40}$/);
    assert.throws(() => readWorktreeSha("unknown"), /full worktree SHA/);
    const kitty = caseById("kitty-ctrl-c");
    assert.equal(kitty.program, "\x1b[>1u\x1b[?u");
    assert.equal(kitty.programReply, "\x1b[?1u");
    assert.equal(kitty.expect.pty, "\x1b[99;5u");
    assert.equal(kitty.expect.widget, "\x1b[99;5u");
    assert.match(kitty.source, /kitty\/keyboard-protocol/);
  }
  if (problems === 0) ok("imports, shell paths, recorder identity and protocol oracle hold");

  if (haveWT) {
    const libsh = wtFile("scripts/e2e/desktop-observations/lib.sh");
    const tails = [
      [0, 0, "driver exit 0"],
      [10, 1, "FAULT"],
      [3, 3, "INCONCLUSIVE"],
      [1, 3, "INCONCLUSIVE"],
      [2, 3, "INCONCLUSIVE"],
    ];
    for (const [driverStatus, shellExpect, marker] of tails) {
      const script = [
        `source ${JSON.stringify(libsh)}`,
        "OBS_NAME=test",
        "obs_verdict",
        `( exit ${driverStatus} )`,
        "verdict=$?",
        'echo "driver exit $verdict"',
        `obs_judge "$verdict" "probe ${driverStatus}"`,
      ].join("\n");
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 30_000 });
      const out = `${r.stdout || ""}\n${r.stderr || ""}`;
      if (r.status !== shellExpect) {
        fail(`shell tail: driver ${driverStatus} exited ${r.status}, want ${shellExpect} (out: ${out.slice(-300)})`);
      } else if (!out.includes(marker)) {
        fail(`shell tail: driver ${driverStatus} left no ${marker} marker`);
      }
    }
    if (problems === 0) ok("shell tail: 0 stays 0, 10 faults, 3/1/2 read inconclusive");
  }

  {
    const productDir = wtFile("web/packages/workspace-app/src/terminal");
    const needed = ["ghosttyKeys.ts", "keyEncoding.ts", "keymap.ts", "clipboardChord.ts"];
    if (!existsSync(join(productDir, "ghosttyKeys.ts"))) {
      note(`product evaluators absent at ${productDir}: anchor check skipped (host-only; set NATIVE_INPUT_PRODUCT)`);
    } else {
      const dir = scratch("input-derive-");
      for (const f of [...needed, "backend.ts"]) {
        const src = join(productDir, f);
        if (!existsSync(src)) continue;
        const text = readFileSync(src, "utf8").replace(/from "(\.[^"]*)"/g, (m, p) => (p.endsWith(".ts") ? m : `from "${p}.ts"`));
        writeFileSync(join(dir, f), text);
      }
      const href = (f) => pathToFileURL(join(dir, f)).href;
      const { ghosttyKeydownAction } = await import(href("ghosttyKeys.ts"));
      const { decideKeydown, createKeydownState } = await import(href("keyEncoding.ts"));
      const { controlSlashBytes, terminalMetaKeyBytes } = await import(href("keymap.ts"));
      const { isTerminalPasteChord } = await import(href("clipboardChord.ts"));
      const PLATFORM = { isMac: false, isWindows: false };
      const K = (key, code, keyCode, extra = {}) => ({
        type: "keydown", key, code, keyCode, location: 0,
        ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        repeat: false, isComposing: false, getModifierState: () => false, ...extra,
      });
      const derived = (keys) => keys.map((e) => {
        const state = createKeydownState();
        const chanBytes = controlSlashBytes(e, null) ?? terminalMetaKeyBytes(e, undefined) ?? null;
        const claimed = isTerminalPasteChord(e, "linux");
        const action = ghosttyKeydownAction(e, { platform: PLATFORM, applicationCursorMode: false, rows: 24, chanBytes }, createKeydownState());
        return { action, claimed };
      }).filter((r) => !r.claimed && r.action.kind === "send").map((r) => r.action.data).join("");
      const anchors = [
        ["ctrl-alt-a", [K("Control", "ControlLeft", 17, { location: 1 }), K("Alt", "AltLeft", 18, { location: 1, ctrlKey: true }), K("a", "KeyA", 65, { ctrlKey: true, altKey: true })]],
        ["paste-ctrl-v", [K("Control", "ControlLeft", 17, { location: 1 }), K("v", "KeyV", 86, { ctrlKey: true })]],
        ["typing-ab", [K("a", "KeyA", 65), K("b", "KeyB", 66)]],
      ];
      for (const [id, keys] of anchors.slice(0, 2)) {
        const bytes = derived(keys);
        const want = caseById(id).expect.pty;
        note(`${id}: derived ${JSON.stringify(bytes)} vs case ${JSON.stringify(want)}`);
        if (bytes !== want) fail(`${id}: product evaluators give ${JSON.stringify(bytes)}, case pins ${JSON.stringify(want)}`);
      }
      {
        const keys = anchors[2][1];
        const kinds = keys.map((e) => {
          const chanBytes = controlSlashBytes(e, null) ?? terminalMetaKeyBytes(e, undefined) ?? null;
          return ghosttyKeydownAction(e, { platform: PLATFORM, applicationCursorMode: false, rows: 24, chanBytes }, createKeydownState()).kind;
        });
        const want = caseById("typing-ab").expect.pty;
        note(`typing-ab: kinds ${JSON.stringify(kinds)} vs case ${JSON.stringify(want)}`);
        if (!kinds.every((k) => k === "ghostty") || keys.map((e) => e.key).join("") !== want) {
          fail(`typing-ab: product does not pass both keystrokes through (kinds ${JSON.stringify(kinds)})`);
        }
      }
      void decideKeydown;
    }
  }
  if (problems === 0) ok("bytes: the anchors come out of the product evaluators");

  if (problems > 0) {
    console.error(`host-control: ${problems} problem(s) found; no ports, servers or browsers touched`);
    assert.equal(problems, 0, "recorder controls failed");
  } else {
    console.log("host-control green: sources compile and run in both call forms, waits record, schema and staging hold, shell exits map, bytes derive");
  }



});
