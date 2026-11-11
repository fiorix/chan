#!/usr/bin/env node
// The page-level arms of basic-flows.sh, and their verdict.
//
//   basic-flows.mjs run --inspector HOST:PORT --page URL-SUBSTRING --xid X-ID
//       --ws DIR --note RELATIVE-PATH --chan-home DIR --fixture PNG
//       --chan PATH --work DIR --results JSONL
//   basic-flows.mjs verdict --results JSONL --webkit VERSION
//
// `run` holds one inspector connection to the workspace page, plants a
// witness of every paste event, Ctrl+Enter keydown and status bar text the
// page sees, and runs the arms in order, appending one JSON record per arm.
// The records are facts: what the X clipboard offered (xclip's TARGETS),
// the clipboard shape the page's own listener saw, the image embeds in the
// editor, the files on disk and their pixels decoded against the fixture
// (arboard re-encodes, so bytes are not compared), the status texts, and
// the terminal's scrollback. It exits 0 once the arms have run, whatever
// they saw, and 3 when it cannot reach the page.
//
// `verdict` judges the records and prints one line per arm, each naming
// the engine. It exits 0 when every subject held with its controls, 10
// when a subject's fault was observed under its controls, and 3 otherwise.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    results: { type: "string" }, webkit: { type: "string" },
  },
});
const mode = positionals[0];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);

// The notices the paste path raises when it does not land an image. Any of
// them in a subject arm is a fault; the text-only control expects the first.
const NO_IMAGE = "No image found on the clipboard";
const PASTE_NOTICES = [NO_IMAGE, "Could not read image from the clipboard", "Image upload failed", "upload limit", "HEIC conversion failed"];
const TEXT_ONLY = "basic-flows text only clipboard";

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
  const results = args.results;
  const record = (row) => appendFileSync(results, `${JSON.stringify(row)}\n`);
  const fixture = args.fixture;
  const fixtureB64 = readFileSync(fixture).toString("base64");
  const shot = (name) => spawnSync("import", ["-window", "root", join(args.work, "shots", `${name}.png`)], { timeout: 20000 });
  const csEnv = { ...process.env };
  const cs = (words, cwd = args.ws) => spawnSync(args.chan, ["shell", ...words], { cwd, env: csEnv, encoding: "utf8", timeout: 20000 });

  // The X CLIPBOARD's owner, one at a time and kept in the foreground so the
  // run can end it; a new owner takes the selection from the old one. The
  // PNG is owned by xclip. Text is owned through GTK, since xclip answers a
  // request for image/png with its text and a reader would then be handed
  // text where a text copy in an app offers no image at all.
  const owners = [];
  const ownerLog = openSync(join(args.work, "xclip.log"), "a");
  const targets = () => {
    const out = spawnSync("xclip", ["-selection", "clipboard", "-o", "-t", "TARGETS"], { encoding: "utf8", timeout: 5000 });
    return out.status === 0 ? out.stdout.split("\n").map((t) => t.trim()).filter(Boolean) : null;
  };
  async function seed(kind) {
    for (const owner of owners.splice(0)) owner.kill();
    const owner = kind === "image"
      ? spawn("xclip", ["-quiet", "-selection", "clipboard", "-t", "image/png", "-i", fixture], { stdio: ["ignore", ownerLog, ownerLog] })
      : spawn("python3", [join(here, "clipboard-text-owner.py"), TEXT_ONLY], { stdio: ["ignore", ownerLog, ownerLog], env: { ...process.env, NO_AT_BRIDGE: "1" } });
    owners.push(owner);
    const offered = await poll(async () => targets(), (list) => Boolean(list) && (kind === "image"
      ? list.includes("image/png")
      : list.some((t) => /STRING|text\/plain/.test(t)) && !list.some((t) => t.startsWith("image/"))), 5000);
    return { kind, offered: offered.met, targets: offered.value };
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
  // nothing chan's handlers do. A paste is recorded in the capture phase,
  // before any handler, with the shape its clipboardData had, and again
  // once it bubbled, with whether a handler took it.
  await page.evaluate(`(() => {
    if (window.__flows) return true;
    const s = (window.__flows = { pastes: [], keys: [], statuses: [] });
    const surface = (node) => node?.closest?.(".rich-prompt") ? "prompt" : node?.closest?.(".cm-editor") ? "editor" : (node?.nodeName || "none");
    addEventListener("paste", (e) => {
      const c = e.clipboardData;
      s.pastes.push({ at: Math.round(performance.now()), surface: surface(e.target), target: e.target?.nodeName || null, isTrusted: e.isTrusted,
        types: c ? Array.from(c.types || []) : null, items: c ? (c.items?.length ?? null) : null, files: c ? (c.files?.length ?? null) : null,
        itemKinds: c?.items ? Array.from(c.items).map((i) => i.kind + ":" + i.type) : null });
    }, true);
    addEventListener("paste", (e) => { const last = s.pastes[s.pastes.length - 1]; if (last) last.defaultPrevented = e.defaultPrevented; });
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
  })()`);
  const marks = () => page.evaluate("({ pastes: window.__flows.pastes.length, keys: window.__flows.keys.length, statuses: window.__flows.statuses.length })");
  const since = (mark) => page.evaluate(`({ pastes: window.__flows.pastes.slice(${mark.pastes}), keys: window.__flows.keys.slice(${mark.keys}), statuses: window.__flows.statuses.slice(${mark.statuses}).map((s) => s.text) })`);

  const facts = await page.evaluate(`({ userAgent: navigator.userAgent, isTauriDesktop: Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__), invoke: typeof window.__TAURI_INTERNALS__?.invoke, origin: location.origin })`);
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
  const pngsUnder = (dir) => {
    const found = [];
    const walk = (d) => {
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = join(d, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith(".png")) found.push(path);
      }
    };
    walk(dir);
    return found.sort();
  };

  // 1. The desktop's own clipboard read, asked of it directly through the
  // IPC the paste uses. It names where a fault sits and decides nothing.
  try {
    const clipboard = await seed("image");
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

  // One paste arm: dispatch the shape, then wait for a new embed whose
  // source names <name> and a new file named <name> under <dir>. An embed
  // that was already there before the paste does not count.
  async function pasteArm({ arm, surface, content, shape, onBr, name, dir, clipboard, bound = 15000 }) {
    const filesBefore = pngsUnder(dir);
    const embedsBefore = (await embeds(content)) ?? [];
    const newEmbed = (shown) => {
      const prior = embedsBefore.map((e) => e.src);
      for (const e of shown) {
        const at = prior.indexOf(e.src);
        if (at >= 0) { prior.splice(at, 1); continue; }
        if (e.src?.includes(name) && e.complete && e.naturalWidth > 0) return e;
      }
      return null;
    };
    const mark = await marks();
    shot(`${surface}-${arm}-before`);
    const event = await dispatch(content, shape, onBr);
    const landing = await poll(async () => {
      const embed = newEmbed((await embeds(content)) ?? []);
      const file = pngsUnder(dir).filter((f) => !filesBefore.includes(f)).find((f) => basename(f).startsWith(name)) ?? null;
      return { embed, file };
    }, (seen) => seen.embed && seen.file, bound);
    const landedAt = now();
    // Room for a late notice, or a second image, to show.
    await sleep(1000);
    const seen = await since(mark);
    const newFiles = pngsUnder(dir).filter((f) => !filesBefore.includes(f));
    const after = (await embeds(content)) ?? [];
    shot(`${surface}-${arm}-after`);
    const file = landing.value.file;
    return {
      arm, surface, clipboard, event, witness: seen.pastes, statuses: seen.statuses,
      pasteNotices: seen.statuses.filter((text) => PASTE_NOTICES.some((n) => text.includes(n))),
      landed: landing.met, waitedMs: landing.waitedMs, landedAt,
      embed: landing.value.embed, embedsAdded: after.length - embedsBefore.length,
      file: file ? { path: file, ...pixels(file) } : null, newFiles,
    };
  }

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

  const notesDir = join(args.ws, args.note.split("/").slice(0, -1).join("/"));
  const noteFile = join(args.ws, args.note);
  const tryArm = async (arm, surface, body) => {
    try { record(await body()); } catch (error) { record({ arm, surface, error: String(error) }); }
  };

  // 2. The editor's subject, then its controls.
  await tryArm("paste-native-shape", "editor", async () => {
    const clipboard = await seed("image");
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
  await tryArm("paste-file-item", "editor", async () => {
    const clipboard = await seed("image");
    return pasteArm({ arm: "paste-file-item", surface: "editor", content: noteContent, shape: FILE_ITEM, name: "control", dir: notesDir, clipboard });
  });
  await tryArm("paste-text-only", "editor", async () => {
    const clipboard = await seed("text");
    const row = await pasteArm({ arm: "paste-text-only", surface: "editor", content: noteContent, shape: NATIVE, name: "pasted-image", dir: notesDir, clipboard, bound: 6000 });
    row.noImageNotice = row.statuses.some((text) => text.includes(NO_IMAGE));
    return row;
  });

  // 3. The Rich Prompt over a terminal running cat, then its control.
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
  const prompt = await openPrompt();
  record({ arm: "open-prompt", terminalStatus: terminal.status, terminalOutput: (terminal.stdout + terminal.stderr).trim().slice(0, 300),
    scrollbackAnswered: live.met, promptFocused: prompt.met, waitedMs: prompt.waitedMs });

  await tryArm("paste-native-shape", "prompt", async () => {
    const clipboard = await seed("image");
    const row = await pasteArm({ arm: "paste-native-shape", surface: "prompt", content: promptContent, shape: NATIVE, onBr: true, name: "pasted-image", dir: args["chan-home"], clipboard });
    if (!row.file) return row;
    // Submit by X input, as a user does, and read what reached the PTY.
    await page.evaluate(`(() => { ${promptContent}?.focus(); return true; })()`);
    const mark = await marks();
    spawnSync("xdotool", ["windowactivate", "--sync", args.xid], { timeout: 10000 });
    const chord = spawnSync("xdotool", ["key", "--clearmodifiers", "ctrl+Return"], { encoding: "utf8", timeout: 10000 });
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
  await tryArm("paste-file-item", "prompt", async () => {
    const shown = await page.evaluate(`Boolean(${promptContent})`);
    const reopened = shown ? null : await openPrompt();
    const clipboard = await seed("image");
    const row = await pasteArm({ arm: "paste-file-item", surface: "prompt", content: promptContent, shape: FILE_ITEM, onBr: true, name: "control", dir: args["chan-home"], clipboard });
    row.reopened = reopened ? reopened.met : null;
    return row;
  });

  // 4. Recorded, decides nothing: the shape WebKitGTK itself hands the page
  // for a real Ctrl+V into the note with the PNG on the clipboard.
  await tryArm("trusted-shape", "editor", async () => {
    await page.evaluate(`(() => { document.querySelector(".rich-prompt") && window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "terminal.richPrompt" } })); return true; })()`);
    const reopened = cs(["open", args.note]);
    const focus = await poll(() => page.evaluate(`(() => { const c = ${noteContent}; return Boolean(c) && document.activeElement === c; })()`), Boolean, 15000);
    const clipboard = await seed("image");
    const filesBefore = pngsUnder(notesDir);
    const mark = await marks();
    spawnSync("xdotool", ["windowactivate", "--sync", args.xid], { timeout: 10000 });
    // The caret at the end of the note's text, not on an image's widget.
    const key = spawnSync("xdotool", ["key", "--clearmodifiers", "ctrl+End", "ctrl+v"], { encoding: "utf8", timeout: 10000 });
    await sleep(4000);
    const seen = await since(mark);
    shot("editor-trusted-shape-after");
    return { arm: "trusted-shape", surface: "editor", clipboard, openStatus: reopened.status, focused: focus.met, keyStatus: key.status,
      witness: seen.pastes, statuses: seen.statuses, newFiles: pngsUnder(notesDir).filter((f) => !filesBefore.includes(f)) };
  });

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
  const page = find("page");
  const tag = `(WebKitGTK ${args.webkit}; ${page?.userAgent ?? "no user agent read"})`;
  const say = (line) => console.log(`${line} ${tag}`);
  if (!page || page.error) {
    say(`INCONCLUSIVE: the page did not answer: ${page?.error ?? "no record"}`);
    process.exit(3);
  }
  // The handler reads the desktop's clipboard only in a Tauri page; in any
  // other page no subject is judged.
  const pageWhy = page.isTauriDesktop && page.invoke === "function" ? null : "the page is not a Tauri desktop page with an invoke bridge";

  const bundle = find("bundle");
  say(bundle?.error ? `RECORDED, bundle: unreadable: ${bundle.error}`
    : `RECORDED, bundle: the served scripts ${bundle?.nativeBranchIn?.length ? `hold the native recovery (${bundle.nativeBranchIn.join(", ")})` : "hold no native recovery"} across ${bundle?.scripts ?? 0} scripts`);

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
  // Landed: the editor shows the uploaded file itself, and the file holds
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

  const subjects = {};
  for (const surface of ["editor", "prompt"]) {
    const subject = find("paste-native-shape", surface);
    const control = find("paste-file-item", surface);
    // The control first: it says whether the readers can see a landed image.
    let controlHeld = false;
    if (!control || control.error) {
      say(`INCONCLUSIVE, ${surface} paste-file-item: ${control?.error ?? "no record"}`);
    } else if (landedWell(control)) {
      controlHeld = true;
      say(`CONTROL HELD, ${surface} paste-file-item: ${describe(control)}`);
    } else {
      say(`INCONCLUSIVE, ${surface} paste-file-item: a File item did not land, so the readers cannot see a landed image: ${describe(control)}`);
    }

    if (!subject || subject.error) {
      subjects[surface] = "inconclusive";
      say(`INCONCLUSIVE, ${surface} paste-native-shape: ${subject?.error ?? "no record"}`);
      continue;
    }
    const why = pageWhy ? pageWhy
      : !subject.clipboard?.offered ? "the X clipboard did not offer image/png"
      : !subject.event?.dispatched ? "the paste target was not on the page"
        : !shapeArrived(subject) ? `the page saw ${JSON.stringify(subject.witness)} rather than one injected empty-Files paste`
          : !controlHeld ? "its control did not land an image"
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

  const trusted = find("trusted-shape", "editor");
  if (trusted && !trusted.error) {
    const shape = (trusted.witness ?? []).map((p) => `{types ${JSON.stringify(p.types)}, items ${p.items} ${JSON.stringify(p.itemKinds)}, files ${p.files}, trusted ${p.isTrusted}, taken ${p.defaultPrevented}}`).join(" ") || "no paste event";
    say(`RECORDED, editor trusted-shape: Ctrl+V by X input with the PNG on the clipboard handed the page ${shape}; ${trusted.newFiles.length} new files; statuses ${JSON.stringify(trusted.statuses)}`);
  } else {
    say(`RECORDED, editor trusted-shape: ${trusted?.error ?? "no record"}`);
  }

  if (Object.values(subjects).includes("fault")) process.exit(10);
  if (allHeld && textHeld) {
    say("PASS: an image pasted with WKWebView's empty-Files clipboard shape landed in the editor and in the Rich Prompt through the desktop's clipboard read");
    process.exit(0);
  }
  process.exit(3);
}
