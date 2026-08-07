// Original Twigl source from Yohei Nishitsuji's #つぶやきGLSL post:
// https://x.com/YoheiNishitsuji/status/2078117522638004265

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const AMBER_RECURSION_TWIGL_SOURCE = `for(float i,g,e,s;++i<99.;o.rgb+=hsv(.09,.5,i*s/2e4)){vec3 p=vec3((FC.xy-.5*r)/r.x*.3,g-.05*sin(t));p.zx*=rotate2D(t*.5);s=1.5;for(int i;i++<9;p=vec3(2)-abs(p*e-.4/e)-sin(t)*.1)s*=e=max(1.07,4.5/dot(p*(3.-sin(t*.5)*.4),p*2.));g+=distance(p.xz,p.yx)/s;s=log(s)/g*.1;}`;

// The compact source relies on zero-valued loop locals. WebGL leaves them
// undefined, so the compiled form spells out the intended starting state
// while the attributed source above remains verbatim.
export const AMBER_RECURSION_WEBGL_SOURCE =
  AMBER_RECURSION_TWIGL_SOURCE.replace(
    "for(float i,g,e,s;",
    "for(float i=0.,g=0.,e=0.,s=0.;",
  ).replace("for(int i;i++<9;", "for(int i=0;i++<9;");

export const AMBER_RECURSION_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 r;
uniform float t;
uniform float uFieldScale;
uniform float uTone;
uniform float uOpacity;
uniform float uExposure;
out vec4 o;

#define FC sourceCoordinate

mat2 rotate2D(float angle) {
  return mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
}

vec3 hsv(float h, float s, float v) {
  vec4 k = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(vec3(h) + k.xyz) * 6.0 - vec3(k.w));
  return v * mix(vec3(k.x), clamp(p - vec3(k.x), 0.0, 1.0), s);
}

void main() {
  vec2 centered = gl_FragCoord.xy - r * 0.5;
  vec2 sourceCoordinate =
    r * 0.5 + centered * (r.x / min(r.x, r.y)) / uFieldScale;
  o = vec4(0.0);
  ${AMBER_RECURSION_WEBGL_SOURCE}
  float intensity = max(o.r, max(o.g, o.b));
  float alpha = (1.0 - exp(-intensity * uExposure)) * uOpacity;
  o = vec4(vec3(uTone) * alpha, alpha);
}
`;

export interface AmberRecursionRenderer {
  draw(
    timeSeconds: number,
    fieldScale: number,
    tone: number,
    opacity: number,
    exposure: number,
  ): void;
  destroy(): void;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not allocate shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) || "unknown compile error";
    gl.deleteShader(shader);
    throw new Error(detail);
  }
  return shader;
}

function uniformLocation(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new Error(`missing shader uniform ${name}`);
  return location;
}

export function createAmberRecursionRenderer(
  gl: WebGL2RenderingContext,
): AmberRecursionRenderer {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      AMBER_RECURSION_FRAGMENT_SHADER,
    );
  } catch (error) {
    gl.deleteShader(vertexShader);
    throw error;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("could not allocate shader program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program) || "unknown link error";
    gl.deleteProgram(program);
    throw new Error(detail);
  }

  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    throw new Error("could not allocate fullscreen triangle");
  }
  const position = gl.getAttribLocation(program, "aPosition");
  if (position < 0) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    throw new Error("missing shader attribute aPosition");
  }

  let resolution: WebGLUniformLocation;
  let time: WebGLUniformLocation;
  let fieldScale: WebGLUniformLocation;
  let tone: WebGLUniformLocation;
  let opacity: WebGLUniformLocation;
  let exposure: WebGLUniformLocation;
  try {
    resolution = uniformLocation(gl, program, "r");
    time = uniformLocation(gl, program, "t");
    fieldScale = uniformLocation(gl, program, "uFieldScale");
    tone = uniformLocation(gl, program, "uTone");
    opacity = uniformLocation(gl, program, "uOpacity");
    exposure = uniformLocation(gl, program, "uExposure");
  } catch (error) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    throw error;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  return {
    draw(
      timeSeconds,
      nextFieldScale,
      nextTone,
      nextOpacity,
      nextExposure,
    ) {
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(
        resolution,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
      );
      gl.uniform1f(time, timeSeconds);
      gl.uniform1f(fieldScale, nextFieldScale);
      gl.uniform1f(tone, nextTone);
      gl.uniform1f(opacity, nextOpacity);
      gl.uniform1f(exposure, nextExposure);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
