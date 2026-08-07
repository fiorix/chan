// Original Twigl source from Yohei Nishitsuji's #つぶやきGLSL post:
// https://x.com/YoheiNishitsuji/status/2081184095376441620

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const TURBULENT_OCULUS_TWIGL_SOURCE = `for(float i=0.,z=0.,d=0.,s=0.;i++<3e2;){vec3 q=z*normalize(vec3(FC.xy*2.-r,r.y));q.zx=abs(q.zx*.8);q.yx*=rotate2D(q.z*.01);for(s=.5;s<22.;s/=.5)q+=cos(q.yzx*s+t)/s;z+=d=.01+abs((length(q.yx)-23.))/6.;o+=.2/d;}o=tanh(o/9e2);`;

export const TURBULENT_OCULUS_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 r;
uniform float t;
uniform float uTone;
uniform float uOpacity;
out vec4 o;

#define FC gl_FragCoord

mat2 rotate2D(float r) {
  return mat2(cos(r), sin(r), -sin(r), cos(r));
}

const float BASE_CENTER_MASS_RADIUS = 0.08;
const float CENTER_MASS_SCALE = 2.0;

void main() {
  o = vec4(0.0);
  ${TURBULENT_OCULUS_TWIGL_SOURCE}
  vec2 center = (FC.xy * 2.0 - r) / r.y;
  float centerMassRadius = BASE_CENTER_MASS_RADIUS * CENTER_MASS_SCALE;
  float centerReveal = smoothstep(
    centerMassRadius * 0.72,
    centerMassRadius,
    length(center)
  );
  float alpha = o.r * centerReveal * uOpacity;
  o = vec4(vec3(uTone) * alpha, alpha);
}
`;

export interface TurbulentOculusRenderer {
  draw(timeSeconds: number, tone: number, opacity: number): void;
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

export function createTurbulentOculusRenderer(
  gl: WebGL2RenderingContext,
): TurbulentOculusRenderer {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      TURBULENT_OCULUS_FRAGMENT_SHADER,
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
  let tone: WebGLUniformLocation;
  let opacity: WebGLUniformLocation;
  try {
    resolution = uniformLocation(gl, program, "r");
    time = uniformLocation(gl, program, "t");
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
    draw(timeSeconds, nextTone, nextOpacity) {
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
