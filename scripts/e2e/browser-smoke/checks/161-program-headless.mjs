import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote, withProgramStatusTabs } from "../lib/program-status.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";

async function detachedReport(ctx, tab, script, label, sessionId) {
  const auditPath = join(ctx.workspaceDir, `status-161-${tab.backend}-${label}.json`);
  const logPath = join(ctx.workspaceDir, `status-161-${tab.backend}-${label}.log`);
  const log = openSync(logPath, "w");
  const child = spawn("setsid", ["python3", script, ctx.chanBin, auditPath], {
    cwd: ctx.workspaceDir,
    env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_SESSION_ID: sessionId },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exit, 0, `detached audit script exited ${exit}: ${readFileSync(logPath, "utf8")}`);
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));
  assert.deepEqual(audit.descriptors, [false, false, false], "detached reporter has no terminal on fd 0, 1 or 2");
  assert.equal(audit.controllingTty, false, "detached reporter cannot open /dev/tty");
  assert.equal(audit.sessionLeader, true, "detached reporter owns a new session");
  return audit;
}

export default {
  name: "program status: a detached reporter uses its terminal session identity",
  async run(ctx) {
    const script = join(ctx.workspaceDir, "status-161-detached.py");
    writeFileSync(script, String.raw`import json
import os
from pathlib import Path
import subprocess
import sys

chan, audit_path = sys.argv[1:]
audit = {
    "descriptors": [os.isatty(fd) for fd in (0, 1, 2)],
    "sessionLeader": os.getsid(0) == os.getpid(),
}
try:
    fd = os.open("/dev/tty", os.O_RDWR)
except OSError:
    audit["controllingTty"] = False
else:
    audit["controllingTty"] = True
    os.close(fd)
result = subprocess.run(
    [chan, "shell", "terminal", "status", "working", "--id", "headless", "--title", "Detached reporter"],
    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, timeout=30,
)
audit.update({"statusExit": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
Path(audit_path).write_text(json.dumps(audit))
`);
    await withProgramStatusTabs(ctx, "161", async (tab) => {
      const envPath = join(ctx.workspaceDir, `status-161-${tab.backend}-session-id`);
      await tab.cs(["write", "--tab-name", tab.subject,
        `printf '%s\\n' "$CHAN_SESSION_ID" > ${shellQuote(envPath)}\n`]);
      const inheritedId = (await ctx.pollFile(envPath, 15_000)).toString().trim();
      assert.equal(inheritedId, tab.subjectRow.session_id, "subject terminal supplies its own session id");

      const accepted = await detachedReport(ctx, tab, script, "live", inheritedId);
      assert.equal(accepted.statusExit, 0, `live detached report accepted: ${accepted.stderr}`);
      const reported = await tab.wait("headless-report", (state) =>
        state.row.program_status?.records?.some((record) =>
          record.source === "program" && record.id === "headless" && record.state === "working" &&
          record.title === "Detached reporter") &&
        state.mark?.activity === "spinner" && state.programCell === "working", 30_000);
      const snapshot = reported.row.program_status;
      await ctx.shot(`${tab.backend}-headless-status-persists`, tab.page);

      const deadName = `Status161${tab.backend}D`;
      const dead = await openAttachedTerminal(ctx, tab.page, tab.cs, tab.windowId, deadName, tab.backend);
      assert.ok(dead.session_id, "closed-session probe has a real attached session id");
      await tab.cs(["close", "--tab-name", deadName]);
      const afterClose = Object.values(JSON.parse((await tab.cs(["list", "--json"])).stdout).groups ?? {}).flat();
      assert.ok(!afterClose.some((row) => row.session_id === dead.session_id), "closed session is absent before the rejected report");
      await tab.focusFront();

      const rejected = await detachedReport(ctx, tab, script, "closed", dead.session_id);
      assert.notEqual(rejected.statusExit, 0, "closed session id is refused");
      assert.match(rejected.stderr, /no live terminal session for program status/, "refusal names the dead session");
      const after = await tab.read();
      assert.deepEqual(after.row.program_status, snapshot, "dead-session refusal leaves the whole subject status unchanged");
      assert.equal(after.mark?.activity, "spinner", "subject spinner survives the refused detached request");
      await tab.sendReport("state=clear:id=headless");
      await tab.wait("headless-cleared", (state) =>
        !state.row.program_status?.records?.some((record) => record.id === "headless"), 30_000);
    });
  },
};
