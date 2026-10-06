// Item 4: a foregrounded page probes its existing /ws subscription, then a
// silent TCP path forces a new subscription before the old socket closes.
// A check-local relay exposes the exact watcher connection being silenced.

import { createServer, connect } from "node:net";

const WINDOW_ID = "smoke-watcher-wake-68";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${description} did not occur within ${timeoutMs}ms`);
    await delay(50);
  }
}

async function startRelay(targetPort, eventPath) {
  const flows = [];
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    const flow = {
      id: flows.length + 1,
      client,
      upstream,
      watcher: false,
      silentAt: null,
      clientClosed: false,
      upstreamClosed: false,
      openedAt: Date.now(),
      closedAt: null,
      bothClosedAt: null,
    };
    flows.push(flow);
    let firstLine = Buffer.alloc(0);
    let classified = false;
    client.on("data", (chunk) => {
      if (!classified) {
        firstLine = Buffer.concat([firstLine, chunk]);
        const end = firstLine.indexOf(10);
        if (end < 0) return;
        const requestLine = firstLine.toString("utf8", 0, end).trim();
        const requestTarget = requestLine.split(" ")[1];
        if (requestLine.startsWith("GET ") && requestTarget) {
          const requestUrl = new URL(requestTarget, "http://127.0.0.1");
          flow.watcher = requestUrl.pathname === eventPath && requestUrl.searchParams.get("w") === WINDOW_ID;
        }
        classified = true;
        upstream.write(firstLine);
        firstLine = Buffer.alloc(0);
        return;
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => client.write(chunk));
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      flow.clientClosed = true;
      flow.closedAt ??= Date.now();
      if (flow.upstreamClosed) flow.bothClosedAt = Date.now();
      upstream.destroy();
    });
    upstream.on("close", () => {
      flow.upstreamClosed = true;
      flow.closedAt ??= Date.now();
      if (flow.clientClosed) flow.bothClosedAt = Date.now();
      client.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    flows,
    watcherFlows: () => flows.filter((flow) => flow.watcher),
    activeWatchers: () => flows.filter((flow) => flow.watcher && !flow.clientClosed && !flow.upstreamClosed),
    silence(flow) {
      if (!flow?.watcher || flow.clientClosed || flow.upstreamClosed) {
        throw new Error("selected watcher relay pair is not live");
      }
      flow.silentAt = Date.now();
      flow.client.pause();
      flow.upstream.pause();
    },
    cut(flow) {
      if (!flow?.watcher) throw new Error("selected relay pair is not a watcher");
      flow.client.destroy();
      flow.upstream.destroy();
    },
    async close() {
      for (const flow of flows) {
        flow.client.destroy();
        flow.upstream.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function watchFrame(response) {
  try {
    return JSON.parse(response.payloadData);
  } catch {
    return null;
  }
}

export default {
  name: "watcher wake retains one socket and silence redials",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const serverUrl = new URL(ctx.serverUrl);
    const eventPath = `${serverUrl.pathname.replace(/\/$/, "")}/ws`;
    const relay = await startRelay(Number(serverUrl.port), eventPath);
    const page = await ctx.browser.newPage();
    let otherPage = null;
    let cdp = null;
    let primaryError = null;
    const terminalNames = [];
    const network = { created: [], handshakes: [], closed: [], sent: [], received: [] };
    const evidence = { windowId: WINDOW_ID, relayPort: relay.port };
    try {
      cdp = await page.createCDPSession();
      cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
        const socketUrl = new URL(url);
        if (socketUrl.pathname === eventPath && socketUrl.searchParams.get("w") === WINDOW_ID) {
          network.created.push({ requestId, at: Date.now() });
        }
      });
      cdp.on("Network.webSocketHandshakeResponseReceived", ({ requestId, response }) => {
        if (network.created.some((entry) => entry.requestId === requestId)) {
          network.handshakes.push({ requestId, status: response.status, at: Date.now() });
        }
      });
      cdp.on("Network.webSocketClosed", ({ requestId }) => {
        if (network.created.some((entry) => entry.requestId === requestId)) {
          network.closed.push({ requestId, at: Date.now() });
        }
      });
      cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
        if (network.created.some((entry) => entry.requestId === requestId)) {
          network.sent.push({ requestId, type: watchFrame(response)?.type, at: Date.now() });
        }
      });
      cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
        if (network.created.some((entry) => entry.requestId === requestId)) {
          network.received.push({ requestId, type: watchFrame(response)?.type, at: Date.now() });
        }
      });
      await cdp.send("Network.enable");

      const ownUrl = new URL(ctx.serverUrl);
      ownUrl.port = String(relay.port);
      ownUrl.searchParams.set("w", WINDOW_ID);
      await page.goto(ownUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.evaluate(() => {
        globalThis.__wake68Visibility = [];
        document.addEventListener("visibilitychange", () => {
          globalThis.__wake68Visibility.push({ state: document.visibilityState, at: Date.now() });
        });
      });
      await ctx.waitWindowLive(WINDOW_ID);
      const first = await until(
        () => network.handshakes.find((entry) => entry.status === 101),
        "first watcher WebSocket handshake",
      );
      const firstFlow = await until(
        () => relay.activeWatchers()[0],
        "first watcher relay pair",
      );
      if (relay.activeWatchers().length !== 1) throw new Error("initial watcher has overlapping relay subscriptions");
      ctx.mark("watcher:first-open", { requestId: first.requestId, relayFlow: firstFlow.id });

      // Establish the 20 s heartbeat's phase first. A foreground ping within
      // two seconds of the next transition cannot be the cadence ping.
      const heartbeat = await until(
        () => network.sent.find((entry) => entry.requestId === first.requestId && entry.type === "ping"),
        "ordinary heartbeat ping",
        25_000,
      );
      await until(
        () => network.received.some((entry) => entry.requestId === first.requestId && entry.type === "pong" && entry.at >= heartbeat.at),
        "ordinary heartbeat pong",
        5_000,
      );
      await delay(2_000);

      // A real tab switch fires visibilitychange on the app page. Require
      // both hidden and visible states before attributing its ping to resume.
      otherPage = await ctx.browser.newPage();
      await otherPage.goto("about:blank");
      await otherPage.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "hidden", { timeout: 10_000, polling: 100 });
      const beforePing = network.sent.filter((entry) => entry.requestId === first.requestId && entry.type === "ping").length;
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible", { timeout: 10_000 });
      const healthyVisibility = await page.evaluate(() => globalThis.__wake68Visibility.slice(-2));
      if (healthyVisibility[0]?.state !== "hidden" || healthyVisibility[1]?.state !== "visible") {
        throw new Error(`healthy foreground did not emit hidden/visible events: ${JSON.stringify(healthyVisibility)}`);
      }
      const healthyVisibleAt = healthyVisibility[1].at;
      await until(
        () => network.sent.filter((entry) => entry.requestId === first.requestId && entry.type === "ping").length > beforePing,
        "foreground watcher probe ping",
        2_000,
      );
      const ping = network.sent.filter((entry) => entry.requestId === first.requestId && entry.type === "ping").at(-1);
      if (ping.at < healthyVisibleAt || ping.at - healthyVisibleAt > 2_000 || ping.at - heartbeat.at > 15_000) {
        throw new Error("foreground probe ping arrived outside its visibility and heartbeat phase windows");
      }
      await until(
        () => network.received.some((entry) => entry.requestId === first.requestId && entry.type === "pong" && entry.at >= ping.at),
        "foreground watcher probe pong",
        5_000,
      );
      await delay(4_100);
      if (network.created.length !== 1 || network.closed.length !== 0 || relay.activeWatchers().length !== 1) {
        throw new Error(`healthy foreground replaced its watcher: ${JSON.stringify({ created: network.created.length, closed: network.closed.length, live: relay.activeWatchers().length })}`);
      }
      evidence.healthy = { requestId: first.requestId, relayFlow: firstFlow.id, heartbeatAt: heartbeat.at, visibilityEvents: healthyVisibility, visibleAt: healthyVisibleAt, probePingAt: ping.at, retainedForMs: Date.now() - healthyVisibleAt };
      ctx.mark("watcher:healthy-retained", evidence.healthy);

      async function oneTerminal(name) {
        await ctx.exec(ctx.chanBin, ["shell", "terminal", "new", "--window", WINDOW_ID, "--tab-name", name], {
          cwd: ctx.workspaceDir,
          env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: WINDOW_ID },
          timeout: 30_000,
        });
        terminalNames.push(name);
        const counts = async () => {
          const tabs = await page.$$eval(".tabs > .tab .path", (nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
          const { stdout } = await ctx.exec(ctx.chanBin, ["shell", "terminal", "list", "--json"], {
            cwd: ctx.workspaceDir,
            env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: WINDOW_ID },
            timeout: 15_000,
          });
          const sessions = Object.values(JSON.parse(stdout).groups ?? {}).flat();
          const tabCount = tabs.filter((tab) => tab === name).length;
          const sessionCount = sessions.filter((session) => session.name === name && session.window === WINDOW_ID).length;
          if (tabCount > 1 || sessionCount > 1) throw new Error(`duplicate delivery for ${name}: tabs=${tabCount} sessions=${sessionCount}`);
          return { tabCount, sessionCount };
        };
        await until(async () => {
          const seen = await counts();
          return seen.tabCount === 1 && seen.sessionCount === 1;
        }, `one terminal tab and session for ${name}`, 20_000);
        await delay(750);
        const settled = await counts();
        if (settled.tabCount !== 1 || settled.sessionCount !== 1) {
          throw new Error(`command ${name} did not settle at one tab and session: ${JSON.stringify(settled)}`);
        }
        return { ...settled, settleMs: 750 };
      }

      evidence.healthyCommand = await oneTerminal("wake68-healthy");
      if (relay.activeWatchers().length !== 1 || network.created.length !== 1) {
        throw new Error("healthy command overlapped watcher subscriptions");
      }

      const afterHealthyPing = network.sent.filter((entry) => entry.requestId === first.requestId && entry.type === "ping").length;
      const nextHeartbeat = await until(
        () => network.sent.filter((entry) => entry.requestId === first.requestId && entry.type === "ping")[afterHealthyPing],
        "heartbeat before the silent transition",
        22_000,
      );
      await until(
        () => network.received.some((entry) => entry.requestId === first.requestId && entry.type === "pong" && entry.at >= nextHeartbeat.at),
        "pong before the silent transition",
        5_000,
      );
      await delay(2_000);

      // Hold both TCP directions open but silent. The server retains this
      // stale subscriber while the client must replace its unanswered probe.
      relay.silence(firstFlow);
      const pongCount = network.received.filter((entry) => entry.requestId === first.requestId && entry.type === "pong").length;
      await otherPage.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "hidden", { timeout: 10_000, polling: 100 });
      const beforeSilentPing = network.sent.filter((entry) => entry.requestId === first.requestId && entry.type === "ping").length;
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible", { timeout: 10_000 });
      const silentVisibility = await page.evaluate(() => globalThis.__wake68Visibility.slice(-2));
      if (silentVisibility[0]?.state !== "hidden" || silentVisibility[1]?.state !== "visible") {
        throw new Error(`silent foreground did not emit hidden/visible events: ${JSON.stringify(silentVisibility)}`);
      }
      const silentVisibleAt = silentVisibility[1].at;
      await until(
        () => network.sent.filter((entry) => entry.requestId === first.requestId && entry.type === "ping").length > beforeSilentPing,
        "silent foreground probe ping",
        2_000,
      );
      const silentPing = network.sent.filter((entry) => entry.requestId === first.requestId && entry.type === "ping").at(-1);
      if (silentPing.at < silentVisibleAt || silentPing.at - silentVisibleAt > 2_000 || silentPing.at - nextHeartbeat.at > 15_000) {
        throw new Error("silent foreground probe ping arrived outside its visibility and heartbeat phase windows");
      }
      const second = await until(
        () => network.handshakes.find((entry) => entry.status === 101 && entry.requestId !== first.requestId),
        "replacement watcher WebSocket handshake",
        6_000,
      );
      if (network.received.filter((entry) => entry.requestId === first.requestId && entry.type === "pong").length !== pongCount) {
        throw new Error("a pong crossed the silenced watcher path");
      }
      if (network.closed.some((entry) => entry.requestId === first.requestId && entry.at <= second.at)) {
        throw new Error("the first browser socket closed before the silent-path replacement handshook");
      }
      if (second.at - silentVisibleAt > 6_000) throw new Error("silent-path replacement exceeded the probe and backoff window");
      const secondFlow = await until(
        () => relay.activeWatchers().find((flow) => flow.id !== firstFlow.id),
        "replacement watcher relay pair",
      );
      if (relay.watcherFlows().length !== 2 || !firstFlow.silentAt || (firstFlow.closedAt !== null && firstFlow.closedAt <= second.at)) {
        throw new Error("the stale TCP pair closed before the replacement handshook");
      }
      evidence.silent = { oldRequestId: first.requestId, newRequestId: second.requestId, oldFlow: firstFlow.id, newFlow: secondFlow.id, visibilityEvents: silentVisibility, visibleAt: silentVisibleAt, probePingAt: silentPing.at, handshakeAt: second.at, oldBrowserClosedBeforeHandoff: false, serverHeldOldSubscriberAtHandoff: true };
      ctx.mark("watcher:silent-and-replaced", evidence.silent);

      // The server broadcasts commands to both tagged sockets while the old
      // upstream remains attached. Reap that stale side before asserting one
      // delivered command on the replacement subscription.
      evidence.silent.cleanupStartedAt = Date.now();
      relay.cut(firstFlow);
      await until(() => firstFlow.clientClosed && firstFlow.upstreamClosed, "both sides of the stale watcher cut");
      const oldBrowserClose = await until(
        () => network.closed.find((entry) => entry.requestId === first.requestId),
        "browser observed the stale watcher cleanup cut",
      );
      evidence.silent.oldBrowserCloseAt = oldBrowserClose.at;
      evidence.silent.oldBrowserCloseBeforeCleanup = oldBrowserClose.at < evidence.silent.cleanupStartedAt;
      await ctx.waitWindowLive(WINDOW_ID);
      if (relay.activeWatchers().length !== 1) throw new Error("replacement watcher overlaps another relay subscription after cleanup");
      evidence.recoveredCommand = await oneTerminal("wake68-recovered");
      await delay(500);
      if (network.created.length !== 2 || relay.activeWatchers().length !== 1) {
        throw new Error(`unexpected watcher churn after replacement: ${JSON.stringify({ created: network.created.length, live: relay.activeWatchers().length })}`);
      }
      await ctx.shot("healthy-and-recovered", page);
      return evidence;
    } catch (error) {
      primaryError = error;
      error.smokeDetails = { ...evidence, network, relayWatchers: relay.watcherFlows().map((flow) => ({ id: flow.id, clientClosed: flow.clientClosed, upstreamClosed: flow.upstreamClosed })) };
      throw error;
    } finally {
      const cleanupErrors = [];
      for (const name of terminalNames) {
        try {
          await ctx.exec(ctx.chanBin, ["shell", "terminal", "close", "--tab-name", name], {
            cwd: ctx.workspaceDir,
            env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: WINDOW_ID },
            timeout: 15_000,
          });
        } catch (error) {
          cleanupErrors.push({ name, message: error.message });
        }
      }
      await cdp?.detach().catch(() => {});
      await otherPage?.close().catch(() => {});
      await page.close().catch(() => {});
      await relay.close();
      if (cleanupErrors.length > 0) {
        if (primaryError) primaryError.smokeDetails.cleanupErrors = cleanupErrors;
        else throw new Error(`watcher test terminal cleanup failed: ${JSON.stringify(cleanupErrors)}`);
      }
    }
  },
};
