// The auto-hide preference in a standalone terminal window, which has no
// workspace and reads its preferences from the slim tenant's /api/config.
// The suite's shared server is a workspace tenant, so this check runs its
// own `chan devserver` under a throwaway CHAN_HOME with the preference set
// through the CLI before boot, and drives the terminal window it mints: one
// terminal at boot and no strip, a second terminal and the strip, back to
// one and no strip, and the preference turned off live through the tenant's
// own PATCH /api/config, after which the lone terminal gets its strip back.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWindows, goto, killChild, poll, spawnDevserver } from "../lib/launcher-devserver.mjs";
import {
  closeActiveTerminal,
  dispatchCommand,
  readPaneStripPreference,
  stripHidden,
  stripShown,
  waitPaneStrip,
  writePaneStripPreference,
} from "../lib/pane-strip.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function terminalWindowUrl(origin, row) {
  const prefix = `/${row.prefix.replace(/^\/+|\/+$/g, "")}`;
  const url = new URL(`${prefix}/`, origin);
  url.searchParams.set("kind", "terminal");
  url.searchParams.set("w", row.window_id);
  url.searchParams.set("t", row.token);
  return url.toString();
}

export default {
  name: "pane-strip-auto-hide-terminal-window",
  async run(ctx) {
    // Everything that needs tearing down is made inside the try, so a throw
    // from any step leaves no devserver or temp home behind.
    let chanHome = null;
    let devserver = null;
    let page = null;
    try {
      chanHome = mkdtempSync(join(tmpdir(), "chan-strip-202-"));
      try {
        execFileSync(ctx.chanBin, ["config", "set", "editor.pane_strip_auto_hide", "true"], {
          env: { ...process.env, CHAN_HOME: chanHome },
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (error) {
        const stderr = error?.stderr ? String(error.stderr).trim() : "";
        throw new Error(`chan config set editor.pane_strip_auto_hide true failed (${error?.status ?? error?.code ?? "?"}): ${stderr || error?.message}`, { cause: error });
      }
      devserver = spawnDevserver(ctx.chanBin, chanHome);
      page = await ctx.browser.newPage();
      const launchUrl = await devserver.url;
      const origin = new URL(launchUrl).origin;
      const token = new URL(launchUrl).searchParams.get("t");
      check(token, "launcher URL has no management token");
      // The devserver mints one terminal window on first boot.
      const row = await poll("the minted terminal window", async () =>
        (await fetchWindows(origin, token)).find((r) => r.kind === "terminal" && r.token) ?? null);
      await goto(page, terminalWindowUrl(origin, row));

      const served = await readPaneStripPreference(page, row.token);
      check(served.on, `the terminal tenant's /api/config does not carry the preference set before boot: ${JSON.stringify(served)}`);

      // A fresh standalone window boots on one terminal, with no strip.
      await page.waitForSelector(".pane .terminal-tab", { timeout: 30_000 });
      const one = await waitPaneStrip(page, "the booted terminal window", (s) => s.terminals === 1 && s.tabs.length === 1);
      check(stripHidden(one), `the lone boot terminal shows a strip: ${JSON.stringify(one)}`);
      await ctx.shot("202-boot-one-terminal", page);

      await dispatchCommand(page, "app.terminal.toggle");
      const two = await waitPaneStrip(page, "two terminals", (s) => s.terminals === 2 && s.tabs.length === 2 && stripShown(s));
      await ctx.shot("202-two-terminals", page);

      await closeActiveTerminal(page, "closing the second terminal");
      const oneAgain = await waitPaneStrip(page, "back to one terminal", (s) => s.terminals === 1 && s.tabs.length === 1 && stripHidden(s));

      // Off, live, through the tenant's own config route: the lone terminal
      // gets its strip back without a reload.
      await writePaneStripPreference(page, row.token, false);
      const restored = await waitPaneStrip(page, "the lone terminal after the preference turned off", (s) => s.tabs.length === 1 && stripShown(s));
      await ctx.shot("202-off-one-terminal", page);
      return { one, two, oneAgain, restored };
    } finally {
      if (page) await page.close().catch(() => {});
      if (devserver) await killChild(devserver.child);
      if (chanHome) rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
