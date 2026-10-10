import assert from "node:assert/strict";
import { openProgramInspector, startSubjectSurvey, withProgramStatusTabs } from "../lib/program-status.mjs";

const hostileTitle = 'Title <img src=x onerror="window.__status157Title=1"> right\u202eto\u200bleft';
const hostileMessage = 'Message <img src=x onerror="window.__status157Message=1"> right\u202eto\u200bleft';
const hostileSurvey = 'Survey <img src=x onerror="window.__status157Survey=1"> right\u202eto\u200bleft';
const visible = (value) => value.replaceAll("\u202e", "□").replaceAll("\u200b", "□");

export default {
  name: "program status: hostile program and survey text render as disarmed text",
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

      await tab.focusFront();
      const surveyPid = await startSubjectSurvey(ctx, tab, "157-survey", hostileSurvey);
      let answered = false;
      try {
        const held = await tab.wait("hostile-survey-title", (value) =>
          value.row.program_status?.records?.some((record) => record.source === "chan" &&
            /^survey\/[0-9a-f]{16}$/.test(record.id) && record.title === hostileSurvey) &&
          value.mark?.attention === "question" &&
          value.mark.attentionTitle?.includes(visible(hostileSurvey)), 30_000);
        assert.ok(!held.mark.attentionTitle.includes("\u202e") && !held.mark.attentionTitle.includes("\u200b"), "survey title formatting code points are disarmed in the tooltip");
        assert.equal(held.programCell, "blocked/question", "survey free text never enters the list table's program cell");
        const surveyTable = (await tab.cs(["list"])).stdout;
        assert.ok(!surveyTable.includes(hostileSurvey) && !surveyTable.includes("<img"), "survey title never enters a list table cell");
        await tab.page.waitForSelector(".survey-overlay .survey-title");
        const overlay = await tab.page.$eval(".survey-overlay", (node) => ({
          title: node.querySelector(".survey-title")?.textContent ?? "",
          injected: node.querySelector("img, script, [onerror]") !== null,
          ran: window.__status157Survey === 1,
        }));
        assert.equal(overlay.title, hostileSurvey, "survey overlay carries the title as text");
        assert.equal(overlay.injected, false, "survey title creates no overlay element");
        assert.equal(overlay.ran, false, "survey title handler never runs");
        await tab.focusSubject();
        const surveyInspector = await tab.page.$eval(".program-inspector", (node) => ({
          record: [...node.querySelectorAll(".program-record")].find((entry) => entry.textContent?.includes("survey/"))?.textContent ?? "",
          injected: node.querySelector("img, script, [onerror]") !== null,
          ran: window.__status157Survey === 1,
        }));
        assert.ok(surveyInspector.record.includes(`Title: ${visible(hostileSurvey)}`), "inspector disarms the survey title");
        assert.ok(!surveyInspector.record.includes("\u202e") && !surveyInspector.record.includes("\u200b"), "inspector contains no survey formatting code point");
        assert.equal(surveyInspector.injected, false, "survey title creates no inspector element");
        assert.equal(surveyInspector.ran, false, "survey title handler never runs");
        await ctx.shot(`${tab.backend}-hostile-survey-title`, tab.page);
        await tab.focusFront();
        await tab.page.click(".survey-overlay .survey-option");
        answered = true;
        await tab.wait("hostile-survey-cleared", (value) =>
          !value.row.program_status?.records?.some((record) => record.source === "chan" && record.id?.startsWith("survey/")), 30_000);
      } finally {
        if (!answered) {
          try { process.kill(surveyPid, "SIGKILL"); } catch { /* Survey already ended. */ }
        }
      }
    });
  },
};
