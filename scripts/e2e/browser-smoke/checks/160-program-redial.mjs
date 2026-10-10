import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { installProgramStatusRecord, withProgramStatusTabs } from "../lib/program-status.mjs";
import { startTerminalCutProxy } from "../lib/terminal-cut-proxy.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitSavedTabs(ctx, page, windowId, names) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const deadline = Date.now() + 20_000;
  do {
    const saved = await page.evaluate(async ({ id, authToken }) => {
      const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
      const response = await fetch(`/api/session?w=${encodeURIComponent(id)}`, { headers });
      return response.status === 200 ? JSON.stringify((await response.json()).layout ?? null) : "";
    }, { id: windowId, authToken: token });
    if (names.every((name) => saved.includes(name))) return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`saved layout does not contain ${names.join(", ")}`);
}

export default {
  name: "program status: held terminal redial attaches the current records",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "160", async (tab) => {
      await tab.sendReport("state=blocked:id=phase:kind=question");
      const initial = await tab.wait("before-cut", (state) =>
        state.mark?.attention === "question" && state.row.program_status?.records?.some((record) =>
          record.id === "phase" && record.state === "blocked"));
      await waitSavedTabs(ctx, tab.page, tab.windowId, [tab.subject, `Status160${tab.backend}F`]);
      const proxy = await startTerminalCutProxy({
        targetUrl: `${new URL(ctx.serverUrl).origin}/`,
        path: "/api/terminal/ws",
        session: tab.subjectRow.session_id,
        deadlineMs: 30_000,
      });
      let second;
      try {
        proxy.arm({ boundary: "after-session" });
        proxy.holdRedial();
        second = await ctx.browser.newPage();
        await second.evaluateOnNewDocument((origin) => {
          const nativeSocket = window.WebSocket;
          window.WebSocket = new Proxy(nativeSocket, {
            construct(target, args) {
              const url = new URL(args[0], location.href);
              if (url.pathname === "/api/terminal/ws") {
                const relay = new URL(origin);
                url.protocol = "ws:";
                url.host = relay.host;
                return Reflect.construct(target, [url.href, ...args.slice(1)]);
              }
              return Reflect.construct(target, args);
            },
          });
        }, proxy.url);
        await second.evaluateOnNewDocument(installProgramStatusRecord);
        const url = new URL(ctx.serverUrl);
        url.searchParams.set("w", tab.windowId);
        await second.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await second.waitForSelector(".pane", { timeout: 30_000 });
        await second.waitForFunction((name) => [...document.querySelectorAll('div[role="tab"]')].some(
          (node) => node.querySelector(".path")?.textContent?.trim() === name),
        { timeout: 20_000, polling: 100 }, `Status160${tab.backend}F`);
        await second.evaluate((name) => [...document.querySelectorAll('div[role="tab"]')].find(
          (node) => node.querySelector(".path")?.textContent?.trim() === name)?.click(), `Status160${tab.backend}F`);
        const forwarded = await proxy.waitForRecord((record) => record.event === "frame" && record.connection === 1 &&
          record.direction === "forwarded" && record.type === "session");
        await second.waitForFunction((name, id, revision) => {
          const trace = window.__programStatusTrace;
          trace.subject = name;
          return trace.readMark()?.attention === "question" && trace.readMark()?.active === false && trace.frames.some((frame) =>
            frame.type === "session" && frame.id === id && frame.program_status?.revision === revision);
        }, { timeout: 20_000, polling: 100 }, tab.subject, tab.subjectRow.session_id, initial.row.program_status.revision);
        proxy.acknowledge({ connection: 1, frame: forwarded.frame, drained: true });
        const cut = await proxy.waitForCut();
        assert.deepEqual(cut.disconnect, { client: "closed", upstream: "closed" }, "the first subject socket is cut and acknowledged");
        await proxy.waitForHeldRedial();
        assert.equal(proxy.records.filter((record) => record.event === "connection").length, 1, "held redial has not connected upstream");
        assert.equal(proxy.records.filter((record) => record.event === "redial-held").length, 1, "the redial is held before the server sees it");

        await tab.sendReport("state=working:id=phase");
        const changed = await tab.wait("server-changed-while-held", (state) =>
          state.row.program_status?.revision > initial.row.program_status.revision &&
          state.row.program_status.records.some((record) => record.id === "phase" && record.state === "working"));
        const expected = changed.row.program_status;
        proxy.releaseRedial();
        const fresh = await proxy.waitForRecord((record) => record.event === "frame" && record.connection === 2 &&
          record.direction === "forwarded" && record.type === "session");
        const frame = JSON.parse(Buffer.from(fresh.bytes, "base64").toString());
        assert.ok(isDeepStrictEqual(frame.program_status, expected), "the redial's session frame carries the server's current record set");
        try {
          await second.waitForFunction((name, id, revision) => {
            const trace = window.__programStatusTrace;
            trace.subject = name;
            const mark = trace.readMark();
            return mark?.active === false && mark.activity === "spinner" &&
              trace.frames.some((frame) => frame.type === "session" && frame.id === id &&
                frame.program_status?.revision === revision &&
                frame.program_status.records.some((record) => record.id === "phase" && record.state === "working"));
          }, { timeout: 20_000, polling: 100 }, tab.subject, tab.subjectRow.session_id, expected.revision);
        } catch (error) {
          const observed = await second.evaluate((name) => {
            const trace = window.__programStatusTrace;
            trace.subject = name;
            return { mark: trace.readMark(), frames: trace.frames.filter((frame) => frame.type === "session"), tabs: [...document.querySelectorAll('div[role="tab"]')].map((node) => ({ name: node.querySelector(".path")?.textContent?.trim(), selected: node.getAttribute("aria-selected") })) };
          }, tab.subject);
          throw new Error(`${tab.backend} redial frame did not reach the background tab: ${JSON.stringify(observed)}`, { cause: error });
        }
        assert.equal(proxy.records.filter((record) => record.event === "redial-released").length, 1);
        await ctx.shot(`${tab.backend}-redial-current-status`, second);
      } finally {
        if (second && !second.isClosed()) await second.close();
        await proxy.close();
      }
    });
  },
};
