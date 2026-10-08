import { linkProgram, uniformLocation } from "./webglProgram";

// A renderer for animations made of straight strokes: every segment is a
// one pixel line in one tone, blended over a transparent canvas so the pane
// shows through and crossing strokes build up.

/// A segment is four numbers: the x and y of each end in source units from
/// the center of the canvas, y growing downward.
export const LINE_SEGMENT_FLOATS = 4;

/// The context attributes a canvas drawing these needs. A line has no
/// interior to antialias in a shader, so the canvas is multisampled.
export const LINE_SEGMENT_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  antialias: true,
};

export const LINE_SEGMENT_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

uniform vec2 uResolution;
uniform float uScale;

void main() {
  vec2 clip = aPosition * uScale * 2.0 / uResolution;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

export const LINE_SEGMENT_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform float uTone;
uniform float uOpacity;
out vec4 o;

void main() {
  o = vec4(vec3(uTone) * uOpacity, uOpacity);
}
`;

/// A run of consecutive segments drawn at `weight` of the frame's opacity.
export interface LineSegmentRun {
  segmentCount: number;
  weight: number;
}

export interface LineSegmentFrame {
  segments: Float32Array;
  segmentCount: number;
  /// The segments in order as runs of differing weight, for a picture with
  /// fainter strokes among its full ones. Left out, every segment is drawn
  /// at the frame's opacity.
  runs?: readonly LineSegmentRun[];
  /// The side of the square the source draws on. It is fitted to the shorter
  /// side of the canvas, then scaled by `fieldScale`.
  sourceSize: number;
  fieldScale: number;
  tone: number;
  opacity: number;
}

export interface LineSegmentRenderer {
  draw(frame: LineSegmentFrame): void;
  destroy(): void;
}

export function createLineSegmentRenderer(
  gl: WebGL2RenderingContext,
): LineSegmentRenderer {
  const program = linkProgram(
    gl,
    LINE_SEGMENT_VERTEX_SHADER,
    LINE_SEGMENT_FRAGMENT_SHADER,
  );

  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    throw new Error("could not allocate vertex buffer");
  }
  const position = gl.getAttribLocation(program, "aPosition");
  if (position < 0) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    throw new Error("missing shader attribute aPosition");
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
      // so crossing strokes build up and the pane shows through the rest.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        frame.segments.subarray(
          0,
          frame.segmentCount * LINE_SEGMENT_FLOATS,
        ),
        gl.DYNAMIC_DRAW,
      );
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(resolution, width, height);
      gl.uniform1f(
        scale,
        (Math.min(width, height) / frame.sourceSize) * frame.fieldScale,
      );
      gl.uniform1f(tone, frame.tone);
      let first = 0;
      for (const run of frame.runs ?? [
        { segmentCount: frame.segmentCount, weight: 1 },
      ]) {
        gl.uniform1f(opacity, frame.opacity * run.weight);
        gl.drawArrays(gl.LINES, first * 2, run.segmentCount * 2);
        first += run.segmentCount;
      }
    },
    destroy() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
