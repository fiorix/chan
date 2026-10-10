import assert from "node:assert/strict";
import { openProgramInspector, withProgramStatusTabs } from "../lib/program-status.mjs";

const hostileTitle = 'Title <img src=x onerror="window.__status157Title=1"> right\u202eto\u200bleft';
const hostileMessage = 'Message <img src=x onerror="window.__status157Message=1"> right\u202eto\u200bleft';
const visible = (value) => value.replaceAll("\u202e", "□").replaceAll("\u200b", "□");

export default {
  name: "program status: hostile title and message render as disarmed text",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "157", async (tab) => {
      await tab.sendReportBel(`state=blocked:id=hostile:kind=question:title=${Buffer.from(hostileTitle).toString("base64")}:msg=${Buffer.from(hostileMessage).toString("base64")}`);
      const state = await tab.wait("hostile-tooltip", (value) =>
        value.mark?.attention === "question" &&
        value.row.program_status?.records?.some((record) => record.id === "hostile" && record.title === hostileTitle && record.msg === hostileMessage) &&
        value.mark.attentionTitle?.includes(visible(hostileTitle)) &&
        value.mark.attentionTitle?.includes(visible(hostileMessage)));
      assert.ok(!state.mark.attentionTitle.includes("\u202e") && !state.mark.attentionTitle.includes("\u200b"), "title and message formatting code points are disarmed in the tooltip");
      assert.equal(state.programCell, "blocked/question", "free text never enters the list table's program cell");
      const table = (await tab.cs(["list"])).stdout;
      assert.ok(!table.includes(hostileTitle) && !table.includes(hostileMessage) && !table.includes("<img"), "free text never enters any list table cell");
      const inspector = await openProgramInspector(tab);
      const record = inspector.records.find((entry) => entry.includes("hostile"));
      assert.ok(record?.includes(`Title: ${visible(hostileTitle)}`), "inspector disarms the title");
      assert.ok(record?.includes(`Message: ${visible(hostileMessage)}`), "inspector disarms the message");
      const dom = await tab.page.evaluate(() => {
        const inspector = document.querySelector(".program-inspector");
        return {
          title: inspector?.textContent ?? "",
          injected: inspector?.querySelector("img, script, [onerror]") !== null,
          ranTitle: window.__status157Title === 1,
          ranMessage: window.__status157Message === 1,
        };
      });
      assert.equal(dom.injected, false, "hostile HTML creates no inspector element");
      assert.equal(dom.ranTitle, false, "title HTML handler never runs");
      assert.equal(dom.ranMessage, false, "message HTML handler never runs");
      assert.ok(!dom.title.includes("\u202e") && !dom.title.includes("\u200b"), "inspector contains no bidi override or zero-width code point");
      await ctx.shot(`${tab.backend}-hostile-program-text`, tab.page);
    });
  },
};
