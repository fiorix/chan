import { buildProcessingBox, buildProcessingSurface, meshMultiply, meshRotation, type ProcessingMeshDraw } from "./processingMesh";

// Geometry and motion adapted from Koma Tebe's p5.js sketch:
// https://x.com/KomaTebe/status/1599750436910686208
export const STACKED_SPIRE_SOURCE = "f=0,draw=o=>{for(f||createCanvas(W=400,W,WEBGL,X=rotateX),background(0),stroke(W,120),X(3),rotateY(f/66),fill(W,99),lights(),box(p=150,1,p),i=0;i<p;i+=10)push(),box(x=i+f%10,300-2*x,x),X(PI/2),rotate(PI/4),stroke(W,(p-i)/3),pop(torus(2*x+99,1,4,2));f+=.3};";

const BOX = buildProcessingBox();
const RING = buildProcessingSurface("torus", 4, 2);

export function buildStackedSpire(clock: number, edges = true): ProcessingMeshDraw[] {
  const model = meshMultiply(meshRotation("x", 3), meshRotation("y", clock / 66));
  const rings = meshMultiply(meshMultiply(model, meshRotation("x", Math.PI / 2)), meshRotation("z", Math.PI / 4));
  const scene: ProcessingMeshDraw[] = [{ mesh: BOX, model, size: [150, 1, 150], alpha: 99 / 255, light: 1, edgeAlpha: edges ? 120 / 255 : 0 }];
  for (let i = 0; i < 150; i += 10) {
    const x = i + clock % 10;
    scene.push({ mesh: BOX, model, size: [x, 300 - 2 * x, x], alpha: 99 / 255, light: 1, edgeAlpha: edges ? 120 / 255 : 0 });
    scene.push({ mesh: RING, model: rings, size: [2 * x + 99, 1, 1], alpha: 99 / 255, light: 1, edgeAlpha: edges ? (150 - i) / 3 / 255 : 0 });
  }
  return scene;
}
