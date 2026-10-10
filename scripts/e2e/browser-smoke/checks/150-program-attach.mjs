import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { installProgramStatusRecord, withProgramStatusTabs } from "../lib/program-status.mjs";

const CROSS_TAB_MIME = "application/x-chan-tab+json";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitSavedTabs(ctx, page, windowId, names) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const deadline = Date.now() + 20_000;
  let last;
  do {
    last = await page.evaluate(async ({ id, authToken }) => {
      const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
      const response = await fetch(`/api/session?w=${encodeURIComponent(id)}`, { headers });
      const body = response.status === 200 ? await response.json() : null;
      return { status: response.status, layout: JSON.stringify(body?.layout ?? null) };
    }, { id: windowId, authToken: token });
    if (last.status === 200 && names.every((name) => last.layout.includes(name))) return last;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`saved layout lacks ${JSON.stringify(names)} before second-page attach: ${JSON.stringify(last)}`);
}

async function waitCoViewSettled(ctx, tab, sourceGets) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const expected = [tab.subjectRow.session_id, tab.frontRow.session_id].sort();
  const deadline = Date.now() + 20_000;
  let matchingReads = 0;
  let last;
  do {
    last = await tab.page.evaluate(async ({ id, authToken }) => {
      const headers = { "x-smoke-probe": "co-view-settle", ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) };
      const response = await fetch(`/api/session?w=${encodeURIComponent(id)}`, { headers });
      const body = response.status === 200 ? await response.json() : null;
      const terminals = [];
      const visit = (node) => {
        if (!node) return;
        if (node.k === "s") {
          visit(node.a);
          visit(node.b);
        } else if (node.k === "l") {
          for (const entry of [...(node.t ?? []), ...(node.bt ?? [])]) {
            if (entry.k === "t") terminals.push({ name: entry.n, session: entry.tsid });
          }
        }
      };
      visit(body?.layout);
      return {
        status: response.status,
        terminals,
        sourceNames: [...document.querySelectorAll(".tabs .tab .path")].map((node) => node.textContent?.trim()),
      };
    }, { id: tab.windowId, authToken: token });
    const saved = last.terminals.map((entry) => entry.session).sort();
    const sameSessions = last.status === 200 && isDeepStrictEqual(saved, expected);
    const sourceHasBoth = [tab.subject, tab.front].every((name) => last.sourceNames.includes(name));
    matchingReads = sameSessions && sourceHasBoth ? matchingReads + 1 : 0;
    if (sourceGets.length > 0 && matchingReads >= 2) {
      return { ...last, sourceGets: sourceGets.length, expectedSessions: expected };
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`co-view session did not settle before move: sourceGets=${sourceGets.length} expected=${JSON.stringify(expected)} last=${JSON.stringify(last)}`);
}

async function openWindow(ctx, url) {
  const page = await ctx.browser.newPage();
  const sessionGets = [];
  page.on("response", (response) => {
    const requestUrl = new URL(response.url());
    if (requestUrl.pathname.endsWith("/api/session") && response.request().method() === "GET") {
      sessionGets.push({ status: response.status(), window: requestUrl.searchParams.get("w") });
    }
  });
  page.__statusSessionGets = sessionGets;
  await page.evaluateOnNewDocument(installProgramStatusRecord);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 30_000 });
  await ctx.waitWindowLive(url.searchParams.get("w"));
  return page;
}

async function trace(page, subject) {
  return page.evaluate((name) => {
    const value = window.__programStatusTrace;
    value.subject = name;
    value.capture();
    return { mark: value.readMark(), frames: value.frames };
  }, subject);
}

async function waitAttach(page, subject, sessionId, expected) {
  try {
    await page.waitForFunction((name, id, records) => {
      const value = window.__programStatusTrace;
      value.subject = name;
      value.capture();
      const canonical = (value) => JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
          : item);
      return value.frames.some((frame) => frame.type === "session" && frame.id === id &&
        canonical(frame.program_status?.records) === canonical(records));
    }, { timeout: 20_000, polling: 100 }, subject, sessionId, expected);
  } catch (error) {
    const observed = await trace(page, subject);
    throw new Error(`attach session status absent for ${sessionId}; expected=${JSON.stringify(expected)}; frames=${JSON.stringify(observed.frames.filter((frame) => frame.id === sessionId))}; mark=${JSON.stringify(observed.mark)}; sessionGets=${JSON.stringify(page.__statusSessionGets)}`, { cause: error });
  }
  return trace(page, subject);
}

async function dragActive(page) {
  await page.bringToFront();
  return page.evaluate(() => {
    const tab = document.querySelector(".tabs .tab.active");
    if (!tab) throw new Error("no active subject tab for move");
    const store = new Map();
    const transfer = { effectAllowed: "", dropEffect: "move", setData: (type, value) => store.set(type, String(value)), getData: (type) => store.get(type) ?? "", setDragImage: () => {}, get types() { return [...store.keys()]; } };
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    tab.dispatchEvent(event);
    return Object.fromEntries(store);
  });
}

async function drop(page, payload) {
  await page.bringToFront();
  return page.evaluate((entries) => {
    const strip = document.querySelector(".tabs");
    if (!strip) throw new Error("target has no tab strip");
    const store = new Map(Object.entries(entries));
    const transfer = { effectAllowed: "move", dropEffect: "move", setData: (type, value) => store.set(type, String(value)), getData: (type) => store.get(type) ?? "", setDragImage: () => {}, get types() { return [...store.keys()]; } };
    const fire = (type) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      strip.dispatchEvent(event);
      return event;
    };
    fire("dragover");
    return fire("drop").defaultPrevented;
  }, payload);
}

async function finishDrag(page, subject) {
  await page.bringToFront();
  await page.evaluate((name) => {
    const tab = [...document.querySelectorAll(".tabs .tab")].find((node) => node.querySelector(".path")?.textContent?.trim() === name);
    if (!tab) throw new Error("source tab vanished before dragend");
    const event = new Event("dragend", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { dropEffect: "move", types: [], getData: () => "" } });
    tab.dispatchEvent(event);
  }, subject);
}

export default {
  name: "program status: attach, reload, window move and restart",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "150", async (tab) => {
      await tab.sendReport("state=idle:app=deploy");
      await tab.sendReport("state=blocked:id=review:kind=question:title=UmV2aWV3");
      const first = await tab.wait("original-records", (state) =>
        state.row.program_status?.records?.length === 2 &&
        state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
          isDeepStrictEqual(frame.program_status?.records, state.row.program_status.records)));
      const expected = first.row.program_status.records;
      const saved = await waitSavedTabs(ctx, tab.page, tab.windowId, [tab.subject, `Status150${tab.backend}F`]);
      ctx.mark("program150:saved-layout", { status: saved.status, bytes: saved.layout.length });
      const sameUrl = new URL(ctx.serverUrl);
      sameUrl.searchParams.set("w", tab.windowId);
      let second;
      let target;
      try {
        second = await openWindow(ctx, sameUrl);
        const attached = await waitAttach(second, tab.subject, tab.subjectRow.session_id, expected);
        assert.deepEqual(attached.frames.find((frame) => frame.type === "session" && frame.id === tab.subjectRow.session_id).program_status.records, expected);
        await ctx.shot(`${tab.backend}-second-page`, second);
        await second.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        const reloaded = await waitAttach(second, tab.subject, tab.subjectRow.session_id, expected);
        assert.ok(reloaded.mark, "same session is visible after page reload");
        await ctx.shot(`${tab.backend}-reloaded`, second);

        // Make the co-viewer save a changed layout, then wait for the source's
        // sync read and for the saved terminal sessions to match its live tabs.
        const sourceGets = [];
        const onSourceResponse = (response) => {
          const url = new URL(response.url());
          if (response.request().method() === "GET" && url.pathname === "/api/session" &&
              url.searchParams.get("w") === tab.windowId && response.status() === 200 &&
              response.request().headers()["x-smoke-probe"] !== "co-view-settle") {
            sourceGets.push(Date.now());
          }
        };
        tab.page.on("response", onSourceResponse);
        try {
          const coViewSelection = await second.evaluate((names) => {
            const tabs = [...document.querySelectorAll(".tabs .tab")];
            const next = tabs.find((node) => names.includes(node.querySelector(".path")?.textContent?.trim()) &&
              node.getAttribute("aria-selected") !== "true");
            if (!next) throw new Error("co-viewer has no inactive terminal tab to select");
            const name = next.querySelector(".path")?.textContent?.trim();
            next.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
            return name;
          }, [tab.subject, tab.front]);
          await second.waitForFunction((name) => [...document.querySelectorAll(".tabs .tab")].some((node) =>
            node.querySelector(".path")?.textContent?.trim() === name &&
            node.getAttribute("aria-selected") === "true"), { timeout: 10_000 }, coViewSelection);
          await second.close();
          second = null;
          const settled = await waitCoViewSettled(ctx, tab, sourceGets);
          ctx.mark("program150:co-view-settled", { backend: tab.backend, coViewSelection, ...settled });
        } finally {
          tab.page.off("response", onSourceResponse);
        }

        const movedUrl = new URL(ctx.serverUrl);
        movedUrl.searchParams.set("w", `status150-${tab.backend}`);
        ctx.mark("program150:open-move-target", { backend: tab.backend });
        target = await openWindow(ctx, movedUrl);
        await tab.page.bringToFront();
        ctx.mark("program150:focus-subject-for-move", { backend: tab.backend });
        await tab.focusSubject();
        ctx.mark("program150:drag-subject", { backend: tab.backend });
        const payload = await dragActive(tab.page);
        assert.ok(payload[CROSS_TAB_MIME], "real dragstart offered a cross-window tab payload");
        const moved = JSON.parse(payload[CROSS_TAB_MIME]);
        assert.equal(moved.kind, "terminal");
        ctx.mark("program150:drop-subject", { backend: tab.backend });
        assert.equal(await drop(target, payload), true, "target accepted the real tab payload");
        await finishDrag(tab.page, tab.subject);
        const newAttach = await waitAttach(target, tab.subject, tab.subjectRow.session_id, expected);
        assert.ok(newAttach.mark, "moved tab is visible after its attach");
        await ctx.shot(`${tab.backend}-moved`, target);

        await tab.cs(["restart", "--tab-name", tab.subject]);
        await target.waitForFunction((id) => window.__programStatusTrace.frames.some((frame) => frame.type === "session" && frame.id === id && frame.program_status?.records?.length === 0), { timeout: 20_000, polling: 100 }, tab.subjectRow.session_id);
        const rows = Object.values(JSON.parse((await tab.cs(["list", "--json"])).stdout).groups ?? {}).flat();
        const row = rows.find((entry) => entry.session_id === tab.subjectRow.session_id);
        assert.deepEqual(row?.program_status?.records, [], "restart starts an empty record set");
        await ctx.shot(`${tab.backend}-restarted`, target);
      } finally {
        if (second && !second.isClosed()) await second.close();
        if (target && !target.isClosed()) await target.close();
      }
    });
  },
};
