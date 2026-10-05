import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { pipeDelayed } from "./delay-proxy.mjs";

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
