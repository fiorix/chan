import { describe, expect, test } from "vitest";
import { terminalBackendFromPrefs } from "./backend";

describe("terminalBackendFromPrefs", () => {
  test("absent field (older server) means xterm.js", () => {
    expect(terminalBackendFromPrefs(undefined)).toBe("xterm");
    expect(terminalBackendFromPrefs({} as never)).toBe("xterm");
  });

  test("explicit false means xterm.js", () => {
    expect(terminalBackendFromPrefs({ ghostty: false } as never)).toBe("xterm");
  });

  test("true selects the ghostty backend", () => {
    expect(terminalBackendFromPrefs({ ghostty: true } as never)).toBe("ghostty");
  });
});
