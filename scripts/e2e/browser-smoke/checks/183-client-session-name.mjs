import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { poll } from "../lib/launcher-devserver.mjs";

export function clientForHolder(payload, holder) {
  assert.ok(Array.isArray(payload), "session list is an array");
  const rows = payload.filter((row) => row.holder === holder);
  assert.ok(rows.length <= 1, "one holder names one client");
  return rows[0];
}

function cli(ctx, windowId, args) {
  return ctx.exec(ctx.chanBin, ["shell", "session", ...args], {
    cwd: ctx.workspaceDir,
    timeout: 15_000,
    env: {
      ...process.env,
      CHAN_CONTROL_SOCKET: ctx.controlSocket,
      CHAN_WINDOW_ID: windowId,
      CHAN_WORKSPACE_PATH: ctx.workspaceDir,
    },
  });
}

async function readClient(ctx, holder) {
  const { stdout } = await cli(ctx, "", ["list", "--json"]);
  return clientForHolder(JSON.parse(stdout), holder);
}

async function observe(page) {
  await page.evaluateOnNewDocument(() => {
    const NativeWebSocket = window.WebSocket;
    const record = window.__clientName183 = { receipts: [], statuses: [], socket: null };
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('[aria-label="status message"]')) {
        const text = node.textContent.trim();
        if (text && !record.statuses.includes(text)) record.statuses.push(text);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        if (new URL(String(args[0])).pathname.endsWith("/ws") &&
            !new URL(String(args[0])).pathname.includes("/api/")) {
          record.socket = socket;
          socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            const frame = JSON.parse(event.data);
            if (frame.type === "session_client") record.receipts.push(frame);
          });
        }
        return socket;
      },
    });
  });
}

async function reconnect(page) {
  const count = await page.evaluate(() => {
    const record = window.__clientName183;
    const count = record.receipts.length;
    record.socket.close();
    return count;
  });
  await page.waitForFunction((before) => window.__clientName183.receipts.length > before,
    { timeout: 30_000 }, count);
  return page.evaluate(() => window.__clientName183.receipts.at(-1));
}

export default {
  name: "client-session-name",
  async run(ctx) {
    assert.ok(ctx.controlSocket, "the check requires its server's control socket");
    const pages = [];
    const nonce = randomUUID();
    const open = async (label, name) => {
      const page = await ctx.browser.newPage();
      pages.push(page);
      const holder = `name183-${label}-${nonce}`;
      const windowId = `name183-${label}-${nonce}`;
      await observe(page);
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", windowId);
      url.searchParams.set("h", holder);
      if (name !== undefined) url.searchParams.set("client_name", name);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.waitForFunction(() => window.__clientName183.receipts.length > 0,
        { timeout: 30_000 });
      await ctx.waitWindowLive(windowId);
      const client = await poll(`client ${label}`, () => readClient(ctx, holder));
      const receipt = await page.evaluate(() => window.__clientName183.receipts.at(-1));
      assert.equal(receipt.id, client.id);
      return { page, holder, windowId, client, receipt };
    };
    try {
      const configured = `Work & home + /\u00e9 ${nonce}`;
      const named = await open("named", configured);
      assert.equal(named.client.name, configured, "the configured name reaches cs session list");
      assert.equal(named.receipt.name_error, undefined);
      const receipt = await reconnect(named.page);
      assert.equal(receipt.id, named.client.id, "reconnect retains the client");
      assert.equal((await readClient(ctx, named.holder)).name, configured);

      const command = `Command ${nonce}`;
      await cli(ctx, named.windowId, ["self", "--id", named.client.id, "--name", command]);
      await reconnect(named.page);
      assert.equal((await readClient(ctx, named.holder)).name, command, "a command survives presentation");
      await cli(ctx, named.windowId, ["self", "--id", named.client.id, "--reset"]);
      const reset = (await readClient(ctx, named.holder)).name;
      assert.notEqual(reset, configured);
      assert.notEqual(reset, command);
      await reconnect(named.page);
      assert.equal((await readClient(ctx, named.holder)).name, reset, "reset survives presentation");

      for (const [label, name] of [["empty", ""], ["absent", undefined]]) {
        const blank = await open(label, name);
        assert.ok(blank.client.name.length > 0, "the default name is generated");
        assert.equal(blank.receipt.name_error, undefined);
        await reconnect(blank.page);
        assert.equal((await readClient(ctx, blank.holder)).name, blank.client.name);
      }

      const refused = await open("refused", "   ");
      const expected = "session name must not be empty";
      assert.equal(refused.receipt.name_error, expected);
      await refused.page.waitForFunction((message) => window.__clientName183.statuses.includes(message),
        { timeout: 30_000 }, expected);
      await assert.rejects(
        cli(ctx, refused.windowId, ["self", "--id", refused.client.id, "--name", "   "]),
        (error) => error.code !== 0 && String(error.stderr).includes(expected),
        "the command refuses with the same sentence",
      );
      assert.equal((await readClient(ctx, refused.holder)).name, refused.client.name);
      assert.equal((await reconnect(refused.page)).name_error, expected);
      await ctx.waitWindowLive(refused.windowId);
      ctx.mark("client names verified", { named: named.client.id, refused: refused.client.id });
    } finally {
      await Promise.all(pages.map((page) => page.close()));
    }
  },
};
