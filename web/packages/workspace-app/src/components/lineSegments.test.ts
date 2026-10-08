import { describe, expect, test } from "vitest";
import {
  createLineSegmentRenderer,
  LINE_SEGMENT_CONTEXT_ATTRIBUTES,
} from "./lineSegments";
import { recordingWebgl2, uniformsSet } from "../__tests__/canvas";

const frame = {
  segments: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  segmentCount: 2,
  sourceSize: 600,
  fieldScale: 1.5,
  tone: 0.5,
  opacity: 0.25,
};

describe("line segment renderer", () => {
  test("uploads the counted segments and draws them as lines in one pass, scaled to the shorter side", () => {
    const { gl, calls } = recordingWebgl2();

    createLineSegmentRenderer(gl).draw(frame);

    // The recording context's drawing buffer is 100 by 100, a sixth of the
    // 600 unit source.
    expect(uniformsSet(calls, "uResolution")).toEqual([[100, 100]]);
    const [[scale]] = uniformsSet(calls, "uScale") as number[][];
    expect(scale).toBeCloseTo(0.25, 9);
    expect(uniformsSet(calls, "uTone")).toEqual([[0.5]]);
    expect(uniformsSet(calls, "uOpacity")).toEqual([[0.25]]);
    const uploads = calls.filter(({ op }) => op === "bufferData");
    expect(uploads).toHaveLength(1);
    expect(Array.from(uploads[0]!.args[1] as Float32Array)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    // Two vertices a segment.
    expect(
      calls.filter(({ op }) => op === "drawArrays").map(({ args }) => args),
    ).toEqual([["LINES", 0, 4]]);
  });

  test("blends premultiplied strokes over a cleared, transparent canvas", () => {
    const { gl, calls } = recordingWebgl2();

    createLineSegmentRenderer(gl).draw(frame);

    expect(calls).toContainEqual({ op: "clearColor", args: [0, 0, 0, 0] });
    expect(calls).toContainEqual({
      op: "blendFunc",
      args: ["ONE", "ONE_MINUS_SRC_ALPHA"],
    });
  });

  test("draws runs of segments one after another, each at its share of the opacity", () => {
    const { gl, calls } = recordingWebgl2();

    createLineSegmentRenderer(gl).draw({
      ...frame,
      segmentCount: 3,
      runs: [
        { segmentCount: 2, weight: 1 },
        { segmentCount: 1, weight: 0.5 },
      ],
    });

    expect(uniformsSet(calls, "uOpacity")).toEqual([[0.25], [0.125]]);
    expect(
      calls.filter(({ op }) => op === "drawArrays").map(({ args }) => args),
    ).toEqual([
      ["LINES", 0, 4],
      ["LINES", 4, 2],
    ]);
    expect(calls.filter(({ op }) => op === "bufferData")).toHaveLength(1);
  });

  test("asks for a multisampled canvas", () => {
    expect(LINE_SEGMENT_CONTEXT_ATTRIBUTES).toEqual({ antialias: true });
  });

  test("frees its buffer and program", () => {
    const { gl, calls } = recordingWebgl2();

    createLineSegmentRenderer(gl).destroy();

    expect(calls.map(({ op }) => op)).toEqual(
      expect.arrayContaining(["deleteBuffer", "deleteProgram"]),
    );
  });
});
