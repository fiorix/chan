import assert from "node:assert/strict";
import { withProgramStatusTabs } from "../lib/program-status.mjs";

async function waitScrollback(tab, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  do {
    output = (await tab.cs(["scrollback", "--tab-name", tab.subject], { maxBuffer: 16 * 1024 * 1024 })).stdout;
    if (pattern.test(output)) return output;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${pattern} absent from terminal scrollback: ${output.slice(-1000)}`);
}

export default {
  name: "program status: paced flood preserves output and latest value",
  async run(ctx) {
    await withProgramStatusTabs(ctx, "155", async (tab) => {
      const before = await tab.read();
      const command = [
        "msg=$(printf '%2048s' '' | tr ' ' A | base64 -w0)",
        "[ ${#msg} -eq 2732 ] || exit 41",
        "start=$(date +%s%3N)",
        "deadline=$((start + 3000))",
        "i=0; last=none",
        "while [ $(date +%s%3N) -lt $deadline ]; do",
        "  if [ $((i % 2)) -eq 0 ]; then last=done; else last=error; fi",
        "  printf '\\033]7501;state=%s:id=flood:msg=%s\\033\\\\' \"$last\" \"$msg\"",
        "  if [ $((i % 16)) -eq 0 ]; then printf 'FLOOD155_LINE_%s\\n' \"$i\"; fi",
        "  i=$((i + 1))",
        "done",
        "end=$(date +%s%3N)",
        "printf 'FLOOD155_END_%s_%s_%s_%s\\n' \"$start\" \"$end\" \"$i\" \"$last\"",
      ].join("; ").replace("do;", "do") + "\n";
      await tab.cs(["write", "--tab-name", tab.subject, command]);
      const scrollback = await waitScrollback(tab, /FLOOD155_END_\d+_\d+_\d+_(?:done|error)/);
      const receipt = /FLOOD155_END_(\d+)_(\d+)_(\d+)_(done|error)/.exec(scrollback);
      assert.ok(receipt, "flood completion carries its measured start, end and last state");
      const [, start, end, attempts, last] = receipt;
      const durationMs = Number(end) - Number(start);
      assert.ok(durationMs >= 2500 && durationMs <= 5000, `flood measured ${durationMs} ms`);
      assert.ok(Number(attempts) > 16, "the loop alternated reports beside more than one ordinary output line");
      assert.match(scrollback, /FLOOD155_LINE_[1-9]\d*/, "plain output kept arriving in terminal scrollback");
      const final = await tab.wait("flood-final", (state) =>
        state.row.program_status?.records?.some((record) => record.id === "flood" && record.state === last && record.msg?.length === 2048) &&
        state.frames.some((frame) => frame.type === "program-status" && frame.id === tab.subjectRow.session_id &&
          frame.program_status?.records?.some((record) => record.id === "flood" && record.state === last && record.msg?.length === 2048)), 20_000);
      const emitted = final.frameTimes.slice(before.frameTimes.length).filter((event) =>
        event.type === "program-status" && event.id === tab.subjectRow.session_id);
      assert.ok(emitted.length > 0, "flood produced a socket status frame");
      assert.ok(emitted.length <= Math.ceil(durationMs / 150) + 1,
        `${emitted.length} status frames exceeded one per 150 ms of ${durationMs} ms plus one`);
    });
  },
};
