import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellQuote, startSubjectSurvey, withProgramStatusTabs } from "../lib/program-status.mjs";

const own = (state, prefix) => state.row.program_status?.records?.filter((record) =>
  record.source === "chan" && record.id?.startsWith(`${prefix}/`)) ?? [];
const program = (state, id) => state.row.program_status?.records?.find((record) =>
  record.source === "program" && record.id === id);

async function checkStatusCommandStates(ctx, tab) {
  const script = join(ctx.workspaceDir, `status-151-${tab.backend}-states.sh`);
  const gate = join(ctx.workspaceDir, `status-151-${tab.backend}-states.fifo`);
  await ctx.exec("mkfifo", [gate]);
  const stages = [
    { state: "idle", args: [], cell: "idle" },
    { state: "working", args: [], cell: "working", activity: "spinner" },
    { state: "blocked", args: ["--kind", "permission"], cell: "blocked/permission", attention: "permission" },
    { state: "done", args: [], cell: "done", attention: "done" },
    { state: "error", args: [], cell: "error", attention: "error" },
    { state: "clear", args: [], cell: "-" },
  ];
  const lines = ["#!/usr/bin/env bash", "set -e"];
  for (const [index, stage] of stages.entries()) {
    const argv = [ctx.chanBin, "shell", "terminal", "status", stage.state, "--id", "command", ...stage.args];
    const marker = join(ctx.workspaceDir, `status-151-${tab.backend}-${stage.state}.ready`);
    lines.push(argv.map(shellQuote).join(" "));
    lines.push(`printf 'ready\\n' > ${shellQuote(marker)}`);
    if (index < stages.length - 1) lines.push(`IFS= read -r _ < ${shellQuote(gate)}`);
  }
  writeFileSync(script, `${lines.join("\n")}\n`);
  await tab.cs(["write", "--tab-name", tab.subject, `bash ${shellQuote(script)}\n`]);
  for (const [index, stage] of stages.entries()) {
    const marker = join(ctx.workspaceDir, `status-151-${tab.backend}-${stage.state}.ready`);
    await ctx.pollFile(marker, 20_000);
    const observed = await tab.wait(`cs-${stage.state}`, (value) =>
      value.programCell === stage.cell &&
      (stage.state === "clear" ? !program(value, "command") : program(value, "command")?.state === stage.state) &&
      (!stage.activity || value.mark?.activity === stage.activity) &&
      (!stage.attention || value.mark?.attention === stage.attention), 30_000);
    if (stage.state !== "clear") assert.equal(program(observed, "command")?.source, "program", "cs status uses the program source");
    if (index < stages.length - 1) await writeFile(gate, "next\n");
  }
}

async function checkExport(ctx, tab) {
  let heldRequest = null;
  let released = false;
  let notifyHeld;
  const intercepted = new Promise((resolve) => { notifyHeld = resolve; });
  const onRequest = (request) => {
    if (!heldRequest && request.method() === "POST" && new URL(request.url()).pathname === "/api/fs/upload") {
      heldRequest = request;
      notifyHeld();
    } else {
      void request.continue().catch(() => {});
    }
  };
  tab.page.on("request", onRequest);
  await tab.page.setRequestInterception(true);
  const outputName = `status-151-${tab.backend}.pdf`;
  const pidPath = join(ctx.workspaceDir, `status-151-${tab.backend}-export.pid`);
  const logPath = join(ctx.workspaceDir, `status-151-${tab.backend}-export.log`);
  const argv = [ctx.chanBin, "shell", "export", "doc.md", "--out", outputName];
  let pid = null;
  try {
    await tab.cs(["write", "--tab-name", tab.subject,
      `${argv.map(shellQuote).join(" ")} > ${shellQuote(logPath)} 2>&1 & printf '%s\\n' "$!" > ${shellQuote(pidPath)}\n`]);
    pid = Number((await ctx.pollFile(pidPath, 15_000)).toString().trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1, "export pid captured from the subject shell");
    let deadline;
    try {
      await Promise.race([intercepted, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("export did not reach the held page upload")), 60_000);
      })]);
    } finally {
      clearTimeout(deadline);
    }
    const held = await tab.wait("export-upload-held", (state) =>
      own(state, "export").length === 1 && state.mark?.activity === "spinner" &&
      state.programCell === "working", 30_000);
    assert.deepEqual(own(held, "export").map(({ state, app, title }) => ({ state, app, title })),
      [{ state: "working", app: "cs", title: "Export" }], "requester holds chan's export record during the page upload");
    assert.match(own(held, "export")[0].id, /^export\/[0-9a-f]{16}$/, "export has a bounded own id");
    await ctx.shot(`${tab.backend}-export-held`, tab.page);
    await heldRequest.continue();
    released = true;
    await ctx.pollFile(join(ctx.workspaceDir, outputName), 60_000);
    await tab.wait("export-finished", (state) => own(state, "export").length === 0 &&
      state.mark?.activity !== "spinner" && state.programCell === "-", 30_000);
    await ctx.shot(`${tab.backend}-export-cleared`, tab.page);
  } finally {
    if (heldRequest && !released) await heldRequest.continue().catch(() => {});
    tab.page.off("request", onRequest);
    await tab.page.setRequestInterception(false).catch(() => {});
    if (!released && pid) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Export already ended. */ }
    }
  }
}

export default {
  name: "program status: chan survey, export and status commands report their lifetimes",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "151", async (tab) => {
      const surveyPid = await startSubjectSurvey(ctx, tab, "151-survey", "Choose a response");
      let answered = false;
      try {
        const held = await tab.wait("survey-held", (state) =>
          own(state, "survey").length === 1 && state.mark?.attention === "question" &&
          state.programCell === "blocked/question", 30_000);
        assert.deepEqual(own(held, "survey").map(({ state, kind, app, title }) => ({ state, kind, app, title })),
          [{ state: "blocked", kind: "question", app: "cs", title: "Choose a response" }],
          "requester holds chan's blocked/question record");
        assert.match(own(held, "survey")[0].id, /^survey\/[0-9a-f]{16}$/, "survey has a bounded own id");
        const rows = Object.values(JSON.parse((await tab.cs(["list", "--json"])).stdout).groups ?? {}).flat();
        assert.equal(rows.find((row) => row.name === tab.front)?.program_status?.records?.length ?? 0, 0,
          "the survey target carries no requester record");
        await tab.page.waitForSelector(".survey-overlay .survey-option");
        await ctx.shot(`${tab.backend}-survey-held`, tab.page);
        await tab.page.click(".survey-overlay .survey-option");
        answered = true;
        await tab.wait("survey-answered", (state) => own(state, "survey").length === 0 &&
          state.mark?.attention !== "question" && state.programCell === "-", 30_000);
      } finally {
        if (!answered) {
          try { process.kill(surveyPid, "SIGKILL"); } catch { /* Survey already ended. */ }
        }
      }

      await checkExport(ctx, tab);
      await checkStatusCommandStates(ctx, tab);

      await tab.sendReport("state=done:id=preserve");
      const before = await tab.wait("before-refused-input", (state) =>
        program(state, "preserve")?.state === "done" && state.programCell === "done", 30_000);
      const output = join(ctx.workspaceDir, `status-151-${tab.backend}-invalid.out`);
      const result = join(ctx.workspaceDir, `status-151-${tab.backend}-invalid.rc`);
      const argv = [ctx.chanBin, "shell", "terminal", "status", "working", "--id", "invalid", "--msg", "x".repeat(2049)];
      await tab.cs(["write", "--tab-name", tab.subject,
        `${argv.map(shellQuote).join(" ")} > ${shellQuote(output)} 2>&1; printf '%s\\n' "$?" > ${shellQuote(result)}\n`]);
      assert.notEqual((await ctx.pollFile(result, 15_000)).toString().trim(), "0", "over-limit cs status input is refused");
      const after = await tab.read();
      assert.deepEqual(after.row.program_status, before.row.program_status, "refused input preserves the whole record set, revision and order");
      assert.equal(after.programCell, "done", "refused input leaves the tab's program cell unchanged");
      await ctx.shot(`${tab.backend}-over-limit-refused`, tab.page);
    });
  },
};
