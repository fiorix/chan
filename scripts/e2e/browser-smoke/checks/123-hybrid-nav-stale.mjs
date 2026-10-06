// Hybrid Nav collaboration boundary. Two browser clients share one window
// session: conflicting layout writes stale and freeze the local transaction,
// transient terminal/editor activity does not, and authoritative terminal
// metadata arriving through the roster does.

import { execFileSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOW_ID = "hybrid-nav-stale-smoke";
const DOC = "doc.md";
const MODE = process.env.SMOKE_123_MODE ?? "ordinary";
const FIRST_UPGRADE_HOLD_MS = 9_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function sourceIdentity() {
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    fixtureDirty: execFileSync("git", ["status", "--porcelain", "--", "scripts/e2e/browser-smoke/checks/123-hybrid-nav-stale.mjs"], { cwd: repo, encoding: "utf8" }).trim() !== "",
  };
}

function layoutPaneCount(node) {
  if (!node) return 0;
  if (node.k === "l") return 1;
  if (node.k === "s") {
    const a = layoutPaneCount(node.a);
    const b = layoutPaneCount(node.b);
    return a === null || b === null ? null : a + b;
  }
  return null;
}

function boundedPush(evidence, kind, row) {
  const rows = evidence[kind];
  if (rows.length === 256) {
    rows.splice(64, 128);
    evidence.dropped[kind] += 128;
  }
  rows.push(row);
}

async function sessionAndSocketEvidence(page, label, sessionPath, eventPath, evidence) {
  const requests = new Map();
  const socketIds = new Set();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== sessionPath || url.searchParams.get("w") !== WINDOW_ID) return;
    const row = { page: label, method: request.method(), startedAt: Date.now(), status: null, paneCount: null, finishedAt: null, failure: null };
    if (row.method === "PUT") {
      try { row.paneCount = layoutPaneCount(JSON.parse(request.postData()).layout); }
      catch { row.failure = "unreadable PUT structure"; }
    }
    requests.set(request, row);
    boundedPush(evidence, "session", row);
  });
  page.on("response", (response) => {
    const row = requests.get(response.request());
    if (row) row.status = response.status();
  });
  page.on("requestfinished", (request) => {
    const row = requests.get(request);
    if (!row) return;
    requests.delete(request);
    const finishedAt = Date.now();
    void (async () => {
      if (row.method === "GET" && row.status === 200) {
        try { row.paneCount = layoutPaneCount((await (await request.response()).json()).layout); }
        catch { row.failure = "unreadable GET structure"; }
      } else if (row.method === "GET" && row.status === 204) {
        row.paneCount = 0;
      }
      row.finishedAt = finishedAt;
    })();
  });
  page.on("requestfailed", (request) => {
    const row = requests.get(request);
    if (!row) return;
    requests.delete(request);
    row.failure = request.failure()?.errorText ?? "request failed";
    row.finishedAt = Date.now();
  });

  const cdp = await page.createCDPSession();
  cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
    const socketUrl = new URL(url);
    if (socketUrl.pathname !== eventPath || socketUrl.searchParams.get("w") !== WINDOW_ID) return;
    socketIds.add(requestId);
    boundedPush(evidence, "sockets", { page: label, event: "created", requestId, at: Date.now() });
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", ({ requestId, response }) => {
    if (socketIds.has(requestId)) boundedPush(evidence, "sockets", { page: label, event: "open", requestId, status: response.status, at: Date.now() });
  });
  cdp.on("Network.webSocketClosed", ({ requestId }) => {
    if (socketIds.has(requestId)) boundedPush(evidence, "sockets", { page: label, event: "closed", requestId, at: Date.now() });
  });
  cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
    if (!socketIds.has(requestId)) return;
    let frame;
    try { frame = JSON.parse(response.payloadData); } catch { return; }
    if (frame.kind === "session_changed" && frame.w === WINDOW_ID) {
      boundedPush(evidence, "sockets", { page: label, event: "session_changed", requestId, at: Date.now() });
    } else if (frame.type === "pong") {
      boundedPush(evidence, "sockets", { page: label, event: "pong", requestId, at: Date.now() });
    }
  });
  cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
    if (!socketIds.has(requestId)) return;
    try {
      if (JSON.parse(response.payloadData).type === "ping") boundedPush(evidence, "sockets", { page: label, event: "ping", requestId, at: Date.now() });
    } catch {}
  });
  await cdp.send("Network.enable");
  return cdp;
}

async function visibilityEvidence(page) {
  if (page.isClosed()) return { state: "closed", events: [] };
  return page.evaluate(() => ({ state: document.visibilityState, events: globalThis.__smoke123Visibility?.slice(-32) ?? [] })).catch(() => ({ state: "unavailable", events: [] }));
}

async function untilBefore(deadline, read, label) {
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(50);
  }
  throw invalidIntervention(`${label} missed its deadline`);
}

function invalidIntervention(reason) {
  const error = new Error(`invalid first-connect intervention: ${reason}`);
  error.interventionInvalid = true;
  return error;
}

async function startFirstUpgradeHold(targetPort, eventPath) {
  const sockets = new Set();
  let held = null;
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    const flow = { client, upstream, firstBytes: Buffer.alloc(0), classified: false, isHeld: false, released: false, closed: false, expired: false, timer: null };
    client.on("data", (chunk) => {
      if (!flow.classified) {
        flow.firstBytes = Buffer.concat([flow.firstBytes, chunk]);
        const end = flow.firstBytes.indexOf("\r\n\r\n");
        if (end < 0) {
          if (flow.firstBytes.length > 16_384) { flow.closed = true; client.destroy(); }
          return;
        }
        flow.classified = true;
        const header = flow.firstBytes.toString("utf8", 0, end + 4);
        const line = header.split("\r\n", 1)[0];
        const target = line.split(" ")[1];
        let url = null;
        try { if (target) url = new URL(target, "http://127.0.0.1"); } catch {}
        if (line.startsWith("GET ") && line.endsWith(" HTTP/1.1") && url && /^upgrade:\s*websocket\s*$/im.test(header)) {
          if (!held && url.pathname === eventPath && url.searchParams.get("w") === WINDOW_ID) {
            flow.isHeld = true;
            flow.heldAt = Date.now();
            held = flow;
            flow.timer = setTimeout(() => {
              flow.expired = true;
              client.destroy();
              upstream.destroy();
            }, FIRST_UPGRADE_HOLD_MS);
            return;
          }
        }
        upstream.write(flow.firstBytes);
        flow.firstBytes = Buffer.alloc(0);
        return;
      }
      if (flow.isHeld && !flow.released) {
        flow.firstBytes = Buffer.concat([flow.firstBytes, chunk]);
        if (flow.firstBytes.length > 16_384) { flow.closed = true; client.destroy(); }
      } else {
        upstream.write(chunk);
      }
    });
    upstream.on("data", (chunk) => client.write(chunk));
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => { flow.closed = true; sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    held: () => held,
    state: () => held ? { heldAt: held.heldAt, releasedAt: held.releasedAt ?? null, expired: held.expired, closed: held.closed } : { heldAt: null },
    release() {
      if (!held || held.closed || held.expired || held.released || Date.now() >= held.heldAt + FIRST_UPGRADE_HOLD_MS) {
        throw invalidIntervention("A's first upgrade retired before release");
      }
      clearTimeout(held.timer);
      held.released = true;
      held.releasedAt = Date.now();
      held.upstream.write(held.firstBytes);
      held.firstBytes = Buffer.alloc(0);
      return { heldAt: held.heldAt, releasedAt: held.releasedAt };
    },
    async close() {
      if (held?.timer) clearTimeout(held.timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function rendered(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value == null ? "" : String(value);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function dispatchCommand(page, name) {
  await page.evaluate((command) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: command } }),
    );
  }, name);
}

async function enterHybridNav(page) {
  await page.bringToFront();
  await dispatchCommand(page, "app.pane.mode");
  await page.waitForSelector(".app.pane-mode", { timeout: 10_000 });
}

async function paneCount(page) {
  return page.$$eval(".pane", (panes) => panes.length);
}

async function waitForPaneCount(page, count) {
  await page.bringToFront();
  await page.waitForFunction(
    (wanted) => document.querySelectorAll(".pane").length === wanted,
    { timeout: 20_000, polling: 100 },
    count,
  );
}

async function waitForStale(page) {
  await page.bringToFront();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".pane-mode-stale-warning")
        ?.textContent?.trim() === "Layout changed. Esc to discard.",
    { timeout: 20_000, polling: 100 },
  ).catch((error) => { throw new Error("A drew no stale warning after B's split", { cause: error }); });
}

async function splitAndCommit(page, expectedPanes) {
  await enterHybridNav(page);
  await page.keyboard.press("/");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".app.pane-mode", {
    hidden: true,
    timeout: 10_000,
  });
  await waitForPaneCount(page, expectedPanes);
}

async function openDoc(page) {
  await page.bringToFront();
  if (!(await page.$(".file-tree, [role=tree]"))) {
    await dispatchCommand(page, "app.files.toggle");
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
  }
  const selected = await page.evaluate((filename) => {
    const row = [
      ...document.querySelectorAll('[role="treeitem"] button.name'),
    ].find((button) => button.textContent?.trim() === filename);
    if (!row) return false;
    row.click();
    return true;
  }, DOC);
  if (!selected) throw new Error(`tree row not found: ${DOC}`);
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Open",
    );
    if (!button) return false;
    button.click();
    return true;
  });
  if (!opened) throw new Error("file inspector Open button not found");
  await page.waitForSelector(".cm-content", { timeout: 30_000 });
}

async function selectTab(page, label) {
  await page.bringToFront();
  await page.waitForFunction(
    (wanted) =>
      [...document.querySelectorAll(".tab .path")].some(
        (node) => node.textContent?.trim() === wanted,
      ),
    { timeout: 20_000, polling: 100 },
    label,
  );
  const clicked = await page.evaluate((wanted) => {
    const labelNode = [...document.querySelectorAll(".tab .path")].find(
      (node) => node.textContent?.trim() === wanted,
    );
    const tab = labelNode?.closest(".tab");
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`tab not clickable: ${label}`);
}

function terminalRows(payload) {
  return Object.entries(payload.groups ?? {}).flatMap(([group, rows]) =>
    (Array.isArray(rows) ? rows : []).map((row) => ({ group, ...row })),
  );
}

async function poll(read, accept, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(
    `${label} did not settle; last=${JSON.stringify(last)} ` +
      `error=${lastError?.message ?? "none"}`,
  );
}

async function renameTerminalSession(page, sessionId, oldName, newName, group) {
  return page.evaluate(
    ({ sessionId, oldName, newName, group, windowId }) =>
      new Promise((resolve, reject) => {
        const token =
          sessionStorage.getItem("chan.token") ??
          new URLSearchParams(location.search).get("t") ??
          "";
        const url = new URL("/api/terminal/ws", location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("cols", "80");
        url.searchParams.set("rows", "24");
        url.searchParams.set("tab_name", oldName);
        url.searchParams.set("window_id", windowId);
        url.searchParams.set("session", sessionId);
        url.searchParams.set("since", "0");
        url.searchParams.set("agent_echo_since", "0");
        if (token) url.searchParams.set("t", token);

        const socket = new WebSocket(url);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("terminal metadata rename timed out"));
        }, 20_000);
        let proposed = false;
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const frame = JSON.parse(event.data);
          if (frame.type === "session" && !proposed) {
            proposed = true;
            socket.send(
              JSON.stringify({ type: "rename", name: newName, group }),
            );
          } else if (frame.type === "renamed") {
            clearTimeout(timer);
            socket.close();
            resolve(frame);
          } else if (frame.type === "rename_failed") {
            clearTimeout(timer);
            socket.close();
            reject(
              new Error(frame.message ?? "terminal metadata rename failed"),
            );
          }
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("terminal metadata socket failed"));
        });
      }),
    { sessionId, oldName, newName, group, windowId: WINDOW_ID },
  );
}

export default {
  name: "Hybrid Nav staged chips and stale collaboration boundary",
  async run(ctx) {
    check(MODE === "ordinary" || MODE === "first-connect-gap", `unsupported SMOKE_123_MODE: ${MODE}`);
    const sharedUrl = new URL(ctx.serverUrl);
    sharedUrl.searchParams.set("w", WINDOW_ID);
    const pageA = await ctx.browser.newPage();
    const pageB = await ctx.browser.newPage();
    const tenantPath = sharedUrl.pathname.replace(/\/$/, "");
    const sessionPath = `${tenantPath}/api/session`;
    const eventPath = `${tenantPath}/ws`;
    const controlled = MODE === "first-connect-gap";
    const evidence = { mode: MODE, source: null, session: [], sockets: [], dropped: { session: 0, sockets: 0 }, intervention: { requested: controlled, valid: controlled ? false : null } };
    let relay = null;
    let cdpA = null;
    let cdpB = null;
    let primaryError = null;
    const createRequests = [];
    pageA.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        (path.endsWith("/api/drafts/new") || path.endsWith("/api/diagrams/new"))
      ) {
        createRequests.push(path);
      }
    });

    const cli = (args) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
        cwd: ctx.workspaceDir,
        env: {
          ...process.env,
          CHAN_CONTROL_SOCKET: ctx.controlSocket,
          CHAN_WINDOW_ID: WINDOW_ID,
          CHAN_WORKSPACE_PATH: ctx.workspaceDir,
        },
        timeout: 90_000,
      });

    let terminalName = null;
    let step = "load co-viewers";
    try {
      evidence.source = sourceIdentity();
      ctx.mark("layout123:mode", { mode: MODE, ...evidence.source });
      cdpA = await sessionAndSocketEvidence(pageA, "A", sessionPath, eventPath, evidence);
      cdpB = await sessionAndSocketEvidence(pageB, "B", sessionPath, eventPath, evidence);
      for (const page of [pageA, pageB]) {
        await page.evaluateOnNewDocument(() => {
          globalThis.__smoke123Visibility = [{ state: document.visibilityState, at: Date.now() }];
          document.addEventListener("visibilitychange", () => {
            globalThis.__smoke123Visibility.push({ state: document.visibilityState, at: Date.now() });
            if (globalThis.__smoke123Visibility.length > 32) globalThis.__smoke123Visibility.shift();
          });
        });
      }
      const aUrl = new URL(sharedUrl);
      if (controlled) {
        relay = await startFirstUpgradeHold(Number(sharedUrl.port), eventPath);
        aUrl.port = String(relay.port);
      }
      ctx.mark(step, { windowId: WINDOW_ID, mode: MODE });
      for (const [page, url] of [[pageA, aUrl], [pageB, sharedUrl]]) {
        await page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForSelector(".pane", { timeout: 30_000 });
      }
      // The panes are mounted; the server does not necessarily know the window
      // yet, and the `cs` calls below address it by id.
      await ctx.waitWindowLive(WINDOW_ID);

      // B's committed split reaches A outside Hybrid Nav: the transaction A
      // opens next starts from those two panes, and the counts below rest on them.
      step = "B commits first split";
      ctx.mark(step);
      let firstA = null;
      let holdDeadline = null;
      if (controlled) {
        const held = await untilBefore(Date.now() + 8_000, () => relay.held(), "A's first watcher upgrade");
        holdDeadline = held.heldAt + FIRST_UPGRADE_HOLD_MS;
        firstA = evidence.sockets.find((row) => row.page === "A" && row.event === "created");
        if (!firstA) throw invalidIntervention("A's held upgrade has no matching browser socket");
        await untilBefore(holdDeadline, () => evidence.session.find((row) => row.page === "A" && row.method === "GET" && row.status === 204 && row.finishedAt && row.finishedAt <= held.heldAt), "A's 204 boot read");
        await untilBefore(holdDeadline, () => evidence.session.find((row) => row.page === "B" && row.method === "GET" && row.status === 204 && row.finishedAt), "B's 204 boot read");
        await untilBefore(holdDeadline, () => evidence.sockets.find((row) => row.page === "B" && row.event === "open" && row.status === 101), "B's subscribed watcher");
        evidence.intervention = { requested: true, valid: false, firstARequestId: firstA.requestId, heldAt: held.heldAt };
        ctx.mark("layout123:first-upgrade-held", { requestId: firstA.requestId, heldAt: held.heldAt });
      }
      await splitAndCommit(pageB, 2);
      if (controlled) {
        const put = await untilBefore(holdDeadline, () => evidence.session.find((row) => row.page === "B" && row.method === "PUT" && row.paneCount === 2 && row.status >= 200 && row.status < 300 && row.finishedAt), "B's acknowledged two-pane PUT");
        const frame = await untilBefore(holdDeadline, () => evidence.sockets.find((row) => row.page === "B" && row.event === "session_changed" && row.at >= put.startedAt), "B's split broadcast");
        if (evidence.sockets.some((row) => row.page === "A" && row.event === "open" && row.at <= frame.at)) throw invalidIntervention("A subscribed before B's broadcast");
        const released = relay.release();
        ctx.mark("layout123:first-upgrade-released", { ...released, bPutFinishedAt: put.finishedAt, bFrameAt: frame.at });
        const opened = await untilBefore(released.heldAt + 10_000, () => {
          if (relay.held().closed || evidence.sockets.some((row) => row.page === "A" && row.event === "closed" && row.requestId === firstA.requestId)) throw invalidIntervention("A retired its first watcher before its handshake");
          if (evidence.sockets.some((row) => row.page === "A" && row.event === "created" && row.requestId !== firstA.requestId)) throw invalidIntervention("A redialed before its first handshake");
          return evidence.sockets.find((row) => row.page === "A" && row.event === "open" && row.requestId === firstA.requestId && row.status === 101);
        }, "A's first watcher handshake");
        evidence.intervention = { ...evidence.intervention, valid: true, releasedAt: released.releasedAt, bPutFinishedAt: put.finishedAt, bFrameAt: frame.at, firstAOpenAt: opened.at };
      }
      step = "A waits for B's split";
      ctx.mark(step);
      await waitForPaneCount(pageA, 2).catch((error) => {
        if (controlled && evidence.sockets.some((row) => row.page === "A" && row.event === "closed" && row.requestId === firstA.requestId)) {
          throw invalidIntervention("A's first watcher closed before the read-back rendered");
        }
        throw new Error("A never showed B's split", { cause: error });
      });
      evidence.visibilityAtFirstSplit = { A: await visibilityEvidence(pageA), B: await visibilityEvidence(pageB) };
      if (controlled) {
        const renderedAt = Date.now();
        if (evidence.dropped.session || evidence.dropped.sockets) throw invalidIntervention("causal evidence exceeded its bound");
        if (evidence.sockets.some((row) => row.page === "A" && row.at <= renderedAt && ((row.event === "closed" && row.requestId === firstA.requestId) || (row.event === "created" && row.requestId !== firstA.requestId)))) throw invalidIntervention("A replaced its first watcher before rendering");
        if (evidence.sockets.some((row) => row.page === "A" && row.event === "session_changed" && row.at <= renderedAt)) throw invalidIntervention("A received a later layout frame before rendering");
        const read = await untilBefore(Date.now() + 2_000, () => evidence.session.find((row) => row.page === "A" && row.method === "GET" && row.startedAt >= evidence.intervention.firstAOpenAt && row.status === 200 && row.paneCount === 2 && row.finishedAt), "A's first-ready two-pane GET");
        if (evidence.session.some((row) => row.page === "A" && row.method === "DELETE" && row.startedAt <= renderedAt)) throw new Error("A deleted the empty session before accepting B's split");
        evidence.intervention = { ...evidence.intervention, aReadFinishedAt: read.finishedAt, aRenderedAt: renderedAt };
        ctx.mark("layout123:first-connect-recovered", evidence.intervention);
      }

      // A owns a local transaction with two path-less editor intents.
      step = "A stages editor intents";
      ctx.mark(step);
      await enterHybridNav(pageA);
      await pageA.keyboard.press("n");
      await pageA.keyboard.press("i");
      await pageA.waitForFunction(
        () => document.querySelectorAll(".staged-editor").length === 2,
        { timeout: 10_000 },
      );
      const stagedLabels = await pageA.$$eval(".staged-editor .path", (nodes) =>
        nodes.map((node) => node.textContent?.trim()),
      );
      check(
        JSON.stringify(stagedLabels) ===
          JSON.stringify(["New draft", "New diagram"]),
        `unexpected staged labels: ${JSON.stringify(stagedLabels)}`,
      );

      // B writes two successive shared layouts. A retains its two-pane draft
      // and queues only the newest remote tree.
      step = "B commits second and third splits";
      ctx.mark(step);
      await splitAndCommit(pageB, 3);
      await waitForStale(pageA);
      await splitAndCommit(pageB, 4);
      await sleep(2_000);
      await pageA.bringToFront();
      check(
        (await paneCount(pageA)) === 2,
        "stale transaction reconciled early",
      );
      check(
        (await pageA.$$(".staged-editor.stale")).length === 2,
        "staged editor chips were not dimmed while stale",
      );
      check(
        await pageA.$$eval(".staged-editor .close", (buttons) =>
          buttons.every((button) => button.disabled),
        ),
        "stale staged editor removal remained enabled",
      );

      // Enter plus two mutation keys are inert and cannot allocate files.
      await pageA.keyboard.press("Enter");
      await pageA.keyboard.press("/");
      await pageA.keyboard.press("n");
      await sleep(500);
      check(await pageA.$(".app.pane-mode"), "stale Enter exited Hybrid Nav");
      check(
        (await paneCount(pageA)) === 2,
        "stale split mutation changed the draft",
      );
      check(
        (await pageA.$$(".staged-editor")).length === 2,
        "stale editor staging changed the queue",
      );
      check(
        createRequests.length === 0,
        "stale Enter created a draft or diagram",
      );

      await pageA.keyboard.press("Escape");
      await pageA.waitForSelector(".app.pane-mode", {
        hidden: true,
        timeout: 10_000,
      });
      await waitForPaneCount(pageA, 4);
      await ctx.shot("hybrid-nav-newest-layout-after-escape", pageA);

      // Establish a terminal and a shared editor before opening the next
      // transaction. Their output/content updates are explicitly excluded.
      step = "terminal and editor activity";
      ctx.mark(step);
      await dispatchCommand(pageA, "app.terminal.toggle");
      await pageA.waitForSelector(".terminal-tab", { timeout: 30_000 });
      const terminalPayload = await poll(
        async () =>
          JSON.parse(rendered((await cli(["list", "--json"])).stdout)),
        (payload) =>
          terminalRows(payload).some((row) => row.window === WINDOW_ID),
        "terminal registration",
      );
      const terminal = terminalRows(terminalPayload).find(
        (row) => row.window === WINDOW_ID,
      );
      terminalName = terminal?.name ?? null;
      check(
        terminalName && terminal?.session_id,
        "registered terminal lacks identity",
      );

      await openDoc(pageA);
      await selectTab(pageB, DOC);
      await pageB.waitForSelector(".cm-content", { timeout: 30_000 });
      await selectTab(pageA, DOC);
      await sleep(1_500);

      await enterHybridNav(pageA);
      const outputMarker = `HYBRID-OUTPUT-${Date.now()}`;
      await cli([
        "write",
        "--tab-name",
        terminalName,
        `printf '${outputMarker}\\n'\n`,
      ]);
      await poll(
        async () =>
          rendered(
            (await cli(["scrollback", "--tab-name", terminalName])).stdout,
          ),
        (scrollback) => scrollback.includes(outputMarker),
        "terminal output",
      );

      const editMarker = `HYBRID-EDIT-${Date.now()}`;
      await pageB.bringToFront();
      await pageB.click(".cm-content");
      await pageB.keyboard.down("Control");
      await pageB.keyboard.press("Home");
      await pageB.keyboard.up("Control");
      await pageB.keyboard.type(`${editMarker} `, { delay: 10 });
      check(
        await pageB.$eval(
          ".cm-content",
          (editor, marker) => editor.textContent?.includes(marker),
          editMarker,
        ),
        "collaborator editor did not accept the content update",
      );
      await sleep(1_000);
      await pageA.bringToFront();
      check(
        !(await pageA.$(".pane-mode-stale-warning")),
        "terminal output or file content made Hybrid Nav stale",
      );
      await pageA.keyboard.press("Escape");
      await pageA.waitForSelector(".app.pane-mode", {
        hidden: true,
        timeout: 10_000,
      });

      // A server-settled name/group pair arrives through the terminal roster.
      // It updates the live tab first, then stales the open transaction.
      step = "terminal roster rename";
      ctx.mark(step);
      await enterHybridNav(pageA);
      const renamed = `${terminalName}-renamed`;
      const renamedFrame = await renameTerminalSession(
        pageB,
        terminal.session_id,
        terminalName,
        renamed,
        "hybrid-smoke",
      );
      check(
        renamedFrame.name === renamed && renamedFrame.group === "hybrid-smoke",
        `unexpected settled metadata: ${JSON.stringify(renamedFrame)}`,
      );
      terminalName = renamed;
      await waitForStale(pageA);
      const renamedPayload = await poll(
        async () =>
          JSON.parse(rendered((await cli(["list", "--json"])).stdout)),
        (payload) =>
          terminalRows(payload).some(
            (row) => row.name === renamed && row.group === "hybrid-smoke",
          ),
        "settled terminal metadata",
      );
      check(
        terminalRows(renamedPayload).length > 0,
        "terminal roster disappeared",
      );
      await pageA.keyboard.press("Escape");
      await pageA.waitForSelector(".app.pane-mode", {
        hidden: true,
        timeout: 10_000,
      });
      await pageA.waitForFunction(
        (label) =>
          [...document.querySelectorAll(".tab .path")].some(
            (node) => node.textContent?.trim() === label,
          ),
        { timeout: 20_000, polling: 100 },
        renamed,
      );
      await ctx.shot("hybrid-nav-roster-metadata-stale", pageA);

      return {
        productVerdict: "passed",
        evidence: { ...evidence, relay: relay?.state() ?? null, visibility: { A: await visibilityEvidence(pageA), B: await visibilityEvidence(pageB) } },
        stagedLabels,
        newestPaneCount: await paneCount(pageA),
        createRequests,
        outputMarker,
        editMarker,
        renamed,
      };
    } catch (error) {
      primaryError = error;
      error.smokeDetails = {
        step,
        productVerdict: error.interventionInvalid ? "not exercised" : "failed",
        evidence: { ...evidence, relay: relay?.state() ?? null, visibility: { A: await visibilityEvidence(pageA), B: await visibilityEvidence(pageB) } },
        pages: [
          ...(!pageA.isClosed() ? [await ctx.capturePage(pageA, "hybrid-a")] : []),
          ...(!pageB.isClosed() ? [await ctx.capturePage(pageB, "hybrid-b")] : []),
        ],
        socketsAndPendingRequests: ctx.pendingEvidence(),
      };
      throw error;
    } finally {
      if (terminalName) {
        await cli(["close", "--tab-name", terminalName]).catch(() => {});
      }
      if (!pageB.isClosed()) await pageB.close().catch(() => {});
      if (!pageA.isClosed()) await pageA.close().catch(() => {});
      if (cdpB) await cdpB.detach().catch(() => {});
      if (cdpA) await cdpA.detach().catch(() => {});
      if (relay) {
        try { await relay.close(); }
        catch (error) {
          if (primaryError) primaryError.smokeDetails.cleanupError = error.message;
          else throw error;
        }
      }
    }
  },
};
