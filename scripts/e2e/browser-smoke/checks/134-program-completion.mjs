import assert from "node:assert/strict";
import { withProgramStatusTabs } from "../lib/program-status.mjs";

export default {
  name: "program status: done and error become seen on focus",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "134", async (tab) => {
      for (const completed of ["done", "error"]) {
        await tab.sendReport(`state=${completed}`);
        await tab.wait(`${completed}-unseen`, (state) =>
          state.mark?.attention === completed && state.programCell === completed &&
          state.row.program_status?.records?.some((record) =>
            record.id === null && record.state === completed && !record.seen) &&
          state.frames.some((frame) => frame.type === "program-status" &&
            frame.id === tab.subjectRow.session_id && frame.program_status?.records?.some(
              (record) => record.id === null && record.state === completed && !record.seen)));
        await tab.focusSubject();
        await tab.wait(`${completed}-seen`, (state) =>
          !["done", "error"].includes(state.mark?.attention) &&
          state.row.program_status?.records?.some((record) =>
            record.id === null && record.state === completed && record.seen));
        if (completed === "done") await tab.focusFront();
      }
      const before = (await tab.read()).marks.length;
      await tab.sendReport("state=done:id=front");
      const seen = await tab.wait("done-in-front", (state) =>
        state.row.program_status?.records?.some((record) =>
          record.id === "front" && record.state === "done" && record.seen));
      assert.ok(seen.marks.slice(before).every((mark) => mark.attention !== "done"),
        "a completion arriving in front never paints an unseen check");
    });
  },
};
