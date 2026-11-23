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

test("native sequence evidence rejects missing, synthetic, wrong-type and foreign-pointer events", async () => {
  const { requirePointerSequence } = await import("./terminal-pointer.mjs");
  const sequence = ["pointerdown", "pointermove", "pointerup"].map((type) => ({
    type, pointerId: 7, pointerType: "pen", isPrimary: true, isTrusted: true, onCanvas: true,
    buttons: type === "pointerup" ? 0 : 1,
  }));
  assert.equal(requirePointerSequence(sequence, "pen"), sequence[0]);
  const cancelledTouch = sequence.map((event) => ({ ...event, pointerType: "touch",
    type: event.type === "pointerup" ? "pointercancel" : event.type }));
  assert.equal(requirePointerSequence(cancelledTouch, "touch", "pointercancel"), cancelledTouch[0]);
  assert.throws(() => requirePointerSequence(cancelledTouch, "touch"), { code: "POINTER_UNAVAILABLE" });
  for (const field of ["isPrimary", "isTrusted", "onCanvas"]) {
    for (let index = 0; index < sequence.length; index++) {
      const bad = sequence.map((event, n) => n === index ? { ...event, [field]: false } : event);
      assert.throws(() => requirePointerSequence(bad, "pen"), { code: "POINTER_UNAVAILABLE" });
    }
  }
  for (let index = 0; index < sequence.length; index++) {
    assert.throws(() => requirePointerSequence(sequence.filter((_, n) => n !== index), "pen"), { code: "POINTER_UNAVAILABLE" });
  }
  assert.throws(() => requirePointerSequence(sequence, "touch"), { code: "POINTER_UNAVAILABLE" });
  assert.throws(() => requirePointerSequence(sequence.map((event, n) => n === 1 ? { ...event, pointerId: 8 } : event), "pen"), { code: "POINTER_UNAVAILABLE" });
  assert.throws(() => requirePointerSequence(sequence.map((event, n) => n === 1 ? { ...event, buttons: 0 } : event), "pen"), { code: "POINTER_UNAVAILABLE" });
});

test("painted thumb location comes from pixels and rejects a hidden, flat or ambiguous strip", async () => {
  const { paintedThumbBand } = await import("./terminal-pointer.mjs");
  const strip = Array(100).fill(7);
  strip.fill(42, 25, 45);
  assert.deepEqual(paintedThumbBand(strip), { start: 25, end: 45, track: 7, peak: 42 });
  const moved = Array(100).fill(7);
  moved.fill(42, 61, 81);
  assert.deepEqual(paintedThumbBand(moved), { start: 61, end: 81, track: 7, peak: 42 });
  for (const samples of [[], Array(100).fill(0), Array(100).fill(42), [...strip, NaN]]) {
    assert.throws(() => paintedThumbBand(samples));
  }
  const doubled = [...strip];
  doubled.fill(42, 70, 90);
  assert.throws(() => paintedThumbBand(doubled), /one painted thumb/);
  const short = Array(100).fill(7);
  short.fill(42, 30, 32);
  assert.throws(() => paintedThumbBand(short), /usable height/);
});

test("unavailable input stays a runner skip without masking a product or cleanup failure", async () => {
  const { pointerCheckError } = await import("./terminal-pointer.mjs");
  const details = { legs: { pen: { status: "unavailable" }, touch: { status: "passed" } }, failures: ["pen unavailable"] };
  const skipped = pointerCheckError(details);
  assert.equal(skipped.smokeSkip, true);
  assert.equal(skipped.smokeDetails, details);
  for (const extra of ["touch reports", "cleanup failed"]) {
    const failed = pointerCheckError({ ...details, failures: [...details.failures, extra] });
    assert.notEqual(failed.smokeSkip, true);
    assert.ok(failed.message.includes(extra));
  }
  assert.notEqual(pointerCheckError({ legs: { pen: { status: "failed" } }, failures: ["pen failed"] }).smokeSkip, true);
});
