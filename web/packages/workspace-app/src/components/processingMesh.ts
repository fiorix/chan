import { linkProgram, uniformLocation } from "./webglProgram";

export type MeshMatrix = Float32Array;
export type MeshVector = [number, number, number];
export interface ProcessingMesh {
  kind: "box" | "torus" | "sphere";
  vertices: Float32Array;
  edges: Float32Array;
}

export function meshIdentity(): MeshMatrix {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function meshMultiply(a: MeshMatrix, b: MeshMatrix): MeshMatrix {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    }
  }
  return out;
}

export function meshTranslation(x: number, y: number, z: number): MeshMatrix {
  const m = meshIdentity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function meshRotation(axis: "x" | "y" | "z", angle: number): MeshMatrix {
  const m = meshIdentity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [a, b] = axis === "x" ? [1, 2] : axis === "y" ? [2, 0] : [0, 1];
  m[a * 4 + a] = c; m[b * 4 + b] = c;
  m[a * 4 + b] = s; m[b * 4 + a] = -s;
  return m;
}

export function buildProcessingBox(): ProcessingMesh {
  const vertices: number[] = [];
  const edges: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    for (const sign of [-1, 1]) {
      const normal = [0, 0, 0]; normal[axis] = sign;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
        const p = [0, 0, 0]; p[axis] = sign / 2;
        p[(axis + 1) % 3] = u / 2; p[(axis + 2) % 3] = v * sign / 2;
        return [...p, ...normal];
      });
      for (const i of [0, 1, 2, 0, 2, 3]) vertices.push(...corners[i]);
    }
  }
  // Box strokes follow the twelve physical edges, without face diagonals.
  for (let axis = 0; axis < 3; axis += 1) {
    for (const a of [-0.5, 0.5]) for (const b of [-0.5, 0.5]) {
      for (const end of [-0.5, 0.5]) {
        const p = [0, 0, 0]; p[axis] = end; p[(axis + 1) % 3] = a; p[(axis + 2) % 3] = b;
        edges.push(...p, 0, 0, 1);
      }
    }
  }
  return { kind: "box", vertices: new Float32Array(vertices), edges: new Float32Array(edges) };
}

export function buildProcessingSurface(kind: "torus" | "sphere", around: number, across: number): ProcessingMesh {
  const vertices: number[] = [];
  const edges: number[] = [];
  function vertex(u: number, v: number): number[] {
    const theta = u * Math.PI * 2;
    if (kind === "torus") {
      const phi = v * Math.PI * 2;
      return [Math.cos(theta), Math.sin(theta), 0,
        Math.cos(phi) * Math.cos(theta), Math.cos(phi) * Math.sin(theta), Math.sin(phi)];
    }
    const phi = v * Math.PI - Math.PI / 2;
    const p = [Math.cos(phi) * Math.sin(theta), Math.sin(phi), Math.cos(phi) * Math.cos(theta)];
    return [...p, ...p];
  }
  for (let y = 0; y < across; y += 1) for (let x = 0; x < around; x += 1) {
    const a = vertex(x / around, y / across);
    const b = vertex((x + 1) / around, y / across);
    const c = vertex((x + 1) / around, (y + 1) / across);
    const d = vertex(x / around, (y + 1) / across);
    vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
    if (around <= 24 && across <= 16) edges.push(...a, ...b, ...b, ...c, ...c, ...a, ...a, ...d, ...d, ...c);
  }
  return { kind, vertices: new Float32Array(vertices), edges: new Float32Array(edges) };
}

export const PROCESSING_MESH_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uModel;
uniform vec3 uSize;
uniform int uKind;
uniform vec2 uClipScale;
uniform float uEdge;
out vec3 vPosition;
out vec3 vNormal;
void main() {
  vec3 p = uKind == 1 ? aPosition * uSize.x + aNormal * uSize.y : aPosition * uSize;
  vec3 n = uKind == 0 ? aNormal / max(abs(uSize), vec3(0.000001)) : aNormal;
  vPosition = (uModel * vec4(p, 1.0)).xyz;
  vNormal = mat3(uModel) * n;
  const float camera = 346.41016151377545;
  const float nearPlane = camera / 10.0;
  const float farPlane = camera * 10.0;
  float depth = camera - vPosition.z;
  float z = (farPlane + nearPlane) / (farPlane - nearPlane) * depth - 2.0 * farPlane * nearPlane / (farPlane - nearPlane);
  gl_Position = vec4(vPosition.x * camera * uClipScale.x, -vPosition.y * camera * uClipScale.y, z - uEdge * depth * 0.0001, depth);
}
`;

export const PROCESSING_MESH_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vPosition;
in vec3 vNormal;
uniform vec3 uPointLight;
uniform int uLight;
uniform float uTone;
uniform float uAlpha;
out vec4 o;
void main() {
  vec3 n = vNormal / max(length(vNormal), 0.000001);
  float light = 1.0;
  if (uLight == 1) light = (128.0 / 255.0) * (1.0 + max(0.0, n.z));
  if (uLight == 2) {
    vec3 delta = uPointLight - vPosition;
    light = max(0.0, dot(n, delta / max(length(delta), 0.000001)));
  }
  // Put diffuse intensity into coverage so the monochrome surface keeps
  // its shading in both the dark and light palettes.
  float alpha = uAlpha * min(1.0, light);
  o = vec4(vec3(uTone) * alpha, alpha);
}
`;

export interface ProcessingMeshDraw {
  mesh: ProcessingMesh;
  model: MeshMatrix;
  size: MeshVector;
  alpha: number;
  light: 0 | 1 | 2;
  edgeAlpha?: number;
}

export function createProcessingMeshRenderer(gl: WebGL2RenderingContext) {
  const program = linkProgram(gl, PROCESSING_MESH_VERTEX_SHADER, PROCESSING_MESH_FRAGMENT_SHADER);
  const buffers = new Map<ProcessingMesh, { faces: WebGLBuffer; edges: WebGLBuffer }>();
  const uniforms: Record<string, WebGLUniformLocation> = {};
  let position: number;
  let normal: number;
  function destroy(): void {
    for (const b of buffers.values()) { gl.deleteBuffer(b.faces); gl.deleteBuffer(b.edges); }
    buffers.clear(); gl.deleteProgram(program);
  }
  try {
    position = gl.getAttribLocation(program, "aPosition");
    normal = gl.getAttribLocation(program, "aNormal");
    if (position < 0 || normal < 0) throw new Error("missing mesh attribute");
    for (const name of ["uModel", "uSize", "uKind", "uClipScale", "uEdge", "uPointLight", "uLight", "uTone", "uAlpha"]) uniforms[name] = uniformLocation(gl, program, name);
  } catch (error) { destroy(); throw error; }
  let opacity = 1;
  function bind(buffer: WebGLBuffer): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position); gl.enableVertexAttribArray(normal);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 24, 12);
  }
  return {
    begin(fieldScale: number, tone: number, nextOpacity: number, pointLight: MeshVector = [0, 0, 0], clear = true): void {
      opacity = nextOpacity;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.DEPTH_BUFFER_BIT | (clear ? gl.COLOR_BUFFER_BIT : 0));
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(program);
      const scale = Math.min(gl.drawingBufferWidth, gl.drawingBufferHeight) / 400 * fieldScale;
      gl.uniform2f(uniforms.uClipScale, 2 * scale / gl.drawingBufferWidth, 2 * scale / gl.drawingBufferHeight);
      gl.uniform1f(uniforms.uTone, tone);
      gl.uniform3f(uniforms.uPointLight, ...pointLight);
    },
    draw(draw: ProcessingMeshDraw): void {
      let b = buffers.get(draw.mesh);
      if (!b) {
        const faces = gl.createBuffer(); const edges = gl.createBuffer();
        if (!faces || !edges) { gl.deleteBuffer(faces); gl.deleteBuffer(edges); throw new Error("could not allocate mesh buffers"); }
        b = { faces, edges }; buffers.set(draw.mesh, b);
        gl.bindBuffer(gl.ARRAY_BUFFER, faces); gl.bufferData(gl.ARRAY_BUFFER, draw.mesh.vertices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, edges); gl.bufferData(gl.ARRAY_BUFFER, draw.mesh.edges, gl.STATIC_DRAW);
      }
      gl.uniformMatrix4fv(uniforms.uModel, false, draw.model);
      gl.uniform3f(uniforms.uSize, ...draw.size);
      gl.uniform1i(uniforms.uKind, draw.mesh.kind === "torus" ? 1 : draw.mesh.kind === "sphere" ? 2 : 0);
      gl.uniform1i(uniforms.uLight, draw.light);
      gl.uniform1f(uniforms.uAlpha, draw.alpha * opacity);
      gl.uniform1f(uniforms.uEdge, 0);
      bind(b.faces); gl.drawArrays(gl.TRIANGLES, 0, draw.mesh.vertices.length / 6);
      if (draw.edgeAlpha && draw.mesh.edges.length) {
        gl.uniform1i(uniforms.uLight, 0);
        gl.uniform1f(uniforms.uAlpha, draw.edgeAlpha * opacity);
        gl.uniform1f(uniforms.uEdge, 1);
        bind(b.edges); gl.drawArrays(gl.LINES, 0, draw.mesh.edges.length / 6);
      }
    },
    destroy,
  };
}
