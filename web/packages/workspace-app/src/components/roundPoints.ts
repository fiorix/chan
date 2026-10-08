import { linkProgram, uniformLocation } from "./webglProgram";

// A renderer for animations made of round dots: each point is a filled,
// antialiased circle of its own radius and opacity, in one tone, blended over
// a transparent canvas so the pane shows through.

/// A point is four numbers: x and y in source units from the center of the
/// canvas, y growing downward, its radius in source units, and its opacity
/// from 0 to 1.
export const ROUND_POINT_FLOATS = 4;

export const ROUND_POINT_VERTEX_SHADER = `#version 300 es
in vec4 aPoint;

uniform vec2 uResolution;
uniform float uScale;
out float vRadius;
out float vAlpha;

void main() {
  vec2 clip = aPoint.xy * uScale * 2.0 / uResolution;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vRadius = aPoint.z * uScale;
  vAlpha = aPoint.w;
  // A pixel of margin on each side holds the antialiased rim.
  gl_PointSize = 2.0 * vRadius + 2.0;
}
`;

// A point thinner than a pixel still rasterizes as a whole one, so its
// coverage is scaled down by its diameter and it fades out as its radius
// goes to zero.
export const ROUND_POINT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in float vRadius;
in float vAlpha;
uniform float uTone;
uniform float uOpacity;
out vec4 o;

void main() {
  float distance =
    length(gl_PointCoord - 0.5) * (2.0 * vRadius + 2.0);
  float coverage =
    clamp(vRadius - distance + 0.5, 0.0, 1.0) * min(1.0, 2.0 * vRadius);
  float alpha = coverage * vAlpha * uOpacity;
  o = vec4(vec3(uTone) * alpha, alpha);
}
`;

export interface RoundPointFrame {
  points: Float32Array;
  pointCount: number;
  /// The side of the square the source draws on. It is fitted to the shorter
  /// side of the canvas, then scaled by `fieldScale`.
  sourceSize: number;
  fieldScale: number;
  tone: number;
  opacity: number;
}

export interface RoundPointRenderer {
  draw(frame: RoundPointFrame): void;
  destroy(): void;
}

export function createRoundPointRenderer(
  gl: WebGL2RenderingContext,
): RoundPointRenderer {
  const program = linkProgram(
    gl,
    ROUND_POINT_VERTEX_SHADER,
    ROUND_POINT_FRAGMENT_SHADER,
  );

  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    throw new Error("could not allocate vertex buffer");
  }
  const point = gl.getAttribLocation(program, "aPoint");
  if (point < 0) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    throw new Error("missing shader attribute aPoint");
  }

  let resolution: WebGLUniformLocation;
  let scale: WebGLUniformLocation;
  let tone: WebGLUniformLocation;
  let opacity: WebGLUniformLocation;
  try {
    resolution = uniformLocation(gl, program, "uResolution");
    scale = uniformLocation(gl, program, "uScale");
    tone = uniformLocation(gl, program, "uTone");
    opacity = uniformLocation(gl, program, "uOpacity");
  } catch (error) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    throw error;
  }

  gl.disable(gl.DEPTH_TEST);

  return {
    draw(frame) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // The shader writes premultiplied colour over a transparent canvas,
      // so overlapping points build up and the pane shows through the rest.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        frame.points.subarray(0, frame.pointCount * ROUND_POINT_FLOATS),
        gl.DYNAMIC_DRAW,
      );
      gl.enableVertexAttribArray(point);
      gl.vertexAttribPointer(
        point,
        ROUND_POINT_FLOATS,
        gl.FLOAT,
        false,
        0,
        0,
      );
      gl.uniform2f(resolution, width, height);
      gl.uniform1f(
        scale,
        (Math.min(width, height) / frame.sourceSize) * frame.fieldScale,
      );
      gl.uniform1f(tone, frame.tone);
      gl.uniform1f(opacity, frame.opacity);
      gl.drawArrays(gl.POINTS, 0, frame.pointCount);
    },
    destroy() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
