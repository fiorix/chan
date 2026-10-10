import assert from "node:assert/strict";
import { assertTerminalPrefs, readTerminalPrefs } from "../lib/terminal-prefs.mjs";
import { runPtyPython, withProgramStatusTabs } from "../lib/program-status.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const help = "Show what programs report through OSC 7501 and mark chan's own waits.";

const noReplyProbe = [
  "import os",
  "import pathlib",
  "import select",
  "import sys",
  "import termios",
  "import time",
  "import tty",
  "",
  "fd = sys.stdin.fileno()",
  "saved = termios.tcgetattr(fd)",
  "data = bytearray()",
  "try:",
  "    tty.setraw(fd)",
  "    os.write(1, b\"\\x1b]7501;?\\x07\")",
  "    deadline = time.monotonic() + 2",
  "    while True:",
  "        remaining = deadline - time.monotonic()",
  "        if remaining <= 0:",
  "            break",
  "        ready, _, _ = select.select([fd], [], [], remaining)",
  "        if not ready:",
  "            break",
  "        chunk = os.read(fd, 4096)",
  "        if not chunk:",
  "            break",
  "        data.extend(chunk)",
  "finally:",
  "    termios.tcsetattr(fd, termios.TCSANOW, saved)",
  "pathlib.Path(sys.argv[1]).write_text(data.hex() or '-')",
].join("\n");

async function toggleInSettings(ctx, tab, enabled) {
  const page = tab.page;
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  await page.keyboard.down("Control");
  await page.keyboard.press("Comma");
  await page.keyboard.up("Control");
  await page.waitForSelector('[aria-label="Settings sections"]', { visible: true, timeout: 15_000 });
  try {
    await page.evaluate(() => {
      const rail = document.querySelector('[aria-label="Settings sections"]');
      const button = [...(rail?.querySelectorAll("button") ?? [])].find((node) => node.textContent?.trim() === "Terminal");
      if (!button) throw new Error("Settings has no Terminal section");
      button.click();
    });
    await page.waitForFunction((next, expectedHelp) => {
      const heading = [...document.querySelectorAll("h3")].find((node) => node.textContent?.trim() === "Program status");
      const field = heading?.closest("section.field");
      const toggle = field?.querySelector('label.pill input[type="checkbox"]');
      return toggle?.checked === !next &&
        field?.querySelector("label.pill")?.textContent?.trim() === "Program status (OSC 7501)" &&
        field?.querySelector(".hint")?.textContent?.trim() === expectedHelp;
    }, { timeout: 15_000 }, enabled, help);
    const patch = page.waitForResponse((response) => {
      if (response.request().method() !== "PATCH" || new URL(response.url()).pathname !== "/api/config") return false;
      const body = JSON.parse(response.request().postData() ?? "{}");
      return body.preferences?.terminal?.program_status === enabled && response.ok();
    }, { timeout: 20_000 });
    const refreshed = page.waitForResponse(async (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/api/workspace" &&
      response.ok() && (await response.json()).preferences?.terminal?.program_status === enabled,
    { timeout: 20_000 });
    refreshed.catch(() => {});
    await page.evaluate(() => {
      const heading = [...document.querySelectorAll("h3")].find((node) => node.textContent?.trim() === "Program status");
      const toggle = heading?.closest("section.field")?.querySelector('label.pill input[type="checkbox"]');
      if (!toggle) throw new Error("Program status toggle missing");
      toggle.click();
    });
    await patch;
    await refreshed;
    await page.waitForFunction((next) => {
      const heading = [...document.querySelectorAll("h3")].find((node) => node.textContent?.trim() === "Program status");
      const field = heading?.closest("section.field");
      return field?.querySelector('label.pill input[type="checkbox"]')?.checked === next && !field?.querySelector(".save-error");
    }, { timeout: 20_000 }, enabled);
    assert.equal((await readTerminalPrefs(page, token)).program_status, enabled, "settings round trip returns the switch value");
    await assertTerminalPrefs(ctx, { program_status: enabled });
    await ctx.shot(tab.backend + (enabled ? "-settings-on" : "-settings-off"), page);
  } finally {
    if (await page.$('[aria-label="Settings sections"]')) {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[aria-label="Settings sections"]'), { timeout: 10_000 });
    }
  }
}

async function outputBarrier(tab) {
  const marker = "STATUS162_OFF_BARRIER";
  await tab.sendOutput(marker);
  const deadline = Date.now() + 15_000;
  do {
    if ((await tab.cs(["scrollback", "--tab-name", tab.subject])).stdout.includes(marker)) return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error("off-state PTY output barrier absent");
}

export default {
  name: "program status: settings switch gates reports, control and query",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "162", async (tab) => {
      const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
      try {
        assert.equal((await readTerminalPrefs(tab.page, token)).program_status, true, "feature starts enabled");
        await tab.sendReport("state=working:id=before");
        const before = await tab.wait("enabled-report", (state) =>
          state.mark?.activity === "spinner" && state.programCell === "working" &&
          state.row.program_status?.records?.some((record) => record.source === "program" && record.id === "before" && record.state === "working"), 30_000);

        await toggleInSettings(ctx, tab, false);
        const off = await tab.wait("disabled-clears", (state) =>
          state.mark?.activity === "icon" && ["none", "output"].includes(state.mark?.attention) &&
          state.programCell === "-" && state.row.program_status?.records?.length === 0 &&
          state.frames.slice(before.frames.length).some((frame) =>
            frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
            frame.program_status?.records?.length === 0), 30_000);

        await tab.sendReport("state=blocked:id=late:kind=question");
        await outputBarrier(tab);
        const ignored = await tab.read();
        assert.deepEqual(ignored.row.program_status, off.row.program_status, "off-state report leaves records and revision unchanged");
        assert.equal(ignored.programCell, "-", "off-state report leaves the program list cell empty");
        assert.equal(ignored.mark?.activity, "icon", "off-state report leaves the leading terminal icon");
        assert.equal(ignored.mark?.attention, "output", "off-state PTY output leaves only the ordinary unread-output dot");
        await ctx.shot(tab.backend + "-off-report-ignored", tab.page);

        let refused = null;
        try {
          await ctx.exec(ctx.chanBin, ["shell", "terminal", "status", "working", "--id", "control-off"], {
            cwd: ctx.workspaceDir,
            env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_SESSION_ID: tab.subjectRow.session_id },
            timeout: 15_000,
          });
        } catch (error) {
          refused = error;
        }
        assert.ok(refused, "off-state control status is refused nonzero");
        assert.match(String(refused.stderr ?? ""), /program status is disabled by configuration/, "control refusal uses the fixed text");

        const reply = await runPtyPython(ctx, tab, "off-query", noReplyProbe);
        assert.equal(reply.toString(), "-", "off-state query gets no answer within the probe's two-second bound");

        await toggleInSettings(ctx, tab, true);
        await tab.sendReport("state=blocked:id=after:kind=question");
        await tab.wait("enabled-again", (state) =>
          state.mark?.attention === "question" && state.programCell === "blocked/question" &&
          state.row.program_status?.records?.some((record) =>
            record.source === "program" && record.id === "after" && record.state === "blocked" && record.kind === "question"), 30_000);
      } finally {
        if ((await readTerminalPrefs(tab.page, token)).program_status === false) {
          await toggleInSettings(ctx, tab, true);
        }
      }
    });
  },
};
