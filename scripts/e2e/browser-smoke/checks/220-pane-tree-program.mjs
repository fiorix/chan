// The pane tree shows what runs in each terminal, beside the tab's name.
//
// One plain window, two distinct Ghostty terminals, each
// running bash with no startup files and a bare prompt, so no prompt hook
// sets a title. The tree stays open while each leg drives the shell through
// `cs terminal write`, which reaches the PTY without the page's keyboard (the
// open tree owns that):
//
//   SHELL   -- the row reads `bash`, the shell's own name.
//   VIM     -- `vim -Nu NONE -n` with its title off: the row reads `vim`.
//   QUIT    -- `:q` brings the row back to `bash`.
//   TITLE   -- the shell's own `printf '\033]2;build\007'`: the row reads
//              `build`, and its tab name is still the tab name.
//   JOB     -- an `sh -c` job that waits, sets the title `held` once the row
//              reads its command, and waits again. Released, it exits with no
//              further title and the row falls back to `bash`, not to `build`.
//
// Then, with the two terminals titled `secret-220-<identity>`:
//
//   SECOND  -- a second page on the same window attaches the same sessions
//              and its tree reads the same text for both rows; the frames it
//              received show the text came in the attach prelude.
//   PRIVACY -- the second page turns privacy mode on with the write the
//              Settings toggle makes in a browser (the shared localStorage
//              record); the first page's open tree reads `Hidden` on both
//              rows with the titles nowhere in it, and off restores them.
//
// Each reading is the `.program` element beside the row's `.title` in the
// open tree. A leg waits for its reading and fails with what the row showed
// and every reading it passed through. Requires vim on PATH.

import { execFileSync } from "node:child_process";

import { openAttachedTerminal } from "../lib/terminal-attach.mjs";

const TERMINALS = ["first", "second"];
const tabName = (identity) => `SmokePaneTree220${identity}`;
const secretTitle = (identity) => `secret-220-${identity}`;
// `exec` keeps one process from the login shell's `-lc` to the PTY's shell,
// so the foreground group's name is bash's.
const SHELL = "exec env -u PROMPT_COMMAND PS1='$ ' bash --noprofile --norc -i";
const VIM = "vim -Nu NONE -n --cmd 'set notitle noicon'\n";
const PRIVACY_KEY = "chan.privacy.v1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireVim() {
  try {
    execFileSync("vim", ["--version"], { stdio: "ignore", timeout: 10_000 });
  } catch (cause) {
    const error = new Error("vim --version must succeed for the foreground-program leg", { cause });
    error.smokeEnvironment = true;
    throw error;
  }
}

async function treeOpen(page) {
  return page.evaluate(() => !!document.querySelector(".pane-tree"));
}

async function openTree(page) {
  if (await treeOpen(page)) return;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.pane.tree" } })));
  await page.waitForSelector('.pane-tree [role="option"]', { timeout: 10_000 });
}

async function closeTree(page) {
  if (!(await treeOpen(page))) return;
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".pane-tree"), { timeout: 10_000 });
}

/// The open tree's row for `name`: its title, its reading and its tooltip.
async function row(page, name) {
  return page.evaluate((tab) => {
    const tree = document.querySelector(".pane-tree");
    if (!tree) return { open: false };
    const rows = [...tree.querySelectorAll('[role="option"]')];
    const found = rows.find((candidate) => candidate.querySelector(".title")?.textContent?.trim() === tab);
    if (!found) return { open: true, found: false, titles: rows.map((r) => r.querySelector(".title")?.textContent?.trim()) };
    return {
      open: true,
      found: true,
      title: found.querySelector(".title").textContent.trim(),
      program: found.querySelector(".program")?.textContent?.trim() ?? null,
      tooltip: found.getAttribute("title") ?? "",
    };
  }, name);
}

/// Wait until the row for `name` reads `want` beside its unchanged tab name.
/// Returns the row and the readings seen while waiting, oldest first.
async function waitReading(ctx, page, name, want, leg, timeoutMs = 20_000) {
  const seen = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await row(page, name);
    const reading = !got.open ? "<tree closed>" : !got.found ? "<no row>" : got.program;
    if (seen.length === 0 || seen.at(-1) !== reading) seen.push(reading);
    if (got.found && got.title === name && got.program === want) return { ...got, seen };
    if (!got.open) throw new Error(`${leg}: the tree closed while waiting for ${JSON.stringify(want)}; seen ${JSON.stringify(seen)}`);
    if (Date.now() > deadline) {
      await ctx.shot(`220-${leg}-failure`, page).catch(() => {});
      throw new Error(`${leg}: row ${name} should read ${JSON.stringify(want)}; it showed ${JSON.stringify(got)}; seen ${JSON.stringify(seen)}`);
    }
    await sleep(100);
  }
}

async function setPrivacy(page, enabled) {
  await page.evaluate((key, on) => {
    const previous = JSON.parse(localStorage.getItem(key) ?? "null") ?? { enabled: false, mask_terminal_secrets: false, revision: 0 };
    localStorage.setItem(key, JSON.stringify({ ...previous, enabled: on, revision: previous.revision + 1 }));
  }, PRIVACY_KEY, enabled);
}

export default {
  name: "pane-tree-program",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    requireVim();
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const env = { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId };
    const cs = (args, opts = {}) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], { cwd: ctx.workspaceDir, env, timeout: 90_000, ...opts });
    const write = (identity, text) => cs(["write", "--tab-name", tabName(identity), text]);

    const engine = await ctx.browser.browser().version();
    const readings = { engine, backend: "ghostty", terminals: {} };
    let second = null;
    const opened = [];
    const sessions = new Set();
    try {
      for (const identity of TERMINALS) {
        const name = tabName(identity);
        await closeTree(page);
        const attached = await openAttachedTerminal(ctx, page, cs, windowId, name, ["--command", SHELL]);
        opened.push(name);
        if (!attached.session_id || sessions.has(attached.session_id)) throw new Error(`${name}: expected a distinct terminal session`);
        sessions.add(attached.session_id);
        await openTree(page);
        const legs = {};

        // SHELL
        legs.shell = await waitReading(ctx, page, name, "bash", `${identity}-shell`);

        // VIM, QUIT
        await write(identity, VIM);
        legs.vim = await waitReading(ctx, page, name, "vim", `${identity}-vim`);
        await ctx.shot(`220-${identity}-vim`);
        await write(identity, ":q\r");
        legs.quit = await waitReading(ctx, page, name, "bash", `${identity}-quit`);

        // TITLE
        await write(identity, "printf '\\033]2;build\\007'\n");
        legs.title = await waitReading(ctx, page, name, "build", `${identity}-title`);
        if (legs.title.tooltip.includes("build")) {
          throw new Error(`${identity}-title: the row's tooltip carries the reading: ${JSON.stringify(legs.title.tooltip)}`);
        }
        await ctx.shot(`220-${identity}-title`);

        // JOB
        await write(identity, "sh -c 'read a; printf \"\\033]2;held\\007\"; read b'\n");
        legs.job = await waitReading(ctx, page, name, "sh", `${identity}-job`);
        await write(identity, "\n");
        legs.held = await waitReading(ctx, page, name, "held", `${identity}-held`);
        await write(identity, "\n");
        legs.exited = await waitReading(ctx, page, name, "bash", `${identity}-exited`);
        if (legs.held.seen.includes("build") || legs.exited.seen.includes("build")) {
          throw new Error(`${identity}-exited: the shell's earlier title came back: ${JSON.stringify([legs.held.seen, legs.exited.seen])}`);
        }
        readings.terminals[identity] = { session: attached.session_id, ...legs };
      }

      for (const identity of TERMINALS) await write(identity, `printf '\\033]2;${secretTitle(identity)}\\007'\n`);
      await openTree(page);
      for (const identity of TERMINALS) await waitReading(ctx, page, tabName(identity), secretTitle(identity), `${identity}-secret`);

      // SECOND
      second = await ctx.browser.newPage();
      const frames = [];
      const cdp = await second.target().createCDPSession();
      await cdp.send("Network.enable");
      cdp.on("Network.webSocketFrameReceived", ({ response }) => {
        if (response.opcode !== 1) return;
        try {
          const frame = JSON.parse(response.payloadData);
          if (frame.type === "session" || frame.type === "program") frames.push({ type: frame.type, id: frame.id, program: frame.program });
        } catch {}
      });
      await second.goto(`${ctx.serverUrl}&w=${windowId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await second.waitForSelector(".pane", { timeout: 30_000 });
      await openTree(second);
      readings.second = {};
      for (const identity of TERMINALS) {
        readings.second[identity] = await waitReading(ctx, second, tabName(identity), secretTitle(identity), `second-${identity}`);
      }
      await ctx.shot("220-second-page", second);
      readings.second.frames = frames;
      for (const identity of TERMINALS) {
        const title = secretTitle(identity);
        if (!frames.some((frame) => frame.type === "session" && frame.id === readings.terminals[identity].session && frame.program?.title === title)) {
          throw new Error(`second: no session prelude carried ${title}: ${JSON.stringify(frames)}`);
        }
      }

      // PRIVACY
      await setPrivacy(second, true);
      readings.privacy = {};
      for (const identity of TERMINALS) {
        readings.privacy[identity] = await waitReading(ctx, page, tabName(identity), "Hidden", `privacy-on-${identity}`);
      }
      const html = await page.evaluate(() => document.querySelector(".pane-tree")?.outerHTML ?? "");
      if (!html) throw new Error("privacy-on: the first page's tree closed");
      if (html.includes("secret-220")) {
        throw new Error("privacy-on: a masked title is still in the tree's markup");
      }
      await ctx.shot("220-privacy-on");
      await setPrivacy(second, false);
      for (const identity of TERMINALS) {
        readings.privacy[`${identity}-off`] = await waitReading(ctx, page, tabName(identity), secretTitle(identity), `privacy-off-${identity}`);
      }
      await ctx.shot("220-privacy-off");
      return readings;
    } finally {
      await second?.close().catch(() => {});
      await closeTree(page).catch(() => {});
      for (const name of opened) await cs(["close", "--tab-name", name]).catch(() => {});
    }
  },
};
