// Drafts in a standalone (mini) window, driven like a user would. The
// suite's shared server is a workspace tenant, which cannot serve the
// standalone surface, so this check runs its own `chan devserver` under a
// throwaway CHAN_HOME and drives the minted terminal window's page. It
// asserts the serving side (both capability metas in the shell), the
// command side (New draft dispatches through the drafts gate and opens an
// editor tab), the Rich Prompt chord (composer opens and autosaves into
// the per-library store), and the store side (real files under
// `<CHAN_HOME>/devserver/Drafts`). Against a binary without the drafts
// surface the meta assertion fails first, so the check can go red.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 39147;

function pollUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = fn();
      } catch {
        value = null;
      }
      if (value) return resolve(value);
      if (Date.now() - t0 > timeoutMs) {
        return reject(new Error(`timed out waiting for ${label}`));
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function fetchJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

export default {
  name: "mini-window-drafts",
  async run(ctx) {
    const chanHome = mkdtempSync(join(tmpdir(), "chan-mini-drafts-"));
    const devserver = spawn(ctx.chanBin, ["devserver", "run", "--bind", "127.0.0.1", "--port", String(PORT)], {
      env: { ...process.env, CHAN_HOME: chanHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    devserver.stdout.on("data", (chunk) => (log += chunk));
    devserver.stderr.on("data", (chunk) => (log += chunk));
    const page = await ctx.page.browser().newPage();
    try {
      await pollUntil(() => log.includes("CHAN_DEVSERVER_TOKEN="), 30_000, "devserver token");
      const mgmtToken = log.match(/CHAN_DEVSERVER_TOKEN=([A-Za-z0-9_-]+)/)[1];
      const base = `http://127.0.0.1:${PORT}`;

      // The devserver mints one terminal window on first boot; its row
      // carries the shared terminal tenant's prefix and bearer.
      let row;
      const t0 = Date.now();
      while (!row && Date.now() - t0 < 30_000) {
        const rows = await fetchJson(`${base}/api/library/windows`, mgmtToken).catch(() => []);
        row = rows.find?.((r) => r.kind === "terminal" && r.token);
        if (!row) await new Promise((r) => setTimeout(r, 500));
      }
      if (!row) throw new Error("no terminal window row appeared on the devserver");

      await page.goto(
        `${base}${row.prefix}/?kind=terminal&w=${encodeURIComponent(row.window_id)}&t=${row.token}`,
        { waitUntil: "domcontentloaded" },
      );

      // The serving tenant's capability advertisement, readable before
      // first render: both metas, injected server-side into the shell.
      const metas = await page.evaluate(() => ({
        files: !!document.querySelector('meta[name="chan-files"]'),
        drafts: !!document.querySelector('meta[name="chan-drafts"]'),
      }));
      if (!metas.files) throw new Error("shell carries no chan-files meta");
      if (!metas.drafts) throw new Error("shell carries no chan-drafts meta");

      // A fresh standalone window boots on one terminal.
      await page.waitForSelector(".terminal-tab", { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 2000));
      await ctx.shot("mini-window-booted", page);

      // Rich Prompt via its real chord. The composer opening at all
      // proves the drafts gate: the chord handler returns early in a
      // window without the capability.
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.press("KeyP");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      await page.waitForSelector(".rich-prompt .cm-content", { timeout: 15_000 });
      await page.type(".rich-prompt .cm-content", "mini window rich prompt body");
      // The composer autosaves (debounced) into the per-library store.
      const draftsDir = join(chanHome, "devserver", "Drafts");
      const richDraft = await pollUntil(() => {
        if (!existsSync(draftsDir)) return null;
        for (const name of readdirSync(draftsDir)) {
          const p = join(draftsDir, name, "draft.md");
          if (existsSync(p) && readFileSync(p, "utf8").includes("rich prompt body")) return p;
        }
        return null;
      }, 15_000, "the rich-prompt draft autosave in the store");
      await ctx.shot("mini-rich-prompt", page);

      // New draft through the command bridge: the dispatch gate consults
      // windowCaps, so this proves the capability wiring in the page, and
      // the editor tab proves the returned wire path reads over /api/fs.
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("chan:command", { detail: { name: "app.draft.new" } }),
        );
      });
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".cm-content")].some((el) =>
            el.textContent?.includes("Draft"),
          ),
        { timeout: 20_000 },
      );
      const draftDirs = readdirSync(draftsDir).sort();
      if (draftDirs.length < 2) {
        throw new Error(
          `expected the rich-prompt draft plus the new draft in the store, found: ${draftDirs.join(", ")}`,
        );
      }
      await ctx.shot("mini-new-draft", page);

      return { store: draftsDir, drafts: draftDirs, richDraft };
    } finally {
      await page.close().catch(() => {});
      devserver.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      devserver.kill("SIGKILL");
      rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
