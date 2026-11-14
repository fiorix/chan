// A centred, capped board can move without resizing. Read scene coordinates
// independently of Excalidraw's cached origin after the surrounding UI moves.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFile } from "../lib/files.mjs";
import { dispatchCommand, selectLauncherCommand } from "../lib/pane-strip.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (page) => page.evaluate(() => window.__diagramPosition.read());
const near = (actual, expected, label) => {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 2,
    `${label}: expected ${expected}, got ${actual}`);
};

// This reads the instance behind the public API; it never refreshes, updates
// the scene or changes geometry. Identity detects an accidental remount.
function installReading() {
  const instances = new WeakMap();
  let nextId = 0;
  const events = [];
  function board() {
    const hosts = [...document.querySelectorAll(".excalidraw-host")]
      .filter((node) => node.getBoundingClientRect().width > 0);
    if (hosts.length !== 1) throw new Error(`expected one board, found ${hosts.length}`);
    const host = hosts[0];
    const container = host.querySelector(".excalidraw");
    const key = container && Object.keys(container).find((name) => name.startsWith("__reactFiber$"));
    for (let fiber = key && container[key]; fiber; fiber = fiber.return) {
      const app = fiber.stateNode;
      if (typeof app?.getSceneElements !== "function" || !Number.isFinite(app.state?.offsetLeft)) continue;
      if (app.excalidrawContainerRef?.current !== container) throw new Error("instance/container mismatch");
      if (!instances.has(app)) instances.set(app, ++nextId);
      return { host, container, app };
    }
    throw new Error("Excalidraw instance unavailable");
  }
  function read() {
    const { host, container, app } = board();
    const rect = container.getBoundingClientRect();
    const s = app.state;
    return {
      instance: instances.get(app),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      cap: getComputedStyle(host).getPropertyValue("--chan-page-max-width"),
      offset: { left: s.offsetLeft, top: s.offsetTop },
      view: { zoom: s.zoom.value, scrollX: s.scrollX, scrollY: s.scrollY,
        selected: s.selectedElementIds, groups: s.selectedGroupIds },
      grid: s.gridModeEnabled, tool: s.activeTool.type,
      elements: app.getSceneElements(),
      files: app.files,
      processedPointer: app.lastPointerMoveCoords ? {
        x: (app.lastPointerMoveCoords.x + s.scrollX) * s.zoom.value + s.offsetLeft,
        y: (app.lastPointerMoveCoords.y + s.scrollY) * s.zoom.value + s.offsetTop,
      } : null,
      details: Boolean(host.closest(".pane")?.querySelector('aside[aria-label="Details"]')),
      viewport: { width: innerWidth, height: innerHeight },
    };
  }
  for (const type of ["pointerdown", "pointerup", "pointermove"]) {
    window.addEventListener(type, (event) => {
      if (!event.target?.matches?.(".excalidraw canvas")) return;
      events.push({ type, trusted: event.isTrusted, x: event.clientX, y: event.clientY });
      if (events.length > 100) events.shift();
    }, true);
  }
  window.__diagramPosition = { read, events };
}

async function settled(page) {
  const deadline = Date.now() + 15_000;
  let previous;
  let since = Date.now();
  while (Date.now() < deadline) {
    const state = await read(page);
    const key = JSON.stringify([state.instance, state.rect, state.offset]);
    if (key !== previous) { previous = key; since = Date.now(); }
    if (Date.now() - since >= 700) return state;
    await sleep(50);
  }
  throw new Error("diagram geometry did not settle");
}

async function config(page, ratio) {
  return page.evaluate(async (ratio) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.content ?? "";
    const token = sessionStorage.getItem("chan.token") ?? new URL(location.href).searchParams.get("t");
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const current = await fetch(`${prefix}/api/config`, { headers });
    if (!current.ok) throw new Error(`config read: ${current.status}`);
    const value = await current.json();
    if (ratio !== undefined) {
      const saved = await fetch(`${prefix}/api/config`, { method: "PATCH", headers,
        body: JSON.stringify({ expected_revision: value.revision, preferences: { page_width_ratio: ratio } }) });
      if (!saved.ok) throw new Error(`config restore: ${saved.status}`);
    }
    return value.preferences.page_width_ratio ?? 0.8;
  }, ratio);
}

async function capPage(page) {
  await dispatchCommand(page, "app.settings.open");
  await page.waitForSelector('[aria-label="Settings sections"]', { visible: true });
  const section = await page.evaluateHandle(() => [...document.querySelectorAll('[aria-label="Settings sections"] button')]
    .find((button) => button.textContent.trim() === "Editor"));
  assert.ok(section.asElement(), "Settings has no Editor section");
  await section.asElement().click();
  await section.dispose();
  const selector = 'input[aria-label="Editor page width percent"]';
  await page.waitForSelector(selector, { visible: true });
  await page.focus(selector);
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  assert.equal(await page.$eval(selector, (input) => Number(input.value)), 50);
  const deadline = Date.now() + 10_000;
  while (await config(page) !== 0.5) {
    if (Date.now() >= deadline) throw new Error("50% page width did not persist");
    await sleep(100);
  }
  await page.click(".settings button.close");
  await page.waitForSelector('[aria-label="Settings sections"]', { hidden: true });
}

async function draw(ctx, page, label) {
  await page.click('.excalidraw [data-testid="toolbar-rectangle"]');
  await page.waitForFunction(() => window.__diagramPosition.read().tool === "rectangle", { polling: 50 });
  const before = await read(page);
  assert.equal(before.grid, false, "grid snapping would change the requested geometry");
  const { left, top, width, height } = before.rect;
  const start = { x: Math.round(left + width * 0.6), y: Math.round(top + height * 0.55) };
  const end = { x: start.x + 90, y: start.y + 60 };
  assert.ok(await page.evaluate(({ start, end }) => [start, end].every(({ x, y }) =>
    document.elementFromPoint(x, y)?.matches(".excalidraw canvas")), { start, end }), "draw segment is obstructed");
  await page.evaluate(() => { window.__diagramPosition.events.length = 0; });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const ids = before.elements.map((element) => element.id);
  try {
    for (let step = 1; step <= 10; step++) {
      const target = { x: start.x + 9 * step, y: start.y + 6 * step };
      const deadline = Date.now() + 10_000;
      // The throttled handler need not process its last event. Resend until
      // it does; its own cached origin is used only to identify that event.
      while (true) {
        await page.mouse.move(target.x, target.y);
        await sleep(50);
        const processed = (await read(page)).processedPointer;
        if (processed && Math.hypot(processed.x - target.x, processed.y - target.y) <= 1) break;
        if (Date.now() >= deadline) throw new Error(`rectangle move ${step} was not processed`);
      }
    }
    // Wait on the rendered element, not an incidental pointer-move field.
    await page.waitForFunction(({ ids, zoom }) => {
      const fresh = window.__diagramPosition.read().elements.filter((element) => !ids.includes(element.id));
      return fresh.length === 1 && Math.abs(fresh[0].width * zoom - 90) <= 2 && Math.abs(fresh[0].height * zoom - 60) <= 2;
    }, { timeout: 15_000, polling: 50 }, { ids, zoom: before.view.zoom });
  } finally { await page.mouse.up(); }
  const after = await settled(page);
  const events = await page.evaluate(() => window.__diagramPosition.events);
  const down = events.find((event) => event.type === "pointerdown");
  const up = events.findLast((event) => event.type === "pointerup");
  assert.ok(down?.trusted && up?.trusted, "trusted canvas drag was not observed");
  for (const [actual, wanted] of [[down, start], [up, end]]) {
    near(actual.x, wanted.x, "pointer x"); near(actual.y, wanted.y, "pointer y");
  }
  assert.equal(after.instance, before.instance, "diagram remounted during drawing");
  const created = after.elements.filter((element) => !ids.includes(element.id));
  assert.equal(created.length, 1, "drag must create exactly one element");
  assert.equal(created[0].type, "rectangle");
  const { zoom, scrollX, scrollY } = before.view;
  const expected = { x: (start.x - left) / zoom - scrollX, y: (start.y - top) / zoom - scrollY,
    width: 90 / zoom, height: 60 / zoom };
  const error = Object.fromEntries(Object.keys(expected).map((key) => [key, (created[0][key] - expected[key]) * zoom]));
  const result = { before, after, start, end, expected, created: created[0], error, events,
    screenshot: await ctx.shot(label, page) };
  return result;
}

function assertDraw(result, label) {
  for (const [key, value] of Object.entries(result.error)) near(value, 0, `${label} ${key} screen error`);
}

async function authority(page, file) {
  return page.evaluate(async (file) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.content ?? "";
    const token = sessionStorage.getItem("chan.token") ?? new URL(location.href).searchParams.get("t");
    const response = await fetch(`${prefix}/api/fs/${encodeURIComponent(file)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`scene read: ${response.status}`);
    const { content, mtime_ns } = await response.json();
    return { content, mtime_ns };
  }, file);
}

export default {
  name: "diagram-position",
  async run(ctx) {
    const { page } = ctx;
    const file = `diagram-position-${Date.now()}.excalidraw`;
    const path = join(ctx.workspaceDir, file);
    copyFileSync(join(ctx.repoRoot, "scripts/e2e/browser-smoke/seed/board.excalidraw"), path);
    const report = { file, writes: { pushes: 0, puts: 0 }, passed: false };
    const cursors = [];
    const originalRatio = await config(page);
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    const sockets = new Set();
    cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
      if (new URL(url).pathname.endsWith("/api/scene/ws")) sockets.add(requestId);
    });
    cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
      if (!sockets.has(requestId)) return;
      try {
        const frame = JSON.parse(response.payloadData);
        if (frame.type === "push") report.writes.pushes++;
        if (frame.type === "cursor") cursors.push(frame);
      } catch { /* Non-JSON frame. */ }
    });
    const request = (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname.endsWith(`/api/fs/${file}`)) report.writes.puts++;
    };
    page.on("request", request);
    try {
      await page.bringToFront();
      await page.setViewport({ width: 1600, height: 1000 });
      // The runner supplies a fresh context; the explicit empty layout also
      // excludes default layouts inherited from the shared server's config.
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", `diagram-position-${Date.now()}`);
      url.hash = "s=" + encodeURIComponent(JSON.stringify({ k: "l", f: 1, t: [] }));
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      assert.equal(await page.$$eval(".pane", (panes) => panes.length), 1, "layout did not start with one pane");
      await capPage(page);
      await openFile(page, file);
      await page.waitForSelector(".excalidraw-host canvas", { visible: true, timeout: 60_000 });
      await page.evaluate(installReading);
      assert.equal((await settled(page)).details, true, "fresh diagram must start with Details open");
      report.control = await draw(ctx, page, "diagram-position-control");
      assertDraw(report.control, "control");
      // Non-default view and a selected shape expose a refresh that resets them.
      await page.click(".excalidraw .zoom-in-button");
      report.beforePan = await settled(page);
      await page.mouse.move(report.control.end.x, report.control.end.y);
      await page.mouse.wheel({ deltaX: 24, deltaY: 36 });
      await page.waitForFunction((before) => {
        const { scrollX, scrollY } = window.__diagramPosition.read().view;
        return Math.abs(scrollX - before.scrollX) > 1 && Math.abs(scrollY - before.scrollY) > 1;
      }, { timeout: 10_000, polling: 50 }, report.beforePan.view);
      report.before = await settled(page);
      assert.notEqual(report.before.view.zoom, 1, "zoom setup did not apply");
      assert.ok(Object.values(report.before.view.selected).some(Boolean), "control shape is not selected");
      const deadline = Date.now() + 15_000;
      while (true) {
        const value = await authority(page, file);
        if (JSON.parse(value.content).elements.some((element) => element.id === report.control.created.id) &&
            JSON.parse(readFileSync(path, "utf8")).elements.some((element) => element.id === report.control.created.id)) break;
        if (Date.now() >= deadline) throw new Error("control drawing did not reach the authority and disk");
        await sleep(100);
      }
      await sleep(1200);
      const saved = { authority: await authority(page, file), disk: readFileSync(path, "utf8"),
        mtime: statSync(path, { bigint: true }).mtimeNs.toString(), writes: { ...report.writes } };
      report.savedBeforeLayout = saved;
      assert.ok(saved.writes.pushes > 0, "scene traffic recorder saw no control push");
      await selectLauncherCommand(page, "Details");
      const row = '[role="dialog"][aria-label="Command launcher"] [role="option"][aria-selected="true"]';
      assert.equal(await page.$eval(`${row} .deck-result-value`, (node) => node.textContent.trim()), "on");
      await page.click(row);
      await page.waitForFunction((selector) => document.querySelector(selector)?.textContent.trim() === "off",
        { timeout: 10_000, polling: 50 }, `${row} .deck-result-value`);
      await page.click('button[aria-label="Hide command launcher"]');
      await page.waitForSelector('[role="dialog"][aria-label="Command launcher"]', { hidden: true });
      report.after = await settled(page);
      assert.equal(report.after.details, false, "Details did not close");
      assert.equal(report.after.instance, report.before.instance, "layout remounted the board");
      assert.deepEqual(report.after.viewport, report.before.viewport, "layout resized the viewport");
      assert.ok(Math.abs(report.after.rect.left - report.before.rect.left) > 20, "layout did not move the board");
      assert.equal(report.after.rect.width, report.before.rect.width, "board resized; its own observer could mask the defect");
      assert.equal(report.after.rect.height, report.before.rect.height, "board height changed");
      assert.deepEqual(report.after.view, report.before.view, "layout changed zoom, scroll or selection");
      assert.deepEqual(report.after.elements, report.before.elements, "layout changed scene elements");
      assert.deepEqual(report.after.files, report.before.files, "layout changed scene files");
      await sleep(1200);
      report.savedAfterLayout = { authority: await authority(page, file), disk: readFileSync(path, "utf8"),
        mtime: statSync(path, { bigint: true }).mtimeNs.toString(), writes: { ...report.writes } };
      assert.deepEqual(report.savedAfterLayout, saved, "layout dirtied or saved the diagram");
      report.afterDraw = await draw(ctx, page, "diagram-position-after-details");
      assertDraw(report.afterDraw, "after Details close");
      const shape = report.afterDraw.created;
      await page.keyboard.press("Escape");
      const current = await settled(page);
      assert.ok(!Object.values(current.view.selected).some(Boolean), "Escape did not clear selection before click");
      const point = { x: current.rect.left + (shape.x + shape.width / 2 + current.view.scrollX) * current.view.zoom,
        y: current.rect.top + (shape.y + current.view.scrollY) * current.view.zoom };
      cursors.length = 0;
      await page.mouse.move(point.x, point.y);
      const hoverDeadline = Date.now() + 10_000;
      while (cursors.length === 0) {
        if (Date.now() >= hoverDeadline) throw new Error("hover emitted no scene cursor frame");
        await sleep(50);
      }
      report.hover = { point, cursor: cursors.at(-1), events: await page.evaluate(() => window.__diagramPosition.events.slice(-1)) };
      assert.equal(report.hover.events[0]?.trusted, true, "hover was not trusted");
      near((report.hover.cursor.x - shape.x - shape.width / 2) * current.view.zoom, 0, "hover x");
      near((report.hover.cursor.y - shape.y) * current.view.zoom, 0, "hover y");
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction((id) => window.__diagramPosition.read().view.selected[id] === true,
        { polling: 50, timeout: 10_000 }, shape.id);
      report.click = await read(page);
      report.passed = true;
      return report;
    } catch (error) {
      report.error = error.stack ?? String(error);
      report.failureScreenshot = await ctx.shot("diagram-position-failure", page).catch(() => null);
      throw error;
    } finally {
      writeFileSync(join(ctx.outDir, "diagram-position.json"), JSON.stringify(report, null, 2) + "\n");
      page.off("request", request);
      await cdp.detach();
      await config(page, originalRatio);
    }
  },
};
