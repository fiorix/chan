import assert from "node:assert/strict";
import { withProgramStatusTabs } from "../lib/program-status.mjs";

const ids = (status) => status.records.map((record) => `${record.source}:${record.id ?? "root"}`);
const assertSet = (status, expected) => assert.deepEqual(ids(status), expected, "the whole ordered record set");

export default {
  name: "program status: clear subtree, clear all and RIS isolate records",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "147", async (tab) => {
      const initial = ["program:root", "program:a", "program:a/b", "program:ab"];
      const survivors = ["program:root", "program:ab"];
      for (const id of [null, "a", "a/b", "ab"]) await tab.sendReport(`state=done${id ? `:id=${id}` : ""}`);
      const seeded = await tab.wait("four-records", (state) => {
        const snapshot = state.row.program_status;
        return snapshot && JSON.stringify(ids(snapshot)) === JSON.stringify(initial) &&
          state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id && frame.program_status &&
            JSON.stringify(ids(frame.program_status)) === JSON.stringify(initial));
      });
      assertSet(seeded.row.program_status, initial);
      await tab.sendReport("state=clear:id=a");
      const childClear = await tab.wait("clear-a", (state) => {
        const snapshot = state.row.program_status;
        return snapshot && snapshot.revision > seeded.row.program_status.revision &&
          JSON.stringify(ids(snapshot)) === JSON.stringify(survivors) &&
          state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
            frame.program_status?.revision === snapshot.revision && JSON.stringify(ids(frame.program_status)) === JSON.stringify(survivors));
      });
      assertSet(childClear.row.program_status, survivors);
      await tab.sendReport("state=clear");
      const allClear = await tab.wait("clear-all", (state) => {
        const snapshot = state.row.program_status;
        return snapshot && snapshot.revision > childClear.row.program_status.revision && snapshot.records.length === 0 &&
          state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
            frame.program_status?.revision === snapshot.revision && frame.program_status.records.length === 0);
      });
      assertSet(allClear.row.program_status, []);
      await tab.sendReport("state=done:id=ris");
      await tab.wait("before-ris", (state) => state.row.program_status?.records?.some((record) => record.id === "ris"));
      await tab.sendRaw("\\033c");
      const reset = await tab.wait("after-ris", (state) => {
        const snapshot = state.row.program_status;
        return snapshot && snapshot.revision > allClear.row.program_status.revision && snapshot.records.length === 0 &&
          state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
            frame.program_status?.revision === snapshot.revision && frame.program_status.records.length === 0);
      });
      assertSet(reset.row.program_status, []);
      // The chan-owned companion record is stage 5's scenario leg; keep it planned in the pack.
    });
  },
};
