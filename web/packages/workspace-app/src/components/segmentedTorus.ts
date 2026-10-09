import { ROUND_POINT_FRAGMENT_SHADER } from "./roundPoints";
import { LINE_SEGMENT_FRAGMENT_SHADER } from "./lineSegments";
import { linkProgram, uniformLocation } from "./webglProgram";

// Inspired by the particle ring in this clip:
// https://x.com/scinaturenews/status/2107967191652192475
// Superellipse parameterization by Pavel Boytchev:
// https://discourse.threejs.org/t/twisted-torus-parametric/56492
export const SEGMENTED_TORUS_CHAMBERS = 12;
export const SEGMENTED_TORUS_GAP = 0.04;
export const SEGMENTED_TORUS_PERIOD_SECONDS = 30;
const ARC_STEPS = 24;
const SECTION_STEPS = 32;
const GRAINS_PER_CHAMBER = 1800;
export const SEGMENTED_TORUS_GRAIN_COUNT = SEGMENTED_TORUS_CHAMBERS * GRAINS_PER_CHAMBER;
export const SEGMENTED_TORUS_GRAIN_FLOATS = 9;
const TAU = Math.PI * 2;
const CHAMBER_ANGLE = TAU / SEGMENTED_TORUS_CHAMBERS;
const CENTER_RADIUS = 0.8;
const TUBE_RADIUS = 0.2;
const SECTION_POWER = 10;
const TWIST_RATE = 1.5;

type Point3 = [number, number, number];

function sectionPoint(angle: number): [number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const radius = TUBE_RADIUS * (Math.abs(cos) ** SECTION_POWER + Math.abs(sin) ** SECTION_POWER) ** (-1 / SECTION_POWER);
  return [radius * cos, radius * sin];
}

const SECTION = Array.from({ length: SECTION_STEPS }, (_, index) => sectionPoint(Math.PI / 4 + index * TAU / SECTION_STEPS));

function point(angle: number, radial: number, depth: number): Point3 {
  const twist = angle * TWIST_RATE;
  const twistedRadius = CENTER_RADIUS + radial * Math.cos(twist) - depth * Math.sin(twist);
  return [Math.cos(angle) * twistedRadius, Math.sin(angle) * twistedRadius,
    radial * Math.sin(twist) + depth * Math.cos(twist)];
}

function orbit(seconds: number): number {
  // One circuit turns a material point through 540 degrees around the tube;
  // it returns after two circuits. Wrapping earlier would make lights jump.
  return seconds % (SEGMENTED_TORUS_PERIOD_SECONDS * 2) * TAU / SEGMENTED_TORUS_PERIOD_SECONDS;
}

interface TorusMesh { faces: Float32Array; edges: Float32Array }

/// Sweep an n=10 superellipse through 1.5 twists, leaving gaps between chambers.
export function buildSegmentedTorusMesh(seconds = 0, out: TorusMesh = {
  faces: new Float32Array(SEGMENTED_TORUS_CHAMBERS * (ARC_STEPS + 1) * SECTION_STEPS * 18),
  edges: new Float32Array(SEGMENTED_TORUS_CHAMBERS * (ARC_STEPS * 4 + SECTION_STEPS * 2) * 6),
}): TorusMesh {
  const { faces, edges } = out;
  let faceOffset = 0;
  let edgeOffset = 0;
  function triangle(a: Point3, b: Point3, c: Point3): void {
    faces.set(a, faceOffset);
    faces.set(b, faceOffset + 3);
    faces.set(c, faceOffset + 6);
    faceOffset += 9;
  }
  function quad(a: Point3, b: Point3, c: Point3, d: Point3): void {
    triangle(a, b, c);
    triangle(a, c, d);
  }
  function edge(a: Point3, b: Point3): void {
    edges.set(a, edgeOffset);
    edges.set(b, edgeOffset + 3);
    edgeOffset += 6;
  }
  for (let chamber = 0; chamber < SEGMENTED_TORUS_CHAMBERS; chamber += 1) {
    const start = chamber * CHAMBER_ANGLE + SEGMENTED_TORUS_GAP / 2 + orbit(seconds);
    const sweep = CHAMBER_ANGLE - SEGMENTED_TORUS_GAP;
    function section(angle: number): Point3[] {
      return SECTION.map(([radial, depth]) => point(angle, radial, depth));
    }
    let a = section(start);
    for (let step = 0; step < ARC_STEPS; step += 1) {
      const b = section(start + sweep * (step + 1) / ARC_STEPS);
      for (let side = 0; side < SECTION_STEPS; side += 1) {
        const next = (side + 1) % SECTION_STEPS;
        quad(a[side]!, b[side]!, b[next]!, a[next]!);
        if (side % (SECTION_STEPS / 4) === 0) edge(a[side]!, b[side]!);
      }
      a = b;
    }
    for (const angle of [start, start + sweep]) {
      const corners = section(angle);
      const center = point(angle, 0, 0);
      for (let side = 0; side < SECTION_STEPS; side += 1) {
        const a = corners[side]!;
        const b = corners[(side + 1) % SECTION_STEPS]!;
        if (angle === start) triangle(center, a, b);
        else triangle(center, b, a);
        edge(a, b);
      }
    }
  }
  return out;
}

const GRAIN_SEEDS = (() => {
  let seed = 31;
  return Float32Array.from({ length: SEGMENTED_TORUS_GRAIN_COUNT * 5 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  });
})();

const GRAIN_SECTIONS = (() => {
  const values = new Float32Array(SEGMENTED_TORUS_GRAIN_COUNT * 4);
  for (let index = 0; index < SEGMENTED_TORUS_GRAIN_COUNT; index += 1) {
    const [radial, depth] = sectionPoint(GRAIN_SEEDS[index * 5 + 1]! * TAU);
    const fill = 0.02 + 0.96 * Math.sqrt(GRAIN_SEEDS[index * 5 + 3]!);
    const nr = (radial / TUBE_RADIUS) ** (SECTION_POWER - 1);
    const nz = (depth / TUBE_RADIUS) ** (SECTION_POWER - 1);
    const length = Math.hypot(nr, nz);
    values.set([radial * fill, depth * fill, nr / length, nz / length], index * 4);
  }
  return values;
})();

/// Interior grains carry a superellipse normal for directional illumination.
/// Cut ends fade before a grain wraps to keep the gaps empty.
export function buildSegmentedTorusGrains(
  seconds: number,
  out: Float32Array = new Float32Array(SEGMENTED_TORUS_GRAIN_COUNT * SEGMENTED_TORUS_GRAIN_FLOATS),
): Float32Array {
  for (let index = 0; index < SEGMENTED_TORUS_GRAIN_COUNT; index += 1) {
    const chamber = Math.floor(index / GRAINS_PER_CHAMBER);
    const u = ((GRAIN_SEEDS[index * 5]! + seconds * 0.045) % 1 + 1) % 1;
    const size = GRAIN_SEEDS[index * 5 + 2]!;
    const angle = chamber * CHAMBER_ANGLE + SEGMENTED_TORUS_GAP / 2 + u * (CHAMBER_ANGLE - SEGMENTED_TORUS_GAP) + orbit(seconds);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const radial = GRAIN_SECTIONS[index * 4]!;
    const depth = GRAIN_SECTIONS[index * 4 + 1]!;
    const twist = angle * TWIST_RATE;
    const twistCos = Math.cos(twist);
    const twistSin = Math.sin(twist);
    const twistedRadial = radial * twistCos - depth * twistSin;
    const twistedDepth = radial * twistSin + depth * twistCos;
    const surfaceRadius = CENTER_RADIUS + twistedRadial;
    const radialNormal = GRAIN_SECTIONS[index * 4 + 2]!;
    const depthNormal = GRAIN_SECTIONS[index * 4 + 3]!;
    const nr = radialNormal * twistCos - depthNormal * twistSin;
    const nz = radialNormal * twistSin + depthNormal * twistCos;
    const nt = TWIST_RATE * (twistedDepth * nr - twistedRadial * nz) / surfaceRadius;
    const normalLength = Math.hypot(nr, nt, nz);
    const offset = index * SEGMENTED_TORUS_GRAIN_FLOATS;
    out[offset] = surfaceRadius * cos;
    out[offset + 1] = surfaceRadius * sin;
    out[offset + 2] = twistedDepth;
    out[offset + 3] = (nr * cos - nt * sin) / normalLength;
    out[offset + 4] = (nr * sin + nt * cos) / normalLength;
    out[offset + 5] = nz / normalLength;
    out[offset + 6] = 0.0018 + size ** 3 * 0.0035;
    out[offset + 7] = (0.6 + size * 0.4) * Math.min(1, u * 18, (1 - u) * 18);
    out[offset + 8] = GRAIN_SEEDS[index * 5 + 4]!;
  }
  return out;
}

const PROJECTION = `
uniform vec2 uResolution;
uniform float uScale;
const float CAMERA_DISTANCE = 12.0;

vec3 turn(vec3 p) {
  p.yz = mat2(cos(-0.84), -sin(-0.84), sin(-0.84), cos(-0.84)) * p.yz;
  p.xy = mat2(cos(-0.78), -sin(-0.78), sin(-0.78), cos(-0.78)) * p.xy;
  return p;
}
vec4 project(vec3 p, float bias) {
  float perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - p.z);
  return vec4(p.xy * perspective * uScale * 2.0 / uResolution, -p.z / 4.0 + bias, 1.0);
}
`;

const EDGE_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec3 aPosition;
uniform float uBias;
uniform float uOutline;
${PROJECTION}
void main() {
  gl_Position = project(turn(aPosition), uBias);
  if (uOutline > 0.0) {
    float angle = atan(aPosition.y, aPosition.x);
    float radius = length(aPosition.xy);
    float radial = radius - ${CENTER_RADIUS};
    float depth = aPosition.z;
    float twist = angle * ${TWIST_RATE};
    vec2 local = mat2(cos(twist), -sin(twist), sin(twist), cos(twist)) * vec2(radial, depth);
    vec2 gradient = sign(local) * pow(abs(local) / ${TUBE_RADIUS}, vec2(${SECTION_POWER - 1}.0));
    vec2 normal = mat2(cos(twist), sin(twist), -sin(twist), cos(twist)) * gradient;
    float tangent = ${TWIST_RATE} * (depth * normal.x - radial * normal.y) / radius;
    vec3 worldNormal = vec3(normal.x * cos(angle) - tangent * sin(angle), normal.x * sin(angle) + tangent * cos(angle), normal.y);
    vec2 screenNormal = turn(worldNormal).xy;
    gl_Position.xy += uOutline * screenNormal / max(length(screenNormal), 0.00001) * 2.0 / uResolution;
  }
}
`;

const GRAIN_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
in vec3 aGrain;
out float vRadius;
out float vAlpha;
${PROJECTION}
void main() {
  vec3 p = turn(aPosition);
  vec3 normal = turn(aNormal);
  gl_Position = project(p, -0.0005);
  vRadius = aGrain.x * uScale * CAMERA_DISTANCE / (CAMERA_DISTANCE - p.z);
  float facing = dot(normal, normalize(vec3(0.0, 0.0, CAMERA_DISTANCE) - p));
  float light = max(0.0, dot(normal, normalize(vec3(-0.5, 0.5, 1.0))));
  float density = 0.04 + 0.96 * pow(light, 3.0);
  float visible = smoothstep(aGrain.z - 0.04, aGrain.z + 0.04, density);
  vAlpha = aGrain.y * visible * smoothstep(0.0, 0.08, facing);
  gl_PointSize = 2.0 * vRadius + 2.0;
}
`;

export interface SegmentedTorusRenderer {
  draw(seconds: number, fieldScale: number, tone: number, opacity: number): void;
  destroy(): void;
}

export function createSegmentedTorusRenderer(gl: WebGL2RenderingContext): SegmentedTorusRenderer {
  const programs: WebGLProgram[] = [];
  const buffers: WebGLBuffer[] = [];
  function release(): void {
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    for (const program of programs) gl.deleteProgram(program);
  }
  function program(vertex: string, fragment: string) {
    const value = linkProgram(gl, vertex, fragment);
    programs.push(value);
    return {
      value,
      position: attribute(value, "aPosition"),
      resolution: uniformLocation(gl, value, "uResolution"),
      scale: uniformLocation(gl, value, "uScale"),
      tone: uniformLocation(gl, value, "uTone"),
      opacity: uniformLocation(gl, value, "uOpacity"),
    };
  }
  function attribute(program: WebGLProgram, name: string): number {
    const location = gl.getAttribLocation(program, name);
    if (location < 0) throw new Error(`missing shader attribute ${name}`);
    return location;
  }
  function buffer(data: Float32Array, usage: number): WebGLBuffer {
    const value = gl.createBuffer();
    if (!value) throw new Error("could not allocate torus buffer");
    buffers.push(value);
    gl.bindBuffer(gl.ARRAY_BUFFER, value);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    return value;
  }

  try {
    const mesh = buildSegmentedTorusMesh();
    const grains = buildSegmentedTorusGrains(0);
    const edgeProgram = program(EDGE_VERTEX_SHADER, LINE_SEGMENT_FRAGMENT_SHADER);
    const grainProgram = program(GRAIN_VERTEX_SHADER, ROUND_POINT_FRAGMENT_SHADER);
    const bias = uniformLocation(gl, edgeProgram.value, "uBias");
    const outline = uniformLocation(gl, edgeProgram.value, "uOutline");
    const normal = attribute(grainProgram.value, "aNormal");
    const grain = attribute(grainProgram.value, "aGrain");
    const faces = buffer(mesh.faces, gl.DYNAMIC_DRAW);
    const edges = buffer(mesh.edges, gl.DYNAMIC_DRAW);
    const particles = buffer(grains, gl.DYNAMIC_DRAW);

    function bind(target: ReturnType<typeof program>, fieldScale: number, tone: number, opacity: number): void {
      gl.useProgram(target.value);
      gl.uniform2f(target.resolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(target.scale, Math.min(gl.drawingBufferWidth, gl.drawingBufferHeight) * 0.47 * fieldScale);
      gl.uniform1f(target.tone, tone);
      gl.uniform1f(target.opacity, opacity);
    }
    function position(buffer: WebGLBuffer, location: number, stride = 0): void {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 3, gl.FLOAT, false, stride, 0);
    }

    return {
      draw(seconds, fieldScale, tone, opacity) {
        if (gl.drawingBufferWidth <= 0 || gl.drawingBufferHeight <= 0) return;
        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        // Front surfaces hide rear outlines. Back surfaces then let each
        // chamber's interior lights show without exposing the chambers behind.
        buildSegmentedTorusMesh(seconds, mesh);
        bind(edgeProgram, fieldScale, tone, opacity);
        position(faces, edgeProgram.position);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.faces);
        gl.uniform1f(bias, 0);
        gl.uniform1f(outline, 0);
        gl.colorMask(false, false, false, false);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.faces.length / 3);
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
        // The expanded back faces trace the silhouette of the rounded tube.
        // The front depth mask removes everything except the outer pixel rim.
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.FRONT);
        gl.uniform1f(outline, 1);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.faces.length / 3);
        gl.uniform1f(outline, 0);
        gl.disable(gl.CULL_FACE);
        gl.uniform1f(bias, -0.0005);
        position(edges, edgeProgram.position);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.edges);
        gl.drawArrays(gl.LINES, 0, mesh.edges.length / 3);
        gl.depthMask(true);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.colorMask(false, false, false, false);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.FRONT);
        position(faces, edgeProgram.position);
        gl.uniform1f(bias, 0);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.faces.length / 3);
        gl.disable(gl.CULL_FACE);
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
        gl.disableVertexAttribArray(edgeProgram.position);

        bind(grainProgram, fieldScale, tone, opacity);
        position(particles, grainProgram.position, SEGMENTED_TORUS_GRAIN_FLOATS * 4);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, buildSegmentedTorusGrains(seconds, grains));
        gl.enableVertexAttribArray(normal);
        gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, SEGMENTED_TORUS_GRAIN_FLOATS * 4, 12);
        gl.enableVertexAttribArray(grain);
        gl.vertexAttribPointer(grain, 3, gl.FLOAT, false, SEGMENTED_TORUS_GRAIN_FLOATS * 4, 24);
        gl.drawArrays(gl.POINTS, 0, SEGMENTED_TORUS_GRAIN_COUNT);
        gl.disableVertexAttribArray(grainProgram.position);
        gl.disableVertexAttribArray(normal);
        gl.disableVertexAttribArray(grain);
      },
      destroy: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
