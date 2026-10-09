import { withProgramStatusTabs, ringProgress } from "../lib/program-status.mjs";

export default {
  name: "program status: root progress draws the ring at 40",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "132", async (tab) => {
      await tab.sendReport("state=working:progress=40");
      await tab.wait("progress-40", (state) =>
        ringProgress(state.mark) === 40 && state.programCell === "working 40%" &&
        state.row.program_status?.records?.some((record) => record.id === null && record.progress === 40) &&
        state.frames.some((frame) => frame.type === "program-status" &&
          frame.id === tab.subjectRow.session_id && frame.program_status?.records?.some(
            (record) => record.id === null && record.progress === 40)));
    });
  },
};
