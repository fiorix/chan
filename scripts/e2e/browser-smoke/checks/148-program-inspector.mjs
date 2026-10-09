import assert from "node:assert/strict";
import { openProgramInspector, withProgramStatusTabs } from "../lib/program-status.mjs";

export default {
  name: "program status: tooltip and keyboard inspector show decoded fields",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "148", async (tab) => {
      const title = "Release, v1";
      const msg = "Approve + deploy?";
      const report = `state=blocked:id=deploy:kind=question:app=release+cli:title=${Buffer.from(title).toString("base64")}:msg=${Buffer.from(msg).toString("base64")}`;
      await tab.sendReportBel(report);
      const state = await tab.wait("tooltip-fields", (value) =>
        value.mark?.attention === "question" &&
        [tab.subject, "release+cli", title, msg].every((part) => value.mark.attentionTitle?.includes(part)) &&
        value.row.program_status?.records?.some((record) => record.id === "deploy" && record.title === title && record.msg === msg && record.app === "release+cli") &&
        value.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
          frame.program_status?.records?.some((record) => record.id === "deploy" && record.title === title && record.msg === msg)));
      assert.ok(state.mark.tabTitle?.includes(tab.subject), "tab tooltip names the terminal");
      const inspector = await openProgramInspector(tab);
      assert.match(inspector.title, new RegExp(tab.subject));
      assert.ok(inspector.records.some((record) => ["program", "deploy", "blocked", "App: release+cli", `Title: ${title}`, `Message: ${msg}`].every((part) => record.includes(part))), "the inspector lists the record's source, id, state and decoded fields");
      await ctx.shot(`${tab.backend}-program-inspector`, tab.page);
    });
  },
};
