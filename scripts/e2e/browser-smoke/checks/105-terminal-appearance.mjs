// Terminal appearance end to end. One live PTY survives renderer reloads while
// Ghostty captures font sizes measured independently through the browser's font
// API. Custom colours update the canvas and surface chrome live; Standard
// restores the exact prior surface and keeps the custom payload dormant.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal, TERMINAL_SURFACE } from "../lib/terminal-attach.mjs";
import { assertTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import { waitRestoredTerminal, waitSaved } from "./290-rich-prompt-disconnected.mjs";

const TAB = "SmokeAppearance105";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function closeEnough(left, right, tolerance = 0.35) {
  return Math.abs(left - right) <= tolerance;
}

export function assertCustomColorBaseline(before) {
  if (before.preferences.terminal_colors.mode !== "standard" || before.checked) {
    throw new Error(
      `custom colours precondition failed: expected stored standard mode and unchecked control, ` +
      `got ${before.preferences.terminal_colors.mode}@${before.revision} and checked=${before.checked}`,
    );
  }
}

function customModePatch(bodyText) {
  try {
    const body = JSON.parse(bodyText ?? "");
    if (body?.preferences?.terminal_colors?.mode === "custom") {
      return { expectedRevision: body.expected_revision };
    }
  } catch {
    // An unreadable config PATCH still belongs in the observed count.
  }
  return null;
}

export function observeCustomColorConfigPatch(request, { requests, otherConfigPatches, tracked, mark }) {
  if (request.method() !== "PATCH" || new URL(request.url()).pathname !== "/api/config") return;
  let customPatch = null;
  try { customPatch = customModePatch(request.postData()); } catch {}
  const record = { customMode: customPatch !== null, status: null, failure: null };
  if (customPatch) {
    record.expectedRevision = customPatch.expectedRevision;
    requests.push(record);
    mark("custom-colours:patch-sent", { expectedRevision: record.expectedRevision });
  } else {
    otherConfigPatches.push(record);
  }
  tracked.set(request, record);
}

export function markOtherConfigPatches(records, mark) {
  for (const record of records) {
    mark("custom-colours:other-config-patch", {
      status: record.status ?? (record.failure ? "failed" : "pending"),
    });
  }
}

export function customColorWriteResult({ before, afterClick, current, checked, requests, otherConfigPatches = 0, readError, evaluatedLate = false }) {
  const accepted = requests.find((request) => request.status >= 200 && request.status < 300);
  const storedCustom = afterClick === true && accepted && current?.revision > before.revision &&
    current.preferences.terminal_colors.mode === "custom";
  if (storedCustom && !evaluatedLate) {
    return { ok: true };
  }
  const last = requests.at(-1);
  let requestStep;
  if (storedCustom && evaluatedLate) requestStep = "custom mode arrived after the 15s deadline";
  else if (!last) requestStep = "no custom-mode PATCH sent by the 15s deadline";
  else if (accepted && current?.revision > before.revision &&
           current.preferences.terminal_colors.mode === "custom") {
    requestStep = `custom-mode PATCH answered HTTP ${accepted.status} and the server stored custom mode`;
  } else if (accepted?.answeredAtMs > 15_000) requestStep = `custom-mode PATCH answered late at ${accepted.answeredAtMs}ms with HTTP ${accepted.status}`;
  else if (accepted) requestStep = `custom-mode PATCH answered HTTP ${accepted.status}, but the server did not store custom mode at a newer revision by the deadline`;
  else if (last.failure) requestStep = `custom-mode PATCH failed: ${last.failure}`;
  else if (last.status >= 400) requestStep = `custom-mode PATCH refused with HTTP ${last.status}`;
  else requestStep = "custom-mode PATCH unanswered by the 15s deadline";
  return {
    ok: false,
    sentence: `${afterClick ? "control checked" : "control remained unchecked"} after click; ${requestStep}; ` +
      `control before=${before.checked}, at deadline=${checked}; ` +
      `server before=${before.preferences.terminal_colors.mode}@${before.revision}, ` +
      `at deadline=${current?.preferences?.terminal_colors?.mode ?? "unavailable"}@${current?.revision ?? "unavailable"}; ` +
      `PATCH attempts=${requests.map((request) => request.status ?? request.failure ?? "pending").join(",") || "none"}; ` +
      `other config PATCHes=${otherConfigPatches}` +
      (readError ? `; last config read error=${readError}` : ""),
  };
}

export default {
  name: "terminal-appearance",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) throw new Error("terminal appearance setup: control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const authToken = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const env = {
      ...process.env,
      CHAN_CONTROL_SOCKET: socket,
      CHAN_WINDOW_ID: windowId,
    };
    const cs = (args, opts = {}) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
        cwd: ctx.workspaceDir,
        env,
        timeout: 90_000,
        ...opts,
      });

    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    const sockets = new Map();
    const resizeFrames = [];
    let terminalSession = null;
    let terminalSelector = null;
    cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/api/terminal/ws")) sockets.set(requestId, parsed.searchParams.get("session"));
    });
    cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
      if (!sockets.has(requestId)) return;
      try {
        const frame = JSON.parse(response.payloadData);
        if (frame?.type === "session" && typeof frame.id === "string") sockets.set(requestId, frame.id);
      } catch {
        // Binary output is not a session identity frame.
      }
    });
    cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
      try {
        const frame = JSON.parse(response.payloadData);
        if (
          frame?.type === "resize" &&
          Number.isInteger(frame.cols) &&
          Number.isInteger(frame.rows)
        ) {
          resizeFrames.push({ requestId, cols: frame.cols, rows: frame.rows });
        }
      } catch {
        // PTY input is binary and is not resize evidence.
      }
    });

    async function patchOwner(preferences) {
      return page.evaluate(
        async ({ preferences, token }) => {
          const headers = { "content-type": "application/json" };
          if (token) headers.authorization = `Bearer ${token}`;
          const got = await fetch("/api/config", { headers });
          if (!got.ok) throw new Error(`GET /api/config -> ${got.status}`);
          const cfg = await got.json();
          const patched = await fetch("/api/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              expected_revision: cfg.revision,
              preferences,
            }),
          });
          if (!patched.ok) {
            throw new Error(`PATCH /api/config -> ${patched.status}: ${await patched.text()}`);
          }
          return patched.json();
        },
        { preferences, token: authToken },
      );
    }

    const patchTerminal = (changes) => writeTerminalPrefs(page, authToken, changes);

    async function session() {
      const { stdout } = await cs(["list", "--json"]);
      const sessions = Object.values(JSON.parse(stdout).groups ?? {}).flat();
      return sessions.find((candidate) => candidate.name === TAB) ?? null;
    }

    async function openTerminal() {
      const frameStart = resizeFrames.length;
      terminalSession = await openAttachedTerminal(ctx, page, cs, windowId, TAB);
      terminalSelector = `.pane[data-pane-id="${terminalSession.pane}"] .terminal-tab.active[data-terminal-tab-id="${terminalSession.tab}"]`;
      await waitSaved(ctx, page, windowId, TAB);
      return frameStart;
    }

    async function waitStableGrid(frameStart, label) {
      const deadline = Date.now() + 20_000;
      let candidate = null;
      let stableSince = 0;
      for (;;) {
        const frame = resizeFrames.slice(frameStart).filter((item) => sockets.get(item.requestId) === terminalSession?.session_id).at(-1);
        const latest = frame ? { cols: frame.cols, rows: frame.rows } : null;
        if (latest) {
          if (
            !candidate ||
            latest.cols !== candidate.cols ||
            latest.rows !== candidate.rows
          ) {
            candidate = latest;
            stableSince = Date.now();
          } else if (Date.now() - stableSince >= 500) {
            return candidate;
          }
        }
        if (Date.now() > deadline) {
          throw new Error(`${label}: no stable resize frame after ${frameStart}`);
        }
        await sleep(100);
      }
    }

    // Independent oracle for chan's 1.2 line spacing: measure W on a separate
    // canvas, floor its device-pixel advance, ceil its device-pixel font box,
    // then floor that height times 1.2. Divide both by DPR for CSS pixels.
    // No widget metric, option or production measurement helper is read.
    async function expectedCells(size) {
      return page.evaluate(async (size) => {
        const font = `400 ${size}px "Source Code Pro"`;
        const faces = await document.fonts.load(font, "W");
        if (!faces.length || !document.fonts.check(font, "W")) throw new Error(`font oracle unavailable: ${font}`);
        const context = document.createElement("canvas").getContext("2d");
        if (!context) throw new Error("font oracle has no 2D context");
        context.font = font;
        const metrics = context.measureText("W");
        const fontHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
        const dpr = window.devicePixelRatio;
        if (!(metrics.width > 0 && fontHeight > 0 && dpr > 0)) throw new Error(`font oracle metrics unavailable: ${font}`);
        return {
          font, size, dpr, advance: metrics.width, fontHeight,
          width: Math.floor(metrics.width * dpr) / dpr,
          height: Math.floor(Math.ceil(fontHeight * dpr) * 1.2) / dpr,
        };
      }, size);
    }

    function assertCells(snapshot, expected) {
      if (!(expected.width > 0 && expected.height > 0) ||
          !closeEnough(snapshot.cellWidth, expected.width, 0.02) ||
          !closeEnough(snapshot.cellHeight, expected.height, 0.02)) {
        throw new Error(`Ghostty cells disagree with independent font measurement: ${JSON.stringify({ snapshot, expected })}`);
      }
    }

    async function rendererSnapshot(label, frameStart) {
      const grid = await waitStableGrid(frameStart, label);
      const dom = await page.evaluate(({ label, grid, selector, surface }) => {
        const tab = document.querySelector(selector);
        const host = tab?.querySelector(".terminal-host");
        const canvas = tab?.querySelector(surface);
        if (!(tab instanceof HTMLElement) || !(host instanceof HTMLElement)) {
          throw new Error(`${label}: terminal surface missing`);
        }
        if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height || grid.cols < 1 || grid.rows < 1) {
          throw new Error(`${label}: terminal canvas/grid missing`);
        }
        const canvasRect = canvas.getBoundingClientRect();
        const hostStyle = getComputedStyle(host);
        const tabStyle = getComputedStyle(tab);
        const context = canvas.getContext("2d");
        if (!context) throw new Error(`${label}: canvas pixels unavailable`);
        const pixel = (x, y) => {
          const [r, g, b, a] = context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
          if (a !== 255) throw new Error(`${label}: expected an opaque terminal canvas`);
          return `rgb(${r}, ${g}, ${b})`;
        };
        // The fixture clears scrollback and paints only the top rows. Its
        // empty body and scrollbar strip must share the terminal background.
        const bodyBackground = pixel(canvas.width / 2, canvas.height / 2);
        const trackBackground = pixel(canvas.width - 8 * canvas.width / canvasRect.width, canvas.height / 2);
        return {
          backend: "ghostty", label,
          grid,
          cellWidth: canvasRect.width / grid.cols,
          cellHeight: canvasRect.height / grid.rows,
          hostWidth: host.clientWidth,
          hostHeight: host.clientHeight,
          padding: {
            top: Number.parseFloat(hostStyle.paddingTop) || 0,
            right: Number.parseFloat(hostStyle.paddingRight) || 0,
            bottom: Number.parseFloat(hostStyle.paddingBottom) || 0,
            left: Number.parseFloat(hostStyle.paddingLeft) || 0,
          },
          dataTheme: tab.getAttribute("data-theme"),
          rendererBackground: bodyBackground,
          trackBackground,
          tabBackground: tabStyle.backgroundColor,
          hostBackground: hostStyle.backgroundColor,
          colors: {
            background: tabStyle.getPropertyValue("--bg").trim(),
            foreground: tabStyle.getPropertyValue("--text").trim(),
            cursor: tabStyle.getPropertyValue("--link").trim(),
          },
        };
      }, { label, grid, selector: terminalSelector, surface: TERMINAL_SURFACE });
      return dom;
    }

    async function proveOutput(label) {
      const marker = `APPEARANCE105_${label}`;
      await cs(["write", "--tab-name", TAB,
        `printf '\\033[3J\\033[2J\\033[HAPPEARANCE105_%s\\n\\033[48;2;37;181;123m  \\033[0m\\n' '${label}'\n`]);
      const deadline = Date.now() + 20_000;
      for (;;) {
        const output = (await cs(["scrollback", "--tab-name", TAB])).stdout;
        if (output.includes(marker)) break;
        if (Date.now() >= deadline) throw new Error(`PTY output missing after ${label}`);
        await sleep(100);
      }
      await page.waitForFunction((selector) => {
        const canvas = document.querySelector(selector);
        if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return false;
        const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!pixels) return false;
        let markerPixels = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === 37 && pixels[i + 1] === 181 && pixels[i + 2] === 123 && pixels[i + 3] === 255) markerPixels++;
        }
        return markerPixels >= 10;
      }, { timeout: 20_000 }, `${terminalSelector} ${TERMINAL_SURFACE}`);
    }

    async function renderedCustomColorCounts() {
      await page.click(`${terminalSelector} ${TERMINAL_SURFACE}`);
      await sleep(250);
      const host = await page.$(`${terminalSelector} .terminal-host`);
      if (!host) throw new Error("terminal host missing for colour screenshot");
      const screenshot = await host.screenshot({ encoding: "base64" });
      return page.evaluate(async (encoded) => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("screenshot decode canvas unavailable");
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const counts = { "#123456": 0, "#fedcba": 0, "#abcdef": 0 };
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const hex = `#${[pixels[offset], pixels[offset + 1], pixels[offset + 2]]
            .map((channel) => channel.toString(16).padStart(2, "0"))
            .join("")}`;
          if (Object.hasOwn(counts, hex)) counts[hex] += 1;
        }
        return { width: canvas.width, height: canvas.height, counts };
      }, screenshot);
    }

    async function reloadTerminal(label) {
      const frameStart = resizeFrames.length;
      await waitSaved(ctx, page, windowId, TAB);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      // Settings writes update terminal colours through this page's watcher.
      await ctx.waitWindowLive(windowId);
      const restored = await waitRestoredTerminal(page, cs, windowId, terminalSession);
      terminalSelector = restored.selector;
      if ((await session())?.session_id !== terminalSession.session_id) {
        throw new Error(`${label}: reload replaced the PTY`);
      }
      // A fresh document records the load even if an earlier check cleared
      // resource timing while the old document's module stayed cached.
      await page.waitForFunction(
        () => performance.getEntriesByType("resource").some((entry) => entry.name.includes("ghostty-vt")),
        { timeout: 60_000 },
      );
      await proveOutput(label);
      return rendererSnapshot(label, frameStart);
    }

    async function openSettingsSection(section) {
      await page.keyboard.down("Control");
      await page.keyboard.press("Comma");
      await page.keyboard.up("Control");
      await page.waitForSelector('[aria-label="Settings sections"]', {
        visible: true,
        timeout: 15_000,
      });
      await page.evaluate((wanted) => {
        const rail = document.querySelector('[aria-label="Settings sections"]');
        const button = [...rail.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === wanted,
        );
        if (!button) throw new Error(`settings section missing: ${wanted}`);
        button.click();
      }, section);
    }

    async function closeSettings() {
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Settings sections"]'),
        { timeout: 10_000 },
      );
    }

    async function editAndBlur(selector, value) {
      await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
      await page.focus(selector);
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await page.keyboard.type(String(value));
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "PATCH" &&
          candidate.url().includes("/api/config") &&
          candidate.ok(),
        { timeout: 15_000 },
      );
      await page.keyboard.press("Tab");
      await response;
    }

    async function setFontSize(size) {
      await openSettingsSection("Terminal");
      await editAndBlur('input[aria-label="Terminal font size"]', size);
      await closeSettings();
      await assertTerminalPrefs(ctx, { font_size: size });
      if ((await readConfig()).preferences.terminal.font_size !== size) {
        throw new Error(`font size ${size} did not reach the config API`);
      }
      await sleep(1_000);
    }

    async function clickConfigControl(selector) {
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "PATCH" &&
          candidate.url().includes("/api/config") &&
          candidate.ok(),
        { timeout: 15_000 },
      );
      await page.click(selector);
      await response;
    }

    async function readConfig(timeoutMs = 15_000) {
      return page.evaluate(async ({ token, timeoutMs }) => {
        const headers = token ? { authorization: `Bearer ${token}` } : {};
        const response = await fetch("/api/config", {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
        return response.json();
      }, { token: authToken, timeoutMs });
    }

    async function customColorChecked() {
      return page.evaluate(() => {
        const label = [...document.querySelectorAll("label.pill")].find(
          (candidate) => candidate.textContent?.trim() === "Custom terminal colours",
        );
        const input = label?.querySelector('input[type="checkbox"]');
        if (!(input instanceof HTMLInputElement)) {
          throw new Error("Custom terminal colours toggle missing");
        }
        return input.checked;
      });
    }

    async function enableCustomColors() {
      await openSettingsSection("Terminal");
      const toggle = await page.evaluateHandle(() => {
        const label = [...document.querySelectorAll("label.pill")].find(
          (candidate) => candidate.textContent?.trim() === "Custom terminal colours",
        );
        const input = label?.querySelector('input[type="checkbox"]');
        if (!(input instanceof HTMLInputElement)) {
          throw new Error("Custom terminal colours toggle missing");
        }
        return input;
      });
      const before = await readConfig();
      before.checked = await customColorChecked();
      assertCustomColorBaseline(before);
      const requests = [];
      const otherConfigPatches = [];
      const tracked = new Map();
      const startedAt = Date.now();
      const observer = { requests, otherConfigPatches, tracked, mark: (name, details) => ctx.mark(name, details) };
      const onRequest = (request) => observeCustomColorConfigPatch(request, observer);
      const onResponse = (response) => {
        const record = tracked.get(response.request());
        if (!record) return;
        record.status = response.status();
        record.answeredAtMs = Date.now() - startedAt;
        if (record.customMode) ctx.mark("custom-colours:patch-response", { status: record.status });
      };
      const onFailed = (request) => {
        const record = tracked.get(request);
        if (!record) return;
        record.failure = request.failure()?.errorText ?? "unknown";
        if (record.customMode) ctx.mark("custom-colours:patch-failed", { error: record.failure });
      };
      page.on("request", onRequest);
      page.on("response", onResponse);
      page.on("requestfailed", onFailed);
      try {
        ctx.mark("custom-colours:before", { revision: before.revision, checked: before.checked });
        try {
          await toggle.click();
        } catch (error) {
          const checked = await customColorChecked().catch(() => "unavailable");
          throw new Error(`custom colours click failed: ${error.message}; control before=false, after=${checked}; server revision=${before.revision}`);
        }
        const afterClick = await customColorChecked();
        ctx.mark("custom-colours:after-click", { checked: afterClick });
        const deadline = startedAt + 15_000;
        let current = null;
        let readError = null;
        let storedInTime = false;
        while (Date.now() < deadline) {
          try {
            current = await readConfig(Math.min(2_000, Math.max(1, deadline - Date.now())));
            readError = null;
          } catch (error) {
            current = null;
            readError = error.message;
          }
          if (Date.now() <= deadline &&
              customColorWriteResult({ before, afterClick, current, checked: afterClick, requests }).ok) {
            ctx.mark("custom-colours:stored", { revision: current.revision });
            storedInTime = true;
            break;
          }
          await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
        }
        if (!storedInTime) {
          const checked = await customColorChecked();
          const diagnosis = customColorWriteResult({
            before, afterClick, current, checked, requests,
            otherConfigPatches: otherConfigPatches.length, readError, evaluatedLate: true,
          });
          throw new Error(diagnosis.sentence);
        }
      } finally {
        markOtherConfigPatches(otherConfigPatches, (name, details) => ctx.mark(name, details));
        page.off("request", onRequest);
        page.off("response", onResponse);
        page.off("requestfailed", onFailed);
        await toggle.dispose();
      }
      await editAndBlur("#terminal-colour-background", "#123456");
      await editAndBlur("#terminal-colour-foreground", "#fedcba");
      await editAndBlur("#terminal-colour-cursor", "#abcdef");
      await clickConfigControl(
        'input[name="settings-terminal-contrast"][value="light"]',
      );
      await closeSettings();
      await page.waitForFunction(
        (selector) => {
          const tab = document.querySelector(selector);
          const host = tab?.querySelector(".terminal-host");
          return (
            tab?.getAttribute("data-theme") === "light" &&
            host instanceof HTMLElement &&
            getComputedStyle(host).backgroundColor === "rgb(18, 52, 86)"
          );
        },
        { timeout: 15_000 },
        terminalSelector,
      );
    }

    async function disableCustomColors() {
      await openSettingsSection("Terminal");
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "PATCH" &&
          candidate.url().includes("/api/config") &&
          candidate.ok(),
        { timeout: 15_000 },
      );
      await page.evaluate(() => {
        const label = [...document.querySelectorAll("label.pill")].find(
          (candidate) => candidate.textContent?.trim() === "Custom terminal colours",
        );
        const input = label?.querySelector('input[type="checkbox"]');
        if (!(input instanceof HTMLInputElement) || !input.checked) {
          throw new Error("enabled Custom terminal colours toggle missing");
        }
        input.click();
      });
      await response;
      await closeSettings();
      await sleep(1_000);
    }

    async function configColors() {
      return page.evaluate(async (token) => {
        const headers = {};
        if (token) headers.authorization = `Bearer ${token}`;
        const response = await fetch("/api/config", { headers });
        if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
        return (await response.json()).preferences.terminal_colors;
      }, authToken);
    }

    const initialPrefs = await page.evaluate(async (token) => {
      const headers = token ? { authorization: `Bearer ${token}` } : {};
      const response = await fetch("/api/config", { headers });
      if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
      return (await response.json()).preferences;
    }, authToken);
    let opened = false;
    const details = { backend: "ghostty" };
    let runError = null;
    try {
      await ctx.waitWindowLive(windowId);
      await patchTerminal({ font: "source-code-pro", font_size: 14 });
      await patchOwner({ terminal_colors: { mode: "standard" } });
      await assertTerminalPrefs(ctx, { font: "source-code-pro", font_size: 14 });
      await sleep(1_500);

      // A known face makes the independent 14px/20px/18px oracle reproducible.
      const expected14 = await expectedCells(14);
      opened = true;
      const initialFrame = await openTerminal();
      await proveOutput("initial");
      const sessionBefore = await session();
      const ghostty14 = await rendererSnapshot("ghostty-14", initialFrame);
      assertCells(ghostty14, expected14);

      // Saving 20px keeps the mounted 14px grid and cells until reload.
      await setFontSize(20);
      const mounted14 = await rendererSnapshot("ghostty-mounted-14", initialFrame);
      if (
        JSON.stringify(mounted14.grid) !== JSON.stringify(ghostty14.grid) ||
        !closeEnough(mounted14.cellWidth, ghostty14.cellWidth, 0.02) ||
        !closeEnough(mounted14.cellHeight, ghostty14.cellHeight, 0.02)
      ) {
        throw new Error(
          `mounted Ghostty refit before reload: ${JSON.stringify({ ghostty14, mounted14 })}`,
        );
      }

      // Reload preserves the PTY and captures independently measured 20px cells.
      const ghostty20 = await reloadTerminal("ghostty-20");
      const expected20 = await expectedCells(20);
      assertCells(ghostty20, expected20);
      if (
        ghostty20.cellWidth <= ghostty14.cellWidth ||
        ghostty20.cellHeight <= ghostty14.cellHeight ||
        ghostty20.grid.cols >= ghostty14.grid.cols ||
        ghostty20.grid.rows >= ghostty14.grid.rows
      ) {
        throw new Error(
          `reconstructed Ghostty did not capture 20px: ${JSON.stringify({ ghostty14, ghostty20 })}`,
        );
      }
      details.fontIncrease = { before: ghostty14, mounted: mounted14, reconstructed: ghostty20, expected14, expected20 };

      // Custom colours update pixels, terminal body and track without a reload.
      const standard = await rendererSnapshot("standard", 0);
      if (standard.rendererBackground !== standard.trackBackground ||
          standard.rendererBackground !== standard.tabBackground ||
          standard.rendererBackground !== standard.hostBackground) {
        throw new Error(`standard terminal body/track backgrounds differ: ${JSON.stringify(standard)}`);
      }
      await enableCustomColors();
      const custom = await rendererSnapshot("custom", 0);
      const persistedCustom = await configColors();
      const renderedColors = await renderedCustomColorCounts();
      if (
        custom.dataTheme !== "light" ||
        custom.rendererBackground !== "rgb(18, 52, 86)" ||
        custom.trackBackground !== "rgb(18, 52, 86)" ||
        custom.tabBackground !== "rgb(18, 52, 86)" ||
        custom.hostBackground !== "rgb(18, 52, 86)" ||
        renderedColors.counts["#123456"] < 1_000 ||
        renderedColors.counts["#fedcba"] < 1 ||
        renderedColors.counts["#abcdef"] < 1 ||
        JSON.stringify(persistedCustom) !==
          JSON.stringify({
            mode: "custom",
            custom: {
              background: "#123456",
              foreground: "#fedcba",
              cursor: "#abcdef",
              contrast: "light",
            },
          })
      ) {
        throw new Error(
          `custom terminal colours did not apply atomically: ${JSON.stringify({ custom, renderedColors, persistedCustom })}`,
        );
      }
      await ctx.shot("custom-live");
      await disableCustomColors();
      const restored = await rendererSnapshot("restored-standard", 0);
      const restoredComparable = {
        dataTheme: restored.dataTheme,
        colors: restored.colors,
        rendererBackground: restored.rendererBackground,
        trackBackground: restored.trackBackground,
        tabBackground: restored.tabBackground,
        hostBackground: restored.hostBackground,
      };
      const standardComparable = {
        dataTheme: standard.dataTheme,
        colors: standard.colors,
        rendererBackground: standard.rendererBackground,
        trackBackground: standard.trackBackground,
        tabBackground: standard.tabBackground,
        hostBackground: standard.hostBackground,
      };
      if (JSON.stringify(restoredComparable) !== JSON.stringify(standardComparable)) {
        throw new Error(
          `Standard did not restore the prior terminal surface: ${JSON.stringify({ standardComparable, restoredComparable })}`,
        );
      }
      const dormant = await configColors();
      if (dormant?.mode !== "standard" || dormant.custom?.background !== "#123456") {
        throw new Error(`custom payload was not retained dormant: ${JSON.stringify(dormant)}`);
      }
      details.colors = {
        standard: standardComparable,
        custom,
        renderedColors,
        restored: restoredComparable,
      };

      // The smaller-font leg also stays mounted at 20px until its reload.
      await setFontSize(18);
      const mountedGhostty = await rendererSnapshot(
        "ghostty-mounted",
        0,
      );
      if (
        JSON.stringify(mountedGhostty.grid) !== JSON.stringify(ghostty20.grid) ||
        !closeEnough(mountedGhostty.cellWidth, ghostty20.cellWidth, 0.02) ||
        !closeEnough(mountedGhostty.cellHeight, ghostty20.cellHeight, 0.02)
      ) {
        throw new Error(
          `mounted ghostty refit after font preference changed: ${JSON.stringify({ ghostty20, mountedGhostty })}`,
        );
      }
      const ghostty18 = await reloadTerminal("ghostty-18");
      const expected18 = await expectedCells(18);
      assertCells(ghostty18, expected18);
      if (
        ghostty18.cellWidth >= ghostty20.cellWidth ||
        ghostty18.cellHeight >= ghostty20.cellHeight
      ) {
        throw new Error(
          `reconstructed ghostty did not capture the smaller 18px font: ${JSON.stringify({ ghostty20, ghostty18 })}`,
        );
      }
      details.fontDecrease = {
        reconstructed20: ghostty20,
        mounted: mountedGhostty,
        reconstructed18: ghostty18,
        expected18,
      };
      details.session = { before: sessionBefore.session_id, after: (await session())?.session_id };
      if (details.session.before !== details.session.after) throw new Error("appearance checks replaced the PTY");
      for (const leg of ["fontIncrease", "colors", "fontDecrease", "session"]) {
        if (!details[leg]) throw new Error(`terminal appearance leg did not run: ${leg}`);
      }
      await ctx.shot("ghostty-reconstructed");
      return details;
    } catch (error) {
      runError = error;
      throw error;
    } finally {
      let restoreError = null;
      try {
        await patchOwner({ terminal_colors: initialPrefs.terminal_colors });
        const saved = readFileSync(join(ctx.chanHome, "preferences.toml"), "utf8");
        const colors = saved.split("[terminal_colors]")[1]?.split("\n[")[0] ?? "";
        if (!colors.split("\n").includes(`mode = "${initialPrefs.terminal_colors.mode}"`)) {
          throw new Error("terminal colours did not restore in preferences.toml");
        }
        if (initialPrefs.terminal_colors.custom) {
          const custom = saved.split("[terminal_colors.custom]")[1]?.split("\n[")[0] ?? "";
          for (const [field, value] of Object.entries(initialPrefs.terminal_colors.custom)) {
            if (!custom.split("\n").includes(`${field} = "${value}"`)) {
              throw new Error(`${field} did not restore in preferences.toml`);
            }
          }
        }
      } catch (error) {
        restoreError = error;
      }
      try {
        await restoreTerminalPrefs(ctx, page, authToken, initialPrefs.terminal);
        await assertTerminalPrefs(ctx, {
          font: initialPrefs.terminal.font,
          font_size: initialPrefs.terminal.font_size,
        });
      } catch (error) {
        restoreError ??= error;
      }
      if (opened) {
        try {
          await cs(["close", "--tab-name", TAB]);
        } catch {}
      }
      await cdp.detach().catch(() => {});
      if (restoreError) {
        if (runError) console.error(`[105-terminal-appearance] restore failed: ${restoreError.message}`);
        else throw restoreError;
      }
    }
  },
};
