import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { pipeDelayed, pipeHeld } from "./delay-proxy.mjs";

test("lowering latency preserves the order of chunks received in one turn", async () => {
  const source = new EventEmitter();
  const received = [];
  const destination = { destroyed: false, write: (chunk) => received.push(Number(chunk.toString())) };
  let latency = 100;
  let time = 0;
  let clockReads = 0;
  pipeDelayed(source, destination, () => latency, () => {
    clockReads += 1;
    return time;
  });

  for (let i = 0; i < 16; i += 1) source.emit("data", Buffer.from(String(i)));
  time = 99;
  latency = 0;
  for (let i = 16; i < 32; i += 1) source.emit("data", Buffer.from(String(i)));

  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.deepEqual(received, Array.from({ length: 32 }, (_, i) => i));
  assert.equal(clockReads, 32, "each received chunk reads the clock once");
});

test("a held direction delivers nothing until release, then everything in order", () => {
  const source = new EventEmitter();
  const received = [];
  const destination = {
    destroyed: false,
    write: (chunk) => received.push(chunk.toString()),
    end: () => received.push("end"),
  };
  const pipe = pipeHeld(source, destination);

  source.emit("data", Buffer.from("a"));
  pipe.hold();
  for (const chunk of ["b", "c", "d"]) source.emit("data", Buffer.from(chunk));
  source.emit("end");
  assert.deepEqual(received, ["a"], "a held direction delivers nothing");

  pipe.release();
  assert.deepEqual(received, ["a", "b", "c", "d", "end"]);
});

test("a chunk that arrives during a release waits behind the queued ones", () => {
  const source = new EventEmitter();
  const received = [];
  const destination = {
    destroyed: false,
    write: (chunk) => {
      received.push(chunk.toString());
      // The first queued write makes the source send again before the
      // release has drained the rest.
      if (chunk.toString() === "b") source.emit("data", Buffer.from("late"));
    },
  };
  const pipe = pipeHeld(source, destination, { held: true });
  for (const chunk of ["b", "c"]) source.emit("data", Buffer.from(chunk));

  pipe.release();
  assert.deepEqual(received, ["b", "c", "late"]);
});
