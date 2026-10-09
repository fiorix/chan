import { withProgramStatusTabs } from "../lib/program-status.mjs";

export default {
  name: "program status: working hides output dot",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "131", async (tab) => {
      await tab.sendReport("state=working:id=run");
      await tab.sendOutput("STATUS131_OUTPUT");
      await tab.wait("working", (state) =>
        state.mark?.activity === "spinner" && !state.mark.dot &&
        state.mark.attention === "none" && state.programCell === "working" &&
        state.row.program_status?.records?.some((record) => record.id === "run" && record.state === "working") &&
        state.frames.some((frame) => frame.type === "program-status" &&
          frame.id === tab.subjectRow.session_id && frame.program_status?.records?.some(
            (record) => record.id === "run" && record.state === "working")));
    });
  },
};
