// Geometry and motion adapted from Koma Tebe's p5.js sketch:
// https://x.com/KomaTebe/status/1631278190244265991
export const TANGENT_SHELL_SOURCE = "f=0,draw=s=>{for(f||createCanvas(W=400,W,WEBGL),background(0),rotateX(f),u=0;u<3*TAU;u+=PI/32)for(U=u+f/99,v=PI;v>PI/64;v-=PI/64)V=v-f%(PI/1024),r=220*sin(v+f),push(),translate(sin(U)*sin(V)*r,cos(V)*r,cos(U)*sin(V)*r),sphere(tan(u+v)/6,W),pop();f+=PI/256};";

import { ROUND_POINT_FLOATS } from "./roundPoints";

export const TANGENT_SHELL_SOURCE_SIZE = 400;
const CAMERA_Z = 200 * Math.sqrt(3);
const SEEDS: Array<{ u: number; v: number; radius: number }> = [];
for (let u = 0; u < Math.PI * 6; u += Math.PI / 32) {
  for (let v = Math.PI; v > Math.PI / 64; v -= Math.PI / 64) {
    SEEDS.push({ u, v, radius: Math.abs(Math.tan(u + v) / 6) });
  }
}
export const TANGENT_SHELL_GRAIN_COUNT = SEEDS.length;

export function buildTangentShell(
  clock: number,
  out: Float32Array,
  maxRadius = 6,
): number {
  let count = 0;
  const c = Math.cos(clock);
  const s = Math.sin(clock);
  for (const seed of SEEDS) {
    const u = seed.u + clock / 99;
    const v = seed.v - clock % (Math.PI / 1024);
    const reach = 220 * Math.sin(seed.v + clock);
    const x = Math.sin(u) * Math.sin(v) * reach;
    const y = Math.cos(v) * reach;
    const z = Math.cos(u) * Math.sin(v) * reach;
    const depth = CAMERA_Z - (s * y + c * z);
    const projection = CAMERA_Z / depth;
    // The tangent's poles otherwise make individual grains cover the pane.
    const radius = Math.min(seed.radius, Math.max(0, maxRadius));
    if (radius === 0) continue;
    const offset = count * ROUND_POINT_FLOATS;
    out[offset] = x * projection;
    out[offset + 1] = (c * y - s * z) * projection;
    out[offset + 2] = radius * projection;
    out[offset + 3] = 1;
    count += 1;
  }
  return count;
}
