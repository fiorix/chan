// Terminal appearance end to end. One live PTY survives renderer reloads while
// the check proves font size is captured (not live-refit), xterm and ghostty
// align their cell metrics at one size, and custom colours update the renderer
// plus surface chrome before Standard restores the exact prior surface.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TAB = "SmokeAppearance105";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function closeEnough(left, right, tolerance = 0.35) {
  return Math.abs(left - right) <= tolerance;
}

export default {
  name: "terminal-appearance",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
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
    const resizeFrames = [];
    cdp.on("Network.webSocketFrameSent", ({ response }) => {
      try {
        const frame = JSON.parse(response.payloadData);
        if (
          frame?.type === "resize" &&
          Number.isInteger(frame.cols) &&
          Number.isInteger(frame.rows)
        ) {
          resizeFrames.push({ cols: frame.cols, rows: frame.rows });
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

    async function patchTerminal(changes) {
      const terminal = await page.evaluate(async (token) => {
        const headers = {};
        if (token) headers.authorization = `Bearer ${token}`;
        const response = await fetch("/api/config", { headers });
        if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
        return (await response.json()).preferences.terminal;
      }, authToken);
      return patchOwner({ terminal: { ...terminal, ...changes } });
    }

    async function assertServerToml(pattern, description) {
      const path = join(ctx.chanHome, "server.toml");
      const deadline = Date.now() + 15_000;
      let content = "";
      for (;;) {
        try {
          content = readFileSync(path, "utf8");
          if (pattern.test(content)) return;
        } catch {
          // The first config write creates the file.
        }
        if (Date.now() > deadline) {
          throw new Error(`${description} was not persisted in ${path}:\n${content}`);
        }
        await sleep(200);
      }
    }

    async function session() {
      const { stdout } = await cs(["list", "--json"]);
      const sessions = Object.values(JSON.parse(stdout).groups ?? {}).flat();
      return sessions.find((candidate) => candidate.name === TAB) ?? null;
    }

    async function openTerminal() {
      const frameStart = resizeFrames.length;
      await cs(["new", "--tab-name", TAB]);
      const deadline = Date.now() + 30_000;
      for (;;) {
        const current = await session();
        if (current) break;
        if (Date.now() > deadline) throw new Error(`${TAB} never registered`);
        await sleep(250);
      }
      await page.waitForSelector(".terminal-tab .terminal.xterm .xterm-screen", {
        visible: true,
        timeout: 30_000,
      });
      return frameStart;
    }

    async function waitStableGrid(frameStart, label) {
      const deadline = Date.now() + 20_000;
      let candidate = null;
      let stableSince = 0;
      for (;;) {
        const latest = resizeFrames.slice(frameStart).at(-1) ?? null;
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

    async function rendererSnapshot(backend, frameStart) {
      const grid = await waitStableGrid(frameStart, backend);
      const dom = await page.evaluate(({ backend, grid }) => {
        const tab = document.querySelector(".terminal-tab");
        const host = tab?.querySelector(".terminal-host");
        const canvas = host?.querySelector("canvas");
        if (!(tab instanceof HTMLElement) || !(host instanceof HTMLElement)) {
          throw new Error(`${backend}: terminal surface missing`);
        }
        if (!(canvas instanceof HTMLCanvasElement)) {
          throw new Error(`${backend}: terminal canvas missing`);
        }
        const canvasRect = canvas.getBoundingClientRect();
        const hostStyle = getComputedStyle(host);
        const tabStyle = getComputedStyle(tab);
        const xtermViewport = host.querySelector(".xterm-scrollable-element");
        return {
          backend,
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
          rendererBackground:
            xtermViewport instanceof HTMLElement
              ? getComputedStyle(xtermViewport).backgroundColor
              : null,
          colors: {
            background: tabStyle.getPropertyValue("--bg").trim(),
            foreground: tabStyle.getPropertyValue("--text").trim(),
            cursor: tabStyle.getPropertyValue("--link").trim(),
          },
        };
      }, { backend, grid });
      return dom;
    }

    async function renderedCustomColorCounts() {
      await page.click(".terminal-tab .terminal-host");
      await sleep(250);
      const host = await page.$(".terminal-tab .terminal-host");
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

    async function reloadBackend(selector, label) {
      const frameStart = resizeFrames.length;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.waitForSelector(selector, { visible: true, timeout: 60_000 });
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
      await assertServerToml(
        new RegExp(`font_size\\s*=\\s*${size}`),
        `terminal font_size = ${size}`,
      );
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

    async function enableCustomColors() {
      await openSettingsSection("Appearance");
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
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "PATCH" &&
          candidate.url().includes("/api/config") &&
          candidate.ok(),
        { timeout: 15_000 },
      );
      await toggle.click();
      await response;
      await editAndBlur("#terminal-colour-background", "#123456");
      await editAndBlur("#terminal-colour-foreground", "#fedcba");
      await editAndBlur("#terminal-colour-cursor", "#abcdef");
      await clickConfigControl(
        'input[name="settings-terminal-contrast"][value="light"]',
      );
      await closeSettings();
      await page.waitForFunction(
        () => {
          const tab = document.querySelector(".terminal-tab");
          const viewport = tab?.querySelector(".xterm-scrollable-element");
          return (
            tab?.getAttribute("data-theme") === "light" &&
            viewport instanceof HTMLElement &&
            getComputedStyle(viewport).backgroundColor === "rgb(18, 52, 86)"
          );
        },
        { timeout: 15_000 },
      );
    }

    async function disableCustomColors() {
      await openSettingsSection("Appearance");
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

    let opened = false;
    const details = {};
    try {
      await patchTerminal({ ghostty: false, font_size: 14 });
      await patchOwner({ terminal_colors: { mode: "standard" } });
      await assertServerToml(/ghostty\s*=\s*false/, "terminal ghostty = false");
      await sleep(1_500);

      const initialFrame = await openTerminal();
      opened = true;
      await cs(["write", "--tab-name", TAB, "printf 'APPEARANCE105\\n'\n"]);
      await sleep(500);
      const sessionBefore = await session();
      const xterm14 = await rendererSnapshot("xterm-14", initialFrame);
      if (!(xterm14.cellWidth > 0 && xterm14.cellHeight > 0)) {
        throw new Error(`xterm initial cell geometry is invalid: ${JSON.stringify(xterm14)}`);
      }

      await setFontSize(20);
      const mountedXterm = await rendererSnapshot("xterm-mounted", initialFrame);
      if (
        JSON.stringify(mountedXterm.grid) !== JSON.stringify(xterm14.grid) ||
        !closeEnough(mountedXterm.cellWidth, xterm14.cellWidth, 0.02) ||
        !closeEnough(mountedXterm.cellHeight, xterm14.cellHeight, 0.02)
      ) {
        throw new Error(
          `mounted xterm refit after font preference changed: ${JSON.stringify({ xterm14, mountedXterm })}`,
        );
      }

      const xterm20 = await reloadBackend(
        ".terminal-tab .terminal.xterm .xterm-screen",
        "xterm-20",
      );
      const sessionAfterXtermReload = await session();
      if (
        !sessionBefore?.session_id ||
        sessionBefore.session_id !== sessionAfterXtermReload?.session_id
      ) {
        throw new Error("xterm reload replaced the PTY instead of reconstructing its renderer");
      }
      if (
        xterm20.cellWidth <= xterm14.cellWidth ||
        xterm20.cellHeight <= xterm14.cellHeight ||
        xterm20.grid.cols >= xterm14.grid.cols ||
        xterm20.grid.rows >= xterm14.grid.rows
      ) {
        throw new Error(
          `reconstructed xterm did not capture 20px: ${JSON.stringify({ xterm14, xterm20 })}`,
        );
      }
      details.xterm = { before: xterm14, mounted: mountedXterm, reconstructed: xterm20 };

      const standard = await rendererSnapshot("standard", resizeFrames.length - 1);
      await enableCustomColors();
      const custom = await rendererSnapshot("custom", resizeFrames.length - 1);
      const persistedCustom = await configColors();
      const renderedColors = await renderedCustomColorCounts();
      if (
        custom.dataTheme !== "light" ||
        custom.rendererBackground !== "rgb(18, 52, 86)" ||
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
      const restored = await rendererSnapshot("restored-standard", resizeFrames.length - 1);
      const restoredComparable = {
        dataTheme: restored.dataTheme,
        colors: restored.colors,
        rendererBackground: restored.rendererBackground,
      };
      const standardComparable = {
        dataTheme: standard.dataTheme,
        colors: standard.colors,
        rendererBackground: standard.rendererBackground,
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

      await patchTerminal({ ghostty: true });
      await assertServerToml(/ghostty\s*=\s*true/, "terminal ghostty = true");
      await sleep(1_500);
      await page.evaluate(() => performance.clearResourceTimings());
      const ghostty20 = await reloadBackend(
        ".terminal-tab .terminal-host canvas",
        "ghostty-20",
      );
      await page.waitForFunction(
        () =>
          performance
            .getEntriesByType("resource")
            .some((entry) => entry.name.includes("ghostty-vt")),
        { timeout: 60_000 },
      );
      if (await page.$(".terminal-tab .xterm")) {
        throw new Error("ghostty preference reconstructed an xterm renderer");
      }
      const sessionAfterGhosttyReload = await session();
      if (sessionBefore.session_id !== sessionAfterGhosttyReload?.session_id) {
        throw new Error("ghostty reload replaced the PTY instead of reconstructing its renderer");
      }
      if (
        ghostty20.grid.rows !== xterm20.grid.rows ||
        !closeEnough(ghostty20.cellWidth, xterm20.cellWidth) ||
        !closeEnough(ghostty20.cellHeight, xterm20.cellHeight)
      ) {
        throw new Error(
          `xterm/ghostty lost cell alignment at 20px: ${JSON.stringify({ xterm20, ghostty20 })}`,
        );
      }

      await setFontSize(18);
      const mountedGhostty = await rendererSnapshot(
        "ghostty-mounted",
        resizeFrames.length - 1,
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
      const ghostty18 = await reloadBackend(
        ".terminal-tab .terminal-host canvas",
        "ghostty-18",
      );
      if (
        ghostty18.cellWidth >= ghostty20.cellWidth ||
        ghostty18.cellHeight >= ghostty20.cellHeight
      ) {
        throw new Error(
          `reconstructed ghostty did not capture the smaller 18px font: ${JSON.stringify({ ghostty20, ghostty18 })}`,
        );
      }
      details.ghostty = {
        reconstructed20: ghostty20,
        mounted: mountedGhostty,
        reconstructed18: ghostty18,
      };
      await ctx.shot("ghostty-reconstructed");
      return details;
    } finally {
      try {
        await patchOwner({ terminal_colors: { mode: "standard" } });
      } catch (error) {
        console.error(`[105-terminal-appearance] colour restore failed: ${error.message}`);
      }
      try {
        await patchTerminal({ ghostty: false, font_size: 14 });
      } catch (error) {
        console.error(`[105-terminal-appearance] terminal restore failed: ${error.message}`);
      }
      if (opened) {
        try {
          await cs(["close", "--tab-name", TAB]);
        } catch {}
      }
      await cdp.detach().catch(() => {});
    }
  },
};
