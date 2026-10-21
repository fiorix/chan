import { buildProcessingSurface, meshMultiply, meshRotation, meshTranslation, type ProcessingMeshDraw, type MeshVector } from "./processingMesh";

// Geometry and motion adapted from Koma Tebe's p5.js sketch:
// https://x.com/KomaTebe/status/1572556353733906432
export const TORUS_LANTERN_SOURCE = "function draw(){for(f||createCanvas(W=400,W,WEBGL,T=translate),T(60*sin(f),-20,z=170),push(f+=.01),T(X=99*sin(-f),0,Z=99*cos(f)),pop(sphere(4,W)),pointLight([W],X,0,z+Z),i=0;i<TAU;i+=PI/32)push(),rotateY(i+f),T(120,0),rotateX(.8),pop(torus(80,4,W))}f=0;";

const RING = buildProcessingSurface("torus", 400, 16);
const MARKER = buildProcessingSurface("sphere", 400, 16);

export function buildTorusLantern(clock: number): { scene: ProcessingMeshDraw[]; light: MeshVector } {
  const base = meshTranslation(60 * Math.sin(clock), -20, 170);
  const next = clock + 0.01;
  const x = 99 * Math.sin(-next);
  const z = 99 * Math.cos(next);
  const scene: ProcessingMeshDraw[] = [{
    mesh: MARKER,
    model: meshMultiply(base, meshTranslation(x, 0, z)),
    size: [4, 4, 4], alpha: 1, light: 0,
  }];
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 32) {
    const model = meshMultiply(meshMultiply(meshMultiply(base, meshRotation("y", angle + next)), meshTranslation(120, 0, 0)), meshRotation("x", 0.8));
    scene.push({ mesh: RING, model, size: [80, 4, 4], alpha: 1, light: 2 });
  }
  // p5 stores point-light coordinates in world space, independently of the
  // current translation used by the small sphere that accompanies it.
  return { scene, light: [x, 0, 170 + z] };
}
