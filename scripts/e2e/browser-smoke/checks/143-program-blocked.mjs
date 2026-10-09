import assert from "node:assert/strict";
import { withProgramStatusTabs } from "../lib/program-status.mjs";

export default {
  name: "program status: every blocked kind has its own shape",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "143", async (tab) => {
      const shapes = new Set();
      for (const kind of ["permission", "question", "auth", null]) {
        await tab.sendReport(`state=blocked${kind ? `:kind=${kind}` : ""}`);
        const state = await tab.wait(`blocked-${kind ?? "other"}`, (value) =>
          value.mark?.attention === (kind ?? "other") && Boolean(value.mark.shape) &&
          value.mark.attentionLabel?.includes("blocked") &&
          value.programCell === (kind ? `blocked/${kind}` : "blocked") &&
          value.row.program_status?.records?.some((record) =>
            record.id === null && record.state === "blocked" && record.kind === kind) &&
          value.frames.some((frame) => frame.type === "program-status" &&
            frame.id === tab.subjectRow.session_id && frame.program_status?.records?.some(
              (record) => record.id === null && record.state === "blocked" && record.kind === kind)));
        shapes.add(state.mark.shape);
      }
      assert.equal(shapes.size, 4, "permission, question, auth and plain blocked use distinct shapes");
    });
  },
};
