import { describe, it, expect } from "vitest";
import { capabilitiesFor, parseSurface } from "./capabilities";

describe("capabilitiesFor", () => {
  it("desktop can mutate and has a bridge, not self-managed", () => {
    expect(capabilitiesFor("desktop")).toEqual({
      canMutateRegistry: true,
      hasDesktopBridge: true,
      selfManagedWindows: false,
    });
  });

  it("devserver can mutate and self-manages, no bridge", () => {
    expect(capabilitiesFor("devserver")).toEqual({
      canMutateRegistry: true,
      hasDesktopBridge: false,
      selfManagedWindows: true,
    });
  });

  it("readonly has no capability", () => {
    expect(capabilitiesFor("readonly")).toEqual({
      canMutateRegistry: false,
      hasDesktopBridge: false,
      selfManagedWindows: false,
    });
  });
});

describe("parseSurface", () => {
  it("takes the descriptor value when valid", () => {
    expect(parseSurface("desktop")).toBe("desktop");
    expect(parseSurface("devserver")).toBe("devserver");
    expect(parseSurface("readonly")).toBe("readonly");
  });

  it("defaults to desktop with no descriptor", () => {
    expect(parseSurface(null)).toBe("desktop");
  });

  it("defaults an unrecognized descriptor value to desktop", () => {
    expect(parseSurface("bogus")).toBe("desktop");
  });
});
