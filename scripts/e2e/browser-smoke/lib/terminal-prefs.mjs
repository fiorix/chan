import { readFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readTerminalPrefs(page, token) {
  return page.evaluate(async (authToken) => {
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const response = await fetch("/api/config", { headers });
    if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
    return (await response.json()).preferences.terminal;
  }, token);
}

export async function writeTerminalPrefs(page, token, changes) {
  const refreshed = page.waitForResponse(
    (response) => response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/workspace" && response.ok(),
    { timeout: 20_000 },
  );
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
  await refreshed;
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
