import { describe, it, expect } from "vitest";
import { basename, rowLabel, windowRowLabel } from "./windowLabel";
import type { WindowRecord } from "../api/library";

describe("basename", () => {
  it("returns the trailing component", () => {
    expect(basename("/Users/x/notes")).toBe("notes");
  });
  it("tolerates a trailing slash", () => {
    expect(basename("/Users/x/notes/")).toBe("notes");
  });
  it("handles empty and root", () => {
    expect(basename("")).toBe("");
    expect(basename("/")).toBe("");
  });
});

describe("rowLabel recompose from kind/ordinal", () => {
  it("names a terminal window by ordinal", () => {
    expect(rowLabel("terminal", 2)).toBe("Terminal Window 2");
  });
  it("names a workspace window as just Window N (its card names the workspace)", () => {
    expect(rowLabel("workspace", 1)).toBe("Window 1");
  });

  it("appends separately persisted user text without parsing the title", () => {
    const record = {
      kind: "workspace",
      ordinal: 3,
      label: "release checks",
      control: false,
      title: "an intentionally unrelated title",
    } as WindowRecord;
    expect(windowRowLabel(record)).toBe("Window 3 [release checks]");
  });

  it("appends the same user text to a terminal's generated label", () => {
    const record = {
      kind: "terminal",
      ordinal: 2,
      label: "deploy shell",
      control: false,
      title: "another intentionally unrelated title",
    } as WindowRecord;
    expect(windowRowLabel(record)).toBe("Terminal Window 2 [deploy shell]");
  });

  it("trims user text and omits empty brackets", () => {
    const record = {
      kind: "workspace",
      ordinal: 1,
      label: "   ",
      control: false,
    } as WindowRecord;
    expect(windowRowLabel(record)).toBe("Window 1");
  });
});
