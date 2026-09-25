import { describe, expect, test } from "vitest";
import { renderTable } from "./shortcuts";

// The shortcut table is the help a user reads (and `chan serve --help`
// prints), and it names the mode in title case: "Hybrid Nav".

describe("the shortcut table names Hybrid Nav in title case", () => {
  test("the mode's own row", () => {
    expect(renderTable("web", "linux")).toMatch(/^Hybrid Nav +Ctrl\+\.$/m);
    expect(renderTable("native", "mac")).toMatch(/^Hybrid Nav +Cmd\+\.$/m);
  });

  test("the New terminal row's Hybrid Nav alternate", () => {
    expect(renderTable("web", "linux")).toMatch(
      /^New terminal +Ctrl\+Shift\+T +\(Cmd\+T on macOS desktop; or Mod\+\. t \(Hybrid Nav\)\)$/m,
    );
  });
});
