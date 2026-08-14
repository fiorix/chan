export const YURUYURAU_ROTATIONAL_SOURCE_SIZE = 400;
const SOURCE_CENTER = YURUYURAU_ROTATIONAL_SOURCE_SIZE / 2;

export const YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

uniform vec2 uResolution;
uniform float uRotation;
uniform float uCoverScale;

void main() {
  vec2 centered = aPosition - ${SOURCE_CENTER}.0;
  float cosine = cos(uRotation);
  float sine = sin(uRotation);
  vec2 rotated = vec2(
    centered.x * cosine - centered.y * sine,
    centered.x * sine + centered.y * cosine
  );
  vec2 clip = (rotated * uCoverScale) * 2.0 / uResolution;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

export const YURUYURAU_ROTATIONAL_POINT_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform vec3 uPointColor;
uniform float uPointAlpha;
out vec4 o;

void main() {
  o = vec4(uPointColor, uPointAlpha);
}
`;

const FULLSCREEN_TRIANGLE_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// Center fade overlay: piecewise-linear radial gradient over the background
// color with stops (0, 0.192), (0.55, 0.164), (1, 0) — the 2D canvas
// createRadialGradient stops (0.96, 0.82) scaled to 20%, keeping the center
// quiet without blanking it out.
export const YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform vec3 uBackgroundColor;
uniform float uFadeInnerRadius;
uniform float uFadeOuterRadius;
out vec4 o;

void main() {
  float centerDistance = distance(gl_FragCoord.xy, uResolution * 0.5);
  float t = clamp(
    (centerDistance - uFadeInnerRadius) /
      max(uFadeOuterRadius - uFadeInnerRadius, 0.0001),
    0.0,
    1.0
  );
  float alpha = t < 0.55
    ? mix(0.192, 0.164, t / 0.55)
    : mix(0.164, 0.0, (t - 0.55) / 0.45);
  o = vec4(uBackgroundColor, alpha);
}
`;

export interface YuruyurauRotationalFrame {
  points: Float32Array;
  rotationCount: number;
  backgroundColor: readonly [number, number, number];
  pointColor: readonly [number, number, number];
  pointAlpha: number;
  fadeInnerRadius: number;
  fadeOuterRadius: number;
}

export interface YuruyurauRotationalRenderer {
  draw(frame: YuruyurauRotationalFrame): void;
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

function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
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
  return program;
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

export function createYuruyurauRotationalRenderer(
  gl: WebGL2RenderingContext,
): YuruyurauRotationalRenderer {
  let pointProgram: WebGLProgram | null = null;
  let fadeProgram: WebGLProgram | null = null;
  let pointBuffer: WebGLBuffer | null = null;
  let triangleBuffer: WebGLBuffer | null = null;

  try {
    pointProgram = linkProgram(
      gl,
      YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER,
      YURUYURAU_ROTATIONAL_POINT_FRAGMENT_SHADER,
    );
    fadeProgram = linkProgram(
      gl,
      FULLSCREEN_TRIANGLE_VERTEX_SHADER,
      YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER,
    );
    pointBuffer = gl.createBuffer();
    triangleBuffer = gl.createBuffer();
    if (!pointBuffer || !triangleBuffer) {
      throw new Error("could not allocate vertex buffers");
    }
  } catch (error) {
    if (pointProgram) gl.deleteProgram(pointProgram);
    if (fadeProgram) gl.deleteProgram(fadeProgram);
    if (pointBuffer) gl.deleteBuffer(pointBuffer);
    if (triangleBuffer) gl.deleteBuffer(triangleBuffer);
    throw error;
  }

  if (!pointProgram || !fadeProgram || !pointBuffer || !triangleBuffer) {
    throw new Error("could not allocate renderer resources");
  }

  const pointPosition = gl.getAttribLocation(pointProgram, "aPosition");
  const fadePosition = gl.getAttribLocation(fadeProgram, "aPosition");
  if (pointPosition < 0 || fadePosition < 0) {
    gl.deleteProgram(pointProgram);
    gl.deleteProgram(fadeProgram);
    gl.deleteBuffer(pointBuffer);
    gl.deleteBuffer(triangleBuffer);
    throw new Error("missing shader attribute aPosition");
  }

  const pointResolution = uniformLocation(gl, pointProgram, "uResolution");
  const pointRotation = uniformLocation(gl, pointProgram, "uRotation");
  const pointCoverScale = uniformLocation(gl, pointProgram, "uCoverScale");
  const pointColor = uniformLocation(gl, pointProgram, "uPointColor");
  const pointAlpha = uniformLocation(gl, pointProgram, "uPointAlpha");
  const fadeResolution = uniformLocation(gl, fadeProgram, "uResolution");
  const fadeBackground = uniformLocation(gl, fadeProgram, "uBackgroundColor");
  const fadeInnerRadius = uniformLocation(
    gl,
    fadeProgram,
    "uFadeInnerRadius",
  );
  const fadeOuterRadius = uniformLocation(
    gl,
    fadeProgram,
    "uFadeOuterRadius",
  );

  gl.bindBuffer(gl.ARRAY_BUFFER, triangleBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  let upload = new Float32Array(0);

  return {
    draw(frame) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;

      // All copies share one upload. Excluding points outside the source
      // square keeps bloom singularities from reaching the canvas edges.
      if (upload.length < frame.points.length) {
        upload = new Float32Array(frame.points.length);
      }
      let pointCount = 0;
      for (let index = 0; index < frame.points.length; index += 2) {
        const x = frame.points[index];
        const y = frame.points[index + 1];
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          x > YURUYURAU_ROTATIONAL_SOURCE_SIZE ||
          y < 0 ||
          y > YURUYURAU_ROTATIONAL_SOURCE_SIZE
        ) {
          continue;
        }
        upload[pointCount * 2] = x;
        upload[pointCount * 2 + 1] = y;
        pointCount += 1;
      }

      gl.disable(gl.BLEND);
      gl.clearColor(
        frame.backgroundColor[0],
        frame.backgroundColor[1],
        frame.backgroundColor[2],
        1,
      );
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      // Blend color only; destination alpha stays 1 (covers the point
      // copies and the fade overlay). Plain blendFunc erodes it and the
      // premultiplied canvas composites the page through every drawn
      // pixel by a term that scales with page brightness: a subtle
      // brightening on the dark theme, a white washout on light.
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ZERO,
        gl.ONE,
      );

      gl.useProgram(pointProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        upload.subarray(0, pointCount * 2),
        gl.DYNAMIC_DRAW,
      );
      gl.enableVertexAttribArray(pointPosition);
      gl.vertexAttribPointer(pointPosition, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(pointResolution, width, height);
      gl.uniform1f(
        pointCoverScale,
        Math.max(width, height) / YURUYURAU_ROTATIONAL_SOURCE_SIZE,
      );
      gl.uniform3f(
        pointColor,
        frame.pointColor[0],
        frame.pointColor[1],
        frame.pointColor[2],
      );
      gl.uniform1f(pointAlpha, frame.pointAlpha);
      for (let copy = 0; copy < frame.rotationCount; copy += 1) {
        gl.uniform1f(
          pointRotation,
          (copy * Math.PI * 2) / frame.rotationCount,
        );
        gl.drawArrays(gl.POINTS, 0, pointCount);
      }

      gl.useProgram(fadeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, triangleBuffer);
      gl.enableVertexAttribArray(fadePosition);
      gl.vertexAttribPointer(fadePosition, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(fadeResolution, width, height);
      gl.uniform3f(
        fadeBackground,
        frame.backgroundColor[0],
        frame.backgroundColor[1],
        frame.backgroundColor[2],
      );
      gl.uniform1f(fadeInnerRadius, frame.fadeInnerRadius);
      gl.uniform1f(fadeOuterRadius, frame.fadeOuterRadius);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.deleteBuffer(pointBuffer);
      gl.deleteBuffer(triangleBuffer);
      gl.deleteProgram(pointProgram);
      gl.deleteProgram(fadeProgram);
    },
  };
}
