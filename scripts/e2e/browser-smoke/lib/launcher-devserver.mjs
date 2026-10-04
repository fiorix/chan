import { spawn } from "node:child_process";

const HOLDER_TAG = /^[A-Za-z0-9_-]{1,64}$/;
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const mask = (text) => text.replace(/([?&#]t=)[^&#\s]+/g, "$1<token>")
  .replace(/(%3[fF]t%3[dD]|%26t%3[dD])(?:(?!%26|%23)[^&#\s])+/gi, "$1<token>")
  .replace(/(CHAN_DEVSERVER_TOKEN=)[^\s]+/g, "$1<token>");

export function holderTagOf(url) {
  let tags;
  try {
    tags = new URL(url).searchParams.getAll("h");
  } catch {
    return null;
  }
  return tags.length === 1 && HOLDER_TAG.test(tags[0]) ? tags[0] : null;
}

export function pageAddress(url) {
  // The workspace app persists tab state in the hash after its page loads.
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

export function spawnDevserver(chanBin, chanHome) {
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

export async function killChild(child) {
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

export async function poll(label, read, timeoutMs = 30_000) {
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

export async function fetchWindows(origin, token) {
  const response = await fetch(`${origin}/api/library/windows`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`windows route answered ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("windows route did not return an array");
  return rows;
}

export function sameTags(actual, expected) {
  return Array.isArray(actual) &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export function tenantUrl(origin, record, tag) {
  const prefix = `/${record.prefix.replace(/^\/+|\/+$/g, "")}`;
  const url = new URL(`${prefix}/`, origin);
  url.searchParams.set("kind", "terminal");
  url.searchParams.set("w", record.window_id);
  url.searchParams.set("t", record.token);
  url.searchParams.set("h", tag);
  return url.toString();
}

export async function goto(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (error) {
    throw new Error(`navigation to ${mask(url)} failed: ${mask(error instanceof Error ? error.message : String(error))}`);
  }
}

export async function findWindowRow(page, name) {
  return poll(`row ${name}`, async () => {
    const rows = await page.$$("section.machine .term-list .row");
    for (const candidate of rows) {
      const label = await candidate.$eval(".row-name", (el) => el.textContent.trim());
      if (label === name) return candidate;
    }
    return null;
  });
}

export async function openRow(page, name) {
  const row = await findWindowRow(page, name);
  const open = await row.$('button[title="Open window"]');
  if (!open) throw new Error(`row ${name} has no Open button`);
  // ElementHandle.click waits for an IntersectionObserver callback before it
  // dispatches the pointer. A backgrounded launcher can leave that callback
  // pending while the popup owns focus, although the row is already visible.
  const box = await open.boundingBox();
  if (!box) throw new Error(`row ${name} is not on screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function openHeldRow(launcher, popup, rowName, originalAddress, label) {
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
    if (navigation) throw new Error(`${label}: Open navigated a held page: ${navigation}`);
    const marker = await popup.evaluate(() => window.__chanSmokeMarker);
    if (marker !== "kept" || pageAddress(popup.url()) !== originalAddress) {
      throw new Error(`${label}: Open changed a held page: marker=${marker}, url=${mask(popup.url())}`);
    }
  } finally {
    popup.off("framenavigated", onNavigation);
  }
}
