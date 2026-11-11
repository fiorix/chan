import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { QUADRANT_COLOURS, pixelDifference, quadrantColour, quadrantPng } from "./png.mjs";

/// The chunks of a PNG, each CRC checked against its type and data.
function chunks(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("ascii");
    const data = bytes.subarray(at + 8, at + 8 + length);
    const crc = bytes.readUInt32BE(at + 8 + length);
    assert.equal(crc, zlib.crc32(bytes.subarray(at + 4, at + 8 + length)) >>> 0, `${type} CRC`);
    out.push({ type, data });
    at += 12 + length;
  }
  return out;
}

test("the quadrant PNG is a valid opaque RGB image of the size asked for", () => {
  const parts = chunks(quadrantPng(8, 6));
  assert.deepEqual(parts.map((part) => part.type), ["IHDR", "IDAT", "IEND"]);
  const header = parts[0].data;
  assert.equal(header.readUInt32BE(0), 8);
  assert.equal(header.readUInt32BE(4), 6);
  assert.deepEqual([...header.subarray(8)], [8, 2, 0, 0, 0]);
});

test("each row is unfiltered and each pixel holds its quadrant's colour", () => {
  const width = 8;
  const height = 6;
  const raw = zlib.inflateSync(chunks(quadrantPng(width, height))[1].data);
  assert.equal(raw.length, height * (1 + width * 3));
  const seen = new Set();
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * (1 + width * 3));
    assert.equal(row[0], 0, `row ${y} filter`);
    for (let x = 0; x < width; x++) {
      const pixel = [...row.subarray(1 + x * 3, 4 + x * 3)];
      assert.deepEqual(pixel, quadrantColour(x, y, width, height), `(${x}, ${y})`);
      seen.add(JSON.stringify(pixel));
    }
  }
  assert.deepEqual([...seen].sort(), QUADRANT_COLOURS.map((c) => JSON.stringify(c)).sort());
  assert.deepEqual(quadrantColour(0, 0, width, height), QUADRANT_COLOURS[0]);
  assert.deepEqual(quadrantColour(7, 5, width, height), QUADRANT_COLOURS[3]);
});

test("the pixel comparison names the first difference and accepts only an exact match", () => {
  const image = { width: 2, height: 1, rgba: [1, 2, 3, 255, 4, 5, 6, 255] };
  assert.equal(pixelDifference(image, { ...image, rgba: [...image.rgba] }), null);
  assert.match(pixelDifference(image, { ...image, width: 1, height: 2 }), /sizes differ: 2x1 and 1x2/);
  assert.match(
    pixelDifference(image, { ...image, rgba: [1, 2, 3, 255, 4, 5, 7, 255] }),
    /pixel at \(1, 0\) is \[4,5,6,255\] in one and \[4,5,7,255\]/,
  );
});
