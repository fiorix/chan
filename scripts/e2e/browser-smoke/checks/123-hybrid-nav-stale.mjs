// Hybrid Nav collaboration boundary. Two browser clients share one window
// session: conflicting layout writes stale and freeze the local transaction,
// transient terminal/editor activity does not, and authoritative terminal
// metadata arriving through the roster does.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOW_ID = "hybrid-nav-stale-smoke";
const DOC = "doc.md";
const MODE = process.env.SMOKE_123_MODE ?? "ordinary";
const FIRST_UPGRADE_HOLD_MS = 9_000;
const FIRST_UPGRADE_RELEASE_MS = 7_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function sourceIdentity() {
  try {
    return {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      fixtureDirty: execFileSync("git", ["status", "--porcelain", "--", "scripts/e2e/browser-smoke/checks/123-hybrid-nav-stale.mjs"], { cwd: repo, encoding: "utf8" }).trim() !== "",
    };
  } catch {
    return { revision: null, fixtureDirty: null, identityUnavailable: true };
  }
}

function keyHash(value) {
  return createHash("sha256").update(value.trim()).digest("hex");
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
  const cdp = await page.createCDPSession();
  cdp.on("Network.requestWillBeSent", ({ requestId, request, timestamp, wallTime }) => {
    let url;
    try { url = new URL(request.url); } catch { return; }
    if (url.pathname !== sessionPath || url.searchParams.get("w") !== WINDOW_ID) return;
    const row = { page: label, requestId, method: request.method, startedAt: timestamp, startedWallAtMs: Math.round(wallTime * 1000), status: null, paneCount: null, finishedAt: null, failure: null };
    requests.set(requestId, row);
    boundedPush(evidence, "session", row);
    if (row.method === "PUT") {
      const postData = request.postData;
      if (postData !== undefined) {
        try { row.paneCount = layoutPaneCount(JSON.parse(postData).layout); }
        catch { row.failure = "unreadable PUT structure"; }
      } else {
        void cdp.send("Network.getRequestPostData", { requestId }).then(({ postData: body }) => {
          row.paneCount = layoutPaneCount(JSON.parse(body).layout);
        }).catch(() => { row.failure = "unreadable PUT structure"; });
      }
    }
  });
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    const row = requests.get(requestId);
    if (row) row.status = response.status;
  });
  cdp.on("Network.loadingFinished", ({ requestId, timestamp }) => {
    const row = requests.get(requestId);
    if (!row) return;
    requests.delete(requestId);
    row.finishedAt = timestamp;
    if (row.method === "GET" && row.status === 204) row.paneCount = 0;
    if (row.method === "GET" && row.status === 200) {
      void cdp.send("Network.getResponseBody", { requestId }).then(({ body, base64Encoded }) => {
        const json = JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body);
        row.paneCount = layoutPaneCount(json.layout);
      }).catch(() => { row.failure = "unreadable GET structure"; });
    }
  });
  cdp.on("Network.loadingFailed", ({ requestId, timestamp, errorText }) => {
    const row = requests.get(requestId);
    if (!row) return;
    requests.delete(requestId);
    row.finishedAt = timestamp;
    row.failure = errorText;
  });
  cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
    let socketUrl;
    try { socketUrl = new URL(url); } catch { return; }
    if (socketUrl.pathname !== eventPath || socketUrl.searchParams.get("w") !== WINDOW_ID) return;
    socketIds.add(requestId);
    boundedPush(evidence, "sockets", { page: label, event: "created", requestId });
  });
  cdp.on("Network.webSocketWillSendHandshakeRequest", ({ requestId, request, timestamp }) => {
    if (!socketIds.has(requestId)) return;
    const entry = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === "sec-websocket-key");
    boundedPush(evidence, "sockets", { page: label, event: "handshake-request", requestId, keyHash: entry ? keyHash(String(entry[1])) : null, at: timestamp });
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", ({ requestId, response, timestamp }) => {
    if (socketIds.has(requestId)) boundedPush(evidence, "sockets", { page: label, event: "open", requestId, status: response.status, at: timestamp });
  });
  cdp.on("Network.webSocketClosed", ({ requestId, timestamp }) => {
    if (socketIds.has(requestId)) boundedPush(evidence, "sockets", { page: label, event: "closed", requestId, at: timestamp });
  });
  cdp.on("Network.webSocketFrameReceived", ({ requestId, response, timestamp }) => {
    if (!socketIds.has(requestId)) return;
    let frame;
    try { frame = JSON.parse(response.payloadData); } catch { return; }
    if (frame.kind === "session_changed" && frame.w === WINDOW_ID) {
      boundedPush(evidence, "sockets", { page: label, event: "session_changed", requestId, at: timestamp });
    } else if (frame.type === "pong") {
      boundedPush(evidence, "sockets", { page: label, event: "pong", requestId, at: timestamp });
    }
  });
  cdp.on("Network.webSocketFrameSent", ({ requestId, response, timestamp }) => {
    if (!socketIds.has(requestId)) return;
    try {
      if (JSON.parse(response.payloadData).type === "ping") boundedPush(evidence, "sockets", { page: label, event: "ping", requestId, at: timestamp });
    } catch {}
  });
  await cdp.send("Network.enable");
  return cdp;
}

async function visibilityEvidence(page) {
  if (page.isClosed()) return { state: "closed", events: [] };
  return page.evaluate(() => ({ state: document.visibilityState, events: globalThis.__smoke123Visibility?.slice(-32) ?? [] })).catch(() => ({ state: "unavailable", events: [] }));
}

async function untilBefore(deadline, read, label, guard = () => {}) {
  while (Date.now() < deadline) {
    guard();
    const value = await read();
    if (value) return value;
    await sleep(50);
  }
  guard();
  throw invalidIntervention(`${label} missed its deadline`);
}

function invalidIntervention(reason) {
  const error = new Error(`invalid ${MODE} intervention: ${reason}`);
  error.interventionInvalid = true;
  return error;
}

async function startFirstUpgradeHold(targetPort, eventPath) {
  const sockets = new Set();
  const flows = [];
  let held = null;
  let matchingUpgrades = 0;
  let invalidReason = null;
  const invalidate = (reason) => {
    invalidReason ??= reason;
    for (const flow of flows) {
      if (flow.isWatcher) {
        flow.client.destroy();
        flow.upstream?.destroy();
      }
    }
  };
  const connectUpstream = (flow) => {
    if (flow.closed || flow.client.destroyed || invalidReason) return;
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    flow.upstream = upstream;
    sockets.add(upstream);
    upstream.on("connect", () => {
      if (flow.closed || flow.client.destroyed || invalidReason) { upstream.destroy(); return; }
      flow.connected = true;
      for (const chunk of flow.outbox) upstream.write(chunk);
      flow.outbox = [];
    });
    upstream.on("data", (chunk) => {
      if (flow.isWatcher && flow.responseStatus === null) {
        flow.responseLine = Buffer.concat([flow.responseLine, chunk]).subarray(0, 1024);
        const end = flow.responseLine.indexOf("\r\n");
        if (end >= 0) {
          const match = /^HTTP\/1\.1 (\d{3})/.exec(flow.responseLine.toString("utf8", 0, end));
          flow.responseStatus = match ? Number(match[1]) : 0;
        }
      }
      if (!flow.client.destroyed) flow.client.write(chunk);
    });
    upstream.on("end", () => flow.client.end());
    upstream.on("error", () => flow.client.destroy());
    upstream.on("close", () => { sockets.delete(upstream); flow.client.destroy(); });
  };
  const forward = (flow, chunk) => {
    if (flow.closed || flow.client.destroyed || invalidReason) return;
    if (flow.connected) flow.upstream.write(chunk);
    else flow.outbox.push(chunk);
  };
  const server = createServer((client) => {
    sockets.add(client);
    const flow = { id: flows.length + 1, client, upstream: null, outbox: [], connected: false, firstBytes: Buffer.alloc(0), responseLine: Buffer.alloc(0), responseStatus: null, classified: false, isWatcher: false, released: false, closed: false, expired: false, timer: null };
    flows.push(flow);
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
        if (line.startsWith("GET ") && line.endsWith(" HTTP/1.1") && url && /^upgrade:\s*websocket\s*$/im.test(header) && /^connection:.*\bupgrade\b/im.test(header)) {
          if (url.pathname === eventPath && url.searchParams.get("w") === WINDOW_ID) {
            flow.isWatcher = true;
            matchingUpgrades += 1;
            const key = /^sec-websocket-key:\s*([^\r\n]+)\s*$/im.exec(header)?.[1];
            flow.keyHash = key ? keyHash(key) : null;
            if (held) {
              invalidate("A attempted a second upgrade before the first-connect verdict");
              return;
            }
            flow.heldAt = Date.now();
            held = flow;
            flow.timer = setTimeout(() => {
              flow.expired = true;
              invalidate("A's first upgrade reached the 9 s hold guard");
            }, FIRST_UPGRADE_HOLD_MS);
            return;
          }
        }
        forward(flow, flow.firstBytes);
        flow.firstBytes = Buffer.alloc(0);
        connectUpstream(flow);
        return;
      }
      if (flow.isWatcher && !flow.released) {
        flow.firstBytes = Buffer.concat([flow.firstBytes, chunk]);
        if (flow.firstBytes.length > 16_384) { flow.closed = true; client.destroy(); }
      } else {
        forward(flow, chunk);
      }
    });
    client.on("end", () => { flow.closed = true; flow.upstream?.end(); });
    client.on("error", () => flow.upstream?.destroy());
    client.on("close", () => {
      flow.closed = true;
      sockets.delete(client);
      flow.upstream?.destroy();
      if (flow === held && !flow.released) invalidReason ??= "A retired its held first upgrade";
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    held: () => held,
    failIfInvalid() { if (invalidReason) throw invalidIntervention(invalidReason); },
    state: () => ({ matchingUpgrades, invalidReason, firstFlowId: held?.id ?? null, firstKeyHash: held?.keyHash ?? null, heldAt: held?.heldAt ?? null, releasedAt: held?.releasedAt ?? null, responseStatus: held?.responseStatus ?? null, expired: held?.expired ?? false, closed: held?.closed ?? false }),
    release() {
      if (invalidReason) throw invalidIntervention(invalidReason);
      if (matchingUpgrades !== 1 || !held || held.closed || held.expired || held.released || Date.now() >= held.heldAt + FIRST_UPGRADE_HOLD_MS) throw invalidIntervention("A's first upgrade retired before release");
      if (Date.now() >= held.heldAt + FIRST_UPGRADE_RELEASE_MS) throw invalidIntervention("A's release exceeded the 7 s margin");
      clearTimeout(held.timer);
      held.released = true;
      held.releasedAt = Date.now();
      const holdMs = held.releasedAt - held.heldAt;
      forward(held, held.firstBytes);
      held.firstBytes = Buffer.alloc(0);
      connectUpstream(held);
      return { flowId: held.id, heldAt: held.heldAt, releasedAt: held.releasedAt, holdMs };
    },
    async close() {
      if (held?.timer) clearTimeout(held.timer);
      for (const socket of sockets) socket.destroy();
      let timer;
      try {
        await Promise.race([
          new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("watcher relay close exceeded 2 s")), 2_000); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
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

function sessionRows(evidence, page, method) {
  return evidence.session.filter((row) => row.page === page && row.method === method);
}

function watcherRows(evidence, page, event) {
  return evidence.sockets.filter((row) => row.page === page && row.event === event);
}

function requireUntruncated(evidence) {
  if (evidence.dropped.session || evidence.dropped.sockets) throw invalidIntervention("causal evidence exceeded its bound");
}

async function requireHeldIdentity(relay, evidence, requestId, deadline) {
  const handshake = await untilBefore(deadline, () => watcherRows(evidence, "A", "handshake-request").find((row) => row.requestId === requestId), "A's browser handshake request", () => relay.failIfInvalid());
  if (!handshake.keyHash || handshake.keyHash !== relay.state().firstKeyHash) throw invalidIntervention("browser and relay handshake keys differ");
  return handshake;
}

async function renderTimingEvidence(page, sessionPath) {
  return page.evaluate((path) => ({
    firstTwoPaneAt: globalThis.__smoke123FirstTwoPaneAt ?? null,
    sessionResources: performance.getEntriesByType("resource")
      .filter((entry) => { try { return new URL(entry.name).pathname === path; } catch { return false; } })
      .map((entry) => ({ startTime: entry.startTime, responseEnd: entry.responseEnd })),
  }), sessionPath);
}

async function runFirstEmptySave(ctx, pageA, pageB, sharedUrl, eventPath, sessionPath, evidence, setRelay) {
  await pageB.goto(sharedUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await pageB.waitForSelector(".pane", { timeout: 30_000 });
  await ctx.waitWindowLive(WINDOW_ID);
  const bBoot = await untilBefore(Date.now() + 10_000, () => sessionRows(evidence, "B", "GET").find((row) => row.status === 204 && row.finishedAt), "B's empty boot read");
  await untilBefore(Date.now() + 10_000, () => watcherRows(evidence, "B", "open").find((row) => row.status === 101), "B's subscribed watcher");
  await splitAndCommit(pageB, 2);
  const put = await untilBefore(Date.now() + 10_000, () => sessionRows(evidence, "B", "PUT").find((row) => row.paneCount === 2 && row.status >= 200 && row.status < 300 && row.finishedAt && row.startedAt > bBoot.finishedAt), "B's acknowledged two-pane PUT");
  const frame = await untilBefore(Date.now() + 10_000, () => watcherRows(evidence, "B", "session_changed").find((row) => row.at >= put.startedAt), "B's own split frame");
  ctx.mark("layout123:first-empty-save-b-ready", { bPutFinishedAt: put.finishedAt, bFrameAt: frame.at });

  const relay = await startFirstUpgradeHold(Number(sharedUrl.port), eventPath);
  setRelay(relay);
  const aUrl = new URL(sharedUrl);
  aUrl.port = String(relay.port);
  aUrl.searchParams.set("fresh", "1");
  const extensionsReady = pageA.waitForResponse((response) => {
    try { return response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/api/extensions"); }
    catch { return false; }
  }, { timeout: 15_000 }).catch((error) => error);
  await pageA.goto(aUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await pageA.waitForSelector(".pane", { timeout: 30_000 });
  const extensionsResponse = await extensionsReady;
  if (extensionsResponse instanceof Error) throw invalidIntervention("A did not finish its extension-bootstrap request");
  await extensionsResponse.buffer();
  const held = await untilBefore(Date.now() + 8_000, () => relay.held(), "A's fresh watcher upgrade", () => relay.failIfInvalid());
  const deadline = held.heldAt + FIRST_UPGRADE_HOLD_MS;
  const firstA = watcherRows(evidence, "A", "created")[0];
  if (!firstA || watcherRows(evidence, "A", "created").length !== 1) throw invalidIntervention("A's fresh watcher identity is ambiguous");
  await requireHeldIdentity(relay, evidence, firstA.requestId, deadline);
  if (sessionRows(evidence, "A", "GET").length !== 0) throw invalidIntervention("fresh A unexpectedly read the saved blob at boot");
  if (await paneCount(pageA) !== 1) throw invalidIntervention("fresh A did not hold one empty pane");
  relay.failIfInvalid();
  evidence.intervention = { requested: true, valid: false, firstARequestId: firstA.requestId, bPutFinishedAt: put.finishedAt, bFrameAt: frame.at, heldAt: held.heldAt };
  await dispatchCommand(pageA, "app.search.toggle");
  await pageA.waitForSelector('[role="dialog"][aria-label="Search"]', { timeout: 3_000 });
  const elapsedBrowserMs = await pageA.evaluate(async () => {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    return performance.now() - start;
  });
  relay.failIfInvalid();
  if (Date.now() >= deadline || elapsedBrowserMs < 1_000) throw invalidIntervention("first empty save did not clear its debounce inside the hold");
  if (await paneCount(pageA) !== 1) throw invalidIntervention("A acquired a layout before its first empty save");
  evidence.intervention = { ...evidence.intervention, valid: true, searchOpened: true, elapsedBrowserMs, firstSaveOccasion: "hydrated effects and search toggle after B's PUT" };
  if (sessionRows(evidence, "A", "GET").length || evidence.session.some((row) => row.page === "A" && row.method !== "GET")) throw new Error("A made a session request during its first empty save");
  if (relay.state().matchingUpgrades !== 1 || relay.state().closed) throw invalidIntervention("fresh A's held watcher retired");
  requireUntruncated(evidence);
  const fixtureUrl = new URL(sharedUrl);
  fixtureUrl.pathname = sessionPath;
  const response = await fetch(fixtureUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => { throw invalidIntervention("fixture saved-blob read failed"); });
  const blob = response.status === 200 ? await response.json() : null;
  relay.failIfInvalid();
  if (Date.now() >= deadline) throw invalidIntervention("A's first upgrade retired before the saved-blob verdict");
  const savedPaneCount = layoutPaneCount(blob?.layout);
  check(response.status === 200 && savedPaneCount === 2, `B's blob did not survive A's first empty save: ${response.status}/${savedPaneCount}`);
  evidence.intervention = { ...evidence.intervention, blobStatus: response.status, savedPaneCount, matchingUpgrades: relay.state().matchingUpgrades };
  ctx.mark("layout123:first-empty-save-survived", evidence.intervention);
  return { productVerdict: "passed", intervention: evidence.intervention, evidence: { ...evidence, relay: relay.state() } };
}

export default {
  name: MODE === "ordinary" ? "Hybrid Nav staged chips and stale collaboration boundary" : MODE === "first-connect-gap" ? "Hybrid Nav first connect read back" : "Hybrid Nav first empty save",
  async run(ctx) {
    check(["ordinary", "first-connect-gap", "first-empty-save"].includes(MODE), `unsupported SMOKE_123_MODE: ${MODE}`);
    const sharedUrl = new URL(ctx.serverUrl);
    sharedUrl.searchParams.set("w", WINDOW_ID);
    const pageA = await ctx.browser.newPage();
    const pageB = await ctx.browser.newPage();
    const tenantPath = sharedUrl.pathname.replace(/\/$/, "");
    const sessionPath = `${tenantPath}/api/session`;
    const eventPath = `${tenantPath}/ws`;
    const controlled = MODE !== "ordinary";
    const evidence = { mode: MODE, source: null, session: [], sockets: [], dropped: { session: 0, sockets: 0 }, intervention: { requested: controlled, valid: controlled ? false : null } };
    let relay = null;
    let cdpA = null;
    let cdpB = null;
    let primaryError = null;
    const createRequests = [];
    pageA.on("request", (request) => {
      try {
        const path = new URL(request.url()).pathname;
        if (request.method() === "POST" && (path.endsWith("/api/drafts/new") || path.endsWith("/api/diagrams/new")) && createRequests.length < 256) createRequests.push(path);
      } catch {}
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
        await page.evaluateOnNewDocument((watchRender) => {
          globalThis.__smoke123Visibility = [{ state: document.visibilityState, at: Date.now() }];
          document.addEventListener("visibilitychange", () => {
            globalThis.__smoke123Visibility.push({ state: document.visibilityState, at: Date.now() });
            if (globalThis.__smoke123Visibility.length > 32) globalThis.__smoke123Visibility.shift();
          });
          if (watchRender) {
            performance.setResourceTimingBufferSize(512);
            const panes = new MutationObserver(() => {
              if (document.querySelectorAll(".pane").length === 2) {
                globalThis.__smoke123FirstTwoPaneAt = performance.now();
                panes.disconnect();
              }
            });
            panes.observe(document, { childList: true, subtree: true });
          }
        }, MODE === "first-connect-gap" && page === pageA);
      }
      if (MODE === "first-empty-save") {
        step = "A's first empty save after B's split";
        ctx.mark(step);
        return await runFirstEmptySave(ctx, pageA, pageB, sharedUrl, eventPath, sessionPath, evidence, (value) => { relay = value; });
      }
      const aUrl = new URL(sharedUrl);
      if (MODE === "first-connect-gap") {
        relay = await startFirstUpgradeHold(Number(sharedUrl.port), eventPath);
        aUrl.port = String(relay.port);
      }
      ctx.mark(step, { windowId: WINDOW_ID, mode: MODE });
      if (controlled) {
        await pageB.goto(sharedUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await pageB.waitForSelector(".pane", { timeout: 30_000 });
        await ctx.waitWindowLive(WINDOW_ID);
        await untilBefore(Date.now() + 10_000, () => sessionRows(evidence, "B", "GET").find((row) => row.status === 204 && row.finishedAt), "B's 204 boot read");
        await untilBefore(Date.now() + 10_000, () => watcherRows(evidence, "B", "open").find((row) => row.status === 101), "B's subscribed watcher");
        await pageA.goto(aUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await pageA.waitForSelector(".pane", { timeout: 30_000 });
      } else {
        for (const [page, url] of [[pageA, aUrl], [pageB, sharedUrl]]) {
          await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await page.waitForSelector(".pane", { timeout: 30_000 });
        }
        // The panes are mounted; the server does not necessarily know the window
        // yet, and the `cs` calls below address it by id.
        await ctx.waitWindowLive(WINDOW_ID);
      }

      // B's committed split reaches A outside Hybrid Nav: the transaction A
      // opens next starts from those two panes, and the counts below rest on them.
      step = "B commits first split";
      ctx.mark(step);
      let firstA = null;
      let holdDeadline = null;
      if (controlled) {
        const held = await untilBefore(Date.now() + 8_000, () => relay.held(), "A's first watcher upgrade", () => relay.failIfInvalid());
        holdDeadline = held.heldAt + FIRST_UPGRADE_HOLD_MS;
        firstA = watcherRows(evidence, "A", "created")[0];
        if (!firstA || watcherRows(evidence, "A", "created").length !== 1) throw invalidIntervention("A's held upgrade has no unique browser socket");
        const handshake = await requireHeldIdentity(relay, evidence, firstA.requestId, holdDeadline);
        const boot = await untilBefore(holdDeadline, () => sessionRows(evidence, "A", "GET").find((row) => row.status === 204 && row.finishedAt), "A's 204 boot read", () => relay.failIfInvalid());
        if (boot.finishedAt > handshake.at) throw invalidIntervention("A's boot read did not finish before its first handshake request");
        await untilBefore(holdDeadline, () => sessionRows(evidence, "B", "GET").find((row) => row.status === 204 && row.finishedAt), "B's 204 boot read", () => relay.failIfInvalid());
        await untilBefore(holdDeadline, () => watcherRows(evidence, "B", "open").find((row) => row.status === 101), "B's subscribed watcher", () => relay.failIfInvalid());
        if (sessionRows(evidence, "A", "GET").length !== 1 || evidence.session.some((row) => row.page === "A" && row.method !== "GET")) throw invalidIntervention("A had a pre-release session request beyond its boot read");
        evidence.intervention = { requested: true, valid: false, firstARequestId: firstA.requestId, heldAt: held.heldAt };
        ctx.mark("layout123:first-upgrade-held", { requestId: firstA.requestId, bootReadFinishedAt: boot.finishedAt, heldAt: held.heldAt });
      }
      await splitAndCommit(pageB, 2);
      if (controlled) {
        const put = await untilBefore(holdDeadline, () => sessionRows(evidence, "B", "PUT").find((row) => row.paneCount === 2 && row.status >= 200 && row.status < 300 && row.finishedAt), "B's acknowledged two-pane PUT", () => relay.failIfInvalid());
        const frame = await untilBefore(holdDeadline, () => watcherRows(evidence, "B", "session_changed").find((row) => row.at >= put.startedAt), "B's split broadcast", () => relay.failIfInvalid());
        if (sessionRows(evidence, "A", "GET").length !== 1 || evidence.session.some((row) => row.page === "A" && row.method !== "GET")) throw invalidIntervention("A read or wrote after boot and before release");
        if (watcherRows(evidence, "A", "open").length || watcherRows(evidence, "A", "session_changed").length) throw invalidIntervention("A subscribed before B's broadcast");
        if (await paneCount(pageA) !== 1) throw invalidIntervention("A learned B's split before release");
        requireUntruncated(evidence);
        const released = relay.release();
        ctx.mark("layout123:first-upgrade-released", { ...released, bPutFinishedAt: put.finishedAt, bFrameAt: frame.at });
        const opened = await untilBefore(released.heldAt + 10_000, () => {
          if (relay.state().closed || watcherRows(evidence, "A", "closed").some((row) => row.requestId === firstA.requestId)) throw invalidIntervention("A retired its first watcher before its handshake");
          if (watcherRows(evidence, "A", "created").some((row) => row.requestId !== firstA.requestId)) throw invalidIntervention("A redialed before its first handshake");
          const open = watcherRows(evidence, "A", "open").find((row) => row.requestId === firstA.requestId && row.status === 101);
          return open && relay.state().responseStatus === 101 ? open : null;
        }, "A's held first watcher handshake", () => relay.failIfInvalid());
        if (relay.state().matchingUpgrades !== 1 || relay.state().firstFlowId !== released.flowId) throw invalidIntervention("A's 101 did not belong to its sole held upgrade");
        evidence.intervention = { ...evidence.intervention, valid: true, releasedAt: released.releasedAt, holdMs: released.holdMs, bPutFinishedAt: put.finishedAt, bFrameAt: frame.at, firstAOpenAt: opened.at, firstFlowId: released.flowId };
      }
      step = "A waits for B's split";
      ctx.mark(step);
      if (controlled) {
        const read = await untilBefore(Date.now() + 20_000, () => sessionRows(evidence, "A", "GET").find((row) => row.startedAt >= evidence.intervention.firstAOpenAt && row.status === 200 && row.paneCount === 2 && row.finishedAt), "A's first-ready two-pane GET", () => relay.failIfInvalid()).catch((error) => {
          if (error.interventionInvalid && !relay.state().invalidReason) throw new Error("A's first-ready two-pane GET did not arrive", { cause: error });
          throw error;
        });
        await untilBefore(Date.now() + 20_000, async () => (await paneCount(pageA)) === 2, "A's hidden two-pane render", () => relay.failIfInvalid()).catch((error) => {
          if (error.interventionInvalid && !relay.state().invalidReason) throw new Error("A did not render B's split while hidden", { cause: error });
          throw error;
        });
        const render = await renderTimingEvidence(pageA, sessionPath);
        if (render.sessionResources.length !== 2 || render.firstTwoPaneAt === null || render.sessionResources[1].responseEnd <= 0 || render.sessionResources[1].responseEnd > render.firstTwoPaneAt) throw invalidIntervention("A's first-ready response was not observed before its two-pane render");
        requireUntruncated(evidence);
        if (sessionRows(evidence, "A", "GET").length !== 2 || evidence.session.some((row) => row.page === "A" && row.method !== "GET")) throw invalidIntervention("A wrote over B or read more than once before its first-ready verdict");
        if (watcherRows(evidence, "A", "closed").length || watcherRows(evidence, "A", "created").length !== 1 || watcherRows(evidence, "A", "session_changed").length) throw invalidIntervention("A's first watcher was replaced or received a later layout frame");
        evidence.intervention = { ...evidence.intervention, aReadFinishedAt: read.finishedAt, aRender: render, hiddenPaneCount: 2, aFrameCountBeforeRead: 0, aWriteCountBeforeRead: 0, matchingUpgrades: relay.state().matchingUpgrades };
        ctx.mark("layout123:first-connect-recovered", evidence.intervention);
        await waitForPaneCount(pageA, 2);
        evidence.visibilityAtFirstSplit = { A: await visibilityEvidence(pageA), B: await visibilityEvidence(pageB) };
        return { productVerdict: "passed", intervention: evidence.intervention, evidence: { ...evidence, relay: relay.state() } };
      }
      await waitForPaneCount(pageA, 2).catch((error) => { throw new Error("A never showed B's split", { cause: error }); });
      void Promise.all([visibilityEvidence(pageA), visibilityEvidence(pageB)]).then(([A, B]) => { evidence.visibilityAtFirstSplit = { A, B }; }).catch(() => {});

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
      const pages = [
        ...(!pageA.isClosed() ? [await ctx.capturePage(pageA, "hybrid-a")] : []),
        ...(!pageB.isClosed() ? [await ctx.capturePage(pageB, "hybrid-b")] : []),
      ];
      const visibility = await Promise.race([
        Promise.all([visibilityEvidence(pageA), visibilityEvidence(pageB)]).then(([A, B]) => ({ A, B })),
        sleep(500).then(() => ({ A: { state: "timed out", events: [] }, B: { state: "timed out", events: [] } })),
      ]);
      error.smokeDetails = {
        step,
        productVerdict: controlled && (error.interventionInvalid || !evidence.intervention.valid) ? "not exercised" : "failed",
        evidence: { ...evidence, relay: relay?.state() ?? null, visibility },
        pages,
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
