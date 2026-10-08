// The smooth noise p5.js's noise() returns, for porting sketches that call
// it: a table of 4,096 random values read as a 16 by 16 by 16 lattice,
// blended between neighbours with a cosine ease, and summed over four
// octaves that each double the frequency and halve the weight. The sum
// stays below 0.9375. A sketch only ever sees the absolute value of each
// coordinate, so the field mirrors across every axis.
//
// The same function is written twice: here for values a sketch never
// changes, and in LATTICE_NOISE_GLSL for values a vertex shader works out
// every frame from the same table.

export const LATTICE_NOISE_TABLE_SIZE = 4096;
/// The table is uploaded as a square texture of this side.
export const LATTICE_NOISE_TEXTURE_SIDE = 64;

const OCTAVES = 4;
const INDEX_MASK = LATTICE_NOISE_TABLE_SIZE - 1;
const Y_STRIDE = 16;
const Z_STRIDE = 256;

/// The table p5.js fills for noiseSeed(seed): 4,096 values from 0 to 1 off
/// a 32-bit linear congruential generator.
export function latticeNoiseTable(seed: number): Float32Array {
  const table = new Float32Array(LATTICE_NOISE_TABLE_SIZE);
  let state = seed >>> 0;
  for (let index = 0; index < table.length; index += 1) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    table[index] = state / 4294967296;
  }
  return table;
}

function ease(fraction: number): number {
  return 0.5 * (1 - Math.cos(fraction * Math.PI));
}

function mix(from: number, to: number, amount: number): number {
  return from + amount * (to - from);
}

export function latticeNoise(
  table: Float32Array,
  x: number,
  y = 0,
  z = 0,
): number {
  x = Math.abs(x);
  y = Math.abs(y);
  z = Math.abs(z);
  let cellX = Math.floor(x);
  let cellY = Math.floor(y);
  let cellZ = Math.floor(z);
  let fractionX = x - cellX;
  let fractionY = y - cellY;
  let fractionZ = z - cellZ;
  let sum = 0;
  let weight = 0.5;

  for (let octave = 0; octave < OCTAVES; octave += 1) {
    const corner = cellX + cellY * Y_STRIDE + cellZ * Z_STRIDE;
    const easeX = ease(fractionX);
    const easeY = ease(fractionY);
    const edge = (offset: number): number =>
      mix(
        table[(corner + offset) & INDEX_MASK]!,
        table[(corner + offset + 1) & INDEX_MASK]!,
        easeX,
      );
    const near = mix(edge(0), edge(Y_STRIDE), easeY);
    const far = mix(edge(Z_STRIDE), edge(Z_STRIDE + Y_STRIDE), easeY);
    sum += mix(near, far, ease(fractionZ)) * weight;
    weight *= 0.5;

    cellX *= 2;
    cellY *= 2;
    cellZ *= 2;
    fractionX *= 2;
    fractionY *= 2;
    fractionZ *= 2;
    if (fractionX >= 1) {
      cellX += 1;
      fractionX -= 1;
    }
    if (fractionY >= 1) {
      cellY += 1;
      fractionY -= 1;
    }
    if (fractionZ >= 1) {
      cellZ += 1;
      fractionZ -= 1;
    }
  }

  return sum;
}

/// `float latticeNoise(vec3)` for a WebGL2 shader, reading the table from
/// the sampler `uNoiseTable`: an R32F texture LATTICE_NOISE_TEXTURE_SIDE
/// wide, the table in row order.
export const LATTICE_NOISE_GLSL = `
uniform highp sampler2D uNoiseTable;

float latticeValue(int index) {
  int wrapped = index & ${INDEX_MASK};
  return texelFetch(
    uNoiseTable,
    ivec2(
      wrapped % ${LATTICE_NOISE_TEXTURE_SIDE},
      wrapped / ${LATTICE_NOISE_TEXTURE_SIDE}
    ),
    0
  ).r;
}

vec3 latticeEase(vec3 fraction) {
  return 0.5 * (1.0 - cos(fraction * 3.141592653589793));
}

float latticeEdge(int corner, float easeX) {
  return mix(latticeValue(corner), latticeValue(corner + 1), easeX);
}

float latticeNoise(vec3 position) {
  position = abs(position);
  ivec3 cell = ivec3(floor(position));
  vec3 fraction = position - vec3(cell);
  float sum = 0.0;
  float weight = 0.5;

  for (int octave = 0; octave < ${OCTAVES}; octave += 1) {
    int corner = cell.x + cell.y * ${Y_STRIDE} + cell.z * ${Z_STRIDE};
    vec3 eased = latticeEase(fraction);
    float near = mix(
      latticeEdge(corner, eased.x),
      latticeEdge(corner + ${Y_STRIDE}, eased.x),
      eased.y
    );
    float far = mix(
      latticeEdge(corner + ${Z_STRIDE}, eased.x),
      latticeEdge(corner + ${Z_STRIDE + Y_STRIDE}, eased.x),
      eased.y
    );
    sum += mix(near, far, eased.z) * weight;
    weight *= 0.5;

    ivec3 carry = ivec3(greaterThanEqual(fraction * 2.0, vec3(1.0)));
    cell = cell * 2 + carry;
    fraction = fraction * 2.0 - vec3(carry);
  }

  return sum;
}
`;
