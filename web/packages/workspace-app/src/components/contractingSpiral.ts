// Geometry and motion adapted from hisadan's Processing sketch:
// https://x.com/hisadan/status/1803807190039384154
export const CONTRACTING_SPIRAL_SOURCE = "float t=5,r;\nvoid setup(){size(800,800);}\nvoid draw(){\nbackground(0);noFill();\nstroke(-1,t*99);\nfor(r=0;r<TAU*99;r+=PI/2.6)circle(r*t*sin(r)+400,r*t*cos(r)+400,r);\nt/=1.002;}";

export const CONTRACTING_SPIRAL_SOURCE_SIZE = 800;
// The source advances at 60 frames per second; reverse at twenty seconds.
export const CONTRACTING_SPIRAL_PERIOD = 20 * 60;

export interface SpiralCircle {
  x: number;
  y: number;
  radius: number;
}

export function contractingSpiralState(frame: number): { contraction: number; alpha: number } {
  const period = CONTRACTING_SPIRAL_PERIOD;
  const cycle = period * 2;
  const phase = ((frame % cycle) + cycle) % cycle;
  const age = phase > period ? cycle - phase : phase;
  const contraction = 5 / Math.pow(1.002, age);
  return { contraction, alpha: Math.min(1, contraction * 99 / 255) };
}

export function buildContractingSpiral(contraction: number): SpiralCircle[] {
  const circles: SpiralCircle[] = [];
  for (let r = 0; r < Math.PI * 2 * 99; r += Math.PI / 2.6) {
    circles.push({
      x: r * contraction * Math.sin(r),
      y: r * contraction * Math.cos(r),
      radius: r / 2,
    });
  }
  return circles;
}
