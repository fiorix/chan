// An image fixture whose pixels say which image it is, and a reading of any
// image's pixels as the browser decodes it.
//
// The fixture is an opaque 8-bit RGB PNG of four coloured quadrants, made
// here so its bytes are known. An image that crossed the browser's clipboard
// is decoded and re-encoded on the way, so a check compares decoded pixels;
// an image that crossed a file drop keeps its bytes.

import zlib from "node:zlib";

/// Top left, top right, bottom left, bottom right.
export const QUADRANT_COLOURS = [
  [220, 40, 40],
  [40, 160, 60],
  [40, 70, 200],
  [230, 200, 40],
];

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/// The colour at (x, y) of a quadrant image of the given size.
export function quadrantColour(x, y, width, height) {
  const right = x >= width / 2 ? 1 : 0;
  const bottom = y >= height / 2 ? 2 : 0;
  return QUADRANT_COLOURS[bottom + right];
}

/// The quadrant PNG's bytes. Each row is stored unfiltered.
export function quadrantPng(width = 8, height = 6) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour, no alpha
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(quadrantColour(x, y, width, height), 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/// `bytes` decoded by the browser behind `page`: `{ width, height, rgba }`,
/// with no colour conversion, so an image and its re-encoding read the same.
export async function decodedPixels(page, bytes) {
  return page.evaluate(async (b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([data]), {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const rgba = Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
    return { width: bitmap.width, height: bitmap.height, rgba };
  }, Buffer.from(bytes).toString("base64"));
}

/// What differs between two decoded images, or null when every pixel of
/// both is the same.
export function pixelDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return `the sizes differ: ${a.width}x${a.height} and ${b.width}x${b.height}`;
  }
  for (let i = 0; i < a.rgba.length; i += 4) {
    const one = a.rgba.slice(i, i + 4);
    const other = b.rgba.slice(i, i + 4);
    if (one.some((value, k) => value !== other[k])) {
      const pixel = i / 4;
      const at = `(${pixel % a.width}, ${Math.floor(pixel / a.width)})`;
      return `the pixel at ${at} is ${JSON.stringify(one)} in one and ${JSON.stringify(other)} in the other`;
    }
  }
  return null;
}
