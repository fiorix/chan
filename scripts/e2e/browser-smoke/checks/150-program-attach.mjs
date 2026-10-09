import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { installProgramStatusRecord, withProgramStatusTabs } from "../lib/program-status.mjs";

const CROSS_TAB_MIME = "application/x-chan-tab+json";

async function openWindow(ctx, url) {
  const page = await ctx.browser.newPage();
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
      const sameUrl = new URL(await tab.page.url());
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
        await second.close();
        second = null;

        const movedUrl = new URL(ctx.serverUrl);
        movedUrl.searchParams.set("w", `status150-${tab.backend}`);
        target = await openWindow(ctx, movedUrl);
        await tab.focusSubject();
        const payload = await dragActive(tab.page);
        assert.ok(payload[CROSS_TAB_MIME], "real dragstart offered a cross-window tab payload");
        const moved = JSON.parse(payload[CROSS_TAB_MIME]);
        assert.equal(moved.kind, "terminal");
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
