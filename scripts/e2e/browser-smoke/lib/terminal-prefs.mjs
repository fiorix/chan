import { readFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const matchesChanges = (terminal, changes) => Object.entries(changes).every(
  ([key, value]) => value == null ? terminal[key] == null : terminal[key] === value,
);

export async function readTerminalPrefs(page, token) {
  return page.evaluate(async (authToken) => {
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const response = await fetch("/api/config", { headers });
    if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
    return (await response.json()).preferences.terminal;
  }, token);
}

export async function writeTerminalPrefs(page, token, changes) {
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
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          expected_revision: config.revision,
          preferences: { terminal: { ...config.preferences.terminal, ...patch } },
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
  await writeTerminalPrefs(page, token, {
    ...original,
    secret_masking: original.secret_masking ?? null,
  });
  await assertTerminalPrefs(ctx, {
    ghostty: original.ghostty,
    mouse_capture: original.mouse_capture,
    secret_masking: original.secret_masking,
  });
}
