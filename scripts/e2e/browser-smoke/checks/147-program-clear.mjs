import assert from "node:assert/strict";
import { startSubjectSurvey, withProgramStatusTabs } from "../lib/program-status.mjs";

const ids = (status) => status.records.map((record) => `${record.source}:${record.id ?? "root"}`);
const assertSet = (status, expected) => assert.deepEqual(ids(status), expected, "the whole ordered record set");
const ownSurvey = (status) => status.records.filter((record) => record.source === "chan" && /^survey\/[0-9a-f]{16}$/.test(record.id));

function assertSurveyView(state, expected, surveyId) {
  const snapshot = state.row.program_status;
  assertSet(snapshot, expected);
  assert.deepEqual(ownSurvey(snapshot).map(({ id, state, kind, app }) => ({ id, state, kind, app })),
    [{ id: surveyId, state: "blocked", kind: "question", app: "cs" }], "chan's survey stays blocked");
  assert.ok(state.frames.some((frame) => frame.type === "program-status" &&
    frame.id === state.row.session_id && frame.program_status?.revision === snapshot.revision &&
    JSON.stringify(ids(frame.program_status)) === JSON.stringify(expected)), "socket carries the whole ordered set");
  assert.equal(state.mark?.attention, "question", "the strip keeps chan's question mark");
  assert.equal(state.programCell, "blocked/question", "the list cell keeps chan's blocked state");
}

export default {
  name: "program status: clear subtree, clear all and RIS isolate records",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "147", async (tab) => {
      const initial = ["program:root", "program:a", "program:a/b", "program:ab"];
      const survivors = ["program:root", "program:ab"];
      for (const id of [null, "a", "a/b", "ab"]) await tab.sendReport(`state=done${id ? `:id=${id}` : ""}`);
      const seeded = await tab.wait("four-records", (state) => {
        const snapshot = state.row.program_status;
        return snapshot && JSON.stringify(ids(snapshot)) === JSON.stringify(initial) &&
          state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id && frame.program_status &&
            JSON.stringify(ids(frame.program_status)) === JSON.stringify(initial));
      });
      assertSet(seeded.row.program_status, initial);
      await tab.focusSubject();
      await tab.wait("completions-seen", (state) => state.row.program_status?.records?.length === 4 &&
        state.row.program_status.records.every((record) => record.seen));
      await tab.focusFront();
      const surveyPid = await startSubjectSurvey(ctx, tab, "147-clear", "Keep this question");
      let answered = false;
      try {
        const held = await tab.wait("five-records", (state) => ownSurvey(state.row.program_status ?? { records: [] }).length === 1 &&
          state.row.program_status.records.length === 5 && state.mark?.attention === "question" &&
          state.programCell === "blocked/question", 30_000);
        const surveyId = ownSurvey(held.row.program_status)[0].id;
        const withSurvey = (programIds) => [...programIds, `chan:${surveyId}`];
        assertSurveyView(held, withSurvey(initial), surveyId);
        await tab.page.waitForSelector(".survey-overlay .survey-option");

        await tab.sendReport("state=clear:id=a");
        const childClear = await tab.wait("clear-a", (state) => state.row.program_status?.revision > held.row.program_status.revision &&
          state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
            frame.program_status?.revision === state.row.program_status.revision));
        assertSurveyView(childClear, withSurvey(survivors), surveyId);

        await tab.sendReport("state=clear");
        const allClear = await tab.wait("clear-all", (state) => state.row.program_status?.revision > childClear.row.program_status.revision &&
          state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
            frame.program_status?.revision === state.row.program_status.revision));
        assertSurveyView(allClear, withSurvey([]), surveyId);

        await tab.sendReport("state=done:id=ris");
        await tab.wait("before-ris", (state) => state.row.program_status?.records?.some((record) => record.source === "program" && record.id === "ris"));
        await tab.sendRaw("\\033c");
        const reset = await tab.wait("after-ris", (state) => state.row.program_status?.revision > allClear.row.program_status.revision &&
          state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
            frame.program_status?.revision === state.row.program_status.revision) &&
          !state.row.program_status.records.some((record) => record.source === "program" && record.id === "ris"));
        assertSurveyView(reset, withSurvey([]), surveyId);

        await tab.page.click(".survey-overlay .survey-option");
        answered = true;
        const released = await tab.wait("survey-answered", (state) => state.row.program_status?.revision > reset.row.program_status.revision &&
          ownSurvey(state.row.program_status).length === 0 && state.mark?.attention !== "question" && state.programCell === "-", 30_000);
        assertSet(released.row.program_status, []);
        assert.ok(released.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
          frame.program_status?.revision === released.row.program_status.revision && frame.program_status.records.length === 0),
        "socket removes the answered survey");
      } finally {
        if (!answered) {
          try { process.kill(surveyPid, "SIGKILL"); } catch { /* Survey already ended. */ }
        }
      }
    });
  },
};
