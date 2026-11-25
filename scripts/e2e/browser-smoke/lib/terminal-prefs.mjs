import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal } from "./terminal-attach.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The server answers without an unset choice, an empty profile list or an
// unset default, so null and an empty list are both met by an absent key.
const unset = (value) => value == null || (Array.isArray(value) && value.length === 0);
const matchesChanges = (terminal, changes) => Object.entries(changes).every(
  ([key, value]) => {
    if (unset(value)) return unset(terminal[key]);
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
  // The page receives the changes as JSON. An undefined value would be left
  // out there, the stored value written back, and the wait for its removal
  // would only time out.
  const missing = Object.keys(changes).find((key) => changes[key] === undefined);
  if (missing) {
    throw new Error(`terminal preference ${missing} is undefined and would not be sent; name the value that clears it`);
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

export async function assertTerminalPrefs(ctx, expected, { expectMissingFile = false } = {}) {
  const path = join(ctx.chanHome, "server.toml");
  const deadline = Date.now() + 10_000;
  if (expectMissingFile && Object.values(expected).some((value) => value != null)) {
    throw new Error("a missing file cannot persist terminal preference values");
  }
  for (;;) {
    let toml;
    try {
      toml = readFileSync(path);
    } catch (error) {
      if (expectMissingFile && error.code === "ENOENT") return;
      throw error;
    }
    if (expectMissingFile) throw new Error("expected server.toml to be missing");
    let terminal;
    try {
      // Python's standard TOML parser also validates unrelated sections;
      // a line regex cannot distinguish a missing key from a broken file.
      terminal = JSON.parse(execFileSync("python3", ["-c",
        'import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.buffer.read().decode("utf-8")).get("terminal", {}), default=str))',
      ], { input: toml, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5_000 }));
    } catch (error) {
      throw new Error(`invalid server.toml or unavailable Python TOML parser: ${error.stderr || error.message}`, { cause: error });
    }
    if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) {
      throw new Error("server.toml terminal must be a table");
    }
    if (matchesChanges(terminal, expected)) return;
    if (Date.now() >= deadline) break;
    await sleep(200);
  }
  throw new Error(`server.toml did not persist terminal preferences: ${JSON.stringify(expected)}`);
}

export async function restoreTerminalPrefs(ctx, page, token, original) {
  const { ghostty: _legacy, ...current } = original;
  // A read leaves these three out while they are unset, and a write is laid
  // over the stored object, so each is named with the value that clears it:
  // otherwise a profile or a default set since the read would be written back.
  const optional = {
    secret_masking: original.secret_masking ?? null,
    profiles: original.profiles ?? [],
    default_profile: original.default_profile ?? null,
  };
  await writeTerminalPrefs(page, token, { ...current, ...optional });
  await assertTerminalPrefs(ctx, { mouse_capture: original.mouse_capture, ...optional });
}

// Undefined sends no legacy key; booleans deliberately carry it. Prove the
// canonical response omits it before opening a fresh Ghostty surface.
export function openLegacyConfiguredTerminal(ctx, page, cs, windowId, name, ghostty, newArgs = []) {
  if (ghostty !== undefined && typeof ghostty !== "boolean") {
    throw new TypeError("legacy terminal.ghostty must be a boolean or undefined (absent)");
  }
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
    const { ghostty: _legacy, ...current } = config.preferences.terminal;
    const terminalPatch = ghostty === undefined ? current : { ...current, ghostty };
    const response = await fetch("/api/config", {
      method: "PATCH", headers,
      body: JSON.stringify({
        expected_revision: config.revision,
        preferences: { terminal: terminalPatch },
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
  return openAttachedTerminal(ctx, page, cs, windowId, name, newArgs);
}
