import assert from "node:assert/strict";
import { join } from "node:path";
import { shellQuote, startSubjectSurvey, withProgramStatusTabs } from "../lib/program-status.mjs";

const ownSurveys = (state) => state.row.program_status?.records?.filter((record) =>
  record.source === "chan" && /^survey\/[0-9a-f]{16}$/.test(record.id)) ?? [];

export default {
  name: "program status: survey marks follow the requesting process lifetime",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "154", async (tab) => {
      const pid = await startSubjectSurvey(ctx, tab, "154-kill", "Kill this survey");
      let killed = false;
      try {
        const held = await tab.wait("survey-before-kill", (state) =>
          ownSurveys(state).length === 1 && state.mark?.attention === "question" &&
          state.programCell === "blocked/question", 30_000);
        assert.deepEqual(ownSurveys(held).map(({ state, kind, app, title }) => ({ state, kind, app, title })),
          [{ state: "blocked", kind: "question", app: "cs", title: "Kill this survey" }],
          "asking session owns the visible survey mark");
        await tab.page.waitForSelector(".survey-overlay .survey-title");
        assert.equal(await tab.page.$eval(".survey-overlay .survey-title", (node) => node.textContent),
          "Kill this survey", "target page shows the parked survey");
        const rows = Object.values(JSON.parse((await tab.cs(["list", "--json"])).stdout).groups ?? {}).flat();
        const target = rows.find((row) => row.name === tab.front);
        assert.ok(target, "target terminal remains listed");
        assert.equal(target.program_status?.records?.length ?? 0, 0, "survey target has no requester mark");
        process.kill(pid, "SIGKILL");
        killed = true;
        await tab.wait("survey-killed-cleared", (state) =>
          ownSurveys(state).length === 0 && state.mark?.attention !== "question" &&
          state.programCell === "-", 30_000);
        await tab.page.waitForFunction(() => !document.querySelector(".survey-overlay"), { timeout: 30_000 });
        await ctx.shot(`${tab.backend}-killed-survey-cleared`, tab.page);
      } finally {
        if (!killed) {
          try { process.kill(pid, "SIGKILL"); } catch { /* Survey already ended. */ }
        }
      }

      const output = join(ctx.workspaceDir, `status-154-${tab.backend}-timeout.out`);
      const result = join(ctx.workspaceDir, `status-154-${tab.backend}-timeout.rc`);
      const argv = [ctx.chanBin, "shell", "terminal", "survey", "--tab-name", tab.front,
        "--title", "Timeout this survey", "--option", "Yes", "--timeout", "1", "Question?"];
      await tab.cs(["write", "--tab-name", tab.subject,
        `${argv.map(shellQuote).join(" ")} > ${shellQuote(output)} 2>&1; printf '%s\\n' "$?" > ${shellQuote(result)}\n`]);
      assert.equal((await ctx.pollFile(result, 15_000)).toString().trim(), "124", "survey reports its timeout");
      await tab.wait("survey-timeout-cleared", (state) =>
        ownSurveys(state).length === 0 && state.mark?.attention !== "question" &&
        state.programCell === "-", 30_000);
      await tab.page.waitForFunction(() => !document.querySelector(".survey-overlay"), { timeout: 30_000 });
      await ctx.shot(`${tab.backend}-timed-out-survey-cleared`, tab.page);
    });
  },
};
