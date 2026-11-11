#!/usr/bin/env node
// The page-level arms of basic-flows.sh, and their verdict.
//
//   basic-flows.mjs run --inspector HOST:PORT --page URL-SUBSTRING --xid X-ID
//       --ws DIR --note RELATIVE-PATH --chan-home DIR --fixture PNG
//       --chan PATH --work DIR --results JSONL --arms GROUP[,GROUP...]
//   basic-flows.mjs verdict --results JSONL --webkit VERSION
//
// `run` holds one inspector connection to the workspace page, plants a
// witness of every paste, drop, drag, pointer move, Ctrl+Enter keydown and
// status bar text the page sees, and runs the arms of the chosen groups in
// order, appending one JSON record per arm. The groups are `native` (the
// injected WKWebView paste shape), `trusted` (a real Ctrl+V and the
// terminal menu's Paste row under three clipboard owners), `drop` (a
// synthetic file drop) and `xdnd` (a real file drop over XDND, on the
// surfaces and outside every drop zone); the file-item paste controls run
// in every selection that holds one of those four. The other groups drive
// the rest of the basic flows by X input: `terminal` (typed input and its
// output, then a text paste by Ctrl+Shift+V and by the terminal menu, on
// each terminal backend), `editor` (typing in a note's rendered and source
// modes until its file holds the text, under document sessions and under
// the page's own autosave, then a reload), `open` (a double-click on a
// Files row), `search` (a query typed into Search and its hit opened by
// Enter) and `panes` (a split by chord, a focus by click, a tab dragged to
// the other pane and both closed by chord). The records are facts: what
// the X clipboard offered
// (its TARGETS), the clipboard or drop shape the page's own listener saw,
// the image embeds, the files on disk and their pixels decoded against the
// fixture (arboard re-encodes, so bytes are not compared), the status
// texts, whether the window stayed on its page and the terminal's
// scrollback. It exits 0 once the arms have run, whatever they saw, and 3
// when it cannot reach the page.
//
// `verdict` judges the records and prints one line per arm, each naming
// the engine. It exits 0 when every chosen group held with its controls,
// 10 when a fault was observed under its controls, and 3 otherwise.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    inspector: { type: "string" }, page: { type: "string" }, xid: { type: "string" },
    ws: { type: "string" }, note: { type: "string" }, "chan-home": { type: "string" },
    fixture: { type: "string" }, chan: { type: "string" }, work: { type: "string" },
    results: { type: "string" }, webkit: { type: "string" }, arms: { type: "string" },
  },
});
const mode = positionals[0];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);
// The window is on the page it was: the same document, which the witness
// lives in, at the same origin and path. The app rewrites the URL's search
// and fragment with its own state, so those may change.
const pageKey = "location.origin + location.pathname";
const pageKept = (before) => `Boolean(window.__flows) && ${pageKey} === ${JSON.stringify(before)}`;
const xdo = (...words) => spawnSync("xdotool", words.map(String), { encoding: "utf8", timeout: 10000 });

const IMAGE_GROUPS = ["native", "trusted", "drop", "xdnd"];
const GROUPS = [...IMAGE_GROUPS, "terminal", "editor", "open", "search", "panes"];
const BACKENDS = ["xterm", "ghostty"];
// The text the terminal arms paste: a space and a newline, which a paste
// must carry whole inside one bracketed pair.
const PASTE_TEXT = "basic flows paste\nsecond line";
const bracketed = (text) => `^[[200~${text}^[[201~`;
// The notices the paste path raises when it does not land an image. Any of
// them in a subject arm is a fault; the text-only control expects the first.
const NO_IMAGE = "No image found on the clipboard";
const PASTE_NOTICES = [NO_IMAGE, "Could not read image from the clipboard", "Image upload failed", "upload limit", "HEIC conversion failed"];
const TEXT_ONLY = "basic-flows text only clipboard";
const IMAGE_FILE = /\.(png|bmp|tiff?|jpe?g|webp|gif|avif|ico)$/i;

// The X CLIPBOARD's owners. xclip answers a request for any target with its
// data; the GTK owners answer only the targets they offer, as an app's copy
// does (clipboard-owner.py). `offered` says whether TARGETS is the owner's.
const OWNERS = {
  xclip: { label: "xclip image/png", offered: (list) => list.includes("image/png") },
  "gtk-image": { label: "GTK set_image", offered: (list) => ["image/png", "image/bmp", "image/tiff", "image/jpeg"].every((t) => list.includes(t)) },
  "gtk-png": { label: "GTK image/png alone", offered: (list) => list.filter((t) => t.includes("/")).join(" ") === "image/png" },
  text: { label: "GTK text", offered: (list) => list.some((t) => /STRING|text\/plain/.test(t)) && !list.some((t) => t.startsWith("image/")) },
};
const TRUSTED_OWNERS = ["gtk-image", "gtk-png", "xclip"];

if (mode === "run") await run();
else if (mode === "verdict") verdict();
else {
  console.error("usage: basic-flows.mjs run|verdict [options]");
  process.exit(3);
}

// ---------------------------------------------------------------- run

async function pageSocket(match) {
  const html = await (await fetch(`http://${args.inspector}/`, { signal: AbortSignal.timeout(5000) })).text();
  for (const [, cells] of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)) {
    const path = /\/socket\/\d+\/\d+\/\w+/.exec(cells)?.[0];
    if (path && cells.includes(match)) return `ws://${args.inspector}${path}`;
  }
  throw new Error(`no inspectable page matches ${match}`);
}

// One inspector connection that answers `evaluate(expression)` with the
// expression's value, and rejects when the page threw.
async function attach(match) {
  const ws = new WebSocket(await pageSocket(match));
  let target = null;
  let next = 1;
  const waiting = new Map();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the inspector named no page target in 8s")), 8000);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page" && !target) {
        target = message.params.targetInfo.targetId;
        clearTimeout(timer);
        resolve();
      } else if (message.method === "Target.dispatchMessageFromTarget") {
        const inner = JSON.parse(message.params.message);
        waiting.get(inner.id)?.(inner);
        waiting.delete(inner.id);
      }
    };
    ws.onerror = () => reject(new Error("cannot reach the inspector"));
  });
  return {
    evaluate(expression) {
      const id = next++;
      const inner = JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the page did not answer in 8s")), 8000);
        waiting.set(id, (answer) => {
          clearTimeout(timer);
          if (answer.error || answer.result?.wasThrown) reject(new Error(JSON.stringify(answer).slice(0, 600)));
          else resolve(answer.result.result.value);
        });
        ws.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId: target, message: inner } }));
      });
    },
    close: () => new Promise((resolve) => { ws.onclose = resolve; ws.close(); setTimeout(resolve, 500); }),
  };
}

// poll <read> until <done> holds or <bound> ms pass; says which, with the
// last value read.
async function poll(read, done, bound) {
  const start = now();
  let value;
  for (;;) {
    value = await read();
    if (done(value)) return { met: true, value, waitedMs: now() - start };
    if (now() - start > bound) return { met: false, value, waitedMs: now() - start };
    await sleep(150);
  }
}

async function run() {
  const groups = (args.arms ?? GROUPS.join(",")).split(",").map((g) => g.trim()).filter(Boolean);
  const want = (group) => groups.includes(group);
  const results = args.results;
  // The image readers' controls run only where an image group is judged.
  const imaging = groups.some((g) => IMAGE_GROUPS.includes(g));
  const record = (row) => appendFileSync(results, `${JSON.stringify(row)}\n`);
  const fixture = args.fixture;
  const fixtureB64 = readFileSync(fixture).toString("base64");
  const shot = (name) => spawnSync("import", ["-window", "root", join(args.work, "shots", `${name}.png`)], { timeout: 20000 });
  const csEnv = { ...process.env };
  const cs = (words, cwd = args.ws) => spawnSync(args.chan, ["shell", ...words], { cwd, env: csEnv, encoding: "utf8", timeout: 20000 });
  record({ arm: "selection", groups });

  // The X CLIPBOARD's owner, one at a time and kept in the foreground so the
  // run can end it; a new owner takes the selection from the old one.
  const owners = [];
  const ownerLog = openSync(join(args.work, "xclip.log"), "a");
  const gtkEnv = { ...process.env, NO_AT_BRIDGE: "1" };
  const targets = () => {
    const out = spawnSync("xclip", ["-selection", "clipboard", "-o", "-t", "TARGETS"], { encoding: "utf8", timeout: 5000 });
    return out.status === 0 ? out.stdout.split("\n").map((t) => t.trim()).filter(Boolean) : null;
  };
  async function seed(kind, text = TEXT_ONLY) {
    for (const owner of owners.splice(0)) owner.kill();
    const io = { stdio: ["ignore", ownerLog, ownerLog] };
    const ownerScript = join(here, "clipboard-owner.py");
    const owner = kind === "xclip"
      ? spawn("xclip", ["-quiet", "-selection", "clipboard", "-t", "image/png", "-i", fixture], io)
      : kind === "text"
        ? spawn("python3", [ownerScript, "text", text], { ...io, env: gtkEnv })
        : spawn("python3", [ownerScript, kind === "gtk-image" ? "image" : "png", fixture], { ...io, env: gtkEnv });
    owners.push(owner);
    const offered = await poll(async () => targets(), (list) => Boolean(list) && OWNERS[kind].offered(list), 5000);
    return { kind, owner: OWNERS[kind].label, offered: offered.met, targets: offered.value };
  }

  let page;
  try {
    page = await attach(args.page);
  } catch (error) {
    record({ arm: "page", error: String(error) });
    process.exit(3);
  }

  let asyncId = 0;
  // Evaluate an expression that may return a promise: the page settles it
  // into a box of its own, which this polls, since the inspector's evaluate
  // returns before a promise settles.
  async function settle(expression, bound = 15000) {
    const id = `a${++asyncId}`;
    await page.evaluate(`(() => {
      const box = (window.__flowsAsync ||= {});
      box[${JSON.stringify(id)}] = { done: false };
      Promise.resolve().then(() => (${expression})).then(
        (value) => { box[${JSON.stringify(id)}] = { done: true, value }; },
        (error) => { box[${JSON.stringify(id)}] = { done: true, error: String((error && error.message) || error) }; });
      return true;
    })()`);
    const answer = await poll(() => page.evaluate(`window.__flowsAsync[${JSON.stringify(id)}]`), (box) => box?.done, bound);
    if (!answer.met) throw new Error(`the page did not settle ${id} in ${bound} ms`);
    if (answer.value.error) throw new Error(answer.value.error);
    return answer.value.value;
  }

  // The witness: the page's own listeners, beside chan's, which change
  // nothing chan's handlers do. A paste or a drop is recorded in the capture
  // phase, before any handler, with the shape its data had, and again once
  // it bubbled, with whether a handler took it. Drags are counted per
  // surface, and the last pointer move is kept for placing X input. Every
  // Ctrl or Meta keydown is kept with whether a handler took it, and every
  // drag start with the tab it lifted. A reload takes the witness with the
  // page, so it is planted again after one.
  const WITNESS = `(() => {
    if (window.__flows) return true;
    const s = (window.__flows = { pastes: [], drops: [], drags: {}, keys: [], chords: [], dragstarts: [], dblclicks: [], statuses: [], lastMove: null });
    addEventListener("keydown", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const row = { at: Math.round(performance.now()), key: e.key, code: e.code, shift: e.shiftKey, alt: e.altKey,
        surface: surface(e.target), target: e.target?.nodeName || null, isTrusted: e.isTrusted, defaultPrevented: null };
      s.chords.push(row);
      setTimeout(() => { row.defaultPrevented = e.defaultPrevented; }, 0);
    }, true);
    addEventListener("dblclick", (e) => {
      s.dblclicks.push({ at: Math.round(performance.now()), isTrusted: e.isTrusted, onRow: Boolean(e.target?.closest?.('[role="option"], [role="treeitem"]')) });
    }, true);
    addEventListener("dragstart", (e) => {
      const tab = e.target?.closest?.('.tab[role="tab"]');
      s.dragstarts.push({ at: Math.round(performance.now()), isTrusted: e.isTrusted, tab: tab ? tab.getAttribute("title") || tab.textContent.trim().slice(0, 80) : null,
        pane: e.target?.closest?.(".pane[data-pane-id]")?.dataset.paneId ?? null });
    }, true);
    // Readers for the arms: a pane's visible editor content (never the
    // composer's), the editor mode it shows, a pane's visible terminal and
    // the backend mounted in it, and the workspace API with the page's own
    // token.
    // Inactive tabs keep their geometry and are hidden by visibility.
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === "visible"; };
    const pane = (id) => id ? document.querySelector('.pane[data-pane-id="' + CSS.escape(id) + '"]') : document;
    window.__flowsHelp = {
      content: (id) => [...(pane(id)?.querySelectorAll(".cm-content") ?? [])].find((c) => !c.closest(".rich-prompt") && visible(c)) ?? null,
      modeOf: (c) => !c ? null : c.closest(".md-source") ? "source" : c.closest(".md-wysiwyg-cm6") ? "rendered" : "other",
      host: (id) => [...(pane(id)?.querySelectorAll(".terminal-host") ?? [])].find(visible) ?? null,
      backendOf: (h) => !h ? null : h.querySelector(".xterm-screen") ? "xterm" : h.querySelector("canvas") ? "ghostty" : "unknown",
      center: (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; },
      api: async (path, init = {}) => {
        const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content")?.replace(/\\/+$/, "") ?? "";
        const token = new URLSearchParams(location.search).get("t") ?? sessionStorage.getItem("chan.token");
        if (!token) throw new Error("the workspace page has no auth token");
        const headers = { authorization: "Bearer " + token, ...(init.body ? { "content-type": "application/json" } : {}) };
        const response = await fetch(prefix + path, { ...init, headers });
        if (!response.ok) throw new Error((init.method || "GET") + " " + path.split("?")[0] + " -> " + response.status);
        return response.json();
      },
    };
    const surface = (node) => node?.closest?.(".rich-prompt") ? "prompt" : node?.closest?.(".cm-editor") ? "editor"
      : node?.closest?.(".terminal-host") ? "terminal" : node?.closest?.("[data-file-drop-zone]") ? "zone" : node?.nodeName ? "outside" : "none";
    const shapeOf = (d) => d ? { types: Array.from(d.types || []), items: d.items?.length ?? null, files: d.files?.length ?? null,
      itemKinds: d.items ? Array.from(d.items).map((i) => i.kind + ":" + i.type) : null,
      fileNames: d.files ? Array.from(d.files).map((f) => f.name + " " + f.type + " " + f.size) : null } : { types: null, items: null, files: null };
    addEventListener("paste", (e) => {
      s.pastes.push({ at: Math.round(performance.now()), surface: surface(e.target), target: e.target?.nodeName || null, isTrusted: e.isTrusted, ...shapeOf(e.clipboardData) });
    }, true);
    addEventListener("paste", (e) => { const last = s.pastes[s.pastes.length - 1]; if (last) last.defaultPrevented = e.defaultPrevented; });
    addEventListener("drop", (e) => {
      s.drops.push({ at: Math.round(performance.now()), surface: surface(e.target), target: e.target?.nodeName || null, isTrusted: e.isTrusted, ...shapeOf(e.dataTransfer) });
    }, true);
    addEventListener("drop", (e) => { const last = s.drops[s.drops.length - 1]; if (last) last.defaultPrevented = e.defaultPrevented; });
    for (const type of ["dragenter", "dragover"]) {
      addEventListener(type, (e) => {
        const key = surface(e.target) + " " + type + " " + (e.isTrusted ? "trusted" : "untrusted");
        s.drags[key] = (s.drags[key] || 0) + 1;
      }, true);
    }
    addEventListener("mousemove", (e) => { s.lastMove = { clientX: e.clientX, clientY: e.clientY, isTrusted: e.isTrusted }; }, true);
    addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) s.keys.push({ at: Math.round(performance.now()), surface: surface(e.target), isTrusted: e.isTrusted });
    }, true);
    let shown = "";
    let queued = false;
    const look = () => {
      queued = false;
      const text = (document.querySelector(".app-statusbar")?.innerText || "").trim();
      if (text !== shown) { shown = text; if (text) s.statuses.push({ at: Math.round(performance.now()), text: text.slice(0, 240) }); }
    };
    new MutationObserver(() => { if (!queued) { queued = true; setTimeout(look, 20); } })
      .observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    return true;
  })()`;
  const plantWitness = () => page.evaluate(WITNESS);
  await plantWitness();
  const marks = () => page.evaluate("({ pastes: window.__flows.pastes.length, drops: window.__flows.drops.length, keys: window.__flows.keys.length, chords: window.__flows.chords.length, dragstarts: window.__flows.dragstarts.length, dblclicks: window.__flows.dblclicks.length, statuses: window.__flows.statuses.length, drags: { ...window.__flows.drags } })");
  const since = (mark) => page.evaluate(`(() => {
    const s = window.__flows;
    const before = ${JSON.stringify(mark.drags)};
    const drags = {};
    for (const [key, count] of Object.entries(s.drags)) if (count > (before[key] || 0)) drags[key] = count - (before[key] || 0);
    return { pastes: s.pastes.slice(${mark.pastes}), drops: s.drops.slice(${mark.drops}), drags, keys: s.keys.slice(${mark.keys}),
      chords: s.chords.slice(${mark.chords}), dragstarts: s.dragstarts.slice(${mark.dragstarts}), dblclicks: s.dblclicks.slice(${mark.dblclicks}), statuses: s.statuses.slice(${mark.statuses}).map((x) => x.text) };
  })()`);

  const facts = await page.evaluate(`({ userAgent: navigator.userAgent, isTauriDesktop: Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__), invoke: typeof window.__TAURI_INTERNALS__?.invoke, origin: location.origin, devicePixelRatio })`);
  record({ arm: "page", ...facts });

  // Decode a file and compare its pixels with the fixture's.
  const pixels = (file) => {
    const id = spawnSync("magick", ["identify", "-format", "%w %h %m", file], { encoding: "utf8" });
    if (id.status !== 0) return { decoded: false, error: id.stderr.trim().slice(0, 200) };
    const [width, height, format] = id.stdout.trim().split(" ");
    const cmp = spawnSync("magick", ["compare", "-metric", "AE", fixture, file, "null:"], { encoding: "utf8" });
    const differing = Number.parseFloat((cmp.stderr || "").trim());
    return { decoded: true, width: Number(width), height: Number(height), format, differingPixels: Number.isFinite(differing) ? differing : null,
      compareStatus: cmp.status, same: cmp.status === 0 && differing === 0 };
  };
  const imagesUnder = (dir) => {
    const found = [];
    const walk = (d) => {
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = join(d, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && IMAGE_FILE.test(entry.name)) found.push(path);
      }
    };
    walk(dir);
    return found.sort();
  };

  // Where X input lands on the page: the offset between a screen point and
  // the client point the page's mousemove reports for it, read at two
  // points, which must agree.
  async function calibrate() {
    const geo = Object.fromEntries((xdo("getwindowgeometry", "--shell", args.xid).stdout || "").trim().split("\n").map((l) => l.split("=")));
    const [x, y, w, h] = ["X", "Y", "WIDTH", "HEIGHT"].map((k) => Number(geo[k]));
    const seen = [];
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.35]]) {
      const sx = Math.round(x + w * fx);
      const sy = Math.round(y + h * fy);
      await page.evaluate("window.__flows.lastMove = null; true");
      xdo("mousemove", sx - 7, sy - 7);
      await sleep(120);
      xdo("mousemove", sx, sy);
      const move = await poll(() => page.evaluate("window.__flows.lastMove"), (m) => m && m.isTrusted, 3000);
      await sleep(120);
      const last = await page.evaluate("window.__flows.lastMove");
      seen.push({ sx, sy, client: move.met ? last : null });
    }
    const offsets = seen.map((p) => p.client ? [p.sx - p.client.clientX, p.sy - p.client.clientY] : null);
    const agree = offsets.every((o) => o && o[0] === offsets[0][0] && o[1] === offsets[0][1]);
    return { window: { x, y, w, h }, seen, offset: agree ? { dx: offsets[0][0], dy: offsets[0][1] } : null };
  }
  let offset = null;
  const toScreen = (point) => {
    if (!offset) throw new Error("X input cannot be placed on the page: the calibration's two points disagreed or the page saw no pointer move");
    return [Math.round(point.x + offset.dx), Math.round(point.y + offset.dy)];
  };

  // A drop point on a surface: inside its last line, scrolled into view, and
  // the element under it named, so a point the surface does not own is seen.
  const dropPoint = (content) => page.evaluate(`(() => {
    const content = ${content};
    if (!content) return null;
    const lines = content.querySelectorAll(".cm-line");
    const line = lines[lines.length - 1] || content;
    line.scrollIntoView({ block: "center" });
    const r = line.getBoundingClientRect();
    const x = Math.round(r.left + Math.min(24, r.width / 2));
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, ownsPoint: Boolean(hit && content.contains(hit)), hit: hit ? hit.nodeName + "." + (hit.className?.baseVal ?? hit.className ?? "") : null };
  })()`);
  // A point in the window that no drop zone owns: the pane's tab strip past
  // its last tab.
  const outsidePoint = () => page.evaluate(`(() => {
    const zone = "[data-file-drop-zone], .cm-editor, input, textarea, [contenteditable]";
    for (const strip of document.querySelectorAll('[role="tablist"]')) {
      const r = strip.getBoundingClientRect();
      if (r.width < 40 || r.height < 8) continue;
      for (const fx of [0.92, 0.8, 0.65]) {
        const x = Math.round(r.left + r.width * fx);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (hit && !hit.closest(zone)) return { x, y, hit: hit.nodeName + "." + (hit.className?.baseVal ?? hit.className ?? "") };
      }
    }
    return null;
  })()`);

  // A real drop over XDND: a GTK window offering a file as text/uri-list,
  // dragged by X input onto a screen point, with the drag source's own
  // account of the drag.
  async function xdndDrop(file, point) {
    const [tx, ty] = toScreen(point);
    let said = "";
    const source = spawn("python3", [join(here, "drag-source.py"), file, "1480", "880"], { stdio: ["ignore", "pipe", ownerLog], env: gtkEnv });
    source.stdout.setEncoding("utf8");
    source.stdout.on("data", (chunk) => { said += chunk; });
    const ready = await poll(async () => said, (text) => /^ready \d+ \d+ \d+ \d+/m.test(text), 10000);
    if (!ready.met) {
      source.kill();
      return { started: false, at: [tx, ty], sourceSaid: said.trim().split("\n") };
    }
    const [sx, sy, sw, sh] = /^ready (\d+) (\d+) (\d+) (\d+)/m.exec(said).slice(1).map(Number);
    const overSource = tx >= sx && tx < sx + sw && ty >= sy && ty < sy + sh;
    const cx = sx + Math.floor(sw / 2);
    const cy = sy + Math.floor(sh / 2);
    xdo("mousemove", cx, cy);
    await sleep(300);
    xdo("mousedown", 1);
    await sleep(200);
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      xdo("mousemove", Math.round(cx + ((tx - cx) * i) / steps), Math.round(cy + ((ty - cy) * i) / steps));
      await sleep(40);
    }
    await sleep(400);
    xdo("mousemove", tx + 1, ty + 1);
    await sleep(300);
    xdo("mousemove", tx, ty);
    await sleep(500);
    xdo("mouseup", 1);
    const ended = await poll(async () => said, (text) => /^(end|failed)/m.test(text), 5000);
    source.kill();
    xdo("windowactivate", "--sync", args.xid);
    return { started: true, at: [tx, ty], overSource, ended: ended.met, sourceSaid: said.trim().split("\n") };
  }

  // A synthetic drop through the inspector: dragenter, dragover and drop as
  // DragEvents whose DataTransfer holds the fixture as a File.
  const syntheticDrop = (name, point) => page.evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(fixtureB64)}), (c) => c.charCodeAt(0));
    const file = new File([bytes], ${JSON.stringify(name)}, { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const target = document.elementFromPoint(${point.x}, ${point.y});
    if (!target) return { dispatched: false };
    const sent = {};
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: ${point.x}, clientY: ${point.y}, dataTransfer: data });
      sent[type] = { carried: event.dataTransfer === data, notCancelled: target.dispatchEvent(event) };
    }
    return { dispatched: true, target: target.nodeName, files: data.files.length, types: Array.from(data.types), sent };
  })()`);

  // 1. The desktop's own clipboard read, asked of it directly through the
  // IPC the paste uses. It names where a fault sits and decides nothing.
  if (want("native")) {
    try {
      const clipboard = await seed("xclip");
      const answer = await settle(`(async () => {
        const bytes = await window.__TAURI_INTERNALS__.invoke("read_clipboard_image");
        if (!bytes) return { bytes: 0 };
        const u8 = new Uint8Array(bytes);
        let bin = "";
        for (const b of u8) bin += String.fromCharCode(b);
        return { bytes: u8.length, base64: btoa(bin) };
      })()`);
      let decoded = null;
      if (answer.base64) {
        const file = join(args.work, "ipc-read.png");
        writeFileSync(file, Buffer.from(answer.base64, "base64"));
        decoded = pixels(file);
      }
      record({ arm: "ipc-read", clipboard, bytes: answer.bytes, pixels: decoded });
    } catch (error) {
      record({ arm: "ipc-read", error: String(error) });
    }
  }

  // The note, opened the way a user's `cs open` does.
  const noteContent = `[...document.querySelectorAll(".cm-content")].find((c) => !c.closest(".rich-prompt") && c.innerText.includes("seed"))`;
  const promptContent = `document.querySelector(".rich-prompt .cm-content")`;
  const embeds = (content) => page.evaluate(`(() => {
    const content = ${content};
    const root = content?.closest(".cm-editor");
    if (!root) return null;
    return [...root.querySelectorAll(".cm-md-image-wrap")].map((w) => {
      const img = w.querySelector("img");
      return { src: w._chanImg?.src ?? null, complete: img ? img.complete : null, naturalWidth: img?.naturalWidth ?? null, naturalHeight: img?.naturalHeight ?? null };
    });
  })()`);

  // The paste shapes. The native one is the vitest's failing WKWebView
  // shape; the file item carries the image as a File, which the handler
  // reads from the event without asking the desktop.
  const NATIVE = `{ types: ["Files"], items: [], files: [], getData: () => "" }`;
  const FILE_ITEM = `(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(fixtureB64)}), (c) => c.charCodeAt(0));
    const image = new File([bytes], "control.png", { type: "image/png" });
    return { types: ["Files"], items: [{ kind: "file", type: image.type, getAsFile: () => image }], files: [image], getData: () => "" };
  })()`;
  const dispatch = (content, shape, onBr) => page.evaluate(`(() => {
    const content = ${content};
    if (!content) return { dispatched: false };
    const target = ${onBr ? `content.querySelector("br") ?? content` : "content"};
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: ${shape} });
    const notCancelled = target.dispatchEvent(event);
    return { dispatched: true, target: target.nodeName, notCancelled, defaultPrevented: event.defaultPrevented };
  })()`);

  // A surface's text, line by line, without the text of its widgets (an
  // image embed's menu, for one), which take no input.
  const lineText = (content) => `(() => {
    const content = ${content};
    if (!content) return "";
    return [...content.querySelectorAll(".cm-line")].map((line) => {
      let text = "";
      const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement?.closest('[contenteditable="false"]')) text += n.data;
      return text;
    }).join("\\n");
  })()`;

  // One landing arm: <act>, then wait for a new embed whose source names
  // <name> and a new image file named <name> under <dir>; a null name takes
  // any new one. An embed that was already there before does not count.
  async function landArm({ arm, surface, content, act, name = null, dir, clipboard, bound = 15000, tag = "" }) {
    const shotName = `${surface}-${arm}${tag ? `-${tag}` : ""}`;
    const filesBefore = imagesUnder(dir);
    const embedsBefore = (await embeds(content)) ?? [];
    const keyBefore = await page.evaluate(pageKey);
    const textBefore = await page.evaluate(lineText(content));
    const named = (text) => name === null || Boolean(text?.includes(name));
    const newEmbed = (shown) => {
      const prior = embedsBefore.map((e) => e.src);
      for (const e of shown) {
        const at = prior.indexOf(e.src);
        if (at >= 0) { prior.splice(at, 1); continue; }
        if (named(e.src) && e.complete && e.naturalWidth > 0) return e;
      }
      return null;
    };
    const mark = await marks();
    shot(`${shotName}-before`);
    const event = await act();
    const landing = await poll(async () => {
      const embed = newEmbed((await embeds(content)) ?? []);
      const file = imagesUnder(dir).filter((f) => !filesBefore.includes(f)).find((f) => named(basename(f))) ?? null;
      return { embed, file };
    }, (seen) => seen.embed && seen.file, bound);
    const landedAt = now();
    // Room for a late notice, or a second image, to show.
    await sleep(1000);
    const seen = await since(mark);
    const newFiles = imagesUnder(dir).filter((f) => !filesBefore.includes(f));
    const after = (await embeds(content)) ?? [];
    const kept = await page.evaluate(pageKept(keyBefore));
    const textAfter = kept ? await page.evaluate(lineText(content)) : "";
    shot(`${shotName}-after`);
    const file = landing.value.file;
    return {
      arm, surface, clipboard, event, witness: seen.pastes, drops: seen.drops, drags: seen.drags, statuses: seen.statuses,
      pasteNotices: seen.statuses.filter((text) => PASTE_NOTICES.some((n) => text.includes(n))),
      landed: landing.met, waitedMs: landing.waitedMs, landedAt, pageKept: kept,
      textGrew: textAfter.length - textBefore.length, textTail: textAfter.slice(-160),
      embed: landing.value.embed, embedsAdded: after.length - embedsBefore.length,
      file: file ? { path: file, ...pixels(file) } : null, newFiles,
    };
  }
  const pasteArm = ({ content, shape, onBr, ...rest }) => landArm({ ...rest, content, act: () => dispatch(content, shape, onBr) });

  // Focus a surface for X input: the window active, the surface's content
  // focused, the caret at its end.
  async function focusForKeys(content) {
    xdo("windowactivate", "--sync", args.xid);
    const focused = await poll(() => page.evaluate(`(() => { const c = ${content}; if (!c) return false; c.focus(); return document.activeElement === c; })()`), Boolean, 5000);
    return focused.met;
  }
  // A real Ctrl+V on a surface under one owner.
  const trustedPaste = (surface, content, dir, kind) => async () => {
    const clipboard = await seed(kind);
    const focused = await focusForKeys(content);
    return landArm({ arm: "paste-trusted", surface, content, dir, clipboard, bound: 8000, tag: kind,
      act: async () => ({ focused, keyStatus: xdo("key", "--clearmodifiers", "ctrl+End", "ctrl+v").status }) });
  };
  // A drop by XDND or through the inspector onto a surface's last line.
  const dropArm = (arm, surface, content, dir) => async () => {
    const name = arm === "drop-xdnd" ? "drop-xdnd" : "drop-synthetic";
    const point = await dropPoint(content);
    if (!point) return { arm, surface, error: "the surface is not on the page" };
    let file = null;
    if (arm === "drop-xdnd") {
      file = join(args.work, `${name}.png`);
      copyFileSync(fixture, file);
    }
    const row = await landArm({ arm, surface, content, dir, name, bound: 10000,
      act: () => (arm === "drop-xdnd" ? xdndDrop(file, point) : syntheticDrop(`${name}.png`, point)) });
    row.point = point;
    return row;
  };

  const opened = cs(["open", args.note]);
  const focused = await poll(() => page.evaluate(`(() => { const c = ${noteContent}; return Boolean(c) && document.activeElement === c; })()`), Boolean, 30000);
  record({ arm: "open-note", status: opened.status, output: (opened.stdout + opened.stderr).trim().slice(0, 300), focused: focused.met, waitedMs: focused.waitedMs });
  await sleep(1000);

  // What the served bundle holds: the native branch's notice text marks
  // the build with the recovery in it.
  try {
    record({ arm: "bundle", ...(await settle(`(async () => {
      const urls = [...new Set(performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.startsWith(location.origin) && /\\.js(\\?|$)/.test(new URL(u).pathname)))];
      const marked = [];
      for (const u of urls) {
        const text = await (await fetch(u)).text();
        if (text.includes(${JSON.stringify(NO_IMAGE)})) marked.push(new URL(u).pathname);
      }
      return { scripts: urls.length, nativeBranchIn: marked };
    })()`, 30000)) });
  } catch (error) {
    record({ arm: "bundle", error: String(error) });
  }
  if (["trusted", "xdnd", "terminal", "open", "panes"].some(want)) {
    const calibration = await calibrate();
    offset = calibration.offset;
    record({ arm: "calibrate", ...calibration });
  }

  const notesDir = join(args.ws, args.note.split("/").slice(0, -1).join("/"));
  const noteFile = join(args.ws, args.note);
  const tryArm = async (arm, surface, body) => {
    try { record(await body()); } catch (error) { record({ arm, surface, error: String(error) }); }
  };

  // 2. The editor's subject, then its controls.
  if (want("native")) {
    await tryArm("paste-native-shape", "editor", async () => {
      const clipboard = await seed("xclip");
      const row = await pasteArm({ arm: "paste-native-shape", surface: "editor", content: noteContent, shape: NATIVE, name: "pasted-image", dir: notesDir, clipboard });
      // The note's own file names the image once it is saved.
      const saved = row.file
        ? await poll(async () => { try { return readFileSync(noteFile, "utf8"); } catch { return ""; } }, (text) => text.includes(basename(row.file.path)), 20000)
        : null;
      row.noteNamesImage = saved ? saved.met : false;
      row.noteSavedAfterLandingMs = saved ? now() - row.landedAt : null;
      row.noteText = (() => { try { return readFileSync(noteFile, "utf8").slice(0, 400); } catch { return null; } })();
      return row;
    });
  }
  if (imaging) {
    await tryArm("paste-file-item", "editor", async () => {
      const clipboard = await seed("xclip");
      return pasteArm({ arm: "paste-file-item", surface: "editor", content: noteContent, shape: FILE_ITEM, name: "control", dir: notesDir, clipboard });
    });
  }
  if (want("native")) {
    await tryArm("paste-text-only", "editor", async () => {
      const clipboard = await seed("text");
      const row = await pasteArm({ arm: "paste-text-only", surface: "editor", content: noteContent, shape: NATIVE, name: "pasted-image", dir: notesDir, clipboard, bound: 6000 });
      row.noImageNotice = row.statuses.some((text) => text.includes(NO_IMAGE));
      return row;
    });
  }
  if (want("trusted")) {
    for (const kind of TRUSTED_OWNERS) await tryArm("paste-trusted", "editor", trustedPaste("editor", noteContent, notesDir, kind));
  }
  if (want("xdnd")) await tryArm("drop-xdnd", "editor", dropArm("drop-xdnd", "editor", noteContent, notesDir));
  if (want("drop")) await tryArm("drop-synthetic", "editor", dropArm("drop-synthetic", "editor", noteContent, notesDir));

  // 3. The Rich Prompt over a terminal running cat, then its control,
  // when an image group is chosen.
  if (imaging) {
    const tab = "basic-flows-cat";
    const terminal = cs(["terminal", "new", "--tab-name", tab, "--command", "cat"]);
    const scrollback = () => {
      const out = cs(["terminal", "scrollback", "--tab-name", tab]);
      return out.status === 0 ? out.stdout : null;
    };
    const live = await poll(async () => scrollback(), (text) => text !== null, 20000);
    await sleep(1500);
    const openPrompt = async () => {
      await page.evaluate(`window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "terminal.richPrompt" } })); true`);
      return poll(() => page.evaluate(`(() => { const c = ${promptContent}; return Boolean(c) && document.activeElement?.closest?.(".rich-prompt") != null; })()`), Boolean, 15000);
    };
    const ensurePrompt = async () => ((await page.evaluate(`Boolean(${promptContent})`)) ? null : (await openPrompt()).met);
    const prompt = await openPrompt();
    record({ arm: "open-prompt", terminalStatus: terminal.status, terminalOutput: (terminal.stdout + terminal.stderr).trim().slice(0, 300),
      scrollbackAnswered: live.met, promptFocused: prompt.met, waitedMs: prompt.waitedMs });

    if (want("native")) {
      await tryArm("paste-native-shape", "prompt", async () => {
        const clipboard = await seed("xclip");
        const row = await pasteArm({ arm: "paste-native-shape", surface: "prompt", content: promptContent, shape: NATIVE, onBr: true, name: "pasted-image", dir: args["chan-home"], clipboard });
        if (!row.file) return row;
        // Submit by X input, as a user does, and read what reached the PTY.
        await page.evaluate(`(() => { ${promptContent}?.focus(); return true; })()`);
        const mark = await marks();
        xdo("windowactivate", "--sync", args.xid);
        const chord = xdo("key", "--clearmodifiers", "ctrl+Return");
        const path = row.file.path;
        const delivered = await poll(async () => scrollback() ?? "", (text) => text.includes(path) || text.replace(/\r?\n/g, "").includes(path), 15000);
        const seen = await since(mark);
        const text = delivered.value;
        row.submit = {
          chordStatus: chord.status, keys: seen.keys, path,
          scrollbackHasPath: delivered.met, onOneLine: text.split(/\r?\n/).some((line) => line.includes(path)), waitedMs: delivered.waitedMs,
          scrollbackTail: text.slice(-600),
        };
        shot("prompt-paste-native-shape-submitted");
        return row;
      });
    }
    const promptControl = (arm) => tryArm(arm, "prompt", async () => {
      const reopened = await ensurePrompt();
      const clipboard = await seed("xclip");
      const row = await pasteArm({ arm, surface: "prompt", content: promptContent, shape: FILE_ITEM, onBr: true, name: "control", dir: args["chan-home"], clipboard });
      row.reopened = reopened;
      return row;
    });
    await promptControl("paste-file-item");

    if (want("trusted")) {
      for (const kind of TRUSTED_OWNERS) {
        await tryArm("paste-trusted", "prompt", async () => {
          const reopened = await ensurePrompt();
          const row = await trustedPaste("prompt", promptContent, args["chan-home"], kind)();
          row.reopened = reopened;
          return row;
        });
      }
      // Recorded, decides nothing: the terminal menu's Paste row, chosen by
      // X input with the composer open, under each owner. The row reads the
      // clipboard's text and writes it to the terminal.
      for (const kind of TRUSTED_OWNERS) {
        await tryArm("menu-paste", "prompt", async () => {
          const reopened = await ensurePrompt();
          const clipboard = await seed(kind);
          const at = await page.evaluate(`(() => {
            const host = [...document.querySelectorAll(".terminal-host")].find((h) => h.getBoundingClientRect().width > 0);
            if (!host) return null;
            const r = host.getBoundingClientRect();
            const top = document.querySelector(".rich-prompt")?.getBoundingClientRect().top ?? r.bottom;
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.max(8, Math.min(40, (top - r.top) / 2))) };
          })()`);
          if (!at) return { arm: "menu-paste", surface: "prompt", clipboard, error: "no terminal on the page" };
          const filesBefore = imagesUnder(args["chan-home"]);
          const embedsBefore = ((await embeds(promptContent)) ?? []).length;
          const before = scrollback() ?? "";
          const mark = await marks();
          xdo("windowactivate", "--sync", args.xid);
          xdo("mousemove", ...toScreen(at));
          await sleep(200);
          xdo("click", 3);
          const menu = await poll(() => page.evaluate(`(() => {
            const menu = document.querySelector('.terminal-tab-menu-bubble[role="menu"]');
            if (!menu) return null;
            const rows = [...menu.querySelectorAll('[role="menuitem"]')];
            const row = rows.find((b) => b.querySelector(".mbtn-label")?.textContent.trim() === "Paste");
            if (!row) return { rows: rows.map((b) => b.textContent.trim()).slice(0, 20) };
            const r = row.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`), (v) => v && v.x !== undefined, 5000);
          shot(`prompt-menu-paste-${kind}-menu`);
          if (menu.met) {
            xdo("mousemove", ...toScreen(menu.value));
            await sleep(150);
            xdo("click", 1);
          }
          await sleep(4000);
          const seen = await since(mark);
          const after = scrollback() ?? "";
          shot(`prompt-menu-paste-${kind}-after`);
          const added = after.startsWith(before) ? after.slice(before.length) : null;
          return { arm: "menu-paste", surface: "prompt", clipboard, reopened, menuOpened: menu.met, menu: menu.value,
            promptShown: await page.evaluate(`Boolean(${promptContent})`),
            embedsAdded: ((await embeds(promptContent)) ?? []).length - embedsBefore,
            newFiles: imagesUnder(args["chan-home"]).filter((f) => !filesBefore.includes(f)),
            scrollbackGrew: after.length - before.length, scrollbackAdded: added === null ? null : added.slice(0, 200),
            witness: seen.pastes, statuses: seen.statuses };
        });
      }
    }
    for (const [arm, group] of [["drop-xdnd", "xdnd"], ["drop-synthetic", "drop"]]) {
      if (want(group)) {
        await tryArm(arm, "prompt", async () => {
          const reopened = await ensurePrompt();
          const row = await dropArm(arm, "prompt", promptContent, args["chan-home"])();
          row.reopened = reopened;
          return row;
        });
      }
    }
    // The control again, after every other arm on the composer.
    if (want("trusted") || want("drop") || want("xdnd")) await promptControl("paste-file-item-late");
  }

  // 4. The rest of the basic flows, by X input. Each arm writes its own
  // uniquely named file and reads the window's layout through `cs`.
  const stamp = Date.now().toString(36);
  const layout = () => {
    const out = cs(["pane", "list", "--json"]);
    if (out.status !== 0) throw new Error(`cs pane list exited ${out.status}: ${(out.stdout + out.stderr).trim().slice(0, 200)}`);
    return JSON.parse(out.stdout);
  };
  const tabsOf = (pane) => ["a", "b"].flatMap((side) => pane?.sides?.[side]?.tabs ?? []);
  const scrollbackOf = (tab) => {
    const out = cs(["terminal", "scrollback", "--tab-name", tab]);
    return out.status === 0 ? out.stdout : null;
  };
  const count = (text, needle) => text.split(needle).length - 1;
  const help = (expression) => page.evaluate(`(() => { const h = window.__flowsHelp; return ${expression}; })()`);
  const command = (name) => page.evaluate(`window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: ${JSON.stringify(name)} } })); true`);
  // The active tab of a pane, as its strip shows it: a file tab's title is
  // its workspace-relative path.
  const activeTab = (paneId) => page.evaluate(`(() => {
    const pane = document.querySelector('.pane[data-pane-id="' + CSS.escape(${JSON.stringify(paneId)}) + '"]');
    const tab = [...(pane?.querySelectorAll('.tab[role="tab"][aria-selected="true"], .tab[role="tab"].active') ?? [])].find((t) => t.getBoundingClientRect().width > 0);
    return tab ? { title: tab.getAttribute("title"), label: tab.querySelector(".path")?.textContent.trim() ?? null } : null;
  })()`);
  const contentText = (paneId) => help(`h.content(${JSON.stringify(paneId)})?.innerText ?? ""`);
  async function clickAt(point, { button = 1, repeat = 1 } = {}) {
    xdo("windowactivate", "--sync", args.xid);
    xdo("mousemove", ...toScreen(point));
    await sleep(150);
    return xdo("click", "--repeat", repeat, "--delay", 90, button).status;
  }
  // A press, a move in steps and a release by X input, as a user's drag.
  async function xdrag(from, to) {
    const [fx, fy] = toScreen(from);
    const [tx, ty] = toScreen(to);
    xdo("windowactivate", "--sync", args.xid);
    xdo("mousemove", fx, fy);
    await sleep(250);
    xdo("mousedown", 1);
    await sleep(200);
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      xdo("mousemove", Math.round(fx + ((tx - fx) * i) / steps), Math.round(fy + ((ty - fy) * i) / steps));
      await sleep(40);
    }
    await sleep(400);
    xdo("mousemove", tx + 1, ty + 1);
    await sleep(300);
    xdo("mousemove", tx, ty);
    await sleep(400);
    return xdo("mouseup", 1).status;
  }
  // Reload the window and attach to the new page, with the witness planted
  // again.
  async function reloadPage(why) {
    const started = now();
    await page.evaluate("setTimeout(() => location.reload(), 50); true");
    await page.close();
    await sleep(1500);
    const back = await poll(async () => {
      let next = null;
      try {
        next = await attach(args.page);
        if (await next.evaluate("document.readyState === 'complete' && Boolean(document.querySelector('.pane[data-pane-id]'))")) return next;
      } catch {
        // Not back yet.
      }
      await next?.close();
      return null;
    }, Boolean, 60000);
    if (!back.met) throw new Error(`the page did not come back from the reload for ${why} in 60 s`);
    page = back.value;
    await plantWitness();
    // Room for the restored tabs to mount.
    await sleep(1500);
    return now() - started;
  }
  // The terminal menu's Paste row, chosen by X input at a point.
  async function menuPaste(at, tag) {
    await clickAt(at, { button: 3 });
    const menu = await poll(() => page.evaluate(`(() => {
      const menu = document.querySelector('.terminal-tab-menu-bubble[role="menu"]');
      if (!menu) return null;
      const rows = [...menu.querySelectorAll('[role="menuitem"]')];
      const row = rows.find((b) => b.querySelector(".mbtn-label")?.textContent.trim() === "Paste");
      if (!row) return { rows: rows.map((b) => b.textContent.trim()).slice(0, 20) };
      return window.__flowsHelp.center(row);
    })()`), (v) => v && v.x !== undefined, 5000);
    shot(`${tag}-menu`);
    if (menu.met) await clickAt(menu.value);
    return { opened: menu.met, at: menu.value };
  }

  // The terminal: per backend, a command typed by X input whose output only
  // the shell computes, then a text pasted by Ctrl+Shift+V and by the menu
  // into cat -v under bracketed paste, read from the PTY's own scrollback.
  async function writeBackend(ghostty) {
    return settle(`(async () => {
      const api = window.__flowsHelp.api;
      const config = await api("/api/config");
      await api("/api/config", { method: "PATCH", body: JSON.stringify({ expected_revision: config.revision,
        preferences: { terminal: { ...config.preferences.terminal, ghostty: ${ghostty} } } }) });
      return true;
    })()`);
  }
  async function terminalArm(backend) {
    const row = { arm: "terminal", surface: backend };
    await writeBackend(backend === "ghostty");
    row.reloadMs = await reloadPage(`the ${backend} backend`);
    const tab = `basic-flows-${backend}-${stamp}`;
    const made = cs(["terminal", "new", "--tab-name", tab]);
    row.terminalNew = { status: made.status, output: (made.stdout + made.stderr).trim().slice(0, 200) };
    const paneId = layout().activePaneId;
    const pid = JSON.stringify(paneId);
    const mounted = await poll(() => help(`h.backendOf(h.host(${pid}))`), (b) => BACKENDS.includes(b), 15000);
    row.backend = mounted.value;
    const live = await poll(async () => scrollbackOf(tab), (text) => Boolean(text), 15000);
    row.shellAnswered = live.met;
    if (row.backend !== backend || !live.met) return row;
    await sleep(800);
    const host = await help(`h.center(h.host(${pid}))`);
    const focus = async () => {
      await clickAt(host);
      return (await poll(() => help(`document.activeElement?.closest?.(".terminal-host") === h.host(${pid})`), Boolean, 3000)).met;
    };

    // Input and output. The typed line holds M$((6*7)); only the shell's
    // answer holds M42.
    row.focused = await focus();
    const typed = xdo("type", "--delay", "12", "echo M$((6*7))");
    xdo("key", "Return");
    const io = await poll(async () => scrollbackOf(tab) ?? "", (text) => text.includes("M42"), 10000);
    row.io = { typeStatus: typed.status, met: io.met, waitedMs: io.waitedMs, tail: io.value.replace(/\r/g, "").slice(-200) };
    shot(`terminal-${backend}-io`);

    // cat -v under bracketed paste, with echo off and bytes read as they
    // come, so each paste shows once and whole. The setup goes in by the
    // PTY, not X input, and prints a word the typed line does not hold.
    cs(["terminal", "write", "--tab-name", tab, "stty -echo -icanon; printf 'BF%sREADY\\033[?2004h' -; exec cat -v\n"]);
    const ready = await poll(async () => scrollbackOf(tab) ?? "", (text) => text.includes("BF-READY"), 10000);
    // The reader's control: a bracketed pair written by the PTY must show
    // in the scrollback as cat -v prints it.
    const before = (scrollbackOf(tab) ?? "").replace(/\r/g, "");
    cs(["terminal", "write", "--tab-name", tab, "\x1b[200~reader control\x1b[201~"]);
    const control = await poll(async () => (scrollbackOf(tab) ?? "").replace(/\r/g, ""), (text) => count(text, bracketed("reader control")) > count(before, bracketed("reader control")), 8000);
    row.pty = { ready: ready.met, control: control.met };

    // A paste lands once and whole: one more bracketed pair holding the text.
    const pasted = async (act, tag) => {
      const clipboard = await seed("text", PASTE_TEXT);
      const focused = await focus();
      const prior = (scrollbackOf(tab) ?? "").replace(/\r/g, "");
      const mark = await marks();
      const acted = await act();
      const landed = await poll(async () => (scrollbackOf(tab) ?? "").replace(/\r/g, ""), (text) => count(text, "^[[201~") > count(prior, "^[[201~"), 6000);
      // Room for a second copy to show.
      await sleep(1000);
      const after = (scrollbackOf(tab) ?? "").replace(/\r/g, "");
      const seen = await since(mark);
      shot(`terminal-${backend}-${tag}`);
      return { clipboard, focused, acted, waitedMs: landed.waitedMs,
        opens: count(after, "^[[200~") - count(prior, "^[[200~"), closes: count(after, "^[[201~") - count(prior, "^[[201~"),
        whole: count(after, bracketed(PASTE_TEXT)) - count(prior, bracketed(PASTE_TEXT)), tail: after.slice(-200),
        witness: seen.pastes.filter((p) => p.surface === "terminal"), chords: seen.chords.filter((c) => c.code === "KeyV"), statuses: seen.statuses };
    };
    row.chord = await pasted(async () => ({ keyStatus: xdo("key", "--clearmodifiers", "ctrl+shift+v").status }), "chord");
    row.menu = await pasted(() => menuPaste(host, `terminal-${backend}`), "menu");
    return row;
  }

  // The editor: typing by X input in a note's rendered mode, then in its
  // source mode after the mode chord, each until the note's file holds it;
  // then a reload, which must show both in the editor in both modes. Under
  // document sessions (the default) the server writes the file; with them
  // off, the page's own autosave does.
  async function editorArm(mode) {
    const row = { arm: "editor", surface: mode };
    const off = mode === "classic";
    if (off !== ((await page.evaluate(`localStorage.getItem("chan.docsync")`)) === "0")) {
      await page.evaluate(off ? `localStorage.setItem("chan.docsync", "0"); true` : `localStorage.removeItem("chan.docsync"); true`);
      row.reloadForFlagMs = await reloadPage(`document sessions ${off ? "off" : "on"}`);
    }
    row.docsync = await page.evaluate(`localStorage.getItem("chan.docsync")`);
    const rel = `notes/editor-${mode}-${stamp}.md`;
    const file = join(args.ws, rel);
    const seedLine = `seed ${mode}`;
    writeFileSync(file, `# Editor\n\n${seedLine}\n`);
    const fileText = () => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
    const opened = cs(["open", rel]);
    let paneId = layout().activePaneId;
    const modeNow = () => help(`(() => { const c = h.content(${JSON.stringify(paneId)}); return c ? { mode: h.modeOf(c), text: c.innerText } : null; })()`);
    const ready = await poll(modeNow, (v) => Boolean(v?.text.includes(seedLine)), 20000);
    row.open = { status: opened.status, met: ready.met, mode: ready.value?.mode ?? null };
    if (!ready.met) return row;
    const markerA = `bfa${stamp}${mode[0]}`;
    const markerB = `bfb${stamp}${mode[0]}`;
    row.markers = [markerA, markerB];

    const typeAndWait = async (text, keysBefore, keysAfter) => {
      const focused = await focusForKeys(`window.__flowsHelp.content(${JSON.stringify(paneId)})`);
      const inFileBefore = fileText().includes(text);
      xdo("key", "--clearmodifiers", ...keysBefore);
      await sleep(150);
      const mark = await marks();
      const typed = xdo("type", "--delay", "12", text);
      for (const key of keysAfter) xdo("key", "--clearmodifiers", key);
      const held = await poll(() => contentText(paneId), (t) => t.includes(text), 5000);
      const onDisk = await poll(async () => fileText(), (t) => t.includes(text), 20000);
      return { focused, typeStatus: typed.status, mode: (await modeNow())?.mode ?? null, editorHeld: held.met, inFileBefore,
        inFile: onDisk.met, fileAfterMs: onDisk.waitedMs, chords: (await since(mark)).chords, fileTail: onDisk.value.slice(-160) };
    };
    // The mode chord, by X input into the focused editor.
    const toggle = async (from) => {
      await focusForKeys(`window.__flowsHelp.content(${JSON.stringify(paneId)})`);
      const mark = await marks();
      xdo("key", "--clearmodifiers", "ctrl+e");
      const flipped = await poll(modeNow, (v) => Boolean(v) && v.mode !== from, 5000);
      return { from, met: flipped.met, mode: flipped.value?.mode ?? null, waitedMs: flipped.waitedMs, text: flipped.value?.text ?? "", chords: (await since(mark)).chords };
    };

    row.rendered = await typeAndWait(markerA, ["ctrl+End"], []);
    shot(`editor-${mode}-rendered`);
    row.toggle = await toggle(row.rendered.mode);
    // A heading in Markdown's own syntax, then Ctrl+S, which chan leaves
    // unbound (the autosave writes); the file must hold the line as typed.
    row.source = row.toggle.met ? await typeAndWait(`## ${markerB}`, ["ctrl+End", "Return"], ["ctrl+s"]) : null;
    shot(`editor-${mode}-source`);
    // Room for the layout, which holds each tab's mode, to be saved.
    await sleep(1200);
    row.reloadMs = await reloadPage(`the ${mode} note`);
    paneId = layout().activePaneId;
    const back = await poll(modeNow, (v) => Boolean(v?.text.includes(markerA) && v.text.includes(markerB)), 15000);
    row.afterReload = { met: back.met, mode: back.value?.mode ?? null, tail: (back.value?.text ?? "").slice(-200) };
    shot(`editor-${mode}-reloaded`);
    const other = await toggle(back.value?.mode ?? null);
    row.afterReloadOther = { met: other.met && other.text.includes(markerA) && other.text.includes(markerB), mode: other.mode, tail: other.text.slice(-200) };
    row.fileFinal = fileText().slice(-300);
    return row;
  }

  if (want("open")) {
    await tryArm("open", "files", async () => {
      // The Files browser opens on a folder of its own, as `cs open DIR`
      // does, so the row is in the listing whatever tab was active.
      const name = `open-target-${stamp}.md`;
      const body = `open target body ${stamp}`;
      mkdirSync(join(args.ws, "open"), { recursive: true });
      writeFileSync(join(args.ws, "open", name), `# Open target\n\n${body}\n`);
      const browser = cs(["open", "open"]);
      if (browser.status !== 0) return { arm: "open", surface: "files", error: `cs open of the folder exited ${browser.status}: ${(browser.stdout + browser.stderr).trim().slice(0, 200)}` };
      const row = await poll(() => page.evaluate(`(() => {
        const rows = [...document.querySelectorAll('[role="listbox"][aria-label="Directory contents"] [role="option"]')].filter((r) => r.getBoundingClientRect().width > 0);
        const row = rows.find((r) => r.querySelector("button.name")?.textContent.trim() === ${JSON.stringify(name)});
        if (!row) return null;
        row.scrollIntoView({ block: "center" });
        const r = (row.querySelector("button.name") ?? row).getBoundingClientRect();
        return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2), rows: rows.length };
      })()`), Boolean, 15000);
      shot("open-files");
      if (!row.met) return { arm: "open", surface: "files", error: `the Files browser showed no row for ${name}` };
      const mark = await marks();
      const clickStatus = await clickAt(row.value, { repeat: 2 });
      const opened = await poll(async () => {
        const l = layout();
        const pane = l.panes.find((p) => p.id === l.activePaneId);
        return { tab: await activeTab(l.activePaneId), hasBody: (await contentText(l.activePaneId)).includes(body),
          csTab: tabsOf(pane).find((t) => t.active && t.kind === "file") ?? null };
      }, (v) => v.tab?.title === `open/${name}` && v.hasBody, 10000);
      shot("open-opened");
      return { arm: "open", surface: "files", file: `open/${name}`, row: row.value, clickStatus, opened: opened.met, waitedMs: opened.waitedMs,
        after: opened.value, ...(({ dblclicks, statuses }) => ({ dblclicks, statuses }))(await since(mark)) };
    });
  }

  if (want("search")) {
    await tryArm("search", "search", async () => {
      const token = `bfsearch${stamp}`;
      const rel = `search/target-${stamp}.md`;
      mkdirSync(join(args.ws, "search"), { recursive: true });
      writeFileSync(join(args.ws, rel), `# Search target\n\nthe hit holds ${token} in its text\n`);
      // The server indexes a new file after a short debounce; the query is
      // typed once the index answers it.
      const indexed = await poll(async () => {
        try { return JSON.stringify(await settle(`window.__flowsHelp.api("/api/search/content?q=" + encodeURIComponent(${JSON.stringify(token)}))`)); } catch (error) { return String(error); }
      }, (text) => text.includes(basename(rel)), 30000);
      const out = { arm: "search", surface: "search", file: rel, query: token, indexed: indexed.met, indexWaitedMs: indexed.waitedMs };
      if (!indexed.met) return { ...out, indexAnswer: indexed.value.slice(0, 300) };
      const input = `document.querySelector('[role="dialog"][aria-label="Search"] input')`;
      const inputFocused = () => page.evaluate(`(() => { const i = ${input}; return Boolean(i) && document.activeElement === i; })()`);
      xdo("windowactivate", "--sync", args.xid);
      const mark = await marks();
      xdo("key", "--clearmodifiers", "ctrl+alt+s");
      let shown = await poll(inputFocused, Boolean, 5000);
      out.chordOpened = shown.met;
      out.chords = (await since(mark)).chords;
      if (!shown.met) {
        await command("app.search.toggle");
        shown = await poll(inputFocused, Boolean, 5000);
      }
      out.opened = shown.met;
      if (!shown.met) return out;
      out.typeStatus = xdo("type", "--delay", "12", token).status;
      const hits = await poll(() => page.evaluate(`(() => {
        const hits = [...document.querySelectorAll(".search .hits li")];
        return { count: hits.length, paths: hits.slice(0, 5).map((li) => li.querySelector(".path")?.textContent.trim() ?? null),
          status: document.querySelector(".search .status-line")?.innerText.trim() ?? null, query: ${input}?.value ?? null };
      })()`), (v) => v.paths.some((p) => p?.includes(basename(rel))), 15000);
      out.hits = { met: hits.met, waitedMs: hits.waitedMs, ...hits.value };
      shot("search-hits");
      if (!hits.met) return out;
      xdo("key", "Return");
      const opened = await poll(async () => {
        const l = layout();
        return { tab: await activeTab(l.activePaneId), hasToken: (await contentText(l.activePaneId)).includes(token),
          dialog: await page.evaluate(`Boolean(document.querySelector('[role="dialog"][aria-label="Search"]'))`) };
      }, (v) => v.tab?.title === rel && v.hasToken, 10000);
      shot("search-opened");
      return { ...out, hitOpened: opened.met, waitedMs: opened.waitedMs, after: opened.value };
    });
  }

  if (want("panes")) {
    await tryArm("panes", "panes", async () => {
      const rel = `notes/drag-${stamp}.md`;
      const title = basename(rel);
      writeFileSync(join(args.ws, rel), "# Drag\n\nthe tab that moves\n");
      const opened = cs(["open", rel]);
      const before = layout();
      const p0 = before.activePaneId;
      const ready = await poll(async () => (await activeTab(p0))?.title === rel, Boolean, 15000);
      const out = { arm: "panes", surface: "panes", file: rel, panesBefore: before.panes.length, p0 };
      if (!ready.met) return { ...out, error: `${rel} did not open in the active pane (${(opened.stdout + opened.stderr).trim().slice(0, 200)})` };
      const paneTitles = (l, id) => tabsOf(l.panes.find((p) => p.id === id)).map((t) => t.title);

      // Split by chord, from the open note.
      await focusForKeys(`window.__flowsHelp.content(${JSON.stringify(p0)})`);
      let mark = await marks();
      xdo("key", "--clearmodifiers", "ctrl+alt+slash");
      const split = await poll(async () => layout(), (l) => l.panes.length === before.panes.length + 1, 6000);
      const p1 = split.met ? split.value.panes.find((p) => !before.panes.some((q) => q.id === p.id))?.id ?? null : null;
      out.split = { met: split.met, waitedMs: split.waitedMs, panes: split.value.panes.length, p1, activePaneId: split.value.activePaneId, chords: (await since(mark)).chords };
      shot("panes-split");
      if (!p1) return out;

      // Focus by a click on the first pane's body.
      const paneBody = (id) => page.evaluate(`(() => {
        const p = document.querySelector('.pane[data-pane-id="' + CSS.escape(${JSON.stringify(id)}) + '"]');
        const b = p?.querySelector(".editor-wrap") ?? p;
        return b ? window.__flowsHelp.center(b) : null;
      })()`);
      const at0 = await paneBody(p0);
      const clickStatus = at0 ? await clickAt(at0) : null;
      const focused = await poll(async () => layout().activePaneId, (id) => id === p0, 5000);
      out.focus = { from: split.value.activePaneId, met: focused.met, activePaneId: focused.value, point: at0, clickStatus };

      // Drag the note's tab onto the other pane's tab strip.
      const points = await page.evaluate(`(() => {
        const pane = (id) => document.querySelector('.pane[data-pane-id="' + CSS.escape(id) + '"]');
        const tab = [...pane(${JSON.stringify(p0)})?.querySelectorAll('.tab[role="tab"]') ?? []].find((t) => t.getAttribute("title") === ${JSON.stringify(rel)} && t.getBoundingClientRect().width > 0);
        const strip = [...pane(${JSON.stringify(p1)})?.querySelectorAll(".tabs") ?? []].find((s) => s.getBoundingClientRect().width > 0);
        if (!tab || !strip) return { tab: Boolean(tab), strip: Boolean(strip) };
        const r = strip.getBoundingClientRect();
        const tabs = strip.querySelectorAll('.tab[role="tab"]');
        const last = tabs.length ? tabs[tabs.length - 1].getBoundingClientRect().right : r.left;
        const x = Math.round(Math.min(r.right - 12, Math.max(last + 30, r.left + r.width * 0.5)));
        return { from: window.__flowsHelp.center(tab), to: { x, y: Math.round(r.top + r.height / 2) }, tab: true, strip: true };
      })()`);
      mark = await marks();
      const dragStatus = points.from ? await xdrag(points.from, points.to) : null;
      const moved = await poll(async () => layout(), (l) => paneTitles(l, p1).includes(title) && !paneTitles(l, p0).includes(title), 8000);
      const seen = await since(mark);
      out.drag = { points, dragStatus, met: moved.met, waitedMs: moved.waitedMs, p0Tabs: paneTitles(moved.value, p0), p1Tabs: paneTitles(moved.value, p1),
        activePaneId: moved.value.activePaneId, dragstarts: seen.dragstarts, drops: seen.drops.map((d) => ({ surface: d.surface, isTrusted: d.isTrusted, types: d.types })) };
      shot("panes-dragged");

      // Close by chord: the other pane's tabs one by one, then the emptied
      // pane, each only while that pane is the active one.
      const closes = [];
      for (let i = 0; i < 4; i++) {
        const l = layout();
        if (!l.panes.some((p) => p.id === p1)) break;
        if (l.activePaneId !== p1) {
          const at1 = await paneBody(p1);
          if (at1) await clickAt(at1);
          const active = await poll(async () => layout().activePaneId, (id) => id === p1, 3000);
          if (!active.met) { closes.push({ refused: "the other pane did not become active" }); break; }
        }
        const prior = layout();
        mark = await marks();
        xdo("windowactivate", "--sync", args.xid);
        xdo("key", "--clearmodifiers", "ctrl+shift+w");
        const changed = await poll(async () => layout(), (n) => JSON.stringify(n.panes.map((p) => [p.id, tabsOf(p).length])) !== JSON.stringify(prior.panes.map((p) => [p.id, tabsOf(p).length])), 4000);
        closes.push({ changed: changed.met, panes: changed.value.panes.length, p1Tabs: paneTitles(changed.value, p1), chords: (await since(mark)).chords });
        if (!changed.met) break;
      }
      const after = layout();
      out.close = { closes, panes: after.panes.length, p1Gone: !after.panes.some((p) => p.id === p1), p0Kept: after.panes.some((p) => p.id === p0) };
      shot("panes-closed");
      return out;
    });
  }

  if (want("editor")) {
    const flag = await page.evaluate(`localStorage.getItem("chan.docsync")`);
    for (const mode of ["session", "classic"]) await tryArm("editor", mode, () => editorArm(mode));
    // The page's document-session flag as it was.
    if ((await page.evaluate(`localStorage.getItem("chan.docsync")`)) !== flag) {
      await page.evaluate(flag === null ? `localStorage.removeItem("chan.docsync"); true` : `localStorage.setItem("chan.docsync", ${JSON.stringify(flag)}); true`);
      await reloadPage("the document-session flag restored");
    }
  }

  if (want("terminal")) {
    const ghostty = await settle(`window.__flowsHelp.api("/api/config").then((c) => c.preferences?.terminal?.ghostty ?? false)`);
    for (const backend of BACKENDS) await tryArm("terminal", backend, () => terminalArm(backend));
    // The backend preference as it was.
    await writeBackend(Boolean(ghostty));
  }

  // 5. A real drop where no zone takes it, last: it must leave the window
  // on its page and upload nothing.
  if (want("xdnd")) {
    await tryArm("drop-outside", "outside", async () => {
      const point = await outsidePoint();
      if (!point) return { arm: "drop-outside", surface: "outside", error: "no point outside every drop zone was found" };
      const file = join(args.work, "drop-outside.png");
      copyFileSync(fixture, file);
      const before = [...imagesUnder(args.ws), ...imagesUnder(args["chan-home"])];
      const keyBefore = await page.evaluate(pageKey);
      const mark = await marks();
      const drag = await xdndDrop(file, point);
      await sleep(2000);
      shot("outside-drop-outside-after");
      // Where the window is now, without the URL's search, which holds the
      // page's token.
      const state = await poll(() => page.evaluate(`({ kept: ${pageKept(keyBefore)}, sameDocument: Boolean(window.__flows),
        where: location.protocol + "//" + location.host + location.pathname, title: document.title.slice(0, 120) })`).catch(() => null), Boolean, 5000);
      const seen = state.value?.sameDocument ? await since(mark) : null;
      const after = [...imagesUnder(args.ws), ...imagesUnder(args["chan-home"])];
      return { arm: "drop-outside", surface: "outside", point, event: drag, pageAnswered: state.met, pageKept: state.value?.kept ?? null,
        sameDocument: state.value?.sameDocument ?? null, where: state.value?.kept ? null : state.value?.where ?? null, title: state.value?.kept ? null : state.value?.title ?? null,
        drops: seen?.drops ?? null, drags: seen?.drags ?? null, statuses: seen?.statuses ?? null,
        newFiles: after.filter((f) => !before.includes(f)) };
    });
  }

  for (const owner of owners.splice(0)) owner.kill();
  await page.close();
  process.exit(0);
}

// ---------------------------------------------------------------- verdict

function verdict() {
  const rows = existsSync(args.results) && statSync(args.results).size
    ? readFileSync(args.results, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
  const find = (arm, surface) => rows.find((r) => r.arm === arm && (surface === undefined || r.surface === surface));
  const all = (arm, surface) => rows.filter((r) => r.arm === arm && (surface === undefined || r.surface === surface));
  const page = find("page");
  const tag = `(WebKitGTK ${args.webkit}; ${page?.userAgent ?? "no user agent read"})`;
  const say = (line) => console.log(`${line} ${tag}`);
  if (!page || page.error) {
    say(`INCONCLUSIVE: the page did not answer: ${page?.error ?? "no record"}`);
    process.exit(3);
  }
  const groups = find("selection")?.groups;
  if (!groups?.length || groups.some((g) => !GROUPS.includes(g))) {
    say(`INCONCLUSIVE: the records name no valid arm selection (${JSON.stringify(groups ?? null)})`);
    process.exit(3);
  }
  const want = (group) => groups.includes(group);
  // The handler reads the desktop's clipboard only in a Tauri page; in any
  // other page no subject is judged.
  const pageWhy = page.isTauriDesktop && page.invoke === "function" ? null : "the page is not a Tauri desktop page with an invoke bridge";
  const outcome = {};

  const bundle = find("bundle");
  say(bundle?.error ? `RECORDED, bundle: unreadable: ${bundle.error}`
    : `RECORDED, bundle: the served scripts ${bundle?.nativeBranchIn?.length ? `hold the native recovery (${bundle.nativeBranchIn.join(", ")})` : "hold no native recovery"} across ${bundle?.scripts ?? 0} scripts`);

  const shapeText = (p) => `{types ${JSON.stringify(p.types)}, items ${p.items} ${JSON.stringify(p.itemKinds ?? null)}, files ${p.files}${p.fileNames?.length ? ` ${JSON.stringify(p.fileNames)}` : ""}, trusted ${p.isTrusted}, ${p.defaultPrevented === undefined ? "stopped before the window" : `taken ${p.defaultPrevented}`}}`;
  // Landed: the surface shows the uploaded file itself, and the file holds
  // the fixture's pixels, with no notice from the paste path.
  const landedWell = (row) => Boolean(row.embed && row.file?.same && !row.pasteNotices.length
    && row.embed.naturalWidth === row.file.width && row.embed.naturalHeight === row.file.height);
  const describe = (row) => {
    const parts = [];
    parts.push(row.embed ? `embed ${row.embed.src} at ${row.embed.naturalWidth}x${row.embed.naturalHeight}` : "no embed");
    parts.push(row.file ? `${basename(row.file.path)} ${row.file.width}x${row.file.height} ${row.file.same ? "with the fixture's pixels" : `${row.file.differingPixels ?? "?"} pixels differ`}` : "no file");
    parts.push(row.pasteNotices.length ? `notices ${JSON.stringify(row.pasteNotices)}` : "no notice");
    return parts.join(", ");
  };

  // The file-item controls, each surface's first: they say whether the
  // readers can see a landed image there. Every one of a surface's must hold.
  // They run only where an image group is chosen.
  const controlHeld = {};
  for (const surface of groups.some((g) => IMAGE_GROUPS.includes(g)) ? ["editor", "prompt"] : []) {
    const controls = rows.filter((r) => r.surface === surface && r.arm?.startsWith("paste-file-item"));
    controlHeld[surface] = controls.length > 0;
    if (!controls.length) say(`INCONCLUSIVE, ${surface} paste-file-item: no record`);
    for (const control of controls) {
      if (control.error) {
        controlHeld[surface] = false;
        say(`INCONCLUSIVE, ${surface} ${control.arm}: ${control.error}`);
      } else if (landedWell(control)) {
        say(`CONTROL HELD, ${surface} ${control.arm}: ${describe(control)}`);
      } else {
        controlHeld[surface] = false;
        say(`INCONCLUSIVE, ${surface} ${control.arm}: a File item did not land, so the readers cannot see a landed image: ${describe(control)}`);
      }
    }
  }

  if (want("native")) outcome.native = judgeNative();
  if (want("trusted")) outcome.trusted = judgeTrusted();
  if (want("drop")) outcome.drop = judgeDrops(["drop-synthetic"]);
  if (want("xdnd")) outcome.xdnd = judgeDrops(["drop-xdnd"], true);
  if (want("open")) outcome.open = judgeOpen();
  if (want("search")) outcome.search = judgeSearch();
  if (want("panes")) outcome.panes = judgePanes();
  if (want("editor")) outcome.editor = judgeEditor();
  if (want("terminal")) outcome.terminal = judgeTerminal();

  const states = Object.values(outcome);
  if (states.includes("fault")) process.exit(10);
  if (states.every((s) => s === "held")) {
    say(`PASS: ${groups.map((g) => ({ native: "an image pasted with WKWebView's empty-Files clipboard shape landed in the editor and in the Rich Prompt through the desktop's clipboard read", trusted: "a real Ctrl+V landed the clipboard's image in the editor and in the Rich Prompt under every owner", drop: "a synthetic image file drop landed in the editor and in the Rich Prompt", xdnd: "a real image file drop landed in the editor and in the Rich Prompt, and one outside every drop zone left the window on its page and uploaded nothing",
      terminal: "on both terminal backends a typed command ran and a text pasted by Ctrl+Shift+V and by the menu reached the PTY once and whole",
      editor: "text typed in a note's rendered and source modes reached its file under document sessions and under the page's autosave, and a reload showed it in both modes",
      open: "a double-click on a Files row opened the file in the editor",
      search: "a query typed into Search found the file and Enter opened it on the hit",
      panes: "a pane split by chord, took focus by click, received a tab dragged from the other pane and closed by chord" })[g]).join("; ")}`);
    process.exit(0);
  }
  process.exit(3);

  // The injected WKWebView shape, as the first stage defined it.
  function judgeNative() {
    const ipc = find("ipc-read");
    const ipcLine = ipc?.error ? `failed: ${ipc.error}`
      : !ipc?.bytes ? "the desktop returned no image"
        : `the desktop returned ${ipc.bytes} bytes, ${ipc.pixels?.width}x${ipc.pixels?.height}, ${ipc.pixels?.same ? "the fixture's pixels" : `${ipc.pixels?.differingPixels ?? "unknown"} pixels differ from the fixture`}`;
    say(`RECORDED, ipc-read: read_clipboard_image asked directly with the PNG on the X clipboard (${ipc?.clipboard?.offered ? "offered" : "NOT offered"}): ${ipcLine}`);

    // The injected shape reached the page as built: one untrusted paste on
    // the surface, advertising Files with no items, files or text.
    const shapeArrived = (row) => {
      const seen = (row.witness ?? []).filter((p) => p.surface === row.surface);
      return seen.length === 1 && !seen[0].isTrusted && JSON.stringify(seen[0].types) === '["Files"]' && seen[0].items === 0 && seen[0].files === 0;
    };
    const subjects = {};
    for (const surface of ["editor", "prompt"]) {
      const subject = find("paste-native-shape", surface);
      if (!subject || subject.error) {
        subjects[surface] = "inconclusive";
        say(`INCONCLUSIVE, ${surface} paste-native-shape: ${subject?.error ?? "no record"}`);
        continue;
      }
      const why = pageWhy ? pageWhy
        : !subject.clipboard?.offered ? "the X clipboard did not offer image/png"
          : !subject.event?.dispatched ? "the paste target was not on the page"
            : !shapeArrived(subject) ? `the page saw ${JSON.stringify(subject.witness)} rather than one injected empty-Files paste`
              : !controlHeld[surface] ? "its control did not land an image"
                : null;
      if (why) {
        subjects[surface] = "inconclusive";
        say(`INCONCLUSIVE, ${surface} paste-native-shape: ${why}; ${describe(subject)}`);
        continue;
      }
      if (!landedWell(subject)) {
        subjects[surface] = "fault";
        const what = !subject.embed && !subject.file ? `landed no image within ${subject.waitedMs} ms` : "did not land the clipboard's image cleanly";
        say(`FAULT, ${surface} paste-native-shape: the injected WKWebView shape ${what}: ${describe(subject)}`);
        continue;
      }
      if (surface === "editor") {
        if (!subject.noteNamesImage) {
          subjects[surface] = "fault";
          say(`FAULT, editor paste-native-shape: the image landed (${describe(subject)}) but the note's file did not name it ${subject.noteSavedAfterLandingMs} ms after the image landed`);
          continue;
        }
        subjects[surface] = "held";
        say(`HELD, editor paste-native-shape: ${describe(subject)}; the note's file named it within ${subject.noteSavedAfterLandingMs} ms of the image landing`);
        continue;
      }
      const submit = subject.submit;
      const chordArrived = submit?.keys?.some((k) => k.surface === "prompt" && k.isTrusted);
      if (!submit || !chordArrived) {
        subjects[surface] = "inconclusive";
        say(`INCONCLUSIVE, prompt paste-native-shape: the image landed (${describe(subject)}) but no trusted Ctrl+Enter reached the composer (${JSON.stringify(submit?.keys ?? null)})`);
      } else if (!submit.scrollbackHasPath) {
        subjects[surface] = "fault";
        say(`FAULT, prompt paste-native-shape: the image landed (${describe(subject)}) but its absolute path was not in the terminal ${submit.waitedMs} ms after Ctrl+Enter`);
      } else {
        subjects[surface] = "held";
        say(`HELD, prompt paste-native-shape: ${describe(subject)}; Ctrl+Enter delivered ${submit.path} to the terminal${submit.onOneLine ? "" : " (across wrapped lines)"}`);
      }
    }

    // The text-only control: with no image on the X clipboard the native read
    // must find none. Where both subjects held it must hold, or their images
    // are not shown to have come from the clipboard.
    const textOnly = find("paste-text-only", "editor");
    const allHeld = subjects.editor === "held" && subjects.prompt === "held";
    let textHeld = false;
    if (!textOnly || textOnly.error) {
      say(`INCONCLUSIVE, editor paste-text-only: ${textOnly?.error ?? "no record"}`);
    } else {
      textHeld = textOnly.clipboard?.offered && shapeArrived(textOnly) && textOnly.noImageNotice && !textOnly.newFiles.length && textOnly.embedsAdded === 0;
      const reading = `the clipboard ${textOnly.clipboard?.offered ? "offered text only" : "did NOT offer text only"}; ${textOnly.noImageNotice ? `"${NO_IMAGE}" shown` : "no such notice"}; ${textOnly.newFiles.length} new files, ${textOnly.embedsAdded} new embeds`;
      if (textHeld) say(`CONTROL HELD, editor paste-text-only: ${reading}`);
      else if (allHeld) say(`INCONCLUSIVE, editor paste-text-only: ${reading}`);
      else say(`RECORDED, editor paste-text-only: ${reading}; a subject did not hold, so this decides nothing`);
    }
    if (Object.values(subjects).includes("fault")) return "fault";
    return allHeld && textHeld ? "held" : "inconclusive";
  }

  // A real Ctrl+V per owner and surface, judged by what landed, with the
  // shape WebKitGTK handed the page named in every line.
  function judgeTrusted() {
    const states = [];
    for (const surface of ["editor", "prompt"]) {
      for (const kind of TRUSTED_OWNERS) {
        const row = all("paste-trusted", surface).find((r) => r.clipboard?.kind === kind);
        const who = `${surface} paste-trusted, ${OWNERS[kind].label}`;
        if (!row || row.error) {
          states.push("inconclusive");
          say(`INCONCLUSIVE, ${who}: ${row?.error ?? "no record"}`);
          continue;
        }
        const pastes = (row.witness ?? []).filter((p) => p.isTrusted && p.surface === surface);
        const shape = pastes.map(shapeText).join(" ") || "no paste event";
        const why = pageWhy ? pageWhy
          : !row.clipboard.offered ? `the X clipboard did not offer the owner's targets (${JSON.stringify(row.clipboard.targets)})`
            : !row.event?.focused ? "the surface did not take focus for the chord"
              : row.event?.keyStatus !== 0 ? `xdotool exited ${row.event?.keyStatus}`
                : pastes.length !== 1 ? `the chord reached the page as ${pastes.length} trusted pastes on the surface (${JSON.stringify(row.witness)})`
                  : !controlHeld[surface] ? "the surface's file-item control did not land an image"
                    : null;
        if (why) {
          states.push("inconclusive");
          say(`INCONCLUSIVE, ${who}: ${why}; ${describe(row)}`);
        } else if (landedWell(row)) {
          states.push("held");
          say(`HELD, ${who}: WebKitGTK handed the page ${shape}; ${describe(row)}`);
        } else {
          states.push("fault");
          const empty = pastes[0].types?.length === 0 && !pastes[0].items && !pastes[0].files;
          const what = !row.embed && !row.file ? `nothing landed within ${row.waitedMs} ms` : "the clipboard's image did not land cleanly";
          say(`FAULT, ${who}: WebKitGTK handed the page ${empty ? "an empty shape " : ""}${shape} and ${what}: ${describe(row)}`);
        }
      }
    }
    for (const row of all("menu-paste", "prompt")) {
      const who = `prompt menu-paste, ${OWNERS[row.clipboard?.kind]?.label ?? "unknown owner"}`;
      if (row.error) { say(`RECORDED, ${who}: ${row.error}`); continue; }
      if (!row.menuOpened) { say(`RECORDED, ${who}: the terminal menu showed no Paste row (${JSON.stringify(row.menu)})`); continue; }
      say(`RECORDED, ${who}: the terminal menu's Paste row with the composer ${row.promptShown ? "open" : "gone"}: ${row.embedsAdded} new composer embeds, ${row.newFiles.length} new images, the terminal grew ${row.scrollbackGrew} chars${row.scrollbackAdded ? ` ${JSON.stringify(row.scrollbackAdded.slice(0, 80))}` : ""}, paste events ${(row.witness ?? []).map(shapeText).join(" ") || "none"}, statuses ${JSON.stringify(row.statuses)}`);
    }
    if (states.includes("fault")) return "fault";
    return states.every((s) => s === "held") ? "held" : "inconclusive";
  }

  // The drops: each lands the fixture beside the document and leaves the
  // window on its page; a real drop outside every zone does nothing.
  function judgeDrops(arms, outsideToo = false) {
    const states = [];
    for (const surface of ["editor", "prompt"]) {
      for (const arm of arms) {
        const row = find(arm, surface);
        const who = `${surface} ${arm}`;
        if (!row || row.error) {
          states.push("inconclusive");
          say(`INCONCLUSIVE, ${who}: ${row?.error ?? "no record"}`);
          continue;
        }
        const trusted = arm === "drop-xdnd";
        const drops = (row.drops ?? []).filter((d) => d.surface === surface && d.isTrusted === trusted);
        const shape = drops.map(shapeText).join(" ") || "no drop event";
        const why = pageWhy ? pageWhy
          : !row.point?.ownsPoint ? `the drop point is not the surface's (${row.point?.hit})`
            : trusted && !row.event?.started ? `the drag source did not start (${JSON.stringify(row.event?.sourceSaid)})`
              : trusted && row.event?.overSource ? "the drop point lies under the drag source"
                : !trusted && !(row.event?.dispatched && row.event?.sent?.drop?.carried && row.event?.files === 1) ? `the synthetic drop was not built as asked (${JSON.stringify(row.event)})`
                  : drops.length !== 1 ? `the page saw ${drops.length} ${trusted ? "trusted" : "untrusted"} drops on the surface (drags ${JSON.stringify(row.drags)}, source ${JSON.stringify(row.event?.sourceSaid ?? null)})`
                    : !controlHeld[surface] ? "the surface's file-item control did not land an image"
                      : null;
        if (why) {
          states.push("inconclusive");
          say(`INCONCLUSIVE, ${who}: ${why}; ${describe(row)}`);
        } else if (!row.pageKept) {
          states.push("fault");
          say(`FAULT, ${who}: the window left its page after the drop ${shape}; ${describe(row)}`);
        } else if (landedWell(row)) {
          states.push("held");
          say(`HELD, ${who}: the page was handed ${shape}; ${describe(row)}; the window stayed on its page`);
        } else {
          states.push("fault");
          const what = !row.embed && !row.file ? `nothing landed within ${row.waitedMs} ms` : "the dropped image did not land cleanly";
          const text = row.textGrew > 0 ? `; the surface's text grew by ${row.textGrew} and ends ${JSON.stringify(row.textTail.slice(-80))}` : "";
          say(`FAULT, ${who}: the page was handed ${shape} and ${what}: ${describe(row)}${text}`);
        }
      }
    }
    const outside = outsideToo ? find("drop-outside") : null;
    if (!outsideToo) {
      // The synthetic drop has no outside arm: an untrusted drop has no
      // default action to take the window anywhere.
    } else if (!outside || outside.error) {
      states.push("inconclusive");
      say(`INCONCLUSIVE, drop-outside: ${outside?.error ?? "no record"}`);
    } else {
      const reached = Object.entries(outside.drags ?? {}).some(([key]) => key.startsWith("outside dragover trusted"));
      const where = `at ${outside.point.x},${outside.point.y} on ${outside.point.hit}`;
      const reading = `drags ${JSON.stringify(outside.drags)}, drops ${(outside.drops ?? []).map(shapeText).join(" ") || "none"}, ${outside.newFiles.length} new images, source ${JSON.stringify(outside.event?.sourceSaid ?? null)}`;
      if (!outside.event?.started) {
        states.push("inconclusive");
        say(`INCONCLUSIVE, drop-outside: the drag source did not start; ${reading}`);
      } else if (outside.pageAnswered && outside.pageKept === false) {
        states.push("fault");
        say(`FAULT, drop-outside: a drop ${where} took the window off its page to ${outside.where} (${outside.sameDocument ? "same document" : "a new document"}, title ${JSON.stringify(outside.title)}); ${reading}`);
      } else if (outside.newFiles.length) {
        states.push("fault");
        say(`FAULT, drop-outside: a drop ${where} uploaded ${outside.newFiles.map((f) => basename(f)).join(", ")}; ${reading}`);
      } else if (!outside.pageAnswered) {
        states.push("inconclusive");
        say(`INCONCLUSIVE, drop-outside: the page did not answer after the drop ${where}; ${reading}`);
      } else if (!reached) {
        states.push("inconclusive");
        say(`INCONCLUSIVE, drop-outside: no trusted drag reached the point outside the zones, so nothing was tried there; ${reading}`);
      } else {
        states.push("held");
        say(`HELD, drop-outside: a drop ${where} left the window's URL unchanged and uploaded nothing; ${reading}`);
      }
    }
    if (states.includes("fault")) return "fault";
    return states.every((s) => s === "held") ? "held" : "inconclusive";
  }

  // A reading's verdict, and the state it gives.
  function held(states, line) { states.push("held"); say(`HELD, ${line}`); }
  function fault(states, line) { states.push("fault"); say(`FAULT, ${line}`); }
  function unsure(states, line) { states.push("inconclusive"); say(`INCONCLUSIVE, ${line}`); }
  function stateOf(states) {
    if (states.includes("fault")) return "fault";
    return states.length && states.every((s) => s === "held") ? "held" : "inconclusive";
  }
  function keysText(chords) {
    return (chords ?? []).map((c) => `${c.shift ? "Shift+" : ""}${c.alt ? "Alt+" : ""}${c.key} ${c.isTrusted ? "trusted" : "untrusted"} on ${c.surface}${c.defaultPrevented ? " taken" : ""}`).join(", ") || "none";
  }

  // The terminal per backend: typed input and its output, then a text
  // paste by chord and by the menu, each once and whole.
  function judgeTerminal() {
    const states = [];
    for (const backend of BACKENDS) {
      const row = find("terminal", backend);
      const who = `terminal ${backend}`;
      if (!row || row.error) { unsure(states, `${who}: ${row?.error ?? "no record"}`); continue; }
      if (row.backend !== backend || !row.shellAnswered) {
        unsure(states, `${who}: ${row.backend !== backend ? `the new terminal mounted ${row.backend ?? "no backend"}` : "the shell's scrollback never answered"} (cs terminal new exited ${row.terminalNew?.status}: ${JSON.stringify(row.terminalNew?.output ?? "")})`);
        continue;
      }
      if (!row.focused) unsure(states, `${who} input: the terminal did not take focus from a click`);
      else if (row.io?.met) held(states, `${who} input: \`echo M$((6*7))\` typed by X input ran, and the shell's M42 reached the PTY's scrollback in ${row.io.waitedMs} ms`);
      else fault(states, `${who} input: a command typed by X input did not run: no M42 in the scrollback ${row.io?.waitedMs} ms after Return; it ends ${JSON.stringify(row.io?.tail ?? "")}`);
      const reader = row.pty?.ready && row.pty?.control;
      if (reader) say(`CONTROL HELD, ${who} pty: cat -v ran under bracketed paste, and a pair the PTY was handed showed as ^[[200~...^[[201~`);
      else say(`INCONCLUSIVE, ${who} pty: ${row.pty?.ready ? "a bracketed pair the PTY was handed did not show" : "cat -v under bracketed paste did not start"}, so the readers cannot see a paste`);
      for (const [arm, label] of [["chord", "Ctrl+Shift+V"], ["menu", "the menu's Paste row"]]) {
        const p = row[arm];
        const what = `${who} paste-${arm}`;
        const events = (p?.witness ?? []).map(shapeText).join(" ") || "no paste event";
        const why = !p ? "no record" : !reader ? "the PTY reader's control did not hold"
          : !p.clipboard?.offered ? `the X clipboard did not offer text (${JSON.stringify(p.clipboard?.targets)})`
            : !p.focused ? "the terminal did not take focus"
              : arm === "menu" && !p.acted?.opened ? `the terminal menu showed no Paste row (${JSON.stringify(p.acted?.at)})`
                : null;
        if (why) unsure(states, `${what}: ${why}`);
        else if (p.whole === 1 && p.opens === 1 && p.closes === 1) held(states, `${what}: ${label} put the clipboard's text in the PTY once and whole, in one bracketed pair, in ${p.waitedMs} ms; the page saw ${events}`);
        else if (!p.opens && !p.closes) fault(states, `${what}: ${label} delivered nothing to the PTY in ${p.waitedMs} ms on ${backend}; WebKitGTK ${p.witness?.length ? `handed the terminal ${events}` : "fired no paste event on the terminal"}; keydowns ${keysText(p.chords)}`);
        else fault(states, `${what}: ${label} delivered ${p.opens} openings, ${p.closes} closings and ${p.whole} whole copies of the text; the scrollback ends ${JSON.stringify(p.tail)}`);
      }
    }
    return stateOf(states);
  }

  // The editor under each write path: what was typed in each mode reached
  // the file, and a reload shows both in both modes.
  function judgeEditor() {
    const states = [];
    for (const mode of ["session", "classic"]) {
      const row = find("editor", mode);
      const who = `editor ${mode === "session" ? "with document sessions" : "with document sessions off"}`;
      if (!row || row.error) { unsure(states, `${who}: ${row?.error ?? "no record"}`); continue; }
      if ((mode === "classic") !== (row.docsync === "0")) { unsure(states, `${who}: the page's chan.docsync reads ${JSON.stringify(row.docsync)}`); continue; }
      if (!row.open?.met) { unsure(states, `${who}: the note did not open (cs open exited ${row.open?.status})`); continue; }
      const typed = (step, label, expect) => {
        if (!step) { unsure(states, `${who} ${label}: not tried, an earlier step did not hold`); return false; }
        if (step.mode !== expect) { unsure(states, `${who} ${label}: the editor showed ${step.mode}, not ${expect}`); return false; }
        if (!step.focused || !step.editorHeld) { unsure(states, `${who} ${label}: the typed text never showed in the editor (focused ${step.focused}, xdotool ${step.typeStatus})`); return false; }
        if (step.inFileBefore) { unsure(states, `${who} ${label}: the file held the text before it was typed`); return false; }
        if (step.inFile) { held(states, `${who} ${label}: typed by X input, and the file held it ${step.fileAfterMs} ms later`); return true; }
        fault(states, `${who} ${label}: the editor held the typed text but the file did not ${step.fileAfterMs} ms later; it ends ${JSON.stringify(step.fileTail)}`);
        return false;
      };
      const rendered = typed(row.rendered, "rendered", "rendered");
      if (!row.toggle?.met) fault(states, `${who} mode chord: Ctrl+E left the note in ${row.toggle?.mode ?? "no mode"}; keydowns ${keysText(row.toggle?.chords)}`);
      const source = typed(row.source, "source", "source");
      if (row.source) {
        const save = (row.source.chords ?? []).filter((c) => c.code === "KeyS");
        say(`RECORDED, ${who} Ctrl+S: keydowns ${keysText(save)}; chan binds no save chord, the autosave writes`);
      }
      if (!rendered || !source) { unsure(states, `${who} reload: not judged, the typing did not hold`); continue; }
      if (row.afterReload?.met) held(states, `${who} reload: the editor showed both lines in ${row.afterReload.mode} after a reload`);
      else fault(states, `${who} reload: after a reload the editor (${row.afterReload?.mode}) did not show both lines; it ends ${JSON.stringify(row.afterReload?.tail)}`);
      if (row.afterReloadOther?.met) held(states, `${who} reload: and in ${row.afterReloadOther.mode} after the mode chord`);
      else fault(states, `${who} reload: after the mode chord the editor (${row.afterReloadOther?.mode}) did not show both lines; it ends ${JSON.stringify(row.afterReloadOther?.tail)}`);
    }
    return stateOf(states);
  }

  // A double-click on a Files row opens the file in the editor.
  function judgeOpen() {
    const states = [];
    const row = find("open", "files");
    if (!row || row.error) unsure(states, `open: ${row?.error ?? "no record"}`);
    else if (row.clickStatus !== 0 || !(row.dblclicks ?? []).some((d) => d.isTrusted && d.onRow)) unsure(states, `open: no trusted double-click reached the row (xdotool ${row.clickStatus}, ${JSON.stringify(row.dblclicks)})`);
    else if (row.opened) held(states, `open: a double-click by X input on its Files row opened ${row.file} in the active pane's editor in ${row.waitedMs} ms (cs pane list: ${row.after?.csTab?.kind} tab ${row.after?.csTab?.title} active)`);
    else fault(states, `open: a double-click by X input on the Files row of ${row.file} opened nothing in ${row.waitedMs} ms: the active tab is ${JSON.stringify(row.after?.tab)}, its text ${row.after?.hasBody ? "holds" : "lacks"} the file's body`);
    return stateOf(states);
  }

  // Search finds a fresh file's token and Enter opens the hit.
  function judgeSearch() {
    const states = [];
    const row = find("search", "search");
    if (!row || row.error) unsure(states, `search: ${row?.error ?? "no record"}`);
    else if (!row.indexed) unsure(states, `search: the index never answered the token in ${row.indexWaitedMs} ms (${row.indexAnswer})`);
    else {
      if (!row.chordOpened) fault(states, `search chord: Ctrl+Alt+S did not open Search; keydowns ${keysText(row.chords)}`);
      if (!row.opened) fault(states, "search: Search did not open by its chord or its command");
      else if (row.hits?.query !== row.query) unsure(states, `search: the input holds ${JSON.stringify(row.hits?.query)}, not the typed token`);
      else if (!row.hits?.met) fault(states, `search: the typed query showed no hit for ${row.file} in ${row.hits?.waitedMs} ms though the index answers it (${row.hits?.count} hits ${JSON.stringify(row.hits?.paths)}, status ${JSON.stringify(row.hits?.status)})`);
      else if (row.hitOpened) held(states, `search: the token typed by X input showed its hit in ${row.hits.waitedMs} ms, and Enter opened ${row.file} with the token in the editor in ${row.waitedMs} ms`);
      else fault(states, `search: Enter on the hit opened nothing in ${row.waitedMs} ms: the active tab is ${JSON.stringify(row.after?.tab)}, the Search dialog ${row.after?.dialog ? "still shown" : "closed"}`);
    }
    return stateOf(states);
  }

  // A split by chord, a focus by click, a tab dragged to the other pane and
  // the other pane closed by chord.
  function judgePanes() {
    const states = [];
    const row = find("panes", "panes");
    if (!row || row.error) return stateOf((unsure(states, `panes: ${row?.error ?? "no record"}`), states));
    if (!row.split?.met) return stateOf((fault(states, `panes split: Ctrl+Alt+/ did not split the pane in ${row.split?.waitedMs} ms (${row.split?.panes} panes); keydowns ${keysText(row.split?.chords)}`), states));
    held(states, `panes split: Ctrl+Alt+/ by X input split the pane in ${row.split.waitedMs} ms (${row.panesBefore} to ${row.split.panes} panes)`);
    if (row.focus?.from === row.p0) unsure(states, "panes focus: the split left the first pane active, so a click on it shows nothing");
    else if (row.focus?.met) held(states, "panes focus: a click by X input on the first pane's body made it the active pane");
    else fault(states, `panes focus: a click by X input on the first pane's body left ${row.focus?.activePaneId} active`);
    const drag = row.drag;
    const started = (drag?.dragstarts ?? []).filter((d) => d.isTrusted).map((d) => d.tab);
    if (!drag?.points?.from) unsure(states, `panes drag: no tab or strip to drag between (${JSON.stringify(drag?.points)})`);
    else if (drag.met) held(states, `panes drag: a drag by X input moved the tab to the other pane's strip in ${drag.waitedMs} ms (drag starts ${JSON.stringify(started)})`);
    else fault(states, `panes drag: a drag by X input of the tab to the other pane's strip moved nothing: trusted drag starts ${JSON.stringify(started)}, drops ${JSON.stringify(drag.drops)}, tabs ${JSON.stringify(drag.p0Tabs)} and ${JSON.stringify(drag.p1Tabs)}`);
    const close = row.close;
    if (close?.p1Gone && close.p0Kept && close.panes === row.panesBefore) held(states, `panes close: Ctrl+Shift+W by X input closed the other pane's tabs and then the pane in ${close.closes.length} presses`);
    else fault(states, `panes close: Ctrl+Shift+W did not close the other pane (${close?.panes} panes, presses ${JSON.stringify(close?.closes?.map((c) => c.refused ?? `${c.changed ? "changed" : "no change"} ${c.panes} ${JSON.stringify(c.p1Tabs)}`))})`);
    return stateOf(states);
  }
}
