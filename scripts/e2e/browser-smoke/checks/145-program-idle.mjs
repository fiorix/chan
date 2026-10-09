import { withProgramStatusTabs } from "../lib/program-status.mjs";

export default {
  name: "program status: idle carries no program mark",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "145", async (tab) => {
      await tab.sendReport("state=idle");
      await tab.wait("idle", (state) =>
        state.mark?.activity === "icon" && ["none", "output"].includes(state.mark.attention) &&
        state.programCell === "idle" &&
        state.row.program_status?.records?.some((record) => record.id === null && record.state === "idle") &&
        state.frames.some((frame) => frame.type === "program-status" &&
          frame.id === tab.subjectRow.session_id && frame.program_status?.records?.some(
            (record) => record.id === null && record.state === "idle")));
    });
  },
};
