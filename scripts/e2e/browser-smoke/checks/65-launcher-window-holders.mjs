// A launcher-opened window keeps this page load's holder tag through navigation.
// The library lists that tag for its live socket, and Open uses the tag on the
// named window's current page to keep or repair it. This drives one browser's
// named popup; it cannot simulate a browser's Duplicate Tab command, another
// browser, an unreadable foreign origin, or the desktop window host.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOLDER_TAG = /^[A-Za-z0-9_-]{1,64}$/;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mask = (text) => text.replace(/([?&]t=)[^&\s]+/g, "$1<token>")
  .replace(/(CHAN_DEVSERVER_TOKEN=)[^\s]+/g, "$1<token>");

function holderTagOf(url) {
  let tags;
  try {
    tags = new URL(url).searchParams.getAll("h");
  } catch {
    return null;
  }
  return tags.length === 1 && HOLDER_TAG.test(tags[0]) ? tags[0] : null;
}

function pageAddress(url) {
  // The workspace app persists tab state in the hash after its page loads.
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

function spawnDevserver(chanBin, chanHome) {
  const child = spawn(chanBin, ["devserver", "run", "--port", "0"], {
    env: { ...process.env, CHAN_HOME: chanHome, CHAN_NO_DEVSERVER_HANDOFF: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  let resolved = false;
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`chan devserver run: no URL after 60s\n${mask(lines.join("\n"))}`)),
      60_000,
    );
    const scan = (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        lines.push(line);
        const match = line.match(/https?:\/\/\S+/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(match[0]);
        }
      }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`chan devserver run exited early (${code})\n${mask(lines.join("\n"))}`));
      }
    });
  });
  return { child, url };
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function poll(label, read, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no matching value";
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = mask(error instanceof Error ? error.message : String(error));
    }
    await wait(300);
  }
  throw new Error(`${label} did not appear within ${timeoutMs}ms: ${lastError}`);
}

async function fetchWindows(origin, token) {
  const response = await fetch(`${origin}/api/library/windows`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`windows route answered ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("windows route did not return an array");
  return rows;
}

function sameTags(actual, expected) {
  return Array.isArray(actual) &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function tenantUrl(origin, record, tag) {
  const prefix = `/${record.prefix.replace(/^\/+|\/+$/g, "")}`;
  const url = new URL(`${prefix}/`, origin);
  url.searchParams.set("kind", "terminal");
  url.searchParams.set("w", record.window_id);
  url.searchParams.set("t", record.token);
  url.searchParams.set("h", tag);
  return url.toString();
}

async function goto(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (error) {
    throw new Error(`navigation to ${mask(url)} failed: ${mask(error instanceof Error ? error.message : String(error))}`);
  }
}

async function openRow(page, name) {
  const row = await poll(`row ${name}`, async () => {
    const rows = await page.$$("section.machine .term-list .row");
    for (const candidate of rows) {
      const label = await candidate.$eval(".row-name", (el) => el.textContent.trim());
      if (label === name) return candidate;
    }
    return null;
  });
  const open = await row.$('button[title="Open window"]');
  if (!open) throw new Error(`row ${name} has no Open button`);
  // ElementHandle.click waits for an IntersectionObserver callback before it
  // dispatches the pointer. A backgrounded launcher can leave that callback
  // pending while the popup owns focus, although the row is already visible.
  const box = await open.boundingBox();
  if (!box) throw new Error(`row ${name} is not on screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function openHeldRow(launcher, popup, rowName, originalAddress) {
  let navigation = null;
  let resolveNavigation;
  const navigationSeen = new Promise((resolve) => { resolveNavigation = resolve; });
  const onNavigation = (frame) => {
    if (frame !== popup.mainFrame()) return;
    navigation = mask(frame.url());
    resolveNavigation();
  };
  popup.on("framenavigated", onNavigation);
  try {
    await openRow(launcher, rowName);
    await Promise.race([navigationSeen, wait(2_000)]);
    if (navigation) throw new Error(`Open navigated a held page: ${navigation}`);
    const marker = await popup.evaluate(() => window.__chanSmokeMarker);
    if (marker !== "kept" || pageAddress(popup.url()) !== originalAddress) {
      throw new Error(`Open changed a held page: marker=${marker}, url=${mask(popup.url())}`);
    }
  } finally {
    popup.off("framenavigated", onNavigation);
  }
}

export default {
  name: "launcher-window-holders",
  async run(ctx) {
    if (!existsSync(join(ctx.repoRoot, "web-launcher/dist/index.html"))) {
      ctx.skip("launcher dist missing; build the web bundles before this check");
    }
    const chanHome = mkdtempSync(join(tmpdir(), "chan-launcher-holders-"));
    const devserver = spawnDevserver(ctx.chanBin, chanHome);
    let launcher = null;
    let popup = null;
    let twin = null;
    let passed = false;
    try {
      const launchUrl = await devserver.url;
      const parsed = new URL(launchUrl);
      const origin = parsed.origin;
      const token = parsed.searchParams.get("t");
      if (!token) throw new Error("launcher URL has no management token");
      launcher = await ctx.browser.newPage();
      await goto(launcher, launchUrl);
      await launcher.waitForSelector('button[aria-label="New local terminal"]', { timeout: 30_000 });

      const popupPromise = new Promise((resolve) => launcher.once("popup", resolve));
      await launcher.click('button[aria-label="New local terminal"]');
      popup = await Promise.race([
        popupPromise,
        wait(30_000).then(() => { throw new Error("New terminal opened no popup within 30s"); }),
      ]);
      try {
        await popup.waitForFunction(() => new URL(location.href).searchParams.has("h"), { timeout: 30_000 });
      } catch {
        throw new Error("the popup's URL names no h within 30s");
      }
      const opened = new URL(popup.url());
      const tag = holderTagOf(opened.toString());
      if (!tag || !/^[0-9a-f]{32}$/.test(tag)) throw new Error("the popup's URL has no 32-hex holder tag");
      const windowId = opened.searchParams.get("w");
      if (!windowId || opened.searchParams.get("kind") !== "terminal" || !opened.searchParams.get("lib")) {
        throw new Error("the popup's URL lacks w, kind=terminal or lib");
      }
      if ([...opened.searchParams.keys()].at(-1) !== "h") throw new Error("h is not the popup URL's last parameter");
      await popup.waitForSelector(".pane", { timeout: 30_000 });

      const held = await poll("new window's holder", async () => {
        const record = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
        return record?.connected && sameTags(record.holders, [tag]) ? record : null;
      });
      const rowName = `Terminal Window ${held.ordinal}${held.label ? ` [${held.label.trim()}]` : ""}`;
      const originalUrl = popup.url();
      const originalAddress = pageAddress(originalUrl);
      await ctx.shot("holder-listed", popup);
      await ctx.shot("launcher-row", launcher);

      await popup.evaluate(() => { window.__chanSmokeMarker = "kept"; });
      await openHeldRow(launcher, popup, rowName, originalAddress);
      const afterHeld = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
      if (!sameTags(afterHeld?.holders, [tag])) throw new Error("Open changed the held socket list");
      await ctx.shot("held-open", popup);

      twin = await ctx.browser.newPage();
      await goto(twin, tenantUrl(origin, held, "smoke-twin"));
      const withTwin = await poll("two live holder tags", async () => {
        const record = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
        return record?.connected && sameTags(record.holders, [tag, "smoke-twin"]) ? record : null;
      });
      await openHeldRow(launcher, popup, rowName, originalAddress);
      await ctx.shot("twin-held-open", popup);

      const dead = new URL(`/${held.prefix.replace(/^\/+|\/+$/g, "")}/favicon.ico`, origin);
      dead.searchParams.set("h", "smoke-dead");
      await goto(popup, dead.toString());
      const afterDead = await poll("only the twin's live tag", async () => {
        const record = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
        return record?.connected && sameTags(record.holders, ["smoke-twin"]) ? record : null;
      });
      await ctx.shot("dead-page", popup);
      await openRow(launcher, rowName);
      const repaired = await poll("repaired popup URL", async () => {
        const url = new URL(popup.url());
        return url.pathname === new URL(tenantUrl(origin, held, tag)).pathname &&
          url.searchParams.get("w") === windowId && holderTagOf(url.toString()) === tag ? url : null;
      });
      const afterRepair = await poll("repaired socket holder", async () => {
        const record = (await fetchWindows(origin, token)).find((row) => row.window_id === windowId);
        return record?.connected && sameTags(record.holders, [tag, "smoke-twin"]) ? record : null;
      });
      await ctx.shot("repaired-page", popup);
      const details = {
        windowId,
        tag,
        rowName,
        heldHolders: afterHeld.holders,
        twinHolders: withTwin.holders,
        deadHolders: afterDead.holders,
        repairedHolders: afterRepair.holders,
        repairedUrl: mask(repaired.toString()),
        launcherUrl: mask(launchUrl),
      };
      passed = true;
      return details;
    } finally {
      if (twin) await twin.close().catch(() => {});
      if (popup) await popup.close().catch(() => {});
      if (launcher) await launcher.close().catch(() => {});
      await killChild(devserver.child);
      if (!passed) cpSync(chanHome, join(ctx.outDir, "launcher-home"), {
        recursive: true,
        filter: (source) => source !== join(chanHome, "devserver", "config.json"),
      });
      rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
