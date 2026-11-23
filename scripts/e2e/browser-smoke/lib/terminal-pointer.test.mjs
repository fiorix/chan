import assert from "node:assert/strict";
import test from "node:test";
import { drainPointerInput, pointerInputSince, pointerReports } from "./terminal-pointer.mjs";

const keys = (text) => ({ type: "keys", base64: Buffer.from(text, "latin1").toString("base64") });

test("raw reports survive fragmented records without accepting old input or control replies", () => {
  const fixture = { records: [keys("old"), keys("\x1b[<0;"), { type: "reply", ok: true }, keys("2;3M\x1b[<0;8;9m")] };
  const input = pointerInputSince(fixture, 1);
  assert.equal(input, "\x1b[<0;2;3M\x1b[<0;8;9m");
  assert.deepEqual(pointerReports(input), [
    { button: 0, col: 2, row: 3, end: "M" },
    { button: 0, col: 8, row: 9, end: "m" },
  ]);
});

test("the SGR reader rejects junk, truncated reports, and invalid coordinates", () => {
  for (const input of ["x\x1b[<0;2;3M", "\x1b[<0;2;3Mx", "\x1b[<0;2;", "\x1b[<0;0;1M", "\x1b[<0;1;0m", "\x1b[2;3R"]) {
    assert.throws(() => pointerReports(input), /only complete SGR reports/, JSON.stringify(input));
  }
  assert.deepEqual(pointerReports(""), []);
  assert.equal(pointerReports("\x1b[<0;2;3m\x1b[<0;2;3m").length, 2, "duplicate releases stay visible to the caller");
});

test("drain requires a new complete cursor reply and retains all preceding gesture bytes", async () => {
  const fixture = {
    records: [keys("\x1b[9;9R")],
    async send(op, args) {
      assert.equal(op, "bytes");
      assert.equal(Buffer.from(args.base64, "base64").toString(), "\x1b[?1000h\x1b[6n");
    },
    async waitFor(predicate) {
      assert.equal(predicate(), false, "a stale reply is not a round trip");
      this.records.push(keys("\x1b[<0;2;3M\x1b[4;"));
      assert.equal(predicate(), false, "a partial reply cannot end the drain");
      this.records.push(keys("1R"));
      assert.equal(predicate(), true);
    },
  };
  assert.deepEqual(await drainPointerInput(fixture, "\x1b[?1000h"), {
    input: "\x1b[<0;2;3M", reply: "\x1b[4;1R",
  });
});

test("drain propagates a missing-reply failure instead of reporting silence", async () => {
  const fixture = { records: [], async send() {}, async waitFor() { throw new Error("FIXTURE_EVENT_TIMEOUT"); } };
  await assert.rejects(drainPointerInput(fixture), /FIXTURE_EVENT_TIMEOUT/);
});
