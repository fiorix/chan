import { describe, expect, test } from "vitest";
import type { TerminalPreferences } from "../api/types";
import { terminalBackendFromPrefs, type TerminalBackend } from "./backend";

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

describe("the backend of a terminal by its window and its masking", () => {
  const backendFor = terminalBackendFromPrefs as (
    prefs: TerminalPreferences | undefined,
    mode: { terminalControl: boolean },
  ) => TerminalBackend;

  // A control terminal whose masking starts on is xterm, the one backend
  // that masks; every other cell is the configured backend.
  test.each([
    [true, undefined, true, "xterm"],
    [true, undefined, false, "xterm"],
    [true, true, true, "xterm"],
    [true, true, false, "xterm"],
    [true, false, true, "ghostty"],
    [true, false, false, "xterm"],
    [false, undefined, true, "ghostty"],
    [false, undefined, false, "xterm"],
    [false, true, true, "ghostty"],
    [false, true, false, "xterm"],
    [false, false, true, "ghostty"],
    [false, false, false, "xterm"],
  ] as const)(
    "control window %s, secret_masking %s, ghostty %s: %s",
    (terminalControl, secretMasking, ghostty, backend) => {
      const prefs = {
        ghostty,
        ...(secretMasking === undefined ? {} : { secret_masking: secretMasking }),
      } as TerminalPreferences;
      expect(backendFor(prefs, { terminalControl })).toBe(backend);
    },
  );
});
