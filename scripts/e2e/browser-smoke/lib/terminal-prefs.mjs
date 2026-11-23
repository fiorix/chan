import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal } from "./terminal-attach.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const matchesChanges = (terminal, changes) => Object.entries(changes).every(
  ([key, value]) => {
    if (value == null) return terminal[key] == null;
    if (typeof value === "object") return JSON.stringify(terminal[key]) === JSON.stringify(value);
    return terminal[key] === value;
  },
);

export async function readTerminalPrefs(page, token) {
  return page.evaluate(async (authToken) => {
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const response = await fetch("/api/config", { headers });
    if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
    return (await response.json()).preferences.terminal;
  }, token);
}

export function writeTerminalPrefs(page, token, changes) {
  if (Object.hasOwn(changes, "ghostty")) {
    throw new Error("retired terminal preference ghostty; use openLegacyConfiguredTerminal for compatibility checks");
  }
  return writeCurrentTerminalPrefs(page, token, changes);
}

async function writeCurrentTerminalPrefs(page, token, changes) {
  let patchIssued = false;
  let lastRefresh = "no workspace request issued after PATCH";
  const postPatchRequests = new Set();
  const onRequest = (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/config" && request.method() === "PATCH") patchIssued = true;
    if (patchIssued && path === "/api/workspace" && request.method() === "GET") {
      postPatchRequests.add(request);
    }
  };
  page.on("request", onRequest);
  const refreshed = page.waitForResponse(
    async (response) => {
      if (!postPatchRequests.has(response.request())) return false;
      if (!response.ok()) {
        lastRefresh = `GET /api/workspace -> ${response.status()}`;
        return false;
      }
      const terminal = (await response.json()).preferences?.terminal;
      lastRefresh = JSON.stringify(Object.fromEntries(
        Object.keys(changes).map((key) => [key, terminal?.[key] ?? null]),
      ));
      return terminal && matchesChanges(terminal, changes);
    },
    { timeout: 20_000 },
  );
  refreshed.catch(() => {});
  try {
    await page.evaluate(async ({ authToken, patch }) => {
      const headers = { "content-type": "application/json" };
      if (authToken) headers.authorization = `Bearer ${authToken}`;
      const got = await fetch("/api/config", { headers });
      if (!got.ok) throw new Error(`GET /api/config -> ${got.status}`);
      const config = await got.json();
      const { ghostty: _legacy, ...terminal } = config.preferences.terminal;
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          expected_revision: config.revision,
          preferences: { terminal: { ...terminal, ...patch } },
        }),
      });
      if (!response.ok) throw new Error(`PATCH /api/config -> ${response.status}`);
    }, { authToken: token, patch: changes });
    try {
      await refreshed;
    } catch (error) {
      throw new Error(`workspace refresh after PATCH did not carry ${JSON.stringify(changes)}; last=${lastRefresh}`, { cause: error });
    }
    const deadline = Date.now() + 10_000;
    let lastRead = null;
    do {
      lastRead = await readTerminalPrefs(page, token);
      if (matchesChanges(lastRead, changes)) return;
      await sleep(200);
    } while (Date.now() < deadline);
    throw new Error(`page did not read back terminal preferences ${JSON.stringify(changes)}; last=${JSON.stringify(lastRead)}`);
  } finally {
    page.off("request", onRequest);
  }
}

export async function assertTerminalPrefs(ctx, expected) {
  const path = join(ctx.chanHome, "server.toml");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let toml = "";
    try { toml = readFileSync(path, "utf8"); } catch {}
    const matched = Object.entries(expected).every(([key, value]) => {
      const assignment = new RegExp(`^${key}\\s*=\\s*(true|false|[0-9]+)\\s*$`, "m").exec(toml);
      return value == null ? !assignment : assignment?.[1] === String(value);
    });
    if (matched) return;
    await sleep(200);
  }
  throw new Error(`server.toml did not persist terminal preferences: ${JSON.stringify(expected)}`);
}

export async function restoreTerminalPrefs(ctx, page, token, original) {
  const { ghostty: _legacy, ...current } = original;
  await writeTerminalPrefs(page, token, {
    ...current,
    secret_masking: original.secret_masking ?? null,
  });
  await assertTerminalPrefs(ctx, {
    mouse_capture: original.mouse_capture,
    secret_masking: original.secret_masking,
  });
}

// Compatibility writes deliberately carry the retired key. Prove the server
// drops it from canonical readback before opening a fresh Ghostty surface.
export function openLegacyConfiguredTerminal(ctx, page, cs, windowId, name, ghostty, newArgs = []) {
  if (typeof ghostty !== "boolean") throw new TypeError("legacy terminal.ghostty must be a boolean");
  return openLegacyTerminal(ctx, page, cs, windowId, name, ghostty, newArgs);
}

async function openLegacyTerminal(ctx, page, cs, windowId, name, ghostty, newArgs) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  await page.evaluate(async ({ token, ghostty }) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const got = await fetch("/api/config", { headers });
    if (!got.ok) throw new Error(`GET /api/config -> ${got.status}`);
    const config = await got.json();
    const response = await fetch("/api/config", {
      method: "PATCH", headers,
      body: JSON.stringify({
        expected_revision: config.revision,
        preferences: { terminal: { ...config.preferences.terminal, ghostty } },
      }),
    });
    if (!response.ok) throw new Error(`legacy terminal.ghostty PATCH -> ${response.status}`);
    const canonical = await fetch("/api/config", { headers });
    if (!canonical.ok) throw new Error(`canonical GET /api/config -> ${canonical.status}`);
    const terminal = (await canonical.json()).preferences?.terminal;
    if (!terminal || Object.hasOwn(terminal, "ghostty")) {
      throw new Error("legacy terminal.ghostty survived canonical readback");
    }
  }, { token, ghostty });
  return openAttachedTerminal(ctx, page, cs, windowId, name, "ghostty", newArgs);
}
