// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { reportingWebgl2 } from "../__tests__/canvas";
import { classifyWebglRenderer } from "./webglRenderer";

const SWIFTSHADER =
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyWebglRenderer", () => {
  test.each([
    [SWIFTSHADER, "software"],
    ["llvmpipe (LLVM 21.1.8, 256 bits)", "software"],
    [
      "ANGLE (Mesa, Vulkan 1.3.255 (llvmpipe (LLVM 15.0.7 256 bits) (0x00000000)), Mesa llvmpipe)",
      "software",
    ],
    ["softpipe", "software"],
    ["lavapipe", "software"],
    ["Apple Software Renderer", "software"],
    [
      "ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "software",
    ],
    ["Apple GPU", "unidentified"],
    ["  Apple GPU ", "unidentified"],
    ["WebKit WebGL", "unidentified"],
    ["", "unidentified"],
    // Hardware drivers whose names share a word with the lists above.
    [
      "ANGLE (AMD, AMD Radeon 780M Graphics (radeonsi, phoenix, LLVM 20.1.8, DRM 3.64), OpenGL ES 3.2)",
      "hardware",
    ],
    [
      "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
      "hardware",
    ],
    [
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "hardware",
    ],
    [null, "none"],
  ] as const)("reads %j as %s", (renderer, kind) => {
    expect(classifyWebglRenderer(renderer)).toBe(kind);
  });
});

describe("pageWebglRenderer", () => {
  // The reading is kept for the life of the page, so each case loads the
  // module again as a new page would.
  async function onPage(answer: () => WebGL2RenderingContext | null) {
    vi.resetModules();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(((kind: string) =>
        kind === "webgl2" ? answer() : null) as never);
    const { pageWebglRenderer } = await import("./webglRenderer");
    return { getContext, pageWebglRenderer };
  }

  test("reads the unmasked renderer once, on a detached canvas it gives back", async () => {
    const loseContext = vi.fn();
    const { getContext, pageWebglRenderer } = await onPage(() =>
      reportingWebgl2(SWIFTSHADER, { loseContext }),
    );

    expect(pageWebglRenderer()).toEqual({
      renderer: SWIFTSHADER,
      kind: "software",
    });
    expect(getContext, "context requests").toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledWith("webgl2");
    const canvas = getContext.mock.contexts[0] as HTMLCanvasElement;
    expect(canvas.isConnected, "the reading's canvas is in the page").toBe(
      false,
    );
    expect(loseContext, "contexts given back").toHaveBeenCalledTimes(1);

    expect(pageWebglRenderer().kind).toBe("software");
    expect(getContext, "context requests after two readings").toHaveBeenCalledTimes(1);
  });

  test("reads the plain renderer of an engine that withholds the unmasked one", async () => {
    const { pageWebglRenderer } = await onPage(() =>
      reportingWebgl2("WebKit WebGL", { extension: false }),
    );

    expect(pageWebglRenderer()).toEqual({
      renderer: "WebKit WebGL",
      kind: "unidentified",
    });
  });

  test("reads a page with no WebGL2 context as none", async () => {
    const { pageWebglRenderer } = await onPage(() => null);

    expect(pageWebglRenderer()).toEqual({ renderer: null, kind: "none" });
  });

  test("reads a canvas that refuses the request as none", async () => {
    const { pageWebglRenderer } = await onPage(() => {
      throw new Error("context creation refused");
    });

    expect(pageWebglRenderer()).toEqual({ renderer: null, kind: "none" });
  });
});
