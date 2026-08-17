import { describe, expect, test, vi } from "vitest";
import type { TerminalFontChoice } from "../api/types";
import type { OS } from "../state/shortcuts";
import {
  resolveReadyTerminalFont,
  selectTerminalFont,
  SOURCE_CODE_PRO_NAME,
  type FontFaceSetLike,
} from "./font";

const CASES: Array<{
  os: OS;
  preference: TerminalFontChoice;
  requiresWebFont: boolean;
  systemFamily: string;
}> = [
  {
    os: "mac",
    preference: "os-default",
    requiresWebFont: false,
    systemFamily: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace',
  },
  {
    os: "windows",
    preference: "os-default",
    requiresWebFont: false,
    systemFamily:
      '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
  },
  {
    os: "linux",
    preference: "os-default",
    requiresWebFont: true,
    systemFamily:
      'ui-monospace, "DejaVu Sans Mono", "Liberation Mono", monospace',
  },
  {
    os: "mac",
    preference: "source-code-pro",
    requiresWebFont: true,
    systemFamily: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace',
  },
  {
    os: "windows",
    preference: "source-code-pro",
    requiresWebFont: true,
    systemFamily:
      '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
  },
  {
    os: "linux",
    preference: "source-code-pro",
    requiresWebFont: true,
    systemFamily:
      'ui-monospace, "DejaVu Sans Mono", "Liberation Mono", monospace',
  },
];

function loadedFontSet(): FontFaceSetLike & { load: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(async () => [{}]),
  };
}

describe("terminal font readiness", () => {
  test.each(CASES)(
    "$os $preference selects a chain with an xterm-safe loading contract",
    async ({ os, preference, requiresWebFont, systemFamily }) => {
      const selection = selectTerminalFont(os, preference);
      const fonts = loadedFontSet();
      const ready = await resolveReadyTerminalFont(os, preference, 16, fonts);

      expect(selection.fallbackFamily).toBe(systemFamily);
      expect(selection.fallbackFamily).not.toContain(SOURCE_CODE_PRO_NAME);
      expect(selection.webFont === SOURCE_CODE_PRO_NAME).toBe(requiresWebFont);
      expect(selection.fontFamily).toBe(
        requiresWebFont
          ? `"${SOURCE_CODE_PRO_NAME}", ${systemFamily}`
          : systemFamily,
      );
      expect(ready.fontFamily).toBe(selection.fontFamily);
      expect(ready.status).toBe(requiresWebFont ? "loaded" : "system");
      expect(fonts.load).toHaveBeenCalledTimes(requiresWebFont ? 1 : 0);
      if (requiresWebFont) {
        expect(fonts.load).toHaveBeenCalledWith(
          `400 16px "${SOURCE_CODE_PRO_NAME}"`,
          "W",
        );
      }
    },
  );

  test("does not resolve a Source Code Pro chain before the face finishes loading", async () => {
    let finishLoad: (faces: readonly unknown[]) => void = () => {};
    const loadResult = new Promise<readonly unknown[]>((resolve) => {
      finishLoad = resolve;
    });
    const fonts: FontFaceSetLike = { load: () => loadResult };
    let settled = false;

    const ready = resolveReadyTerminalFont(
      "mac",
      "source-code-pro",
      16,
      fonts,
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishLoad([{}]);
    expect((await ready).status).toBe("loaded");
  });

  test.each([
    ["the Font Loading API is unavailable", undefined],
    ["no matching face is registered", { load: vi.fn(async () => []) }],
    [
      "the face fails to load",
      { load: vi.fn(async () => Promise.reject(new Error("decode failed"))) },
    ],
  ])("pins the system fallback when %s", async (_case, fonts) => {
    const selection = selectTerminalFont("mac", "source-code-pro");
    const ready = await resolveReadyTerminalFont(
      "mac",
      "source-code-pro",
      16,
      fonts as FontFaceSetLike | undefined,
    );

    expect(ready.status).toBe("fallback");
    expect(ready.fontFamily).toBe(selection.fallbackFamily);
    expect(ready.fontFamily).not.toContain(SOURCE_CODE_PRO_NAME);
    expect(ready.error).toBeInstanceOf(Error);
  });
});
