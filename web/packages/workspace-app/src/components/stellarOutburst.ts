// Original Twigl source from Yohei Nishitsuji's #つぶやきGLSL post:
// https://x.com/YoheiNishitsuji/status/2081001408665715188

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const STELLAR_OUTBURST_TWIGL_SOURCE = `vec2 p=(FC.xy*2.-r)/r.y;for(float i=0.,f,d,u,s,w,l;i++<1e3;){f=fract(t*.2+ceil(i/80.)*.4);d=f*5.;u=fract(i*.1)*2.-1.;s=sqrt(1.3-u*u);w=sin(i)+4.;l=length(p-vec2(s*cos(i),u)*d/w)*w;o.rgb+=hsv(.1,.3,1.7-f)*(clamp(-l,.0,1.)+exp(-l*79.));}o.rgb+=.02/(1e-2+dot(p,p));`;

export const STELLAR_OUTBURST_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 r;
uniform float t;
uniform float uFieldScale;
uniform float uTone;
uniform float uOpacity;
out vec4 o;

#define FC sourceCoordinate

vec3 hsv(float h, float s, float v) {
  vec4 k = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(vec3(h) + k.xyz) * 6.0 - vec3(k.w));
  return v * mix(vec3(k.x), clamp(p - vec3(k.x), 0.0, 1.0), s);
}

void main() {
  vec2 sourceCoordinate =
    r * 0.5 + (gl_FragCoord.xy - r * 0.5) / uFieldScale;
  o = vec4(0.0);
  ${STELLAR_OUTBURST_TWIGL_SOURCE}
  float intensity = max(o.r, max(o.g, o.b));
  float alpha = (1.0 - exp(-intensity)) * uOpacity;
  vec3 sourceHue = clamp(o.rgb / max(intensity, 0.0001), 0.0, 1.0);
  vec3 neutralHue = mix(vec3(1.0), sourceHue, 0.08);
  o = vec4(neutralHue * uTone * alpha, alpha);
}
`;

export interface StellarOutburstRenderer {
  draw(
    timeSeconds: number,
    fieldScale: number,
    tone: number,
    opacity: number,
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

export function createStellarOutburstRenderer(
  gl: WebGL2RenderingContext,
): StellarOutburstRenderer {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      STELLAR_OUTBURST_FRAGMENT_SHADER,
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
  try {
    resolution = uniformLocation(gl, program, "r");
    time = uniformLocation(gl, program, "t");
    fieldScale = uniformLocation(gl, program, "uFieldScale");
    tone = uniformLocation(gl, program, "uTone");
    opacity = uniformLocation(gl, program, "uOpacity");
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
    draw(timeSeconds, nextFieldScale, nextTone, nextOpacity) {
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
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
