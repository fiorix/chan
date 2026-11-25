import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mask, poll } from "../lib/launcher-devserver.mjs";
import { readPaneStripPreference, windowSessions, writePaneStripPreference } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TAB = ".tabs .tab-row > .tab";
const CONFIRM = '[role="dialog"][aria-labelledby="confirm-title"]';

function requireProduct(value, message) {
  if (!value) throw new Error(`PRODUCT_TAB_ACTION: ${message}`);
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`instrument: ${label} exceeded ${ms}ms`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

// Observe native delivery and real session/exit frames, without changing the
// application's state. Synthetic activation below is a separate control.
function installProbe() {
  const probe = window.__tab266 = { events: [], frames: [], focusEvents: [], focusEventsDropped: 0 };
  const identify = (node) => {
    if (!(node instanceof Element)) return null;
    const terminal = node.closest("[data-terminal-tab-id]");
    // Ghostty focuses its host while retaining a hidden textarea inside it.
    const input = terminal?.querySelector(".terminal-host[tabindex]") ?? terminal?.querySelector(".terminal-host textarea");
    return { tag: node.tagName, id: node.id, class: node.getAttribute("class"), role: node.getAttribute("role"),
      tabLabel: node.closest(".tabs .tab")?.querySelector(".path")?.textContent.trim() ?? null,
      terminalTabId: terminal?.getAttribute("data-terminal-tab-id") ?? null,
      paneId: node.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null, terminalInput: node === input };
  };
  probe.activeIdentity = () => identify(document.activeElement);
  for (const type of ["focusin", "focusout", "mousedown", "mouseup", "contextmenu", "dragstart", "dragend", "drop"]) {
    document.addEventListener(type, (event) => {
      if (probe.focusEvents.length >= 512) { probe.focusEventsDropped += 1; return; }
      const reading = { type, at: performance.now(), trusted: event.isTrusted, button: event.button,
        target: identify(event.target), relatedTarget: identify(event.relatedTarget), active: probe.activeIdentity() };
      probe.focusEvents.push(reading);
      setTimeout(() => {
        reading.afterTurnAt = performance.now();
        reading.activeAfterTurn = probe.activeIdentity();
        reading.defaultPrevented = event.defaultPrevented;
      }, 0);
    }, { capture: true, passive: true });
  }
  for (const type of ["mousedown", "mouseup", "click", "keydown", "contextmenu", "dragstart", "dragover", "dragend", "drop"]) {
    document.addEventListener(type, (event) => {
      const outer = event.target?.closest?.(".tabs .tab");
      if (!event.target?.closest?.(".tabs")) return;
      const reading = { type, trusted: event.isTrusted, key: event.key, shiftKey: event.shiftKey, button: event.button,
        label: outer?.querySelector(".path")?.textContent.trim(), target: event.target.className, targetIsOuter: event.target === outer,
        x: event.clientX, y: event.clientY, dropEffect: event.dataTransfer?.dropEffect };
      probe.events.push(reading);
      setTimeout(() => { reading.defaultPrevented = event.defaultPrevented; }, 0);
    }, true);
  }
  const NativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      if (new URL(String(args[0]), location.href).pathname.endsWith("/api/terminal/ws")) {
        let session = null;
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          if (frame.type === "session") session = frame.id;
          if (frame.type === "session" || frame.type === "exit") probe.frames.push({ type: frame.type, session, code: frame.code });
        });
      }
      return socket;
    },
  });
}

async function state(page) {
  return page.evaluate((selector) => {
    const box = (node) => {
      if (!node) return null;
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    const showing = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      tabs: [...document.querySelectorAll(selector)].map((outer) => {
        const role = outer.matches('[role="tab"]') ? outer : outer.querySelector('[role="tab"]');
        const close = outer.querySelector("button.close");
        return { label: outer.querySelector(".path")?.textContent.trim(), selected: role?.getAttribute("aria-selected") === "true",
          active: outer.classList.contains("active"), closeName: close?.getAttribute("aria-label"), closeInsideRole: !!role?.contains(close),
          rect: box(outer), labelRect: box(role), closeRect: box(close), inTitleBar: !!outer.closest(".tabs.in-bar"),
          labelFocused: document.activeElement === role, closeFocused: document.activeElement === close,
          labelFocusVisible: !!role?.matches(":focus-visible"), closeFocusVisible: !!close?.matches(":focus-visible"),
          labelOutlineOffset: role ? getComputedStyle(role).outlineOffset : null,
          labelOutlineStyle: role ? getComputedStyle(role).outlineStyle : null,
          labelOutlineWidth: role ? getComputedStyle(role).outlineWidth : null,
          closeOpacity: close ? getComputedStyle(close).opacity : null, hovered: outer.matches(":hover") };
      }),
      dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(showing).map((node) => ({
        name: node.getAttribute("aria-label") ?? (node.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent.trim() ?? "").join(" "),
        text: node.textContent.trim(),
      })),
      overflow: [...document.querySelectorAll(".tab-scroll-button")].filter(showing).map((node) => ({
        name: node.getAttribute("aria-label"), disabled: node.getAttribute("aria-disabled"), rect: box(node),
      })),
      events: window.__tab266.events, frames: window.__tab266.frames,
      activeElement: window.__tab266.activeIdentity(), focusEventCount: window.__tab266.focusEvents.length,
    };
  }, TAB);
}

async function element(page, label, part = "label") {
  const handle = await page.evaluateHandle(({ selector, wanted, part }) => {
    const outer = [...document.querySelectorAll(selector)].find((node) => node.querySelector(".path")?.textContent.trim() === wanted);
    if (!outer) return null;
    if (part === "close") return outer.querySelector("button.close");
    if (part === "role") return outer.matches('[role="tab"]') ? outer : outer.querySelector('[role="tab"]');
    return outer.querySelector(".path");
  }, { selector: TAB, wanted: label, part });
  assert.ok(handle.asElement(), `instrument: ${part} exists for ${label}`);
  return handle.asElement();
}

async function click(page, label, part = "label", button = "left") {
  const handle = await element(page, label, part);
  try { await handle.click({ button }); } finally { await handle.dispose(); }
}

function names(reading) { return reading.tabs.map((tab) => tab.label).sort(); }
function sessionIds(sessions) { return sessions.map((session) => session.id).sort(); }

async function allSessions(fixture) {
  const { stdout } = await fixture.cs(["terminal", "list", "--json"]);
  const { groups } = JSON.parse(stdout);
  assert.ok(groups && typeof groups === "object" && !Array.isArray(groups), "instrument: terminal registry has groups");
  const grouped = Object.values(groups);
  assert.ok(grouped.every(Array.isArray), "instrument: terminal registry groups are arrays");
  const rows = grouped.flat();
  assert.ok(rows.every((row) => row && typeof row.session_id === "string" && typeof row.name === "string" && "window" in row),
    "instrument: terminal registry rows have session identity");
  return rows.map((row) => ({ id: row.session_id, name: row.name, window: row.window }));
}

function preserveSessions(before, after, action) {
  requireProduct(JSON.stringify(sessionIds(after.sessions)) === JSON.stringify(sessionIds(before.sessions)), `${action} changed the window session set`);
  requireProduct(JSON.stringify(sessionIds(after.allSessions)) === JSON.stringify(sessionIds(before.allSessions)), `${action} changed the global session set`);
}

async function snapshot(fixture) {
  const { stdout } = await fixture.cs(["pane", "list", "--window", fixture.windowId, "--json"]);
  return { ...await state(fixture.page), panes: JSON.parse(stdout), sessions: await windowSessions(fixture.page, fixture.token),
    allSessions: await allSessions(fixture) };
}

async function fixture(ctx, index, report) {
  const suffix = `${Date.now().toString(36)}-${index}`;
  const result = { backend: "ghostty", windowId: `tab266-${suffix}`, token: new URL(ctx.serverUrl).searchParams.get("t"), files: [], page: null,
    labels: { control: `axc-control-${suffix}.md`, file: `axc-file-${suffix}.md`, live: `axc-live-${suffix}`, ended: `axc-ended-${suffix}` } };
  result.cs = async (args) => {
    try {
      const reply = await ctx.exec(ctx.chanBin, ["shell", ...args], { cwd: ctx.workspaceDir, timeout: 30_000,
        env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: result.windowId, CHAN_WORKSPACE_PATH: ctx.workspaceDir } });
      report.commands.push({ args, exit: 0, stdout: mask(String(reply.stdout)), stderr: mask(String(reply.stderr)) });
      return reply;
    } catch (error) {
      report.commands.push({ args, exit: error.code ?? null, error: mask(error.message) });
      throw error;
    }
  };
  report.fixture = result;
  for (const label of [result.labels.control, result.labels.file]) {
    const path = join(ctx.workspaceDir, label);
    writeFileSync(path, `# ${label}\n\nClean file for tab activation.\n`);
    result.files.push(path);
  }
  const page = result.page = await ctx.browser.newPage();
  result.pageErrors = [];
  page.on("pageerror", (error) => result.pageErrors.push(mask(error.message)));
  await page.setViewport({ width: 1600, height: 1000 });
  await page.evaluateOnNewDocument(installProbe);
  const url = new URL(ctx.serverUrl);
  url.hash = "";
  url.searchParams.set("w", result.windowId);
  url.searchParams.set("fresh", "1");
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 30_000 });
  await page.bringToFront();
  await ctx.waitWindowLive(result.windowId);
  result.originalStrip = await readPaneStripPreference(page, result.token);
  await writePaneStripPreference(page, result.token, false);
  for (const label of [result.labels.control, result.labels.file]) await result.cs(["open", label, "--window", result.windowId]);
  await poll("both clean file tabs", async () => (await state(page)).tabs.filter((tab) => tab.label?.endsWith(".md")).length === 2);
  for (const kind of ["live", "ended"]) {
    const row = await openAttachedTerminal(ctx, page, (args) => result.cs(["terminal", ...args]), result.windowId, result.labels[kind]);
    result[`${kind}Session`] = row.session_id;
    result[`${kind}TabId`] = row.tab;
    result[`${kind}PaneId`] = row.pane;
  }
  await result.cs(["terminal", "write", "--tab-name", result.labels.ended, "exit 0\n"]);
  await poll("real shell exit and retained tab", async () => {
    const reading = await state(page);
    const sessions = await windowSessions(page, result.token);
    const registry = await allSessions(result);
    return reading.frames.some((frame) => frame.type === "exit" && frame.session === result.endedSession) &&
      reading.tabs.some((tab) => tab.label === result.labels.ended) && sessions.length === 1 && sessions[0].id === result.liveSession &&
      !registry.some((session) => session.id === result.endedSession || session.name === result.labels.ended);
  });
  const ready = await snapshot(result);
  assert.deepEqual(names(ready), Object.values(result.labels).sort(), "instrument: exactly the four fixture tabs");
  assert.equal(ready.panes.panes.length, 1, "instrument: one fixture pane");
  assert.deepEqual(result.pageErrors, [], "instrument: fixture page has no runtime error");
  report.initial = ready;
  return result;
}

async function cleanup(f, report) {
  if (!f) return;
  const attempt = async (run) => { try { await run(); } catch (error) { (report.cleanupErrors ??= []).push(mask(error.message)); } };
  if (f.page) {
    await attempt(() => f.page.keyboard.press("Escape"));
    await attempt(async () => {
      const { stdout } = await f.cs(["pane", "list", "--window", f.windowId, "--json"]);
      for (const pane of JSON.parse(stdout).panes) for (const side of Object.values(pane.sides ?? {})) for (const tab of side.tabs ?? []) {
        await f.cs(["pane", "close-tab", "--pane", pane.id, "--tab", tab.id, "--force", "--window", f.windowId]);
      }
      await poll("cleanup released live sessions", async () => (await windowSessions(f.page, f.token)).length === 0);
    });
    // The registry remains usable if a failed DOM/control arm cannot close
    // its pane. Only this fixture's unique terminal names are eligible.
    await attempt(async () => {
      const own = async () => {
        const { stdout } = await f.cs(["terminal", "list", "--json"]);
        return Object.values(JSON.parse(stdout).groups ?? {}).flat().filter((row) =>
          [f.labels.live, f.labels.ended].includes(row.name));
      };
      for (const row of await own()) await f.cs(["terminal", "close", "--tab-name", row.name]);
      await poll("cleanup removed fixture sessions from the registry", async () => (await own()).length === 0);
    });
    if (f.originalStrip) await attempt(() => writePaneStripPreference(f.page, f.token, f.originalStrip.on));
    await attempt(() => f.page.close());
  }
  for (const path of f.files) await attempt(() => rmSync(path));
}

function preserved(before, after, label, mode) {
  requireProduct(JSON.stringify(names(after)) === JSON.stringify(names(before)), `${mode} changed the tab set`);
  const selected = after.tabs.find((tab) => tab.label === label);
  requireProduct(selected?.selected && selected.active, `${mode} did not select ${label}`);
  const menu = mode === "right" || mode === "padding-right" ? ["tab menu", "terminal tab settings"] : [];
  requireProduct(after.dialogs.every((dialog) => menu.includes(dialog.name)), `${mode} opened a dialog: ${JSON.stringify(after.dialogs)}`);
}

function terminalMenuFocus(reading, expected) {
  requireProduct(reading.dialogs.some((dialog) => ["tab menu", "terminal tab settings"].includes(dialog.name)),
    "right padding press did not keep the terminal menu open");
  const active = reading.activeElement;
  requireProduct(active?.terminalInput && active.terminalTabId === expected.tabId && active.paneId === expected.paneId,
    `right padding menu did not retain the selected terminal's input focus: ${JSON.stringify(active)}`);
}

async function paddingPoint(page, label) {
  const handle = await element(page, label, "role");
  try { await handle.hover(); } finally { await handle.dispose(); }
  // Read the padding after the strip's 260 ms hover transform settles.
  await sleep(300);
  const tab = (await state(page)).tabs.find((row) => row.label === label);
  assert.ok(tab?.rect && tab.labelRect, "instrument: tab and label have measured boxes");
  const gap = tab.labelRect.x - tab.rect.x;
  assert.ok(gap >= 2, "instrument: the tab has exposed left padding");
  const point = { x: tab.rect.x + gap / 2, y: tab.rect.y + tab.rect.height / 2 };
  await page.mouse.move(point.x, point.y);
  assert.ok(await page.evaluate(({ point, label, selector }) => {
    const target = document.elementFromPoint(point.x, point.y);
    return target?.matches(selector) && target.querySelector(".path")?.textContent.trim() === label;
  }, { point, label, selector: TAB }), "instrument: pointer hits the outer tab's padding, not its label or close button");
  return point;
}

async function activation(ctx, f, kind, mode) {
  const arm = { backend: f.backend, kind, mode, synthetic: mode === "synthetic-webkit", status: "incomplete" };
  const label = f.labels[kind];
  if (mode === "padding-right") arm.expectedFocus = { tabId: f[`${kind}TabId`], paneId: f[`${kind}PaneId`] };
  try {
    await click(f.page, f.labels.control);
    await poll("control tab selected", async () => (await state(f.page)).tabs.find((tab) => tab.label === f.labels.control)?.selected);
    arm.before = await snapshot(f);
    assert.deepEqual(names(arm.before), Object.values(f.labels).sort(), "instrument: complete fixture before activation");
    assert.ok(!arm.before.tabs.find((tab) => tab.label === label)?.selected && arm.before.dialogs.length === 0, "instrument: inactive subject and no dialog");
    arm.beforeShot = await ctx.shot(`${f.backend}-${kind}-${mode}-before`, f.page);
    const eventStart = arm.before.events.length;
    if (mode === "Enter" || mode === "Space") {
      const role = await element(f.page, label, "role");
      try {
        await role.focus();
        assert.ok(await role.evaluate((node) => document.activeElement === node), "instrument: role tab holds keyboard focus");
        await f.page.keyboard.press(mode);
      } finally { await role.dispose(); }
    } else if (mode === "synthetic-webkit") {
      const role = await element(f.page, label, "role");
      try {
        await role.evaluate((node) => {
          const target = node.querySelector("button,select") ?? node;
          for (const type of ["mousedown", "mouseup", "click"]) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
        });
      } finally { await role.dispose(); }
    } else if (mode === "drag" || mode === "padding-drag") {
      const handle = await element(f.page, label);
      const from = await handle.boundingBox();
      await handle.dispose();
      assert.ok(from, "instrument: inner label has a pointer target");
      const control = arm.before.tabs.find((tab) => tab.label === f.labels.control).rect;
      // Stay inside the control when its insertion marker shifts the row.
      const padding = mode === "padding-drag";
      const start = padding ? await paddingPoint(f.page, label) : { x: from.x + from.width / 2, y: from.y + from.height / 2 };
      const target = { x: control.x + control.width * (padding ? 0.75 : 0.25), y: control.y + control.height / 2 };
      if (padding) assert.ok(arm.before.tabs.findIndex((tab) => tab.label === label) < arm.before.tabs.findIndex((tab) => tab.label === f.labels.control),
        "instrument: padding drag starts before its control target and must reorder");
      arm.drag = { start, target };
      await f.page.setDragInterception(true);
      try {
        const data = await withTimeout(f.page.mouse.drag(start, target), 15_000, `native ${mode}`);
        arm.drag.types = (data.items ?? []).map((item) => item.mimeType);
        assert.ok(arm.drag.types.includes("application/x-md-tab"), "instrument: the native drag carries the app's tab payload");
        await f.page.mouse.dragEnter(target, data);
        await f.page.mouse.dragOver(target, data);
        await poll("trusted dragover accepted on the control tab", async () => f.page.evaluate(({ target, control, eventStart, padding }) => {
          const hit = document.elementFromPoint(target.x, target.y)?.closest(".tab");
          return hit?.querySelector(".path")?.textContent.trim() === control &&
            (padding ? hit.nextElementSibling : hit.previousElementSibling)?.classList.contains("drop-bar") &&
            window.__tab266.events.slice(eventStart).some((event) => event.type === "dragover" &&
              event.trusted && event.defaultPrevented && event.label === control);
        }, { target, control: f.labels.control, eventStart, padding }));
        arm.drag.hover = await state(f.page);
        arm.hoverShot = await ctx.shot(`${f.backend}-${kind}-${mode}-hover`, f.page);
        await f.page.mouse.drop(target, data);
      } finally {
        try { await f.page.mouse.up(); }
        finally { await f.page.setDragInterception(false); }
      }
    } else if (["held-pointer", "right", "padding-held", "padding-right"].includes(mode)) {
      const handle = await element(f.page, label);
      const from = await handle.boundingBox();
      await handle.dispose();
      assert.ok(from, "instrument: inner label has a pointer target");
      const padding = mode.startsWith("padding-");
      const right = mode === "right" || mode === "padding-right";
      if (padding) arm.padding = await paddingPoint(f.page, label);
      else await f.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      const button = right ? "right" : "left";
      await f.page.mouse.down({ button });
      try {
        if (right) {
          arm.held = await snapshot(f);
          preserved(arm.before, arm.held, label, mode);
          preserveSessions(arm.before, arm.held, "right mousedown");
          if (padding) terminalMenuFocus(arm.held, arm.expectedFocus);
        } else {
          arm.heldSamples = [];
          if (padding) {
            arm.focusWaitStartedAt = Date.now();
            arm.focusWaitDeadlineAt = arm.focusWaitStartedAt + 1_000;
            arm.focusWaitSamples = [];
            while (true) {
              arm.held = await state(f.page);
              const at = Date.now();
              arm.focusWaitSamples.push({ at, activeElement: arm.held.activeElement,
                focusEventCount: arm.held.focusEventCount, tabs: arm.held.tabs, dialogs: arm.held.dialogs });
              requireProduct(arm.held.tabs.find((tab) => tab.label === f.labels.control)?.selected, "terminal mousedown selected before release");
              requireProduct(arm.held.dialogs.length === 0, "terminal mousedown opened a dialog");
              if (arm.held.tabs.find((tab) => tab.label === label)?.labelFocused && at <= arm.focusWaitDeadlineAt) {
                arm.focusAcquiredAt = at;
                break;
              }
              requireProduct(at < arm.focusWaitDeadlineAt, "held padding press did not acquire focus on the tab label within 1000 ms");
              await sleep(Math.min(25, arm.focusWaitDeadlineAt - at));
            }
          }
          arm.heldStartedAt = Date.now();
          const until = arm.heldStartedAt + 500;
          while (true) {
            arm.held = await state(f.page);
            const at = Date.now();
            arm.heldSamples.push({ at, activeElement: arm.held.activeElement,
              focusEventCount: arm.held.focusEventCount, tabs: arm.held.tabs, dialogs: arm.held.dialogs });
            requireProduct(arm.held.tabs.find((tab) => tab.label === f.labels.control)?.selected, "terminal mousedown selected before release");
            requireProduct(arm.held.dialogs.length === 0, "terminal mousedown opened a dialog");
            if (padding) requireProduct(arm.held.tabs.find((tab) => tab.label === label)?.labelFocused,
              "held padding press did not keep focus on the tab label");
            if (at >= until) {
              arm.heldCompletedAt = at;
              break;
            }
            await sleep(Math.min(50, until - at));
          }
        }
        if (padding) arm.heldShot = await ctx.shot(`${f.backend}-${kind}-${mode}-held`, f.page);
      } finally {
        arm.releaseStartedAt = Date.now();
        await f.page.mouse.up({ button });
        arm.releasedAt = Date.now();
      }
    } else await click(f.page, label);
    const deadline = Date.now() + 5_000;
    do {
      arm.after = await state(f.page);
      if (arm.after.dialogs.length || !arm.after.tabs.some((tab) => tab.label === label) || arm.after.tabs.find((tab) => tab.label === label)?.selected) break;
      await sleep(50);
    } while (Date.now() < deadline);
    preserved(arm.before, arm.after, label, mode);
    const until = Date.now() + 500;
    arm.holdSamples = [];
    while (Date.now() < until) {
      const sample = await state(f.page);
      preserved(arm.before, sample, label, mode);
      if (mode === "padding-right") terminalMenuFocus(sample, arm.expectedFocus);
      arm.holdSamples.push({ at: Date.now(), selected: label, dialogs: sample.dialogs, tabs: names(sample), activeElement: sample.activeElement });
      await sleep(50);
    }
    arm.after = await snapshot(f);
    preserved(arm.before, arm.after, label, mode);
    preserveSessions(arm.before, arm.after, mode);
    requireProduct(arm.after.panes.activePaneId === arm.after.panes.panes[0].id, `${mode} did not focus the subject pane`);
    const events = arm.after.events.slice(eventStart);
    if (!arm.synthetic) assert.ok(events.some((event) => event.trusted && event.label === label), "instrument: trusted input reached the subject");
    if (mode === "right" || mode === "padding-right") requireProduct(arm.after.dialogs.some((dialog) => ["tab menu", "terminal tab settings"].includes(dialog.name)), "right press did not open the tab menu");
    if (mode.startsWith("padding-")) {
      const press = events.find((event) => event.type === "mousedown" && event.trusted && event.label === label);
      assert.ok(press?.targetIsOuter, "instrument: native mousedown reached the outer padding");
      requireProduct(press.defaultPrevented === false, "padding mousedown prevented the native focus or drag default");
      if (mode === "padding-right") terminalMenuFocus(arm.after, arm.expectedFocus);
    }
    if (mode === "drag" || mode === "padding-drag") {
      assert.ok(["dragstart", "dragend", "drop"].every((type) => events.some((event) => event.type === type && event.trusted)), "instrument: trusted drag started, dropped and ended");
      if (mode === "drag") requireProduct(arm.after.tabs[0].label === label, "inner-label drag did not reorder before the control tab");
      else requireProduct(arm.after.tabs.findIndex((tab) => tab.label === label) ===
        arm.after.tabs.findIndex((tab) => tab.label === f.labels.control) + 1, "padding drag did not reorder after the control tab");
    }
    arm.status = "passed";
  } catch (error) {
    arm.status = error.message.startsWith("PRODUCT_TAB_ACTION:") ? "observed" : "incomplete";
    arm.error = mask(error.message);
    arm.after = await snapshot(f).catch((cause) => ({ error: mask(cause.message) }));
  } finally {
    arm.afterShot = await ctx.shot(`${f.backend}-${kind}-${mode}-after`, f.page).catch((error) => { arm.screenshotError = mask(error.message); arm.status = "incomplete"; });
    await f.page.keyboard.press("Escape").catch(() => {});
  }
  return arm;
}

async function keyboardFocusStyles(ctx, f) {
  const arm = { backend: f.backend, kind: "live", mode: "keyboard-focus-styles", status: "incomplete" };
  const label = f.labels.live;
  try {
    await click(f.page, f.labels.control);
    await f.page.mouse.move(1500, 950);
    arm.before = await snapshot(f);
    const index = arm.before.tabs.findIndex((tab) => tab.label === label);
    assert.ok(index >= 0, "instrument: the inactive style subject exists");
    assert.ok(!arm.before.tabs[index].selected && !arm.before.tabs[index].hovered,
      "instrument: focus styles are read on an inactive, unhovered tab");
    const eventStart = arm.before.events.length;
    const subjectClose = await element(f.page, label, "close");
    try {
      await subjectClose.focus();
      assert.ok(await subjectClose.evaluate((node) => document.activeElement === node),
        "instrument: style setup focused the subject's close control");
    } finally { await subjectClose.dispose(); }
    arm.setup = await snapshot(f);
    await f.page.keyboard.down("Shift");
    try { await f.page.keyboard.press("Tab"); } finally { await f.page.keyboard.up("Shift"); }
    arm.label = await snapshot(f);
    const focusedLabel = arm.label.tabs.find((tab) => tab.label === label);
    requireProduct(focusedLabel?.labelFocused && focusedLabel.labelFocusVisible, "Shift+Tab did not visibly focus the inactive label");
    requireProduct(!focusedLabel.selected && !focusedLabel.hovered, "label focus selected or hovered the subject");
    arm.labelShot = await ctx.shot(`${f.backend}-live-label-keyboard-focus`, f.page);
    await f.page.keyboard.press("Tab");
    const deadline = Date.now() + 2_000;
    arm.closeFocusSamples = [];
    do {
      const tab = (await state(f.page)).tabs.find((row) => row.label === label);
      arm.closeFocusSamples.push({ at: Date.now(), tab });
      if (tab?.closeFocused && tab.closeFocusVisible && Number(tab.closeOpacity) === 1) break;
      await sleep(50);
    } while (Date.now() < deadline);
    arm.after = await snapshot(f);
    const focusedClose = arm.after.tabs.find((tab) => tab.label === label);
    arm.styleChecks = {
      labelOffsetOutline: Number.parseFloat(focusedLabel.labelOutlineOffset) > 0 && Number.parseFloat(focusedLabel.labelOutlineWidth) > 0 &&
        focusedLabel.labelOutlineStyle !== "none",
      inactiveCloseVisible: !!focusedClose?.closeFocused && focusedClose.closeFocusVisible && Number(focusedClose.closeOpacity) === 1,
    };
    requireProduct(!focusedClose?.selected && !focusedClose?.hovered, "close focus selected or hovered the subject");
    requireProduct(JSON.stringify(names(arm.after)) === JSON.stringify(names(arm.before)) && arm.after.dialogs.length === 0,
      "keyboard focus changed tabs or opened a dialog");
    preserveSessions(arm.before, arm.after, "keyboard focus");
    assert.deepEqual(arm.after.events.slice(eventStart).filter((event) => event.type === "keydown" && event.key === "Tab" && event.trusted)
      .map((event) => event.shiftKey), [true, false], "instrument: focus steps came from trusted Shift+Tab and Tab");
    requireProduct(Object.values(arm.styleChecks).every(Boolean),
      `keyboard focus style failed: ${Object.entries(arm.styleChecks).filter(([, held]) => !held).map(([name]) => name).join(", ")}`);
    arm.status = "passed";
  } catch (error) {
    arm.status = error.message.startsWith("PRODUCT_TAB_ACTION:") ? "observed" : "incomplete";
    arm.error = mask(error.message);
    arm.after = await snapshot(f).catch((cause) => ({ error: mask(cause.message) }));
  } finally {
    arm.afterShot = await ctx.shot(`${f.backend}-live-close-keyboard-focus`, f.page).catch((error) => { arm.screenshotError = mask(error.message); arm.status = "incomplete"; });
  }
  return arm;
}

async function dialogButton(page, label) {
  const handle = await page.evaluateHandle(({ selector, label }) => [...(document.querySelector(selector)?.querySelectorAll("button") ?? [])]
    .find((node) => node.textContent.trim() === label), { selector: CONFIRM, label });
  assert.ok(handle.asElement(), `instrument: confirmation has ${label}`);
  try { await handle.asElement().click(); } finally { await handle.dispose(); }
}

async function closeControl(ctx, f, kind) {
  const arm = { backend: f.backend, kind, mode: "close-control", status: "incomplete" };
  const label = f.labels[kind];
  try {
    await click(f.page, f.labels.control);
    arm.before = await snapshot(f);
    arm.beforeShot = await ctx.shot(`${f.backend}-${kind}-close-before`, f.page);
    await click(f.page, label, "close");
    if (kind === "live") {
      await poll("live close prompt", async () => (await state(f.page)).dialogs.find((dialog) => dialog.name === "Close tab?"));
      arm.prompt = await snapshot(f);
      requireProduct(JSON.stringify(names(arm.prompt)) === JSON.stringify(names(arm.before)), "live prompt removed a tab before confirmation");
      preserveSessions(arm.before, arm.prompt, "live prompt");
      arm.promptShot = await ctx.shot(`${f.backend}-live-close-prompt`, f.page);
      await dialogButton(f.page, "Cancel");
      await poll("close prompt cancelled", async () => (await state(f.page)).dialogs.length === 0);
      arm.cancelled = await snapshot(f);
      requireProduct(JSON.stringify(names(arm.cancelled)) === JSON.stringify(names(arm.before)), "Cancel changed tabs");
      preserveSessions(arm.before, arm.cancelled, "Cancel");
      await click(f.page, label, "close");
      await f.page.waitForSelector(CONFIRM);
      arm.secondPrompt = await snapshot(f);
      requireProduct(JSON.stringify(names(arm.secondPrompt)) === JSON.stringify(names(arm.before)), "second live prompt removed a tab before confirmation");
      preserveSessions(arm.before, arm.secondPrompt, "second live prompt");
      await dialogButton(f.page, "Close");
    }
    const deadline = Date.now() + 10_000;
    do {
      arm.after = await snapshot(f);
      if (arm.after.dialogs.length || (!arm.after.tabs.some((tab) => tab.label === label) &&
        (kind !== "live" || (!arm.after.sessions.some((session) => session.id === f.liveSession) &&
          !arm.after.allSessions.some((session) => session.id === f.liveSession))))) break;
      await sleep(100);
    } while (Date.now() < deadline);
    requireProduct(JSON.stringify(names(arm.after)) === JSON.stringify(names(arm.before).filter((name) => name !== label)), "close control did not remove exactly its tab");
    requireProduct(arm.after.dialogs.length === 0, "close control left an unexpected prompt");
    const expected = sessionIds(arm.before.sessions).filter((id) => kind !== "live" || id !== f.liveSession);
    requireProduct(JSON.stringify(sessionIds(arm.after.sessions)) === JSON.stringify(expected), "close control changed the wrong session set");
    const globalExpected = sessionIds(arm.before.allSessions).filter((id) => kind !== "live" || id !== f.liveSession);
    requireProduct(JSON.stringify(sessionIds(arm.after.allSessions)) === JSON.stringify(globalExpected), "close control changed the wrong global session set");
    arm.status = "passed";
  } catch (error) {
    arm.status = error.message.startsWith("PRODUCT_TAB_ACTION:") ? "observed" : "incomplete";
    arm.error = mask(error.message);
    arm.after = await snapshot(f).catch((cause) => ({ error: mask(cause.message) }));
  } finally {
    arm.afterShot = await ctx.shot(`${f.backend}-${kind}-close-after`, f.page).catch((error) => { arm.screenshotError = mask(error.message); arm.status = "incomplete"; });
  }
  return arm;
}

export default {
  name: "tab-accessibility",
  async run(ctx) {
    const backend = "ghostty";
    const evidence = { engine: "Chrome", backends: ["ghostty"], nativeAccessibility: "not exercised",
      fixtures: [], arms: [], supplementalArms: [], status: "incomplete" };
    try {
      assert.ok(ctx.controlSocket, "instrument: real control socket is available");
      for (const kind of ["live", "file", "ended"]) for (const closing of [false, true]) {
        const report = { backend, kind, closing, commands: [] };
        evidence.fixtures.push(report);
        try {
          const f = await fixture(ctx, evidence.fixtures.length, report);
          if (kind === "live" && !closing) {
            report.initialShot = await ctx.shot(`${backend}-strip-1600-before`, f.page);
            await f.page.setViewport({ width: 640, height: 1000 });
            report.overflowShot = await ctx.shot(`${backend}-strip-640-overflow`, f.page);
            report.overflow = await state(f.page);
            await f.page.setViewport({ width: 1600, height: 1000 });
          }
          if (closing) evidence.arms.push(await closeControl(ctx, f, kind));
          else {
            const modes = [kind === "live" ? "held-pointer" : "pointer", "Enter", "Space",
              ...(kind === "live" ? ["right", "drag"] : kind === "file" ? ["right"] : []), "synthetic-webkit"];
            for (const mode of modes) evidence.arms.push(await activation(ctx, f, kind, mode));
            if (kind === "live") {
              for (const mode of ["padding-held", "padding-right", "padding-drag"]) {
                evidence.supplementalArms.push(await activation(ctx, f, kind, mode));
              }
              evidence.supplementalArms.push(await keyboardFocusStyles(ctx, f));
            }
          }
          report.pageErrors = f.pageErrors;
        } catch (error) { report.setupError = mask(error.message); }
        finally {
          if (report.fixture?.page) {
            report.focusTrace = await report.fixture.page.evaluate(() => ({
              count: window.__tab266.focusEvents.length, limit: 512,
              events: window.__tab266.focusEvents, dropped: window.__tab266.focusEventsDropped,
            })).catch((error) => ({ error: mask(error.message) }));
          }
          console.log(`[smoke]   tab266 ${backend} ${kind} closing=${closing}: focus trace ${report.focusTrace?.count ?? "unavailable"}/512, dropped=${report.focusTrace?.dropped ?? "unavailable"}`);
          await cleanup(report.fixture, report);
          delete report.fixture;
        }
      }
      evidence.backendResults = [{ backend,
        arms: evidence.arms.filter((arm) => arm.backend === backend).length,
        supplementalArms: evidence.supplementalArms.filter((arm) => arm.backend === backend).length,
        passed: evidence.arms.filter((arm) => arm.backend === backend && arm.status === "passed").length,
        supplementalPassed: evidence.supplementalArms.filter((arm) => arm.backend === backend && arm.status === "passed").length,
      }];
      evidence.status = evidence.backendResults.every((result) => result.arms === 18 && result.supplementalArms === 4) &&
        [...evidence.arms, ...evidence.supplementalArms].every((arm) => arm.backend === "ghostty" && arm.status === "passed") && evidence.fixtures.every((report) =>
          !report.setupError && !report.cleanupErrors?.length && !report.pageErrors?.length && report.focusTrace &&
          !report.focusTrace.error && report.focusTrace.dropped === 0) ? "passed" : "failed";
    } catch (error) { evidence.error = mask(error.message); }
    finally { writeFileSync(join(ctx.outDir, "tab266-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`); }
    assert.equal(evidence.status, "passed", `tab-accessibility: ${JSON.stringify({
      error: evidence.error, backendResults: evidence.backendResults,
      arms: [...evidence.arms, ...evidence.supplementalArms].filter((arm) => arm.status !== "passed").map(({ backend, kind, mode, status, error }) => ({ backend, kind, mode, status, error })),
      fixtures: evidence.fixtures.map(({ backend, kind, closing, setupError, cleanupErrors, pageErrors, focusTrace }) => ({
        backend, kind, closing, setupError, cleanupErrors, pageErrors,
        focusTraceCount: focusTrace?.count, focusTraceLimit: focusTrace?.limit, focusTraceError: focusTrace?.error, focusTraceDropped: focusTrace?.dropped })),
    })}`);
    return evidence;
  },
};
