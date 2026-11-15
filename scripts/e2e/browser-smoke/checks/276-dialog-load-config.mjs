// Load and Bootstrap a hand-edited team through the real dialog, then read
// the file on disk. Edited Load and New exercise the ordinary save path.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEveryTerminal, dispatchCommand } from "../lib/pane-strip.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const DIR_INPUT = '.team-dialog input[list="team-dir-suggestions"]';
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function mode(page, name) {
  for (const button of await page.$$(".team-dialog .team-realestate-mode")) {
    if (await button.evaluate((node, expected) => node.textContent?.trim() === expected, name)) {
      await button.click();
      return;
    }
  }
  throw new Error(`team mode ${name} is absent`);
}

async function input(page, selector, value) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
  await page.keyboard.press("Tab");
}

export default {
  name: "dialog-load-config",
  async run(ctx) {
    const { page } = ctx;
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w") || sessionStorage.getItem("chan.session.window"));
    if (!windowId) throw new Error("dialogload page has no window id");
    const report = { legs: [], pageErrors: [], cleanupErrors: [] };
    const save = () => writeFileSync(join(ctx.outDir, "276-dialog-load-config.json"), JSON.stringify(report, null, 2));
    const pageError = (error) => report.pageErrors.push(maskTokens(error?.stack ?? String(error)));
    page.on("pageerror", pageError);
    const api = async (path, body, method = "POST") => {
      const url = new URL(path, ctx.serverUrl);
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    };

    try {
      for (const kind of ["unchanged", "edited", "new"]) {
        const dir = `dialog-load-276-${kind}-${Date.now().toString(36)}`;
        const leg = { kind, dir, passed: false, error: null };
        report.legs.push(leg);
        const requests = [];
        const onRequest = (request) => {
          if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/api/team-config/write")) {
            requests.push(JSON.parse(request.postData()));
          }
        };
        page.on("request", onRequest);
        try {
          await api("/api/team-config/write", {
            dir,
            config: {
              team_name: "Hand written name",
              host_name: "Saved host",
              host_handle: "@@SavedHost",
              tab_group: dir,
              auto_prefix_at: true,
              mcp_env: false,
              created_at: "2026-01-01T00:00:00Z",
              members: [{ handle: `@@${dir}`, command: "bash --noprofile --norc", env: {}, is_lead: true }],
            },
            brief_content: "Keep this brief.",
          });
          const configPath = join(ctx.workspaceDir, dir, "config.toml");
          const generated = readFileSync(configPath, "utf8");
          const lines = generated.split("\n");
          const teamName = lines.findIndex((line) => line.startsWith("team_name = "));
          if (teamName < 0) throw new Error("generated config lacks team_name");
          const [nameLine] = lines.splice(teamName, 1);
          const host = lines.findIndex((line) => line.startsWith("host_handle = "));
          if (host < 0) throw new Error("generated config lacks host_handle");
          lines.splice(host + 1, 0, nameLine);
          // Derive the fixture from this server's serializer, then hand-edit
          // the first key, its order and an unmodelled root key.
          const before = `# Keep this hand edit.\ncustom_note = "not a modeled field"\n${lines.join("\n")}`;
          writeFileSync(configPath, before);
          await api("/api/team-config/read", { dir });
          const bootstrapPath = join(ctx.workspaceDir, dir, "bootstrap.md");
          const bootstrapBefore = readFileSync(bootstrapPath, "utf8");
          writeFileSync(join(ctx.outDir, `276-${kind}-before.toml`), before);

          await dispatchCommand(page, "app.terminal.teamWork");
          await page.waitForSelector(".team-dialog", { timeout: 15_000 });
          await mode(page, "Load");
          await input(page, DIR_INPUT, dir);
          await page.waitForFunction((expected) => {
            const found = document.querySelector(".team-load-file")?.textContent?.trim();
            return found === `${expected}/config.toml` && !document.querySelector(".team-dialog-bootstrap")?.disabled;
          }, { timeout: 15_000 }, dir);
          if (kind === "edited") {
            await input(page, '.team-dialog input[placeholder="Neo"]', "Edited host");
          } else if (kind === "new") {
            await mode(page, "New");
          }
          await ctx.shot(`276-${kind}-before-bootstrap`);
          await page.click(".team-dialog-bootstrap");
          await page.waitForSelector(".team-dialog", { hidden: true, timeout: 30_000 });
          await ctx.shot(`276-${kind}-after-bootstrap`);

          const after = readFileSync(configPath, "utf8");
          const saved = await api("/api/team-config/read", { dir });
          writeFileSync(join(ctx.outDir, `276-${kind}-after.toml`), after);
          leg.beforeSha256 = sha256(before);
          leg.afterSha256 = sha256(after);
          leg.requests = requests.map((request) => ({ dir: request.dir, keep_config: request.keep_config ?? false, keep_bootstrap: request.keep_bootstrap ?? false }));
          leg.savedHost = saved.host_name;
          leg.bootstrapKept = readFileSync(bootstrapPath, "utf8") === bootstrapBefore;
          if (requests.length !== 1) throw new Error(`expected one dialog write, read ${requests.length}`);
          const preserve = kind === "unchanged";
          if (preserve && after !== before) throw new Error("unchanged Load rewrote config.toml bytes");
          if (Boolean(requests[0].keep_config) !== preserve) throw new Error(`keep_config=${Boolean(requests[0].keep_config)}, expected ${preserve}`);
          if (Boolean(requests[0].keep_bootstrap) !== (kind !== "new")) throw new Error("bootstrap preservation request disagrees with mode");
          if (!preserve && (after === before || after.includes("custom_note") || after.includes("# Keep this hand edit."))) throw new Error(`${kind} did not replace the hand-edited config`);
          if (saved.host_name !== (kind === "edited" ? "Edited host" : "Saved host")) throw new Error("saved host differs from the dialog");
          if (leg.bootstrapKept !== (kind !== "new")) throw new Error("bootstrap file preservation disagrees with mode");
          leg.passed = true;
        } catch (error) {
          leg.error = maskTokens(error?.stack ?? String(error));
          try {
            const state = await page.evaluate(() => ({
              modeButtons: [...document.querySelectorAll(".team-dialog .team-realestate-mode")]
                .map((button) => button.textContent?.trim() ?? ""),
              windowName: window.name,
            }));
            leg.failureState = {
              modeButtons: state.modeButtons.map((label) => maskTokens(label)),
              windowName: maskTokens(state.windowName),
            };
          } catch (evidenceError) {
            leg.failureStateError = maskTokens(evidenceError?.stack ?? String(evidenceError));
          }
          try {
            await ctx.shot(`276-${kind}-failure`);
          } catch (evidenceError) {
            leg.failureScreenshotError = maskTokens(evidenceError?.stack ?? String(evidenceError));
          }
        } finally {
          page.off("request", onRequest);
          try {
            if (await page.$(".team-dialog")) {
              await page.click(".team-dialog-cancel");
              await page.waitForSelector(".team-dialog", { hidden: true, timeout: 15_000 });
            }
          } catch (error) {
            report.cleanupErrors.push(maskTokens(error?.stack ?? String(error)));
          }
          try {
            await closeEveryTerminal(page, `dialogload ${kind}`, token);
          } catch (error) {
            report.cleanupErrors.push(maskTokens(error?.stack ?? String(error)));
          }
          // A busy dialog can block UI cancellation. Reap only sessions
          // belonging to this check's window, independently of that UI.
          try {
            const roster = await api("/api/terminals/roster", undefined, "GET");
            for (const session of roster.sessions.filter((session) => session.window_id === windowId)) {
              await api(`/api/terminals/${encodeURIComponent(session.id)}`, undefined, "DELETE");
            }
            const remaining = await api("/api/terminals/roster", undefined, "GET");
            if (remaining.sessions.some((session) => session.window_id === windowId)) throw new Error("dialogload cleanup left sessions behind");
          } catch (error) {
            report.cleanupErrors.push(maskTokens(error?.stack ?? String(error)));
          }
          save();
        }
        if (report.cleanupErrors.length) break;
      }
    } finally {
      page.off("pageerror", pageError);
      save();
    }
    const failures = report.legs.filter((leg) => !leg.passed);
    if (report.legs.length !== 3 || failures.length || report.pageErrors.length || report.cleanupErrors.length) {
      throw new Error(`dialogload failed: ${failures.map((leg) => `${leg.kind}: ${leg.error}`).join("; ")}; page errors ${report.pageErrors.length}; cleanup errors ${report.cleanupErrors.length}`);
    }
  },
};
