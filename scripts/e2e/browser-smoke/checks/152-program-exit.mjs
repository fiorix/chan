import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withProgramStatusTabs } from "../lib/program-status.mjs";

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export default {
  name: "program status: a session's final done survives its process exit",
  async run(ctx) {
    const script = join(ctx.workspaceDir, "status-152-exit.py");
    await writeFile(script, String.raw`import os
from pathlib import Path
import sys

release = Path(__file__).with_name(os.environ["CHAN_TAB_NAME"] + ".fifo")
with release.open() as signal:
    if signal.readline() != "go\n":
        sys.exit(2)
sys.stdout.buffer.write(b"\x1b]7501;state=done:id=finished\x07")
sys.stdout.buffer.flush()
`);
    for (const backend of ["xterm", "ghostty"]) {
      await ctx.exec("mkfifo", [join(ctx.workspaceDir, `Status152${backend}S.fifo`)]);
    }
    await withProgramStatusTabs(ctx, "152", async (tab) => {
      assert.equal((await tab.read()).mark?.active, false, "the subject is behind the front tab before release");
      await writeFile(join(ctx.workspaceDir, `${tab.subject}.fifo`), "go\n");
      try {
        await tab.page.waitForFunction((name, id) => {
          const trace = window.__programStatusTrace;
          trace.subject = name;
          const mark = trace.readMark();
          return mark?.attention === "done" && mark.shapeClass?.includes("lucide-circle-check") &&
            mark.active === false &&
            trace.frames.some((frame) => frame.type === "exit" && frame.session_id === id) &&
            trace.frames.some((frame) => frame.type === "program-status" && frame.id === id &&
              frame.program_status?.records?.some((record) => record.id === "finished" && record.state === "done" && !record.seen));
        }, { timeout: 30_000, polling: 100 }, tab.subject, tab.subjectRow.session_id);
      } catch (error) {
        const observed = await tab.page.evaluate((name, terminalTabId) => {
          const trace = window.__programStatusTrace;
          trace.subject = name;
          return {
            mark: trace.readMark(),
            frames: trace.frames.filter((frame) => frame.type === "exit" || frame.type === "program-status"),
          };
        }, tab.subject);
        throw new Error(`${tab.backend} final status and exit did not coexist: ${JSON.stringify(observed)}`, { cause: error });
      }
      const mark = await tab.page.evaluate((name) => {
        window.__programStatusTrace.subject = name;
        return window.__programStatusTrace.readMark();
      }, tab.subject);
      assert.equal(mark.attention, "done", "the terminal tab retains the unseen check after process exit");
      await ctx.shot(`${tab.backend}-done-after-process-exit`, tab.page);
      await tab.focusSubject();
      await ctx.shot(`${tab.backend}-process-exited-message`, tab.page);
    }, { subjectArgs: ["--command", `python3 ${shellQuote(script)}`] });
  },
};
