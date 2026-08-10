import {
  fitPointCloudCover,
  type PointCloudBounds,
} from "./pointCloudCover";

// The 2D path drew each point as a rect between 0.75 and 1.25 device
// pixels. GL rasterizes a point smaller than one pixel as a single
// fragment, so the lower bound only ever reads as 1px -- the same place
// the 2D fill landed once antialiasing collapsed the sub-pixel rect.
const MIN_POINT_SIZE = 0.75;
const MAX_POINT_SIZE = 1.25;

export const YURUYURAU_POINT_CLOUD_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

uniform vec2 uResolution;
uniform vec2 uCenter;
uniform vec2 uSourceCenter;
uniform float uScale;
uniform float uPointSize;

void main() {
  vec2 pixel = uCenter + (aPosition - uSourceCenter) * uScale;
  vec2 clip = pixel * 2.0 / uResolution - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = uPointSize;
}
`;

export const YURUYURAU_POINT_CLOUD_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform vec3 uPointColor;
uniform float uPointAlpha;
out vec4 o;

void main() {
  o = vec4(uPointColor, uPointAlpha);
}
`;

export interface YuruyurauPointCloudFrame {
  points: Float32Array;
  bounds: PointCloudBounds;
  backgroundColor: readonly [number, number, number];
  pointColor: readonly [number, number, number];
  pointAlpha: number;
}

export interface YuruyurauPointCloudRenderer {
  draw(frame: YuruyurauPointCloudFrame): void;
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

export function createYuruyurauPointCloudRenderer(
  gl: WebGL2RenderingContext,
): YuruyurauPointCloudRenderer {
  let pointProgram: WebGLProgram | null = null;
  let pointBuffer: WebGLBuffer | null = null;

  try {
    pointProgram = linkProgram(
      gl,
      YURUYURAU_POINT_CLOUD_VERTEX_SHADER,
      YURUYURAU_POINT_CLOUD_FRAGMENT_SHADER,
    );
    pointBuffer = gl.createBuffer();
    if (!pointBuffer) throw new Error("could not allocate vertex buffer");
  } catch (error) {
    if (pointProgram) gl.deleteProgram(pointProgram);
    if (pointBuffer) gl.deleteBuffer(pointBuffer);
    throw error;
  }

  const pointPosition = gl.getAttribLocation(pointProgram, "aPosition");
  if (pointPosition < 0) {
    gl.deleteProgram(pointProgram);
    gl.deleteBuffer(pointBuffer);
    throw new Error("missing shader attribute aPosition");
  }

  const pointResolution = uniformLocation(gl, pointProgram, "uResolution");
  const pointCenter = uniformLocation(gl, pointProgram, "uCenter");
  const pointSourceCenter = uniformLocation(gl, pointProgram, "uSourceCenter");
  const pointScale = uniformLocation(gl, pointProgram, "uScale");
  const pointSize = uniformLocation(gl, pointProgram, "uPointSize");
  const pointColor = uniformLocation(gl, pointProgram, "uPointColor");
  const pointAlpha = uniformLocation(gl, pointProgram, "uPointAlpha");

  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  let upload = new Float32Array(0);

  return {
    draw(frame) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;

      const transform = fitPointCloudCover(width, height, frame.bounds);
      const size = Math.max(
        MIN_POINT_SIZE,
        Math.min(MAX_POINT_SIZE, transform.scale),
      );

      // Points ship in source space and the vertex shader places them, so
      // the cull repeats the screen-space test the 2D path used: a chaotic
      // attractor throws stray points far outside the cover box, and they
      // would otherwise ride along in every upload.
      if (upload.length < frame.points.length) {
        upload = new Float32Array(frame.points.length);
      }
      let pointCount = 0;
      for (let index = 0; index < frame.points.length; index += 2) {
        const sourceX = frame.points[index];
        const sourceY = frame.points[index + 1];
        const x =
          transform.centerX +
          (sourceX - transform.sourceCenterX) * transform.scale;
        const y =
          transform.centerY +
          (sourceY - transform.sourceCenterY) * transform.scale;
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < -size ||
          x > width + size ||
          y < -size ||
          y > height + size
        ) {
          continue;
        }
        upload[pointCount * 2] = sourceX;
        upload[pointCount * 2 + 1] = sourceY;
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
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

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
      gl.uniform2f(pointCenter, transform.centerX, transform.centerY);
      gl.uniform2f(
        pointSourceCenter,
        transform.sourceCenterX,
        transform.sourceCenterY,
      );
      gl.uniform1f(pointScale, transform.scale);
      gl.uniform1f(pointSize, size);
      gl.uniform3f(
        pointColor,
        frame.pointColor[0],
        frame.pointColor[1],
        frame.pointColor[2],
      );
      gl.uniform1f(pointAlpha, frame.pointAlpha);
      gl.drawArrays(gl.POINTS, 0, pointCount);
    },
    destroy() {
      gl.deleteBuffer(pointBuffer);
      gl.deleteProgram(pointProgram);
    },
  };
}
