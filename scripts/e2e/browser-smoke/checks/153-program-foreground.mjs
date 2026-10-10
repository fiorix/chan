import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withProgramStatusTabs } from "../lib/program-status.mjs";

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ids = (state) => state.row.program_status?.records?.map((record) => record.id) ?? [];

async function waitProcessState(ctx, pid, expected) {
  const deadline = Date.now() + 15_000;
  do {
    try {
      const { stdout } = await ctx.exec("ps", ["-o", "stat=", "-p", String(pid)]);
      if (stdout.trim().startsWith(expected)) return;
    } catch { /* A process that exited is checked by the status assertion. */ }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`process ${pid} did not enter state ${expected}`);
}

async function startJob(ctx, tab, script, label, mode = "full") {
  const infoPath = join(ctx.workspaceDir, `status-153-${tab.backend}-${label}.json`);
  const command = `python3 ${shellQuote(script)} ${shellQuote(label)} ${shellQuote(infoPath)} ${shellQuote(mode)}; printf 'REAPED_<${label}>\\n'`;
  await tab.cs(["write", "--tab-name", tab.subject, `${command}\n`]);
  await ctx.pollFile(infoPath, 20_000);
  const info = JSON.parse(await readFile(infoPath, "utf8"));
  const runnerGroup = Number((await ctx.exec("ps", ["-o", "pgid=", "-p", String(process.pid)])).stdout.trim());
  assert.ok(Number.isSafeInteger(info.pgid) && info.pgid > 1 && info.pgid !== runnerGroup,
    `foreground job ${label} has its own killable process group`);
  await tab.wait(`${label}-reported`, (state) =>
    ids(state).includes(`${label}/working`) &&
    (mode === "working" || (ids(state).includes(`${label}/blocked`) && ids(state).includes(`${label}/done`))), 30_000);
  return info;
}

async function clearJob(tab, label) {
  await tab.sendReport(`state=clear:id=${label}`);
  await tab.wait(`${label}-cleared`, (state) => !ids(state).some((id) => id?.startsWith(`${label}/`)), 30_000);
}

export default {
  name: "program status: foreground job lifetime clears transient reports",
  async run(ctx) {
    const script = join(ctx.workspaceDir, "status-153-job.py");
    await writeFile(script, String.raw`import json
import os
from pathlib import Path
import sys

label, path, mode = sys.argv[1:]
Path(path).write_text(json.dumps({"pid": os.getpid(), "pgid": os.getpgrp()}))
states = ["working"] if mode == "working" else ["working", "blocked", "idle", "done"]
for state in states:
    payload = f"state={state}:id={label}/{state}"
    if state == "blocked":
        payload += ":kind=question"
    sys.stdout.buffer.write(b"\x1b]7501;" + payload.encode() + b"\x07")
sys.stdout.buffer.write(f"READY_<{label}>\n".encode())
sys.stdout.buffer.flush()
sys.stdin.readline()
`);
    await withProgramStatusTabs(ctx, "153", async (tab) => {
      const first = await startJob(ctx, tab, script, "kill");
      const held = await tab.read();
      assert.equal(held.mark.activity, "spinner", "working paints while the job owns the foreground");
      assert.equal(held.mark.attention, "question", "blocked paints alongside working");
      process.kill(-first.pgid, "SIGKILL");
      await tab.wait("kill-cleanup", (state) =>
        !ids(state).some((id) => id?.startsWith("kill/") && id !== "kill/done") &&
        ids(state).includes("kill/done") && state.mark?.activity === "icon" && state.mark?.attention === "done", 30_000);
      await ctx.shot(`${tab.backend}-kill-cleared-working-blocked-kept-done`, tab.page);
      await clearJob(tab, "kill");

      await startJob(ctx, tab, script, "interrupt");
      await tab.cs(["write", "--tab-name", tab.subject, "\x03"]);
      await tab.wait("interrupt-cleanup", (state) =>
        !ids(state).some((id) => id?.startsWith("interrupt/") && id !== "interrupt/done") &&
        ids(state).includes("interrupt/done") && state.mark?.activity === "icon", 30_000);
      await clearJob(tab, "interrupt");

      await startJob(ctx, tab, script, "silent");
      await tab.cs(["write", "--tab-name", tab.subject, "go\n"]);
      await tab.wait("silent-cleanup", (state) =>
        !ids(state).some((id) => id?.startsWith("silent/") && id !== "silent/done") &&
        ids(state).includes("silent/done") && state.mark?.activity === "icon", 30_000);
      await clearJob(tab, "silent");

      const stopped = await startJob(ctx, tab, script, "stopped", "working");
      await tab.cs(["write", "--tab-name", tab.subject, "\x1a"]);
      await waitProcessState(ctx, stopped.pid, "T");
      const next = await startJob(ctx, tab, script, "next", "working");
      const both = await tab.read();
      assert.deepEqual(ids(both), ["stopped/working", "next/working"], "a stopped job keeps its spinner beside the next job");
      process.kill(-stopped.pgid, "SIGKILL");
      await tab.wait("second-survives-first-end", (state) =>
        !ids(state).includes("stopped/working") && ids(state).includes("next/working") &&
        state.mark?.activity === "spinner", 30_000);
      process.kill(-next.pgid, "SIGKILL");
      await tab.wait("second-cleanup", (state) => !ids(state).includes("next/working"), 30_000);
      await ctx.shot(`${tab.backend}-stopped-and-sequential-jobs`, tab.page);

      const release = join(ctx.workspaceDir, `status-153-${tab.backend}-background.fifo`);
      await ctx.exec("mkfifo", [release]);
      const reporter = `python3 -c 'import os,sys; f=open(sys.argv[1]); f.readline(); os.write(1,b"\\x1b]7501;state=working:id=background\\x07")' ${shellQuote(release)} & printf 'BG_WAITING\\n'`;
      await tab.cs(["write", "--tab-name", tab.subject, `${reporter}\n`]);
      const foreground = await startJob(ctx, tab, script, "foreground", "working");
      await writeFile(release, "go\n");
      await tab.wait("background-under-foreground", (state) =>
        ids(state).includes("foreground/working") && ids(state).includes("background"), 30_000);
      process.kill(-foreground.pgid, "SIGKILL");
      await tab.wait("background-inherits-foreground-limit", (state) =>
        !ids(state).includes("foreground/working") && !ids(state).includes("background") &&
        state.mark?.activity === "icon", 30_000);
      await ctx.shot(`${tab.backend}-background-limit`, tab.page);
    }, { subjectArgs: ["--command", "exec bash --noprofile --norc -i", "--env", "PS1=STATUS_PROMPT>", "--env", "PROMPT_COMMAND="] });
  },
};
