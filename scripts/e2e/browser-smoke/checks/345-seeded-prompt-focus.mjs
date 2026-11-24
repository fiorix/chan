// Proves that the 150 ms seeded-prompt callback rechecks pane focus. The
// user opens New terminal here, leaves its pane before the program's first
// output, and keeps the keyboard when the seed arrives. Both raw programs
// enable DECSET 1004; no seed-driven focus report may reach either one.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectLauncherCommand } from "../lib/pane-strip.mjs";
import { drainPointerInput, pointerInputSince } from "../lib/terminal-pointer.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import {
  assertKeyboard, clearFocus, clickTerminal, enableFocusReports,
  readFocus, runFocusCheck, settleFocus, waitFocus,
} from "../lib/terminal-focus.mjs";

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const SEED = "focus-seed-345.md";
const INPUT = ` ${SEED}\x01`;

export default {
  name: "seeded-prompt-focus",
  run(ctx) {
    return runFocusCheck(ctx, 345, async ({ page, details, windowId, shell, cs, open, create, attach, leg, restore }) => {
      const panes = async () => JSON.parse((await shell(["pane", "list", "--json"])).stdout);
      const initial = await panes();
      assert.equal(initial.panes.length, 1, "the check starts with one pane");
      await shell(["pane", "new", "right", "--pane", initial.panes[0].id]);
      const split = await waitFocus("two panes", panes, (read) => read.panes.length === 2);
      const left = split.panes.find((pane) => pane.id === initial.panes[0].id);
      const right = split.panes.find((pane) => pane.id !== initial.panes[0].id);
      assert.ok(left && right, "the split retains the original pane");
      const owner = await open("owner", ["--pane", left.id]);
      await clickTerminal(page, owner.query);
      await enableFocusReports(owner);

      const directory = mkdtempSync(join(ctx.workspaceDir, ".focus-345-"));
      restore("remove seeded fixtures", async () => rmSync(directory, { recursive: true, force: true }));
      const seeded = await create("seeded");
      // A public shell profile supplies a silent raw program. Its first
      // output is under the controller's hand, not a race against 150 ms.
      const script = join(directory, "shell.sh");
      writeFileSync(script, ["#!/bin/sh", "stty -opost -echo || exit 1",
        ...Object.entries(seeded.fixture.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
        seeded.fixture.command, ""].join("\n"), { mode: 0o700 });
      writeFileSync(join(directory, SEED), "# Focus seed\n");
      const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
      const original = await readTerminalPrefs(page, token);
      // The default profile is the server's, not this window's: left in
      // place it would start every later terminal on a script that is gone.
      // The three readings are kept so the saved details show the round trip.
      const profileOf = (terminal) => ({
        default_profile: terminal.default_profile ?? null, profiles: (terminal.profiles ?? []).map((entry) => entry.id),
      });
      details.terminalProfile = { before: profileOf(original) };
      restore("restore terminal profile", async () => {
        await restoreTerminalPrefs(ctx, page, token, original);
        details.terminalProfile.after = profileOf(await readTerminalPrefs(page, token));
        assert.deepEqual(details.terminalProfile.after, details.terminalProfile.before,
          "the server's terminal profiles and default are the ones the check found");
      });
      const profile = { id: "focus-345", name: "Focus recorder", program: "/bin/sh", args: [script], kind: "posix", hidden: false };
      assert.ok(!(original.profiles ?? []).some((entry) => entry.id === profile.id), "the temporary profile id is unused");
      await writeTerminalPrefs(page, token, { profiles: [...(original.profiles ?? []), profile], default_profile: profile.id });
      details.terminalProfile.during = profileOf(await readTerminalPrefs(page, token));
      const known = new Set(Object.values(JSON.parse((await cs(["list", "--json"])).stdout).groups ?? {}).flat().map((row) => row.session_id));
      const relative = `${directory.slice(ctx.workspaceDir.length + 1)}/${SEED}`;
      await shell(["open", relative, "--pane", right.id]);
      await page.waitForSelector(`.pane[data-pane-id="${right.id}"] .editor-wrap .cm-content`, { visible: true, timeout: 20_000 });
      await page.click(`.pane[data-pane-id="${right.id}"] .editor-wrap .cm-content`);
      await selectLauncherCommand(page, "New terminal here");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[role="dialog"][aria-label="Command launcher"]', { hidden: true, timeout: 10_000 });
      await attach(seeded, (row) => row.window === windowId && row.pane === right.id && !known.has(row.session_id));
      await clickTerminal(page, owner.query);
      await drainPointerInput(owner.fixture);
      await clearFocus(page);

      await leg("seed-keeps-other-pane", async (result) => {
        result.before = { owner: await readFocus(page, owner.query), seeded: await readFocus(page, seeded.query) };
        assertKeyboard(result.before.owner, "terminal");
        assert.equal(result.before.owner.terminal.paneFocused, true);
        assert.equal(result.before.seeded.terminal.paneFocused, false);
        assert.equal(result.before.seeded.terminal.tabActive, true, "the seeded terminal remains visible in its own pane");
        assert.equal(result.before.seeded.terminal.containsFocus, false);
        assert.equal(pointerInputSince(seeded.fixture, 0), "", "no seed has arrived ahead of the controlled first output");
        const seedIndex = seeded.fixture.records.length, ownerIndex = owner.fixture.records.length;
        await seeded.fixture.send("bytes", { base64: Buffer.from("\x1b[?1004h\x1b[?2004l$ ").toString("base64") });
        await seeded.fixture.waitFor(() => pointerInputSince(seeded.fixture, seedIndex).includes(INPUT));
        await settleFocus(page);
        result.seededReceipt = await drainPointerInput(seeded.fixture, "", seedIndex);
        result.ownerReceipt = await drainPointerInput(owner.fixture, "", ownerIndex);
        result.mode = await seeded.term.evaluate((term) => term.getMode(1004));
        result.after = { owner: await readFocus(page, owner.query), seeded: await readFocus(page, seeded.query) };
        assert.equal(result.mode, true, "the seeded program enables real focus reporting");
        assert.equal(result.seededReceipt.input, INPUT, "the program receives the complete seed once, with no focus reports");
        assert.equal(result.ownerReceipt.input, "", "the owner program receives no focus-out report");
        assertKeyboard(result.after.owner, "terminal");
        assert.deepEqual(result.after.owner.active, result.before.owner.active, "the same element retains the keyboard");
        assert.equal(result.after.seeded.terminal.textareaFocused, false);
        assert.equal(result.after.seeded.terminal.containsFocus, false);
        assert.deepEqual(result.after.seeded.events.filter((event) => event.type === "focusin" && event.target.tab === seeded.row.tab), [],
          "the seed callback never takes the keyboard, even transiently");
      });
      await leg("requested-pane-focus", async (result) => {
        await clickTerminal(page, owner.query);
        await drainPointerInput(owner.fixture);
        await drainPointerInput(seeded.fixture);
        const seedIndex = seeded.fixture.records.length, ownerIndex = owner.fixture.records.length;
        await clickTerminal(page, seeded.query);
        result.seeded = await readFocus(page, seeded.query);
        await clickTerminal(page, owner.query);
        result.owner = await readFocus(page, owner.query);
        result.seededReceipt = await drainPointerInput(seeded.fixture, "", seedIndex);
        result.ownerReceipt = await drainPointerInput(owner.fixture, "", ownerIndex);
        assertKeyboard(result.seeded, "terminal");
        assertKeyboard(result.owner, "terminal");
        assert.equal(result.seededReceipt.input, "\x1b[I\x1b[O", "the seeded program receives the deliberate focus pair");
        assert.equal(result.ownerReceipt.input, "\x1b[O\x1b[I", "the owner program sees the matching handover");
      });
    });
  },
};
