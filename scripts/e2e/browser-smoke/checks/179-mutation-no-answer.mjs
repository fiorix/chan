// A mutation the server stores and announces, with no answer within the
// page's ten-second deadline, is reported as possibly made and never as a
// failure, and the Drafts group shows the stored draft once. The page's origin
// is a relay that can hold what the server sends (`lib/hold-proxy.mjs`).
//
// The frame after the report: everything the server sends is held from just
// before New draft. The page's report comes at its deadline, the server has
// stored the draft meanwhile, and the hold ends within fifteen seconds of its
// start with the page visible, well inside the event socket's read deadline.
// The draft's `created` frame then reaches the page on the event socket it had
// before the hold, no socket is opened across it, and the group lists the
// draft once with no tab opened for it.
//
// The frame before the report: only HTTP is held and the event socket flows,
// so the `created` frame reaches the page before its deadline; the report at
// the deadline still does not say the mutation failed. HTTP is let go right
// after the report, and the group lists the draft once; a drafts listing that
// failed in between, which a refresh behind the held HTTP can, is recorded.

import { groupNames, listDrafts, showFileTree, waitFor } from "../lib/drafts.mjs";
import { startHoldProxy } from "../lib/hold-proxy.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const REPORT = "New draft may have completed: no answer within 10 s";
const HOLD_LIMIT_MS = 15_000;

function isEventSocket(path) {
  return path === "/ws" || (path.endsWith("/ws") && !path.includes("/api/"));
}

/// A window on the relay's origin, with the page's WebSockets and their
/// received frames recorded from CDP as they arrive.
async function openWindow(ctx, proxy, windowId, record) {
  const page = await ctx.browser.newPage();
  const cdp = await page.createCDPSession();
  const seen = { sockets: [], frames: [], failed: [] };
  cdp.on("Network.webSocketCreated", (event) => {
    seen.sockets.push({ id: event.requestId, path: new URL(event.url).pathname, at: Date.now() });
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
    const socket = seen.sockets.find((s) => s.id === event.requestId);
    if (socket) socket.open = event.response.status;
  });
  cdp.on("Network.webSocketFrameReceived", (event) => {
    seen.frames.push({ id: event.requestId, at: Date.now(), payload: event.response.payloadData });
  });
  await cdp.send("Network.enable");
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    seen.failed.push({
      method: request.method(),
      path: url.pathname,
      error: request.failure()?.errorText ?? "unknown",
      at: Date.now(),
    });
  });
  const url = new URL(ctx.serverUrl);
  url.port = String(proxy.port);
  url.searchParams.set("w", windowId);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 60_000 });
  // The file tree is open before anything is held, so its Drafts group is on
  // the page when the stored draft is listed.
  await showFileTree(page);
  const socket = await waitFor("the event socket open", 30_000, () =>
    seen.sockets.find((s) => isEventSocket(s.path) && s.open === 101),
  );
  record.eventSocket = { path: socket.path };
  return { page, seen, socket };
}

function statusText(page) {
  return page.evaluate(() => document.querySelector(".status-msg")?.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

/// The page's New draft line, whichever it says.
function newDraftLine(page, timeoutMs) {
  return waitFor("the New draft line", timeoutMs, async () => {
    const text = await statusText(page);
    return text.startsWith("New draft ") ? text : null;
  });
}

async function newDraft(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.draft.new" } }));
  });
}

/// The server's draft that `before` did not list, read from the server.
function storedDraft(ctx, before, timeoutMs) {
  return waitFor("the draft stored on the server", timeoutMs, async () =>
    (await listDrafts(ctx)).drafts.find((d) => !before.has(d.primary.draft_id)),
  );
}

function createdFrames(seen, socketId, draftId) {
  return seen.frames.filter((frame) => {
    if (frame.id !== socketId) return false;
    try {
      const parsed = JSON.parse(frame.payload);
      return parsed.type === "draft" && parsed.event === "created" && parsed.source?.draft_id === draftId;
    } catch {
      return false;
    }
  });
}

async function listsOnce(page, name, label) {
  await waitFor(label, 20_000, async () => (await groupNames(page)).filter((n) => n === name).length === 1);
  const names = await groupNames(page);
  if (names.filter((n) => n === name).length !== 1) {
    throw new Error(`${label}: the Drafts group lists ${JSON.stringify(names)}`);
  }
}

async function tabTitles(page) {
  return page.evaluate(() => [...document.querySelectorAll(".tabs .tab")].map((t) => t.getAttribute("title")));
}

async function knownDrafts(ctx) {
  return new Set((await listDrafts(ctx)).drafts.map((d) => d.primary.draft_id));
}

export default {
  name: "mutation-no-answer",
  async run(ctx) {
    const target = new URL(ctx.serverUrl);
    const proxy = await startHoldProxy({ targetPort: Number(target.port) });
    const record = { frameAfterReport: {}, frameBeforeReport: {} };
    const pages = [];
    try {
      // The frame after the report.
      {
        const arm = record.frameAfterReport;
        const { page, seen, socket } = await openWindow(ctx, proxy, "smoke-mtout-1", arm);
        pages.push(page);
        const before = await knownDrafts(ctx);
        const socketsBefore = seen.sockets.length;
        const heldAt = Date.now();
        proxy.hold("http");
        proxy.hold("socket");
        await newDraft(page);
        const line = await newDraftLine(page, 14_000);
        const reportAt = Date.now();
        arm.line = line;
        arm.reportAfterMs = reportAt - heldAt;
        if (line !== REPORT) throw new Error(`with everything held, the page says "${line}"`);
        const stored = await storedDraft(ctx, before, HOLD_LIMIT_MS - (Date.now() - heldAt) - 1_000);
        arm.draft = { name: stored.name, path: stored.primary.path };
        const visibility = await page.evaluate(() => document.visibilityState);
        arm.queuedAtRelease = { http: proxy.queued("http"), socket: proxy.queued("socket") };
        proxy.release("socket");
        proxy.release("http");
        const releasedAt = Date.now();
        arm.heldMs = releasedAt - heldAt;
        if (arm.heldMs > HOLD_LIMIT_MS) throw new Error(`the hold lasted ${arm.heldMs} ms`);
        if (visibility !== "visible") throw new Error(`the page was ${visibility} at the release`);

        await waitFor("the created frame on the event socket", 15_000, () =>
          createdFrames(seen, socket.id, stored.primary.draft_id).length > 0,
        );
        const [frame] = createdFrames(seen, socket.id, stored.primary.draft_id);
        arm.frameAfterReportMs = frame.at - reportAt;
        if (frame.at < releasedAt) throw new Error("the created frame reached the page while it was held");
        await listsOnce(page, stored.name, "the stored draft in the Drafts group");
        const opened = seen.sockets.slice(socketsBefore).map((s) => s.path);
        arm.socketsOpenedAcross = opened;
        if (opened.length > 0) throw new Error(`the page opened sockets across the hold: ${opened.join(", ")}`);
        const titles = await tabTitles(page);
        if (titles.includes(`Drafts/${stored.primary.path}`)) throw new Error("the late frame opened a tab for the draft");
        arm.failedRequests = seen.failed.filter((f) => f.at >= heldAt).map(({ method, path, error }) => ({ method, path, error }));
        await ctx.shot("frame-after-report", page);
        await page.close();
        pages.pop();
      }

      // The frame before the report.
      {
        const arm = record.frameBeforeReport;
        const { page, seen, socket } = await openWindow(ctx, proxy, "smoke-mtout-2", arm);
        pages.push(page);
        const before = await knownDrafts(ctx);
        const heldAt = Date.now();
        proxy.hold("http");
        await newDraft(page);
        const stored = await storedDraft(ctx, before, 8_000);
        arm.draft = { name: stored.name, path: stored.primary.path };
        await waitFor("the created frame before the deadline", 9_000, () =>
          createdFrames(seen, socket.id, stored.primary.draft_id).length > 0,
        );
        const [frame] = createdFrames(seen, socket.id, stored.primary.draft_id);
        const line = await newDraftLine(page, 14_000);
        const reportAt = Date.now();
        proxy.release("http");
        arm.line = line;
        arm.frameBeforeReportMs = reportAt - frame.at;
        arm.heldMs = Date.now() - heldAt;
        if (frame.at >= reportAt) throw new Error("the created frame did not reach the page before the report");
        if (line !== REPORT) throw new Error(`with HTTP held, the page says "${line}"`);
        await listsOnce(page, stored.name, "the stored draft in the Drafts group after the release");
        arm.draftListingsFailed = seen.failed
          .filter((f) => f.at >= heldAt && f.path.endsWith("/api/drafts"))
          .map(({ method, path, error }) => ({ method, path, error }));
        await ctx.shot("frame-before-report", page);
      }
      record.connections = proxy.connections().length;
      return record;
    } catch (error) {
      error.smokeDetails = JSON.parse(maskTokens(JSON.stringify(record)));
      for (const page of pages) {
        if (!page.isClosed()) {
          error.smokeDetails.status = await statusText(page).catch(() => null);
          await ctx.shot("failure", page).catch(() => {});
        }
      }
      throw error;
    } finally {
      for (const page of pages) if (!page.isClosed()) await page.close().catch(() => {});
      await proxy.close().catch(() => {});
    }
  },
};
