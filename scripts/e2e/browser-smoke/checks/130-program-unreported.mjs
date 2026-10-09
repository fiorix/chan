import { withProgramStatusTabs } from "../lib/program-status.mjs";

export default {
  name: "program status: unreported output keeps the ordinary dot",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "130", async (tab) => {
      await tab.sendOutput("STATUS130_OUTPUT");
      await tab.wait("unreported-output", (state) =>
        state.mark?.activity === "icon" && state.mark.attention === "output" && state.mark.dot &&
        state.programCell === "-" && state.row.program_status?.records?.length === 0 &&
        state.frames.some((frame) => frame.type === "session" &&
          frame.id === tab.subjectRow.session_id && frame.program_status?.records?.length === 0));
    });
  },
};
