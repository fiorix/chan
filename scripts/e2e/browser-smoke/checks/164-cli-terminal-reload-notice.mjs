import assert from "node:assert/strict";
import { poll } from "../lib/launcher-devserver.mjs";

const NOTICE = "After reload, this tab opened a plain shell. Its requested command was not restored here and may still be running in another session.";
const ENV_VALUE = "clirld-check-164-value";
const COMMAND = "printf 'CLIRLD_164_ORIGINAL:%s\\n' \"$CLIRLD_ENV\"; exec sleep 600";
const PLAIN_MARKER = "CLIRLD_164_PLAIN";
const SEARCH_QUERY = "clirldneedle";

function windowUrl(ctx, windowId) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  return url.href;
}

function cli(ctx, windowId, args) {
  return ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
    cwd: ctx.workspaceDir,
    env: {
      ...process.env,
      CHAN_CONTROL_SOCKET: ctx.controlSocket,
      CHAN_WINDOW_ID: windowId,
      CHAN_WORKSPACE_PATH: ctx.workspaceDir,
    },
  });
}

async function sessions(ctx, windowId, name) {
  const { stdout } = await cli(ctx, windowId, ["list", "--json"]);
  return Object.values(JSON.parse(stdout).groups ?? {}).flat()
    .filter((row) => row.name === name)
    .map((row) => ({ name: row.name, id: row.session_id }));
}

async function allSessions(ctx, windowId) {
  const { stdout } = await cli(ctx, windowId, ["list", "--json"]);
  return Object.values(JSON.parse(stdout).groups ?? {}).flat()
    .map((row) => ({ name: row.name, id: row.session_id }));
}

async function openCliTab(ctx, windowId, name) {
  await cli(ctx, windowId, ["new", "--window", windowId, "--tab-name", name,
    "--command", COMMAND, "--env", `CLIRLD_ENV=${ENV_VALUE}`]);
}

async function holdFirstTerminalSocket(page, mode) {
  await page.evaluate((holdMode) => {
    const NativeWebSocket = window.WebSocket;
    window.__clirld164 = { dials: [], messages: [] };
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const url = new URL(String(args[0]));
        if (url.pathname !== "/api/terminal/ws") return Reflect.construct(target, args);
        window.__clirld164.dials.push({
          command: url.searchParams.get("command"),
          env: url.searchParams.get("env"),
          session: url.searchParams.get("session"),
        });
        if (holdMode === "constructor") {
          return {
            readyState: NativeWebSocket.CONNECTING,
            binaryType: "arraybuffer",
            close() { this.readyState = NativeWebSocket.CLOSED; },
            send() { throw new Error("held terminal socket cannot send"); },
          };
        }
        const socket = Reflect.construct(target, args);
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          try {
            const frame = JSON.parse(event.data);
            window.__clirld164.messages.push({ type: frame.type, id: frame.id ?? null });
          } catch { /* PTY bytes are not control frames. */ }
        });
        // The server has delivered the frame, but the page has not adopted its id.
        Object.defineProperty(socket, "onmessage", {
          configurable: true,
          get() { return this.__heldHandler ?? null; },
          set(handler) { this.__heldHandler = handler; },
        });
        return socket;
      },
    });
  }, mode);
}

async function recordRestoredDials(page) {
  await page.evaluateOnNewDocument(() => {
    const NativeWebSocket = window.WebSocket;
    window.__clirld164RestoredDials = [];
    window.__clirld164RestoredFrames = [];
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const url = new URL(String(args[0]));
        const socket = Reflect.construct(target, args);
        if (url.pathname === "/api/terminal/ws") {
          window.__clirld164RestoredDials.push({
            command: url.searchParams.get("command"),
            env: url.searchParams.get("env"),
            session: url.searchParams.get("session"),
          });
          socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            try {
              const frame = JSON.parse(event.data);
              if (frame.type === "session") window.__clirld164RestoredFrames.push({ id: frame.id });
            } catch { /* PTY bytes are not control frames. */ }
          });
        }
        return socket;
      },
    });
  });
}

async function firstDial(page, field) {
  const read = (key) => key.split(".").reduce((value, part) => value?.[part], window);
  await page.waitForFunction((key) => key.split(".").reduce((value, part) => value?.[part], window)?.length > 0, {}, field);
  return (await page.evaluate(read, field))[0];
}

function assertCommandDial(dial) {
  assert.equal(dial.command, COMMAND, "the held first socket carries the requested command");
  assert.deepEqual(JSON.parse(dial.env), { CLIRLD_ENV: ENV_VALUE }, "the held first socket carries the environment");
  assert.equal(dial.session, null, "the first socket has no session id");
}

function assertPlainDial(dial) {
  assert.equal(dial.command, null, "the restored socket has no command override");
  assert.equal(dial.env, null, "the restored socket has no environment override");
  assert.equal(dial.session, null, "the restored socket cannot reattach the original session");
}

async function assertNotice(page) {
  const banner = await page.waitForSelector(".cli-reload-notice", { visible: true });
  const actual = await banner.evaluate((node) => ({
    role: node.getAttribute("role"),
    text: node.querySelector("span")?.textContent?.trim(),
    button: node.querySelector("button")?.getAttribute("aria-label"),
    height: node.getBoundingClientRect().height,
    bottom: node.getBoundingClientRect().bottom,
  }));
  assert.equal(actual.role, "alert");
  assert.equal(actual.text, NOTICE);
  assert.equal(actual.button, "Dismiss notice");
  assert.ok(actual.height > 0, "the notice occupies visible layout space");
  const host = await page.$eval(".terminal-host", (node) => ({
    top: node.getBoundingClientRect().top,
    height: node.getBoundingClientRect().height,
  }));
  assert.ok(host.height > 0 && host.top >= actual.bottom, "the terminal remains sized below the notice");
  return host.height;
}

async function searchRestoreArm(ctx) {
  const windowId = "smoke-check-164-search";
  const page = await ctx.browser.newPage();
  const details = {};
  try {
    await page.goto(windowUrl(ctx, windowId), { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pane");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } })));
    await page.waitForSelector('[role="treeitem"]');
    const selected = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[role="treeitem"] button.name')]
        .find((button) => button.textContent?.trim() === "doc.md");
      if (!row) return false;
      row.click();
      return true;
    });
    assert.ok(selected, "fixture file is present in the file browser");
    const opened = await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.trim() === "Open");
      if (!button) return false;
      button.click();
      return true;
    });
    assert.ok(opened, "the file inspector has an Open button");
    await page.waitForSelector(".cm-content");
    await page.keyboard.down("Control");
    await page.keyboard.down("Alt");
    await page.keyboard.press("KeyS");
    await page.keyboard.up("Alt");
    await page.keyboard.up("Control");
    await page.waitForSelector('[role="dialog"][aria-label="Search"] .head input');
    await page.type('[role="dialog"][aria-label="Search"] .head input', SEARCH_QUERY);
    await page.waitForFunction((query) => new URLSearchParams(location.hash.slice(1)).get("search") === `0:${query}`, {}, SEARCH_QUERY);
    details.before = await page.evaluate(() => ({
      searchOpen: !!document.querySelector('[role="dialog"][aria-label="Search"]'),
      query: document.querySelector('[role="dialog"][aria-label="Search"] .head input')?.value ?? null,
      searchHash: new URLSearchParams(location.hash.slice(1)).get("search"),
      layoutHash: new URLSearchParams(location.hash.slice(1)).get("s"),
      fileOpen: !!document.querySelector(".cm-content"),
    }));
    assert.deepEqual({ searchOpen: details.before.searchOpen, query: details.before.query, searchHash: details.before.searchHash, fileOpen: details.before.fileOpen },
      { searchOpen: true, query: SEARCH_QUERY, searchHash: `0:${SEARCH_QUERY}`, fileOpen: true },
      "Search and a file tab are ready before reload");
    assert.ok(details.before.layoutHash, "the file tab has a layout hash");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pane");
    await page.waitForFunction(() => !!document.querySelector('[role="dialog"][aria-label="Search"]'), { timeout: 8_000 }).catch(() => {});
    details.after = await page.evaluate(() => ({
      searchOpen: !!document.querySelector('[role="dialog"][aria-label="Search"]'),
      query: document.querySelector('[role="dialog"][aria-label="Search"] .head input')?.value ?? null,
      searchHash: new URLSearchParams(location.hash.slice(1)).get("search"),
      layoutHash: new URLSearchParams(location.hash.slice(1)).get("s"),
    }));
    assert.equal(details.after.searchOpen, true, `Search closed after reload: ${JSON.stringify(details)}`);
    assert.equal(details.after.query, SEARCH_QUERY, "Search query survives reload");
    assert.equal(details.after.searchHash, `0:${SEARCH_QUERY}`, "the Search hash survives reload");
    assert.equal(details.after.layoutHash, details.before.layoutHash, "the file layout hash survives reload");
    return details;
  } finally {
    await page.close().catch(() => {});
  }
}

async function plainControlNegativeArm(ctx) {
  const windowId = "smoke-check-164";
  const name = "cli-reload-164-negative-control";
  await ctx.waitWindowLive(windowId);
  await cli(ctx, windowId, ["new", "--window", windowId, "--tab-name", name, "--command", "exec sleep 600"]);
  try {
    await ctx.page.waitForSelector(".terminal-tab");
    await poll("sleeping control session", async () => (await sessions(ctx, windowId, name))[0] ?? null);
    await cli(ctx, windowId, ["write", "--tab-name", name, "--submit", "codex", "printf 'CLIRLD_%s\\n' 164_PLAIN"]);
    const newControl = await poll("new control echoed on sleeping tab", async () => {
      const { stdout } = await cli(ctx, windowId, ["scrollback", "--tab-name", name]);
      return stdout.includes("164_PLAIN") ? stdout : null;
    });
    assert.ok(!newControl.includes(PLAIN_MARKER), "a sleeping tab cannot compute the new marker");
    await cli(ctx, windowId, ["write", "--tab-name", name, "--submit", "codex", "printf 'CLIRLD_164_PLAIN_SHELL\\n'"]);
    const oldControl = await poll("old control echoed on sleeping tab", async () => {
      const { stdout } = await cli(ctx, windowId, ["scrollback", "--tab-name", name]);
      return stdout.includes("CLIRLD_164_PLAIN_SHELL") ? stdout : null;
    });
    assert.ok(oldControl.includes("CLIRLD_164_PLAIN_SHELL"), "the old marker matches its own echo");
    return { newMarkerAbsent: true, oldMarkerPresent: true };
  } finally {
    await cli(ctx, windowId, ["close", "--tab-name", name]).catch(() => {});
  }
}

async function preSocketArm(ctx) {
  const page = ctx.page;
  const windowId = "smoke-check-164";
  const name = "cli-reload-164-before-socket";
  const details = {};
  let opened = false;
  let copy;
  try {
    await holdFirstTerminalSocket(page, "constructor");
    await openCliTab(ctx, windowId, name);
    opened = true;
    await page.waitForSelector(".terminal-tab");
    details.heldDial = await firstDial(page, "__clirld164.dials");
    assertCommandDial(details.heldDial);
    assert.deepEqual(await sessions(ctx, windowId, name), [], "the held constructor created no server session");
    const stored = await page.evaluate(() => ({
      hash: location.hash,
      marker: sessionStorage.getItem("chan-cli-reload-bits"),
    }));
    assert.ok(stored.hash.includes(name), "the hash carries the tab name");
    assert.ok(!stored.hash.includes("CLIRLD_164_ORIGINAL") && !stored.hash.includes(ENV_VALUE), "the public hash omits spawn values");
    if (stored.marker) {
      assert.ok(!stored.marker.includes("CLIRLD_164_ORIGINAL") && !stored.marker.includes(ENV_VALUE), "the private marker omits spawn values");
    }

    await recordRestoredDials(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".terminal-tab");
    details.restoredDial = await firstDial(page, "__clirld164RestoredDials");
    assertPlainDial(details.restoredDial);
    await cli(ctx, windowId, ["write", "--tab-name", name, "--submit", "codex", "printf 'CLIRLD_%s\\n' 164_PLAIN"]);
    await poll("plain shell output", async () => {
      const { stdout } = await cli(ctx, windowId, ["scrollback", "--tab-name", name]);
      return stdout.includes(PLAIN_MARKER) ? stdout : null;
    });
    details.plainShellAnswered = true;
    ctx.mark("before-socket-controls", { heldCommand: true, noOriginalSession: true, plainShellAnswered: true });
    details.firstHostHeight = await assertNotice(page);
    await ctx.shot("before-socket-notice", page);

    copy = await ctx.browser.newPage();
    const copiedUrl = new URL(windowUrl(ctx, windowId));
    copiedUrl.hash = new URL(page.url()).hash;
    await copy.goto(copiedUrl.href, { waitUntil: "domcontentloaded" });
    await copy.waitForSelector(".terminal-tab");
    details.copyPage = await copy.evaluate(() => ({
      hash: location.hash,
      terminalCount: document.querySelectorAll(".terminal-tab").length,
    }));
    assert.ok(details.copyPage.hash.includes(name) && details.copyPage.terminalCount > 0,
      "the separate page received and rendered the same layout");
    assert.equal(await copy.$(".cli-reload-notice"), null, "the same URL in a separate page has no private marker");
    await copy.close();
    copy = null;
    assert.ok(await page.$(".cli-reload-notice"), "the original page still owes its notice");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".terminal-tab");
    await assertNotice(page);
    await page.click('.cli-reload-notice button[aria-label="Dismiss notice"]');
    await page.waitForSelector(".cli-reload-notice", { hidden: true });
    await page.waitForFunction((before) => document.querySelector(".terminal-host")?.getBoundingClientRect().height > before,
      {}, details.firstHostHeight);
    details.dismissedHostHeight = await page.$eval(".terminal-host", (node) => node.getBoundingClientRect().height);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".terminal-tab");
    assert.equal(await page.$(".cli-reload-notice"), null, "a dismissed notice stays dismissed after reload");
    return details;
  } finally {
    if (copy && !copy.isClosed()) await copy.close().catch(() => {});
    if (opened) await cli(ctx, windowId, ["close", "--tab-name", name]).catch(() => {});
  }
}

async function heldMessagesArm(ctx) {
  const windowId = "smoke-check-164-messages";
  const name = "cli-reload-164-before-frame";
  const page = await ctx.browser.newPage();
  const details = {};
  let opened = false;
  try {
    await page.goto(windowUrl(ctx, windowId), { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".pane");
    await ctx.waitWindowLive(windowId);
    await holdFirstTerminalSocket(page, "messages");
    await openCliTab(ctx, windowId, name);
    opened = true;
    await page.waitForSelector(".terminal-tab");
    await page.waitForFunction(() => window.__clirld164.messages.some((frame) => frame.type === "session"));
    details.heldDial = await firstDial(page, "__clirld164.dials");
    assertCommandDial(details.heldDial);
    details.heldFrame = await page.evaluate(() => window.__clirld164.messages.find((frame) => frame.type === "session"));
    assert.ok(details.heldFrame.id, "the held server frame names the original session");
    const original = await poll("original command session", async () => {
      const rows = await sessions(ctx, windowId, name);
      return rows.find((row) => row.id === details.heldFrame.id);
    });
    details.originalId = original.id;

    await recordRestoredDials(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".terminal-tab");
    details.restoredDial = await firstDial(page, "__clirld164RestoredDials");
    assertPlainDial(details.restoredDial);
    await page.waitForFunction(() => window.__clirld164RestoredFrames?.length > 0);
    details.restoredFrame = (await page.evaluate(() => window.__clirld164RestoredFrames))[0];
    let lastRows = [];
    let rows;
    try {
      rows = await poll("original and replacement sessions", async () => {
        lastRows = await allSessions(ctx, windowId);
        return lastRows.some((row) => row.id === original.id) &&
          lastRows.some((row) => row.id === details.restoredFrame.id) ? lastRows : null;
      });
    } catch (error) {
      throw new Error(`session list after reload: ${JSON.stringify(lastRows)}`, { cause: error });
    }
    details.originalStillListed = rows.some((row) => row.id === original.id);
    details.restoredId = details.restoredFrame.id;
    details.restoredName = rows.find((row) => row.id === details.restoredId).name;
    assert.notEqual(details.restoredId, original.id, "the restored tab has a different session id");
    await cli(ctx, windowId, ["write", "--tab-name", details.restoredName, "--submit", "codex", "printf 'CLIRLD_%s\\n' 164_PLAIN"]);
    await poll("replacement shell output", async () => {
      const { stdout } = await cli(ctx, windowId, ["scrollback", "--tab-name", details.restoredName]);
      return stdout.includes(PLAIN_MARKER) ? stdout : null;
    });
    details.plainShellAnswered = true;
    ctx.mark("before-frame-controls", { heldSession: true, originalStillListed: true, differentReplacement: true, plainShellAnswered: true });
    await assertNotice(page);
    await ctx.shot("before-frame-notice", page);
    return details;
  } finally {
    if (opened) {
      const rows = await allSessions(ctx, windowId).catch(() => []);
      for (const terminalName of new Set(rows.filter((row) => row.name === name || row.name.startsWith(`${name}-`)).map((row) => row.name))) {
        await cli(ctx, windowId, ["close", "--tab-name", terminalName]).catch(() => {});
      }
    }
    await page.close().catch(() => {});
  }
}

export default {
  name: "CLI terminal reload reports a lost command in both socket windows",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("the isolated server's control socket is unavailable");
    const details = {};
    try {
      if (!process.env.CLIRLD_164_ARM || process.env.CLIRLD_164_ARM === "search") {
        details.search = await searchRestoreArm(ctx);
      }
      if (!process.env.CLIRLD_164_ARM || process.env.CLIRLD_164_ARM === "before-socket") {
        details.beforeSocket = await preSocketArm(ctx);
      }
      if (!process.env.CLIRLD_164_ARM || process.env.CLIRLD_164_ARM === "before-frame") {
        details.beforeFrame = await heldMessagesArm(ctx);
      }
      if (process.env.CLIRLD_164_ARM === "negative-control") {
        details.negativeControl = await plainControlNegativeArm(ctx);
      }
      assert.ok(Object.keys(details).length > 0, "CLIRLD_164_ARM selects a known arm");
      return details;
    } catch (error) {
      error.smokeDetails = details;
      throw error;
    }
  },
};
