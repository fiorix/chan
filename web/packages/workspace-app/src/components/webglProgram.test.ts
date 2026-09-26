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

/// Shaders that carry the type they were created with, so a deletion names
/// the shader it freed. Enums read back as their names, so a vertex shader is
/// `{ shader: "VERTEX_SHADER" }`.
const TYPED_SHADERS = { createShader: (type: unknown) => ({ shader: type }) };

/// The calls in order, each shader deletion naming the shader's type.
function sequence(calls: { op: string; args: unknown[] }[]): string[] {
  return calls.map(({ op, args }) =>
    op === "deleteShader" ? `deleteShader ${(args[0] as { shader: string }).shader}` : op,
  );
}

const BOTH_DELETED = ["deleteShader FRAGMENT_SHADER", "deleteShader VERTEX_SHADER"];

function shaderDeletions(ops: string[]): string[] {
  return ops.filter((op) => op.startsWith("deleteShader")).sort();
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
  test("links both shaders, then deletes each of them once", () => {
    const { gl, calls } = recordingWebgl2(TYPED_SHADERS);
    expect(linkProgram(gl, "vertex", "fragment")).toEqual({ created: "createProgram" });
    expect(calls.filter(({ op }) => op === "shaderSource").map(({ args }) => args[1])).toEqual([
      "vertex",
      "fragment",
    ]);
    const ops = sequence(calls);
    const linked = ops.indexOf("linkProgram");
    expect(linked, "the program is linked").toBeGreaterThan(-1);
    // A shader deleted before it is attached cannot be attached, and the link
    // then fails in a browser.
    expect(shaderDeletions(ops.slice(0, linked)), "no shader is deleted before the link").toEqual([]);
    expect(shaderDeletions(ops.slice(linked)), "each shader is deleted once after the link").toEqual(BOTH_DELETED);
  });

  test("deletes each shader once when the fragment shader fails to compile", () => {
    let compiled = 0;
    const { gl, calls } = recordingWebgl2({
      ...TYPED_SHADERS,
      getShaderParameter: () => ++compiled === 1,
      getShaderInfoLog: () => "fragment error",
    });
    expect(() => linkProgram(gl, "vertex", "fragment")).toThrow("fragment error");
    expect(shaderDeletions(sequence(calls))).toEqual(BOTH_DELETED);
    expect(calls.map(({ op }) => op)).not.toContain("createProgram");
  });

  test("deletes each shader once when the driver allocates no program", () => {
    const { gl, calls } = recordingWebgl2({ ...TYPED_SHADERS, createProgram: () => null });
    expect(() => linkProgram(gl, "vertex", "fragment")).toThrow("could not allocate shader program");
    expect(shaderDeletions(sequence(calls))).toEqual(BOTH_DELETED);
  });

  test("throws the info log and deletes the program on a link error", () => {
    const { gl, calls } = recordingWebgl2({
      getProgramParameter: () => false,
      getProgramInfoLog: () => "link failed: varying mismatch",
    });
    expect(() => linkProgram(gl, "vertex", "fragment")).toThrow("link failed: varying mismatch");
    expect(deleted(calls)).toContain('deleteProgram {"created":"createProgram"}');
  });

  test("names an empty link log as an unknown link error", () => {
    const { gl } = recordingWebgl2({ getProgramParameter: () => false, getProgramInfoLog: () => "" });
    expect(() => linkProgram(gl, "vertex", "fragment")).toThrow("unknown link error");
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
