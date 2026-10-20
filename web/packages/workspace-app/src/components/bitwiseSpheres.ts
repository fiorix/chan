import { linkProgram, uniformLocation } from "./webglProgram";

// Geometry and motion adapted from yuruyurau's Processing Python-mode sketch:
// https://x.com/yuruyurau/status/1283102963112636416
export const BITWISE_SPHERES_SOURCE = "N=256\ndef setup():size(N*2,N*2,P3D);noStroke()\ndef draw():clear();translate(N,N);[2*i%N&(i/N*2+frameCount)or circle(i%N*2-N,i/N*2-N,3)for i in range(N*N)];rotateX(2);e=get();clear();[s.setTexture(e)or shape(s)for s in[createShape(40,-~i*30)for i in range(6)]]";

export const BITWISE_SPHERES_RADII = [30, 60, 90, 120, 150, 180] as const;

export function buildBitwiseSphere(): Float32Array {
  const vertices: number[] = [];
  const detail = 30;
  function vertex(x: number, y: number): number[] {
    const u = x / detail;
    const v = y / detail;
    const theta = u * Math.PI * 2;
    const phi = v * Math.PI - Math.PI / 2;
    return [Math.cos(phi) * Math.sin(theta), Math.sin(phi), Math.cos(phi) * Math.cos(theta), u, v];
  }
  for (let y = 0; y < detail; y += 1) for (let x = 0; x < detail; x += 1) {
    const a = vertex(x, y); const b = vertex(x + 1, y);
    const c = vertex(x + 1, y + 1); const d = vertex(x, y + 1);
    vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return new Float32Array(vertices);
}

export const BITWISE_SPHERES_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec2 aUv;
uniform vec2 uClipScale;
uniform float uRadius;
out vec2 vUv;
void main() {
  vec3 p = aPosition * uRadius;
  p.yz = mat2(cos(2.0), sin(2.0), -sin(2.0), cos(2.0)) * p.yz;
  const float camera = 443.40500673763256;
  const float nearPlane = camera / 10.0;
  const float farPlane = camera * 10.0;
  float depth = camera - p.z;
  float z = (farPlane + nearPlane) / (farPlane - nearPlane) * depth - 2.0 * farPlane * nearPlane / (farPlane - nearPlane);
  gl_Position = vec4(p.x * camera * uClipScale.x, -p.y * camera * uClipScale.y, z, depth);
  vUv = aUv;
}
`;

// Evaluate the captured dot bitmap on the sphere, avoiding get()'s readback
// and the six per-frame texture uploads. The grid is the source's 512px
// canvas, with 3px dots on 2px centers and Python 2 integer division.
export const BITWISE_SPHERES_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform int uFrame;
uniform float uTone;
uniform float uOpacity;
out vec4 o;
void main() {
  vec2 pixel = vUv * 512.0;
  ivec2 cell = ivec2(floor(pixel / 2.0));
  float aa = max(0.5, length(fwidth(pixel)) * 0.5);
  float coverage = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 dotCell = cell + ivec2(x, y);
      if (any(lessThan(dotCell, ivec2(0))) || any(greaterThanEqual(dotCell, ivec2(256)))) continue;
      if (((2 * dotCell.x % 256) & (2 * dotCell.y + uFrame)) != 0) continue;
      float radius = length(pixel - vec2(dotCell) * 2.0);
      float dotAlpha = 1.0 - smoothstep(1.5 - aa, 1.5 + aa, radius);
      coverage += dotAlpha * (1.0 - coverage);
    }
  }
  float alpha = coverage * uOpacity;
  if (alpha == 0.0) discard;
  o = vec4(vec3(uTone) * alpha, alpha);
}
`;

export function createBitwiseSpheresRenderer(gl: WebGL2RenderingContext) {
  const program = linkProgram(gl, BITWISE_SPHERES_VERTEX_SHADER, BITWISE_SPHERES_FRAGMENT_SHADER);
  const buffer = gl.createBuffer();
  function destroy(): void { gl.deleteBuffer(buffer); gl.deleteProgram(program); }
  const uniforms: Record<string, WebGLUniformLocation> = {};
  let position: number; let uv: number;
  try {
    if (!buffer) throw new Error("could not allocate sphere buffer");
    position = gl.getAttribLocation(program, "aPosition"); uv = gl.getAttribLocation(program, "aUv");
    if (position < 0 || uv < 0) throw new Error("missing textured sphere attribute");
    for (const name of ["uClipScale", "uRadius", "uFrame", "uTone", "uOpacity"]) uniforms[name] = uniformLocation(gl, program, name);
  } catch (error) { destroy(); throw error; }
  const mesh = buildBitwiseSphere();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
  return {
    draw(frame: number, fieldScale: number, tone: number, opacity: number): void {
      const width = gl.drawingBufferWidth; const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(uv); gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 20, 12);
      const scale = Math.min(width, height) / 512 * fieldScale;
      gl.uniform2f(uniforms.uClipScale, 2 * scale / width, 2 * scale / height);
      gl.uniform1i(uniforms.uFrame, ((Math.floor(frame) % 256) + 256) % 256);
      gl.uniform1f(uniforms.uTone, tone); gl.uniform1f(uniforms.uOpacity, opacity);
      for (const radius of BITWISE_SPHERES_RADII) {
        gl.uniform1f(uniforms.uRadius, radius);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.length / 5);
      }
    },
    destroy,
  };
}
