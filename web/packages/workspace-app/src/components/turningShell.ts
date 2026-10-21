// Geometry and motion adapted from Koma Tebe's p5.js sketch:
// https://x.com/KomaTebe/status/1639375802964795392
export const TURNING_SHELL_SOURCE = "f=0,draw=a=>{for(f||createCanvas(W=400,W,WEBGL,R=rotateY),background(0),j=0;j<PI;j+=PI/128)for(i=0;i<TAU;i+=PI/64)push(R(j)),R(f),translate(sin(T=tan(atan(i+j)))*(S=sin(J=j+f)*W),atan(cos(J))*sin(J)*W,cos(T)*S),R(i),pop(sphere(2*sin(J*PI*f),W));f+=PI/2048};";

import { ROUND_POINT_FLOATS } from "./roundPoints";

export const TURNING_SHELL_SOURCE_SIZE = 400;
const CAMERA_Z = 200 * Math.sqrt(3);

// rotateY(j) is evaluated before push(), so it accumulates across grains.
// Retain the source's floating loops, including their final boundary grains.
const SEEDS: Array<{ j: number; sine: number; cosine: number; turn: number }> = [];
let turn = 0;
for (let j = 0; j < Math.PI; j += Math.PI / 128) {
  for (let i = 0; i < Math.PI * 2; i += Math.PI / 64) {
    turn += j;
    const angle = Math.tan(Math.atan(i + j));
    SEEDS.push({ j, sine: Math.sin(angle), cosine: Math.cos(angle), turn });
  }
}
export const TURNING_SHELL_GRAIN_COUNT = SEEDS.length;

export function buildTurningShell(clock: number, out: Float32Array): number {
  let count = 0;
  for (const seed of SEEDS) {
    const phase = seed.j + clock;
    const reach = Math.sin(phase) * 400;
    const x = seed.sine * reach;
    const y = Math.atan(Math.cos(phase)) * Math.sin(phase) * 400;
    const z = seed.cosine * reach;
    const c = Math.cos(seed.turn + clock);
    const s = Math.sin(seed.turn + clock);
    const depth = CAMERA_Z - (-s * x + c * z);
    if (depth < CAMERA_Z / 10) continue;
    // p5 scales unlit spheres by their signed radius; either sign has the
    // same silhouette. A zero-radius sphere contributes no grain.
    const radius = Math.abs(2 * Math.sin(phase * Math.PI * clock));
    if (radius === 0) continue;
    const projection = CAMERA_Z / depth;
    const offset = count * ROUND_POINT_FLOATS;
    out[offset] = (c * x + s * z) * projection;
    out[offset + 1] = y * projection;
    out[offset + 2] = radius * projection;
    out[offset + 3] = 1;
    count += 1;
  }
  return count;
}
