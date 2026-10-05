import { FULLSCREEN_TRIANGLE, linkProgram, uniformLocation } from "./webglProgram";

// Original Twigl source from Yohei Nishitsuji's #つぶやきGLSL post:
// https://x.com/YoheiNishitsuji/status/2106013834540732704

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const TENFOLD_DAHLIA_TWIGL_SOURCE = `float i,e,R,s;vec3 q,p,d=vec3((FC.xy-.5*r)/r.y,.8);for(q.z--;i++<99.;){o.rgb+=hsv(.1,-e,e/1.5e1);p=q+=d*max(e,.004)*R*.22;p=vec3(log2(R=length(p))-t*.3,e=asin(-p.z/R-.01)-.9,atan(p.x,p.y)*2.5-t*.3);for(s=2.;s<1e3/(i*.3);s+=s)e+=abs(dot(sin(p.yzx*s),cos(p.yzx*s)))/s;}`;

// The compact source relies on zero-valued locals. WebGL leaves them
// undefined, so the compiled form spells out the intended starting state.
// The post also assigns R in one constructor argument and divides by it in
// the next, which gives its picture only when the arguments are evaluated
// left to right. The compiled form makes those assignments statements, so
// the result does not rest on how a shader translator orders side effects
// inside an argument list.
// Every ray takes its first sample on the axis, where both arguments of the
// post's atan are zero. GLSL leaves that result undefined, and a driver that
// answers NaN there carries it into the summed colour of every pixel, which
// empties the whole frame. The compiled form asks for atan(0, 1) at that
// point instead, so the answer is zero on every driver. The attributed source
// above remains verbatim.
export const TENFOLD_DAHLIA_WEBGL_SOURCE =
  TENFOLD_DAHLIA_TWIGL_SOURCE.replace(
    "float i,e,R,s;vec3 q,p,d=",
    "float i=0.,e=0.,R=0.,s=0.;vec3 q=vec3(0.),p=vec3(0.),d=",
  ).replace(
    "p=vec3(log2(R=length(p))-t*.3,e=asin(-p.z/R-.01)-.9,atan(p.x,p.y)*2.5-t*.3);",
    "R=length(p);e=asin(-p.z/R-.01)-.9;p=vec3(log2(R)-t*.3,e,atan(p.x,p.xy==vec2(0.)?1.:p.y)*2.5-t*.3);",
  );

export const TENFOLD_DAHLIA_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 r;
uniform float t;
uniform float uFieldScale;
uniform float uTone;
uniform float uOpacity;
uniform float uExposure;
out vec4 o;

#define FC sourceCoordinate

vec3 hsv(float h, float s, float v) {
  vec4 k = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(vec3(h) + k.xyz) * 6.0 - vec3(k.w));
  return v * mix(vec3(k.x), clamp(p - vec3(k.x), 0.0, 1.0), s);
}

void main() {
  vec2 centered = gl_FragCoord.xy - r * 0.5;
  vec2 sourceCoordinate =
    r * 0.5 + centered * (r.y / min(r.x, r.y)) / uFieldScale;
  o = vec4(0.0);
  ${TENFOLD_DAHLIA_WEBGL_SOURCE}
  // The density is negative in the veins, and so is the colour it sums to.
  float intensity = max(max(o.r, max(o.g, o.b)), 0.0);
  float alpha = (1.0 - exp(-intensity * uExposure)) * uOpacity;
  o = vec4(vec3(uTone) * alpha, alpha);
}
`;

export interface TenfoldDahliaRenderer {
  draw(
    timeSeconds: number,
    fieldScale: number,
    tone: number,
    opacity: number,
    exposure: number,
  ): void;
  destroy(): void;
}

export function createTenfoldDahliaRenderer(
  gl: WebGL2RenderingContext,
): TenfoldDahliaRenderer {
  const program = linkProgram(gl, VERTEX_SHADER, TENFOLD_DAHLIA_FRAGMENT_SHADER);

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
    new Float32Array(FULLSCREEN_TRIANGLE),
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
