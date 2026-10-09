import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPtyPython, withProgramStatusTabs } from "../lib/program-status.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const records = (state) => state.row.program_status?.records ?? [];
const statusFrames = (state, id) => state.frames.filter((frame) => frame.type === "program-status" && frame.id === id);
const partialProgram = String.raw`
import os
import pathlib
import sys
import time

output = pathlib.Path(sys.argv[1])
os.write(sys.stdout.fileno(), b"\x1b]7501;state=working:id=partial")
pathlib.Path(str(output) + ".ready").write_text("sent\n")
time.sleep(1.2)
release = pathlib.Path(str(output) + ".release")
deadline = time.monotonic() + 15
while not release.exists():
    if time.monotonic() >= deadline:
        raise RuntimeError("partial report was not released")
    time.sleep(0.01)
os.write(sys.stdout.fileno(), b"\x1b\\")
output.write_text("complete\n")
`;

export default {
  name: "program status: incomplete, aborted and ESC-ended reports obey framing",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "158", async (tab) => {
      const before = await tab.read();
      const output = join(ctx.workspaceDir, `status-framing-${tab.backend}.bin`);
      const program = runPtyPython(ctx, tab, "framing", partialProgram);
      void program.catch(() => {});
      try {
        await ctx.pollFile(`${output}.ready`, 10_000);
        await sleep(1_000);
        const incomplete = await tab.read();
        assert.deepEqual(incomplete.row.program_status, before.row.program_status, "an unterminated report leaves the complete set and revision unchanged for one second");
        assert.equal(statusFrames(incomplete, tab.subjectRow.session_id).length,
          statusFrames(before, tab.subjectRow.session_id).length, "an unterminated report emits no status frame");
      } finally {
        writeFileSync(`${output}.release`, "continue\n");
        await program;
      }
      const completed = await tab.wait("partial-completed", (state) =>
        records(state).some((record) => record.id === "partial" && record.state === "working") &&
        statusFrames(state, tab.subjectRow.session_id).some((frame) =>
          frame.program_status?.records?.some((record) => record.id === "partial" && record.state === "working")));
      assert.ok(completed.row.program_status.revision > (before.row.program_status?.revision ?? -1));

      await tab.sendRaw("\\033]7501;state=blocked:id=aborted\\030");
      await tab.sendReport("state=done:id=after-can");
      const afterCan = await tab.wait("after-can", (state) =>
        records(state).some((record) => record.id === "after-can" && record.state === "done"));
      assert.ok(!records(afterCan).some((record) => record.id === "aborted"), "CAN discards the current report without swallowing the next");

      await tab.sendRaw("\\033]7501;state=done:id=esc\\033[0m");
      const afterEsc = await tab.wait("esc-sequence", (state) =>
        records(state).some((record) => record.id === "esc" && record.state === "done"));
      assert.ok(afterEsc.row.program_status.revision > afterCan.row.program_status.revision, "ESC before harmless CSI applies the report");

      await tab.sendRaw("\\033]7501;state=done:id=reset\\033c");
      const reset = await tab.wait("esc-reset", (state) =>
        state.row.program_status?.revision > afterEsc.row.program_status.revision && records(state).length === 0 &&
        statusFrames(state, tab.subjectRow.session_id).some((frame) =>
          frame.program_status?.revision === state.row.program_status.revision && frame.program_status.records.length === 0));
      assert.deepEqual(reset.row.program_status.records, [], "ESC c leaves no program record");
    });
  },
};
