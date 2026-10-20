// Geometry and motion adapted from Hau_kun's Processing sketch:
// https://x.com/Hau_kun/status/1273643037747318785
export const SWAYING_BRANCHES_SOURCE = "float t,r;\nvoid setup(){size(720,720);stroke(-1);}\nvoid draw(){\nclear();\nt+=.01;\nfor(r=0;r<6;r++)\nf(360,360,PI/3*r,99);\n}\nvoid f(float x,float y,float r,float d){if(d>5){line(x,y,x+=cos(r)*d,y+=sin(r)*d);f(x,y,cos(t)+r+PI/2,d*.7);f(x,y,sin(t)+r-PI/7,d*.72);}}";

export const SWAYING_BRANCHES_SOURCE_SIZE = 720;

export interface SwayingBranch {
  x: number;
  y: number;
  endX: number;
  endY: number;
}

export function buildSwayingBranches(clock: number): SwayingBranch[] {
  const lines: SwayingBranch[] = [];
  const left = Math.cos(clock) + Math.PI / 2;
  const right = Math.sin(clock) - Math.PI / 7;

  function branch(x: number, y: number, angle: number, length: number): void {
    if (length <= 5) return;
    const endX = x + Math.cos(angle) * length;
    const endY = y + Math.sin(angle) * length;
    lines.push({ x, y, endX, endY });
    branch(endX, endY, angle + left, length * 0.7);
    branch(endX, endY, angle + right, length * 0.72);
  }

  for (let arm = 0; arm < 6; arm += 1) {
    branch(0, 0, (Math.PI / 3) * arm, 99);
  }
  return lines;
}
