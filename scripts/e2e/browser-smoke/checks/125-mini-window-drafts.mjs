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

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWindows, goto, killChild, poll, spawnDevserver } from "../lib/launcher-devserver.mjs";

const TERMINAL_MENU = '.terminal-tab-menu-bubble[role="menu"]';
// Puppeteer's names for the modifier labels formatChord renders.
const MODIFIER_KEYS = { Ctrl: "Control", Alt: "Alt", Shift: "Shift", Cmd: "Meta" };

function terminalWindowUrl(origin, row) {
  const prefix = `/${row.prefix.replace(/^\/+|\/+$/g, "")}`;
  const url = new URL(`${prefix}/`, origin);
  url.searchParams.set("kind", "terminal");
  url.searchParams.set("w", row.window_id);
  url.searchParams.set("t", row.token);
  return url.toString();
}

/// The Rich Prompt chord as this page labels it. The terminal menu's row
/// renders chordFor("terminal.richPrompt"), the shortcut registry's chord
/// for this OS and surface, while App.svelte's keymap matches the keys on
/// its own; pressing the label holds the two to each other instead of to a
/// copy of either.
async function richPromptChord(page) {
  const terminal = await page.$eval(".pane .terminal-tab.active", (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  // The menu opens at the press and extends right and down from it.
  await page.mouse.click(terminal.left + terminal.width / 2, terminal.top + terminal.height / 2, { button: "right" });
  await page.waitForSelector(TERMINAL_MENU, { visible: true, timeout: 10_000 });
  const rows = await page.$$eval(`${TERMINAL_MENU} button.mbtn`, (buttons) =>
    buttons.map((b) => [
      b.querySelector(".mbtn-label")?.textContent?.trim() ?? "",
      b.querySelector(".mbtn-chord")?.textContent?.trim() ?? "",
    ]));
  // Close it with a press on the terminal outside it. Escape would reach the
  // focused terminal, which takes the key before the menu's window listener.
  await page.mouse.click(terminal.left + 24, terminal.top + 24);
  await page.waitForSelector(TERMINAL_MENU, { hidden: true, timeout: 10_000 });
  const row = rows.find(([label]) => label === "Show Rich Prompt");
  if (!row) throw new Error(`the terminal menu has no Show Rich Prompt row: ${JSON.stringify(rows)}`);
  const parts = row[1].split("+");
  const letter = parts.pop();
  const modifiers = parts.map((part) => MODIFIER_KEYS[part]);
  if (!/^[A-Z]$/.test(letter ?? "") || modifiers.length === 0 || modifiers.some((key) => !key)) {
    throw new Error(`the Rich Prompt row's chord label is not a modified letter: ${JSON.stringify(row[1])}`);
  }
  return { label: row[1], modifiers, key: `Key${letter}` };
}

async function pressChord(page, { modifiers, key }) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

export default {
  name: "mini-window-drafts",
  async run(ctx) {
    // Everything that needs tearing down is made inside the try, so a throw
    // from any step leaves no devserver or temp home behind.
    let chanHome = null;
    let devserver = null;
    let page = null;
    try {
      chanHome = mkdtempSync(join(tmpdir(), "chan-mini-drafts-"));
      devserver = spawnDevserver(ctx.chanBin, chanHome, ["--bind", "127.0.0.1"]);
      page = await ctx.browser.newPage();
      const launchUrl = await devserver.url;
      const origin = new URL(launchUrl).origin;
      const token = new URL(launchUrl).searchParams.get("t");
      if (!token) throw new Error("launcher URL has no management token");

      // The devserver mints one terminal window on first boot; its row
      // carries the shared terminal tenant's prefix and bearer.
      const row = await poll("the minted terminal window", async () =>
        (await fetchWindows(origin, token)).find((r) => r.kind === "terminal" && r.token) ?? null);
      await goto(page, terminalWindowUrl(origin, row));

      // The serving tenant's capability advertisement, readable before
      // first render: both metas, injected server-side into the shell.
      const metas = await page.evaluate(() => ({
        files: !!document.querySelector('meta[name="chan-files"]'),
        drafts: !!document.querySelector('meta[name="chan-drafts"]'),
      }));
      if (!metas.files) throw new Error("shell carries no chan-files meta");
      if (!metas.drafts) throw new Error("shell carries no chan-drafts meta");

      // A fresh standalone window boots on one terminal.
      await page.waitForSelector(".pane .terminal-tab.active", { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 2000));
      await ctx.shot("mini-window-booted", page);

      // Rich Prompt via its real chord. The composer opening at all
      // proves the drafts gate: the chord handler returns early in a
      // window without the capability.
      const chord = await richPromptChord(page);
      await pressChord(page, chord);
      await page.waitForSelector(".rich-prompt .cm-content", { timeout: 15_000 });
      await page.type(".rich-prompt .cm-content", "mini window rich prompt body");
      // The composer autosaves (debounced) into the per-library store.
      const draftsDir = join(chanHome, "devserver", "Drafts");
      const richDraft = await poll("the rich-prompt draft autosave in the store", () => {
        if (!existsSync(draftsDir)) return null;
        for (const name of readdirSync(draftsDir)) {
          const p = join(draftsDir, name, "draft.md");
          if (existsSync(p) && readFileSync(p, "utf8").includes("rich prompt body")) return p;
        }
        return null;
      }, 15_000);
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

      return { chord: chord.label, store: draftsDir, drafts: draftDirs, richDraft };
    } finally {
      if (page) await page.close().catch(() => {});
      if (devserver) await killChild(devserver.child);
      if (chanHome) rmSync(chanHome, { recursive: true, force: true });
    }
  },
};
