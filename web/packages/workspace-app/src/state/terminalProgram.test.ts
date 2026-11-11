// The terminal program reading as it arrives on the terminal socket and the
// text the pane tree shows for it.

import { describe, expect, test } from "vitest";
import { terminalProgramFromWire, terminalProgramText } from "./terminalProgram";

describe("the wire value", () => {
  test("a pair arrives whole, nulls kept", () => {
    expect(terminalProgramFromWire({ title: "build", command: "bash" })).toEqual({ title: "build", command: "bash" });
    expect(terminalProgramFromWire({ title: null, command: "vim" })).toEqual({ title: null, command: "vim" });
    expect(terminalProgramFromWire({ title: null, command: null })).toEqual({ title: null, command: null });
  });

  test("an older server's missing field reads as no reading", () => {
    expect(terminalProgramFromWire(undefined)).toBeUndefined();
    expect(terminalProgramFromWire(null)).toBeUndefined();
  });

  test("a value that is not a pair reads as no reading, and a field that is not text as unknown", () => {
    expect(terminalProgramFromWire("bash")).toBeUndefined();
    expect(terminalProgramFromWire(["build", "bash"])).toBeUndefined();
    expect(terminalProgramFromWire({ title: 7, command: "" })).toEqual({ title: null, command: null });
    expect(terminalProgramFromWire({})).toEqual({ title: null, command: null });
  });
});

describe("the shown text", () => {
  test("the title wins over the command", () => {
    expect(terminalProgramText({ title: "build", command: "bash" })).toBe("build");
  });

  test("the command stands in when no title is set", () => {
    expect(terminalProgramText({ title: null, command: "vim" })).toBe("vim");
  });

  test("a reading of neither, or none at all, shows nothing", () => {
    expect(terminalProgramText({ title: null, command: null })).toBeNull();
    expect(terminalProgramText(undefined)).toBeNull();
  });
});
