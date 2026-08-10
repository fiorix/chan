// Launcher machine-card collapse persists across a reload. The harness's
// `chan open` server has no launcher surface at `/`, so this check spawns its
// OWN isolated `chan devserver` (fresh CHAN_HOME, ephemeral port, no handoff)
// which serves the launcher SPA at `/`, drives it in a fresh page, collapses the
// "This machine" card, reloads, and asserts it stays collapsed.
//
// A headless devserver installs no config-backed collapse store, so this proves
// the localStorage reload-persistence half; the desktop-restart persistence
// (config side-channel) is decomposed into unit tests + Alex's host smoke.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/// Spawn an isolated devserver and resolve with its tokenized launcher URL. The
/// URL is `http://127.0.0.1:<port>/?t=<token>`, printed on the listen line.
function spawnDevserver(chanBin, chanHome) {
  const child = spawn(chanBin, ["devserver", "--port", "0"], {
    env: { ...process.env, CHAN_HOME: chanHome, CHAN_NO_DEVSERVER_HANDOFF: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  let resolved = false;
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`chan devserver: no URL after 60s\n${lines.join("\n")}`)),
      60_000,
    );
    const scan = (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        lines.push(line);
        const m = line.match(/https?:\/\/\S+/);
        if (m && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(m[0]);
        }
      }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`chan devserver exited early (${code})\n${lines.join("\n")}`));
      }
    });
  });
  return { child, url, lines };
}

async function killChild(child) {
  try {
    child.kill("SIGTERM");
  } catch {}
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 5000);
    child.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

// The local machine card's collapse toggle (the count badge). A fresh devserver
// surfaces only "This machine", so this selector is unique on the page.
const TOGGLE = "section.machine .machine-actions button.count-badge.machine-toggle";

export default {
  name: "launcher-collapse",
  async run(ctx) {
    // Same launcher-dist precondition as 95-launcher-native-trust: without
    // it the devserver serves no SPA and the selector wait below times out.
    const distRoot = join(ctx.repoRoot, "web-launcher", "dist");
    if (!existsSync(join(distRoot, "index.html"))) {
      ctx.skip(
        "launcher dist missing; the devserver has no launcher SPA to serve; run the web build before SMOKE_SKIP_BUILD=1",
      );
    }
    const chanHome = mkdtempSync(join(tmpdir(), "chan-launcher-collapse-"));
    const ds = spawnDevserver(ctx.chanBin, chanHome);
    let page = null;
    try {
      const url = await ds.url;
      page = await ctx.browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(TOGGLE, { timeout: 30_000 });

      const label = await page.$eval(TOGGLE, (el) => el.getAttribute("aria-label"));
      if (!label?.includes("This machine")) {
        throw new Error(`expected the local machine toggle, got aria-label ${label}`);
      }
      // Expanded by default: the content block renders, aria-expanded is true.
      await page.waitForSelector(".machine-content", { timeout: 10_000 });
      const startExpanded = await page.$eval(TOGGLE, (el) => el.getAttribute("aria-expanded"));
      if (startExpanded !== "true") {
        throw new Error(`expected aria-expanded=true before collapse, got ${startExpanded}`);
      }

      // Collapse: the content block goes away, aria-expanded flips to false.
      await page.click(TOGGLE);
      await page.waitForFunction(() => !document.querySelector(".machine-content"), {
        timeout: 10_000,
      });
      const collapsed = await page.$eval(TOGGLE, (el) => el.getAttribute("aria-expanded"));
      if (collapsed !== "false") {
        throw new Error(`expected aria-expanded=false after collapse, got ${collapsed}`);
      }
      await ctx.shot("collapsed", page);

      // Reload and assert the collapse survived (localStorage reload path).
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(TOGGLE, { timeout: 30_000 });
      const afterReload = await page.$eval(TOGGLE, (el) => el.getAttribute("aria-expanded"));
      if (afterReload !== "false") {
        throw new Error(`collapse did not persist across reload (aria-expanded=${afterReload})`);
      }
      const contentBack = await page.evaluate(() => !!document.querySelector(".machine-content"));
      if (contentBack) {
        throw new Error("machine content reappeared after reload; collapse did not persist");
      }
      await ctx.shot("collapsed-after-reload", page);

      return { url: url.replace(/([?&]t=)[^&]+/, "$1<token>"), persistedAcrossReload: true };
    } finally {
      if (page) await page.close().catch(() => {});
      await killChild(ds.child);
      try {
        rmSync(chanHome, { recursive: true, force: true });
      } catch {}
    }
  },
};
