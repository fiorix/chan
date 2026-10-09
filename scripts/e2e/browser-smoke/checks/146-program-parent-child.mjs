import assert from "node:assert/strict";
import { openProgramInspector, withProgramStatusTabs } from "../lib/program-status.mjs";

export default {
  name: "program status: working parent and blocked child coexist",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "146", async (tab) => {
      await tab.sendReport("state=working:app=deploy");
      await tab.sendReport("state=blocked:id=a:kind=question:title=Q2hpbGQ=");
      const state = await tab.wait("parent-and-child", (value) => {
        const records = value.row.program_status?.records ?? [];
        return value.mark?.activity === "spinner" && value.mark.attention === "question" &&
          value.mark.attentionTitle?.includes("deploy") &&
          records.some((record) => record.source === "program" && record.id === null && record.state === "working" && record.app === "deploy") &&
          records.some((record) => record.source === "program" && record.id === "a" && record.state === "blocked" && record.kind === "question" && record.app === null) &&
          value.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
            frame.program_status?.records?.some((record) => record.id === null && record.state === "working") &&
            frame.program_status.records.some((record) => record.id === "a" && record.state === "blocked"));
      });
      assert.match(state.mark.attentionTitle, new RegExp(tab.subject));
      const inspector = await openProgramInspector(tab);
      assert.match(inspector.title, new RegExp(tab.subject));
      assert.ok(inspector.records.some((record) => record.includes("a") && record.includes("App: deploy") && record.includes("blocked")), "child inspector row inherits the parent's app");
      await ctx.shot(`${tab.backend}-parent-child-inspector`, tab.page);
    });
  },
};
