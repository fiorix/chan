// Typing in a workspace document saves it, in the rendered view and in
// source, and a reload shows what was typed in both, on each of the editor's
// two save paths.
//
// Engine: headless Chrome through puppeteer-core; the result names the
// browser's version. It says nothing about WebKit.
//
// Each arm runs in a window of its own on a document of its own. The `live`
// arm is the default: the document attaches a live session (/api/doc/ws), the
// editor pushes each edit to the server's authority and the authority writes
// the file. The `classic` arm sets the page's `chan.docsync` flag off, as a
// window with no session saves (a standalone window, a server without the
// route, a session that degraded): the editor's text becomes the tab's
// content and the autosave PUTs it. Each arm asserts the path it claims from
// the page's traffic: pushes and no PUT, or PUTs and no session socket.
//
// The seeded Markdown document opens from the Files tab in its rendered view.
// A marker typed at the end of its first line must reach the file. Show Source
// Code (app.editor.toggleMode) flips the tab to source, where a second marker
// is typed as a bold paragraph, `**marker**`, and Ctrl+S is pressed as a person
// would. chan binds no save chord in a browser, where the browser owns Ctrl+S;
// the save is the editor's own, so the press must leave the document as it
// was. The file must then read exactly the seed with both markers where they
// were typed: each once, the document's tail intact. The page reloads, and
// the restored tab must hold that text in whichever view it comes back in and
// in the other one after a flip: the source shows the `**` markup, the
// rendered view draws the marker bold.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserTab, openFileTab, showFiles } from "../lib/files.mjs";
import { waitFor } from "../lib/drafts.mjs";

const RUN = Date.now().toString(36);
const EDITOR = ".editor-tab.active";
const DOCSYNC_FLAG = "chan.docsync";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// The active editor's mode, view text and drawn text.
function readEditor(page) {
  return page.evaluate((selector) => {
    const tab = document.querySelector(selector);
    const content = tab?.querySelector(".cm-content");
    const view = content?.cmTile?.root?.view;
    return {
      mode: tab?.querySelector(".md-source") ? "source" : tab?.querySelector(".md-wysiwyg-cm6") ? "rendered" : null,
      doc: view ? view.state.doc.toString() : null,
      drawn: content?.textContent ?? null,
      bold: [...(content?.querySelectorAll(".cm-md-bold") ?? [])].map((el) => el.textContent),
    };
  }, EDITOR);
}

/// Put the caret at the end of the active editor's first line and focus it.
async function caretAtEndOfFirstLine(page) {
  await page.evaluate((selector) => {
    const view = document.querySelector(`${selector} .cm-content`)?.cmTile?.root?.view;
    if (!view) throw new Error("editor view unavailable");
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });
    view.focus();
  }, EDITOR);
  await sleep(150);
}

async function toggleMode(page, want) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.editor.toggleMode" } })));
  await waitFor(`the editor in ${want}`, 15_000, async () => {
    const editor = await readEditor(page);
    return editor.mode === want && editor.doc !== null ? editor : null;
  });
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

async function waitFile(file, want, what) {
  await waitFor(what, 20_000, () => readFileSync(file, "utf8") === want || null)
    .catch((error) => { throw new Error(`${error.message}; the file reads ${JSON.stringify(readFileSync(file, "utf8"))}`); });
}

/// The document's text in the editor's current view, checked against the file.
async function assertView(page, label, want, first, second) {
  const editor = await waitFor(`${label}: the editor holding the saved text`, 20_000, async () => {
    const read = await readEditor(page);
    return read.doc === want ? read : null;
  }).catch(async (error) => {
    throw new Error(`${error.message}; it holds ${JSON.stringify(await readEditor(page))}`);
  });
  const failures = [];
  if (count(editor.drawn, first) !== 1) failures.push(`the view draws ${first} ${count(editor.drawn, first)} times`);
  if (editor.mode === "source" && count(editor.drawn, `**${second}**`) !== 1) {
    failures.push(`source does not draw **${second}** once`);
  }
  if (editor.mode === "rendered" && !editor.bold.includes(second)) {
    failures.push(`the rendered view draws no bold ${second}; bold runs ${JSON.stringify(editor.bold)}`);
  }
  if (failures.length) throw new Error(`${label} (${editor.mode}): ${failures.join("; ")}; drawn ${JSON.stringify(editor.drawn)}`);
  return editor.mode;
}

/// Count the page's document-session frames by type and its PUTs of files.
async function recordTraffic(page) {
  const traffic = { docSockets: 0, sent: {}, received: {}, puts: 0 };
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  const sockets = new Set();
  const tally = (into, payload) => {
    try {
      const type = JSON.parse(payload)?.type;
      if (typeof type === "string") into[type] = (into[type] ?? 0) + 1;
    } catch {
      // Not a JSON frame.
    }
  };
  cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
    if (new URL(url).pathname.endsWith("/api/doc/ws")) {
      sockets.add(requestId);
      traffic.docSockets += 1;
    }
  });
  cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
    if (sockets.has(requestId)) tally(traffic.sent, response.payloadData);
  });
  cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
    if (sockets.has(requestId)) tally(traffic.received, response.payloadData);
  });
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname.startsWith("/api/fs")) traffic.puts += 1;
  });
  return traffic;
}

const snapshotOf = (traffic) => JSON.parse(JSON.stringify(traffic));

/// The path the saves took so far, against the arm's claim.
function assertPath(arm, traffic, stage) {
  const pushes = traffic.sent.push ?? 0;
  if (arm === "live" && (pushes === 0 || traffic.puts !== 0)) {
    throw new Error(`live arm ${stage}: the saves did not ride the session alone: ${JSON.stringify(traffic)}`);
  }
  if (arm === "classic" && (traffic.docSockets !== 0 || traffic.puts === 0)) {
    throw new Error(`classic arm ${stage}: the saves were not classic PUTs alone: ${JSON.stringify(traffic)}`);
  }
}

async function typeAndSave(ctx, arm) {
  const dir = `smoke-type-${arm}-${RUN}`;
  const doc = `${dir}/type-${RUN}.md`;
  const file = join(ctx.workspaceDir, doc);
  const head = `type doc ${arm} ${RUN}`;
  const tail = `tail line ${RUN}`;
  const first = `M1${arm}x${RUN}`;
  const second = `M2${arm}x${RUN}`;
  const seed = `${head}\n\n${tail}\n`;
  const typed = `${head} ${first}\n\n**${second}**\n\n${tail}\n`;
  const page = await ctx.browser.newPage();
  const result = { arm, doc };
  let primary = null;
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.bringToFront();
    const traffic = await recordTraffic(page);
    result.traffic = traffic;
    if (arm === "classic") {
      await page.evaluateOnNewDocument((key) => localStorage.setItem(key, "0"), DOCSYNC_FLAG);
    }
    mkdirSync(join(ctx.workspaceDir, dir));
    writeFileSync(file, seed);
    const url = new URL(ctx.serverUrl);
    url.searchParams.set("w", `type-save-217-${arm}-${RUN}`);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });

    // The rendered view: a marker at the end of the first line.
    await showFiles(page);
    result.opens = await openFileTab(page, doc);
    await waitFor("the document in its rendered view", 30_000, async () => {
      const editor = await readEditor(page);
      return editor.mode === "rendered" && editor.doc === seed ? editor : null;
    });
    if (arm === "live") {
      // A live session's attach can replace the editor's state and move the
      // caret; type once its snapshot is in.
      await waitFor("the document's live session snapshot", 15_000, () => traffic.received.snapshot ?? null);
      await sleep(300);
    }
    await caretAtEndOfFirstLine(page);
    await page.keyboard.type(` ${first}`);
    await waitFile(file, `${head} ${first}\n\n${tail}\n`, `${arm}: the first marker in the file`);
    assertPath(arm, traffic, "in the rendered view");
    result.afterRendered = snapshotOf(traffic);
    await ctx.shot(`217-${arm}-rendered-typed`, page);

    // Source: a bold paragraph after the first line, then Ctrl+S.
    await toggleMode(page, "source");
    await caretAtEndOfFirstLine(page);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type(`**${second}**`);
    const beforeChord = (await readEditor(page)).doc;
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyS");
    await page.keyboard.up("Control");
    await sleep(300);
    const afterChord = (await readEditor(page)).doc;
    if (afterChord !== beforeChord) {
      throw new Error(`${arm}: Ctrl+S changed the document: ${JSON.stringify(beforeChord)} -> ${JSON.stringify(afterChord)}`);
    }
    if (beforeChord !== typed) throw new Error(`${arm}: source holds ${JSON.stringify(beforeChord)}, not ${JSON.stringify(typed)}`);
    await waitFile(file, typed, `${arm}: both markers in the file`);
    assertPath(arm, traffic, "in source");
    result.afterSource = snapshotOf(traffic);
    await ctx.shot(`217-${arm}-source-typed`, page);

    // A reload restores the tab: the text in both views.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(
      (wanted) => document.querySelector(".tabs .tab.active")?.getAttribute("title") === wanted,
      { timeout: 30_000 },
      doc,
    );
    const restored = await assertView(page, `${arm} after the reload`, typed, first, second);
    await ctx.shot(`217-${arm}-reload-${restored}`, page);
    const other = restored === "source" ? "rendered" : "source";
    await toggleMode(page, other);
    await assertView(page, `${arm} after the reload and a flip`, typed, first, second);
    await ctx.shot(`217-${arm}-reload-${other}`, page);
    result.restoredIn = restored;
    if (readFileSync(file, "utf8") !== typed) {
      throw new Error(`${arm}: the file changed after the reload: ${JSON.stringify(readFileSync(file, "utf8"))}`);
    }
    console.log(`[smoke]   ${arm}: opened on try ${result.opens}; restored in ${restored}; after rendered ${JSON.stringify(result.afterRendered)}; after source ${JSON.stringify(result.afterSource)}; total ${JSON.stringify(traffic)}`);
    return result;
  } catch (error) {
    primary = error;
    await ctx.shot(`217-${arm}-failure`, page).catch(() => {});
    console.log(`[smoke]   ${arm} traffic ${JSON.stringify(result.traffic ?? null)}`);
    throw error;
  } finally {
    try {
      const active = await page.evaluate(() => document.querySelector(".tabs .tab.active")?.getAttribute("title") ?? "");
      if (active === doc) {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } })));
      }
      const tab = await browserTab(page);
      if (tab) {
        await tab.click();
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.tab.close" } })));
      }
      if (arm === "classic") await page.evaluate((key) => localStorage.removeItem(key), DOCSYNC_FLAG);
      await page.close();
    } catch (error) {
      if (primary) console.log(`[smoke]   cleanup also failed: ${error?.message ?? error}`);
      else throw error;
    } finally {
      rmSync(join(ctx.workspaceDir, dir), { recursive: true, force: true });
    }
  }
}

export default {
  name: "editor-type-save",
  async run(ctx) {
    const result = { browser: await ctx.browser.browser().version(), arms: [] };
    for (const arm of ["live", "classic"]) result.arms.push(await typeAndSave(ctx, arm));
    console.log(`[smoke]   ${result.browser}`);
    return result;
  },
};
