import assert from "node:assert/strict";
import { withProgramStatusTabs } from "../lib/program-status.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const names = (status) => status.records.map((record) => `${record.source}:${record.id ?? "root"}`);

async function snapshot(tab) {
  const listed = await tab.cs(["list", "--json"]);
  const rows = Object.values(JSON.parse(listed.stdout).groups ?? {}).flat();
  const row = rows.find((entry) => entry.session_id === tab.subjectRow.session_id);
  assert.ok(row?.program_status, "list row exposes a program status snapshot");
  return row.program_status;
}

async function waitRevision(tab, previous, label) {
  const deadline = Date.now() + 15_000;
  do {
    const value = await snapshot(tab);
    if (value.revision > previous) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label} did not advance the status revision after ${previous}`);
}

async function outputBarrier(tab, label) {
  const [prefix, suffix] = label.split(/_(.*)/s);
  await tab.cs(["write", "--tab-name", tab.subject, `printf '%s%s\\n' '${prefix}_' '${suffix}'\n`]);
  const deadline = Date.now() + 15_000;
  do {
    const output = (await tab.cs(["scrollback", "--tab-name", tab.subject])).stdout;
    if (output.includes(label)) return;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`PTY output barrier ${label} absent`);
}

export default {
  name: "program status: malformed reports discard atomically and LRU cap holds",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "156", async (tab) => {
      for (const id of [null, "a", "a/b", "ab", "guard"]) await tab.sendReport(`state=done${id ? `:id=${id}` : ""}`);
      const seed = await tab.wait("invalid-seed", (state) =>
        state.row.program_status?.records?.length === 5 &&
        state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
          JSON.stringify(frame.program_status?.records) === JSON.stringify(state.row.program_status.records)));
      let previous = seed.row.program_status;
      const body = "state=done:x=" + "A".repeat(4088 - "state=done:x=".length);
      assert.equal(Buffer.byteLength(body), 4088, "body is one byte over the 4087-byte cap");
      const broken = [
        ["overlong", `\\033]7501;${body}\\033\\\\`],
        ["bad-base64", "\\033]7501;state=done:id=a:msg=A\\033\\\\"],
        ["control", "\\033]7501;state=done:id=a:msg=AQ==\\033\\\\"],
        ["non-utf8", "\\033]7501;state=done:id=a:msg=/w==\\033\\\\"],
        ["bad-id", "\\033]7501;state=done:id=/bad\\033\\\\"],
        ["unknown-state", "\\033]7501;state=unknown:id=a\\033\\\\"],
        ["clear-broken-value", "\\033]7501;state=clear:id=a:msg=AQ==\\033\\\\"],
      ];
      for (const [label, format] of broken) {
        await tab.sendRaw(format);
        await outputBarrier(tab, `STATUS156_${label.replaceAll("-", "_")}`);
        const after = await snapshot(tab);
        assert.deepEqual(after, previous, `${label} left records, revision and update order unchanged`);
        await tab.sendReport("state=done:id=guard:app=recovered");
        previous = await waitRevision(tab, previous.revision, `${label} recovery`);
        assert.equal(previous.records.find((record) => record.id === "guard")?.app, "recovered", `${label} did not poison the next valid report`);
        await ctx.shot(`${tab.backend}-${label}-recovery`, tab.page);
      }

      // Syntax skips a malformed pair. This valid clear still removes a and a/b.
      await tab.sendRaw("\\033]7501;state=clear:id=a:broken\\033\\\\");
      const skippedPair = await waitRevision(tab, previous.revision, "clear with skipped pair");
      assert.deepEqual(names(skippedPair), ["program:root", "program:ab", "program:guard"]);
      const clearFrame = await tab.wait("skipped-pair-clear-frame", (state) =>
        state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
          frame.program_status?.revision === skippedPair.revision &&
          JSON.stringify(names(frame.program_status)) === JSON.stringify(names(skippedPair))));
      assert.deepEqual(clearFrame.row.program_status, skippedPair);
      await tab.sendReport("state=done:id=guard:app=after-clear");
      previous = await waitRevision(tab, skippedPair.revision, "valid report after skipped pair");
      assert.equal(previous.records.find((record) => record.id === "guard")?.app, "after-clear");

      await tab.sendReport("state=clear");
      previous = await waitRevision(tab, previous.revision, "clear before cap");
      assert.deepEqual(previous.records, []);
      const ordered = [];
      for (let index = 0; index < 300; index += 1) {
        if (index === 64) {
          await tab.sendReport("state=done:id=r0");
          previous = await waitRevision(tab, previous.revision, "refresh r0 before eviction");
          ordered.splice(ordered.indexOf("r0"), 1);
          ordered.push("r0");
        }
        const id = `r${index}`;
        await tab.sendReport(`state=done:id=${id}`);
        previous = await waitRevision(tab, previous.revision, `insert ${id}`);
        if (ordered.length === 64) ordered.shift();
        ordered.push(id);
        assert.deepEqual(names(previous), ordered.map((name) => `program:${name}`), `${id} evicted the least recently updated program record`);
        assert.ok(previous.records.every((record, at) => at === 0 || previous.records[at - 1].update_order < record.update_order), `${id} retains increasing update order`);
      }
      assert.equal(previous.records.length, 64, "300 distinct records respect the 64-record cap");
      await tab.wait("cap-final-frame", (state) =>
        state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
          frame.program_status?.revision === previous.revision &&
          JSON.stringify(frame.program_status.records) === JSON.stringify(previous.records)), 30_000);
    });
  },
};
