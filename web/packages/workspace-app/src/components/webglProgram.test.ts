// The WebGL2 program helpers over a recording stand-in context (jsdom has no
// WebGL2): what each returns on success, and what each throws and deletes
// when the driver refuses.

import { describe, expect, test } from "vitest";

import { recordingWebgl2 } from "../__tests__/canvas";
import { FULLSCREEN_TRIANGLE, compileShader, linkProgram, uniformLocation } from "./webglProgram";

function deleted(calls: { op: string; args: unknown[] }[]): string[] {
  return calls
    .filter(({ op }) => op.startsWith("delete"))
    .map(({ op, args }) => `${op} ${JSON.stringify(args[0])}`);
}

describe("compileShader", () => {
  test("returns the compiled shader", () => {
    const { gl, calls } = recordingWebgl2();
    expect(compileShader(gl, gl.VERTEX_SHADER, "void main() {}")).toEqual({ created: "createShader" });
    expect(calls.map(({ op }) => op)).toEqual(["createShader", "shaderSource", "compileShader", "getShaderParameter"]);
  });

  test("throws the info log and deletes the shader on a compile error", () => {
    const { gl, calls } = recordingWebgl2({
      getShaderParameter: () => false,
      getShaderInfoLog: () => "ERROR: 0:1: syntax error",
    });
    expect(() => compileShader(gl, gl.FRAGMENT_SHADER, "bad")).toThrow("ERROR: 0:1: syntax error");
    expect(deleted(calls)).toEqual(['deleteShader {"created":"createShader"}']);
  });

  test("names an empty info log as an unknown compile error", () => {
    const { gl } = recordingWebgl2({ getShaderParameter: () => false, getShaderInfoLog: () => "" });
    expect(() => compileShader(gl, gl.FRAGMENT_SHADER, "bad")).toThrow("unknown compile error");
  });

  test("throws when the driver allocates no shader", () => {
    const { gl } = recordingWebgl2({ createShader: () => null });
    expect(() => compileShader(gl, gl.VERTEX_SHADER, "void main() {}")).toThrow("could not allocate shader");
  });
});

describe("linkProgram", () => {
  test("links both shaders and deletes them once linked", () => {
    const { gl, calls } = recordingWebgl2();
    expect(linkProgram(gl, "vertex", "fragment")).toEqual({ created: "createProgram" });
    expect(calls.filter(({ op }) => op === "shaderSource").map(({ args }) => args[1])).toEqual([
      "vertex",
      "fragment",
    ]);
    expect(deleted(calls)).toEqual([
      'deleteShader {"created":"createShader"}',
      'deleteShader {"created":"createShader"}',
    ]);
  });

  test("deletes the vertex shader when the fragment shader fails to compile", () => {
    let compiled = 0;
    const { gl, calls } = recordingWebgl2({
      getShaderParameter: () => ++compiled === 1,
      getShaderInfoLog: () => "fragment error",
    });
    expect(() => linkProgram(gl, "vertex", "fragment")).toThrow("fragment error");
    expect(deleted(calls)).toHaveLength(2);
    expect(calls.map(({ op }) => op)).not.toContain("createProgram");
  });

  test("deletes both shaders when the driver allocates no program", () => {
    const { gl, calls } = recordingWebgl2({ createProgram: () => null });
    expect(() => linkProgram(gl, "vertex", "fragment")).toThrow("could not allocate shader program");
    expect(deleted(calls)).toHaveLength(2);
  });

  test("throws the info log and deletes the program on a link error", () => {
    const { gl, calls } = recordingWebgl2({
      getProgramParameter: () => false,
      getProgramInfoLog: () => "link failed: varying mismatch",
    });
    expect(() => linkProgram(gl, "vertex", "fragment")).toThrow("link failed: varying mismatch");
    expect(deleted(calls)).toContain('deleteProgram {"created":"createProgram"}');
  });
});

describe("uniformLocation", () => {
  test("returns the location of a uniform the program has", () => {
    const { gl } = recordingWebgl2();
    expect(uniformLocation(gl, {} as WebGLProgram, "uTime")).toEqual({ uniform: "uTime" });
  });

  test("throws naming a uniform the program does not have", () => {
    const { gl } = recordingWebgl2({ getUniformLocation: () => null });
    expect(() => uniformLocation(gl, {} as WebGLProgram, "uGone")).toThrow("missing shader uniform uGone");
  });
});

describe("FULLSCREEN_TRIANGLE", () => {
  test("is one triangle whose corners cover clip space", () => {
    expect([...FULLSCREEN_TRIANGLE]).toEqual([-1, -1, 3, -1, -1, 3]);
  });
});
