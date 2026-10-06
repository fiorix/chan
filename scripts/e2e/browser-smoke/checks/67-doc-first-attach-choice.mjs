// A classic tab can carry a base and local buffer into its first live
// document attach after another window has advanced the authority. Keep
// that buffer until the user chooses what joins the live document.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { armFlip, paneFlip } from "../lib/flip.mjs";

const STAMP = Date.now();
const POLL_MS = 100;
const EDITOR = ".editor-tab.active .cm-content";
const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT = `${LAUNCHER} input[role="combobox"]`;
const SELECTED_TITLE = `${LAUNCHER} [role="option"][aria-selected="true"] .deck-result-title`;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label, check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await pause(POLL_MS);
  }
  throw new Error(`${label} did not settle in ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function editorText(page) {
  return page.evaluate((selector) => document.querySelector(selector)?.textContent ?? null, EDITOR);
}

async function waitEditor(page, marker) {
  await page.bringToFront();
  await until(`editor marker ${marker}`, async () => (await editorText(page))?.includes(marker));
}

async function replaceFirstLine(page, marker) {
  await page.bringToFront();
  await page.click(EDITOR);
  await page.keyboard.down("Control");
  await page.keyboard.press("Home");
  await page.keyboard.up("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Input.insertText", { text: marker });
  } finally {
    await cdp.detach();
  }
  await waitEditor(page, marker);
}

function diskText(ctx, file) {
  return readFileSync(join(ctx.workspaceDir, file), "utf8");
}

async function waitDisk(ctx, file, marker) {
  await until(`disk marker ${marker}`, () => diskText(ctx, file).includes(marker));
}

function windowId(page) {
  const id = new URL(page.url()).searchParams.get("w");
  if (!id) throw new Error("browser page has no window id");
  return id;
}

async function openFile(ctx, page, file, marker) {
  await page.bringToFront();
  const id = windowId(page);
  await ctx.waitWindowLive(id);
  await ctx.exec(ctx.chanBin, ["shell", "open", file], {
    cwd: ctx.workspaceDir,
    env: {
      ...process.env,
      CHAN_CONTROL_SOCKET: ctx.controlSocket,
      CHAN_WINDOW_ID: id,
    },
    timeout: 30_000,
  });
  await waitEditor(page, marker);
}

async function setDocSync(page, enabled) {
  await page.evaluate((on) => localStorage.setItem("chan.docsync", on ? "1" : "0"), enabled);
}

async function moveTabToOtherSide(page) {
  await page.bringToFront();
  const { paneId, side } = await page.evaluate((selector) => {
    const pane = document.querySelector(selector)?.closest(".pane[data-pane-id]");
    return {
      paneId: pane?.getAttribute("data-pane-id") ?? null,
      side: pane?.querySelector(".side-toggle")?.textContent?.trim() ?? null,
    };
  }, EDITOR);
  if (!paneId || (side !== "A" && side !== "B")) {
    throw new Error(`classic tab has no visible side: ${JSON.stringify({ paneId, side })}`);
  }
  const title = `Send tab to side ${side === "A" ? "B" : "A"}`;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", {
    detail: { name: "app.launcher.toggle" },
  })));
  await page.waitForSelector(LAUNCHER_INPUT, { timeout: 10_000 });
  await page.$eval(LAUNCHER_INPUT, (input) => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.type(LAUNCHER_INPUT, title);
  await page.waitForFunction((selector, expected) =>
    document.querySelector(selector)?.textContent?.trim() === expected,
  { timeout: 10_000 }, SELECTED_TITLE, title);
  const flip = await armFlip(page, paneFlip(paneId));
  await page.keyboard.press("Enter");
  await flip.settled("first attach tab move");
  await flip.assertSettled("first attach tab move");
}

async function hasModal(page, fragment) {
  return page.evaluate((copy) => [...document.querySelectorAll('[role="dialog"]')].some(
    (dialog) => (dialog.textContent ?? "").includes(copy),
  ), fragment);
}

async function waitModal(page, fragment) {
  await until(`modal ${fragment}`, () => hasModal(page, fragment));
}

async function clickModal(page, label) {
  const clicked = await page.evaluate((text) => {
    const dialog = document.querySelector('[role="dialog"]');
    const button = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
    button?.click();
    return Boolean(button);
  }, label);
  if (!clicked) throw new Error(`modal button ${label} is missing`);
}

async function waitHeld(page) {
  await until("held first-attach banner", () => page.evaluate(() =>
    [...document.querySelectorAll(".recovery-banner")].some((banner) =>
      (banner.textContent ?? "").includes("changed before live editing started"),
    ),
  ));
  await waitModal(page, "changed in the live document before your edits joined it");
}

async function observeSocket(page) {
  const cdp = await page.createCDPSession();
  const sockets = new Map();
  const pushes = [];
  const writes = [];
  cdp.on("Network.requestWillBeSent", ({ request }) => {
    if (request.method === "PUT" && request.url.includes("/api/fs/")) writes.push("PUT");
  });
  cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
    if (url.includes("/api/doc/ws")) sockets.set(requestId, { handshake: false, closed: false, frames: 0 });
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", ({ requestId }) => {
    const socket = sockets.get(requestId);
    if (socket) socket.handshake = true;
  });
  cdp.on("Network.webSocketFrameReceived", ({ requestId }) => {
    const socket = sockets.get(requestId);
    if (socket) socket.frames++;
  });
  cdp.on("Network.webSocketClosed", ({ requestId }) => {
    const socket = sockets.get(requestId);
    if (socket) socket.closed = true;
  });
  cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
    if (!sockets.has(requestId)) return;
    try {
      const frame = JSON.parse(response.payloadData);
      if (frame.type === "push") pushes.push({ requestId, version: frame.version });
    } catch {
      // Presence and other non-JSON frames are outside this assertion.
    }
  });
  await cdp.send("Network.enable");
  return { cdp, sockets, pushes, writes };
}

async function makeClassicPage(ctx, arm) {
  // The peer's live flag must never change the classic tab's context.
  // A tab move below remounts the SAME tab after its own flag turns on,
  // preserving its in-memory content and saved base without a reload.
  const context = await ctx.page.browser().createBrowserContext();
  try {
    const page = await context.newPage();
    await page.evaluateOnNewDocument(() => localStorage.setItem("chan.docsync", "0"));
    const url = new URL(ctx.serverUrl);
    url.searchParams.set("w", `smoke-doc-first-${arm}-${STAMP}`);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
    await ctx.waitWindowLive(windowId(page));
    return { page, context };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function prepare(ctx, arm) {
  const file = `first-attach-${arm}-${STAMP}.md`;
  const base = `BASE-${arm}-${STAMP}`;
  const theirs = `PEER-${arm}-${STAMP}`;
  const mine = `LOCAL-${arm}-${STAMP}`;
  writeFileSync(join(ctx.workspaceDir, file), `${base}\n`);
  const { page, context } = await makeClassicPage(ctx, arm);
  try {
    await openFile(ctx, page, file, base);
    await setDocSync(ctx.page, true);
    await openFile(ctx, ctx.page, file, base);
    await replaceFirstLine(ctx.page, theirs);
    await waitDisk(ctx, file, theirs);
    const classicText = await editorText(page);
    if (!classicText?.includes(base) || classicText.includes(theirs)) {
      throw new Error(`classic tab changed before attach: ${JSON.stringify(classicText)}`);
    }
    return { page, context, file, base, theirs, mine };
  } catch (error) {
    error.smokeDetails = { arm, stage: "prepare", file,
      editor: await editorText(page).catch(() => null),
      peer: await editorText(ctx.page).catch(() => null), disk: diskText(ctx, file) };
    await ctx.shot(`${arm}-prepare-failure`, page).catch(() => {});
    await context.close().catch(() => {});
    throw error;
  }
}

async function makeDirty(ctx, arm) {
  const state = await prepare(ctx, arm);
  try {
    await replaceFirstLine(state.page, state.mine);
    await waitModal(state.page, "changed on disk since you opened it");
    if (!diskText(ctx, state.file).includes(state.theirs)) {
      throw new Error("classic save replaced the peer version before first attach");
    }
    await clickModal(state.page, "Cancel");
    return state;
  } catch (error) {
    error.smokeDetails = { arm, stage: "classic-conflict", file: state.file,
      editor: await editorText(state.page).catch(() => null), disk: diskText(ctx, state.file) };
    await ctx.shot(`${arm}-classic-failure`, state.page).catch(() => {});
    await state.context.close().catch(() => {});
    throw error;
  }
}

async function attach(ctx, state) {
  const socket = await observeSocket(state.page);
  await setDocSync(state.page, true);
  await moveTabToOtherSide(state.page);
  return socket;
}

async function assertHeldSafe(ctx, state, socket) {
  await waitHeld(state.page);
  const shown = await editorText(state.page);
  const peer = await editorText(ctx.page);
  const disk = diskText(ctx, state.file);
  if (!shown?.includes(state.mine) || !peer?.includes(state.theirs) ||
      !disk.includes(state.theirs) || socket.pushes.length !== 0 || socket.writes.length !== 0) {
    throw new Error(`held choice changed text: ${JSON.stringify({ shown, peer, disk, pushes: socket.pushes, writes: socket.writes })}`);
  }
}

export default {
  name: "document-first-attach-choice",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const results = [];
    const arms = ["clean", "reload", "overwrite", "reconnect"];
    for (const arm of arms) {
      const state = arm === "clean" ? await prepare(ctx, arm) : await makeDirty(ctx, arm);
      let socket = null;
      let stage = "attach-trigger";
      try {
        socket = await attach(ctx, state);
        if (arm === "clean") {
          stage = "clean-adoption";
          await waitEditor(state.page, state.theirs);
          const disk = diskText(ctx, state.file);
          const peer = await editorText(ctx.page);
          if (!disk.includes(state.theirs) || !peer?.includes(state.theirs) ||
              socket.pushes.length !== 0 || socket.writes.length !== 0 ||
              await hasModal(state.page, "changed in the live document")) {
            throw new Error(`clean adoption changed authority: ${JSON.stringify({ disk, peer, pushes: socket.pushes, writes: socket.writes })}`);
          }
        } else {
          stage = "held-choice";
          await assertHeldSafe(ctx, state, socket);
          await ctx.shot(`${arm}-held`, state.page);
          if (arm === "reconnect") {
            stage = "held-timing-and-reconnect";
            // The held choice must outlive both the save-funnel quiet bound
            // and the reconnect grace. These waits exercise named time
            // bounds only after the choice and socket are observed.
            await until("first doc socket frame", () => [...socket.sockets].find(([, s]) => s.frames > 0));
            const firstId = [...socket.sockets].find(([, s]) => s.frames > 0)?.[0];
            await pause(4_500);
            await assertHeldSafe(ctx, state, socket);
            await state.page.setOfflineMode(true);
            await until("first doc socket closed", () => socket.sockets.get(firstId)?.closed);
            await pause(3_500);
            await assertHeldSafe(ctx, state, socket);
            await state.page.setOfflineMode(false);
            await until("new doc socket received a frame", () =>
              [...socket.sockets].some(([id, s]) => id !== firstId && s.handshake && s.frames > 0),
              30_000,
            );
            await assertHeldSafe(ctx, state, socket);
          }
          stage = "choice-resolution";
          await clickModal(state.page, arm === "reload" ? "Reload" : "Overwrite");
          await waitEditor(state.page, arm === "reload" ? state.theirs : state.mine);
          await waitDisk(ctx, state.file, arm === "reload" ? state.theirs : state.mine);
          await waitEditor(ctx.page, arm === "reload" ? state.theirs : state.mine);
          const disk = diskText(ctx, state.file);
          const peer = await editorText(ctx.page);
          const answer = arm === "reload" ? state.theirs : state.mine;
          if (!peer?.includes(answer) || disk.split(answer).length - 1 !== 1 ||
              socket.writes.length !== 0 ||
              (arm === "reload" && socket.pushes.length !== 0) ||
              (arm !== "reload" && socket.pushes.length === 0)) {
            throw new Error(`choice did not converge: ${JSON.stringify({ arm, disk, peer, pushes: socket.pushes, writes: socket.writes })}`);
          }
        }
        stage = "accepted";
        await state.page.bringToFront();
        await ctx.shot(`${arm}-resolved`, state.page);
        results.push({ arm, stage, disk: diskText(ctx, state.file), pushes: socket.pushes.length });
      } catch (error) {
        error.smokeDetails = { arm, stage, file: state.file, editor: await editorText(state.page).catch(() => null),
          peer: await editorText(ctx.page).catch(() => null), disk: diskText(ctx, state.file),
          sockets: socket ? [...socket.sockets] : [], pushes: socket?.pushes ?? [],
          writes: socket?.writes ?? [], results };
        await ctx.shot(`${arm}-failure`, state.page).catch(() => {});
        throw error;
      } finally {
        await state.page.setOfflineMode(false).catch(() => {});
        await socket?.cdp.detach().catch(() => {});
        await state.context.close().catch(() => {});
      }
    }
    return { results };
  },
};
