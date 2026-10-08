import { describe, expect, test } from "vitest";
import { createRoundPointRenderer } from "./roundPoints";
import { recordingWebgl2, shaderSources, uniformsSet } from "../__tests__/canvas";

const frame = {
  points: Float32Array.from([1, 2, 3, 1, 4, 5, 6, 0.5, 7, 8, 9, 0.25]),
  pointCount: 2,
  sourceSize: 600,
  fieldScale: 1.5,
  tone: 0.5,
  opacity: 0.25,
};

describe("round point renderer", () => {
  test("uploads the counted points and draws them in one pass, scaled to the shorter side", () => {
    const { gl, calls } = recordingWebgl2();

    createRoundPointRenderer(gl).draw(frame);

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
      1, 2, 3, 1, 4, 5, 6, 0.5,
    ]);
    expect(
      calls.filter(({ op }) => op === "drawArrays").map(({ args }) => args),
    ).toEqual([["POINTS", 0, 2]]);
  });

  test("blends premultiplied points over a cleared, transparent canvas", () => {
    const { gl, calls } = recordingWebgl2();

    createRoundPointRenderer(gl).draw(frame);

    expect(calls).toContainEqual({ op: "clearColor", args: [0, 0, 0, 0] });
    expect(calls).toContainEqual({
      op: "blendFunc",
      args: ["ONE", "ONE_MINUS_SRC_ALPHA"],
    });
  });

  test("gives each point its own radius and opacity", () => {
    const { gl, calls } = recordingWebgl2();

    createRoundPointRenderer(gl);

    const [vertex, fragment] = shaderSources(calls);
    expect(vertex).toContain("vRadius = aPoint.z * uScale;");
    expect(vertex).toContain("vAlpha = aPoint.w;");
    expect(fragment).toContain("coverage * vAlpha * uOpacity");
  });

  test("frees its buffer and program", () => {
    const { gl, calls } = recordingWebgl2();

    createRoundPointRenderer(gl).destroy();

    expect(calls.map(({ op }) => op)).toEqual(
      expect.arrayContaining(["deleteBuffer", "deleteProgram"]),
    );
  });
});
