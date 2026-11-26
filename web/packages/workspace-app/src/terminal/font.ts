import type { TerminalFontChoice } from "../api/types";
import type { OS } from "../state/shortcuts";

export const SOURCE_CODE_PRO_NAME = "Source Code Pro";
const SOURCE_CODE_PRO_FAMILY = `"${SOURCE_CODE_PRO_NAME}"`;
const FONT_LOAD_PROBE = "W";

const SYSTEM_FONT_FAMILIES: Record<OS, string> = {
  mac: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace',
  windows:
    '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
  linux:
    'ui-monospace, "DejaVu Sans Mono", "Liberation Mono", monospace',
};

export interface FontFaceSetLike {
  load(font: string, text?: string): PromiseLike<readonly unknown[]>;
}

export interface TerminalFontSelection {
  fontFamily: string;
  fallbackFamily: string;
  webFont: typeof SOURCE_CODE_PRO_NAME | null;
}

export interface ReadyTerminalFont {
  fontFamily: string;
  status: "system" | "loaded" | "fallback";
  error?: Error;
}

export function selectTerminalFont(
  os: OS,
  preference: TerminalFontChoice,
): TerminalFontSelection {
  const fallbackFamily = SYSTEM_FONT_FAMILIES[os];
  const useSourceCodePro = preference === "source-code-pro" || os === "linux";
  return {
    fontFamily: useSourceCodePro
      ? `${SOURCE_CODE_PRO_FAMILY}, ${fallbackFamily}`
      : fallbackFamily,
    fallbackFamily,
    webFont: useSourceCodePro ? SOURCE_CODE_PRO_NAME : null,
  };
}

function fontLoadError(message: string, cause?: unknown): Error {
  if (cause instanceof Error) return cause;
  return new Error(message);
}

/// Resolve a font chain that is safe to hand to a terminal renderer.
///
/// The terminal measures its cell from the font when it starts and draws
/// each glyph with whatever face is loaded when it paints. A webfont that
/// swaps in after it starts can therefore draw in cells measured for the
/// fallback. System fonts need no wait; the bundled face must finish loading
/// first. On failure, dropping it from the returned chain prevents a later
/// load from changing a live terminal.
export async function resolveReadyTerminalFont(
  os: OS,
  preference: TerminalFontChoice,
  fontSize: number,
  fonts: FontFaceSetLike | undefined,
): Promise<ReadyTerminalFont> {
  const selection = selectTerminalFont(os, preference);
  if (!selection.webFont) {
    return { fontFamily: selection.fontFamily, status: "system" };
  }
  if (!fonts) {
    return {
      fontFamily: selection.fallbackFamily,
      status: "fallback",
      error: new Error("Font Loading API unavailable"),
    };
  }

  try {
    const faces = await fonts.load(
      `400 ${fontSize}px "${selection.webFont}"`,
      FONT_LOAD_PROBE,
    );
    if (faces.length === 0) {
      return {
        fontFamily: selection.fallbackFamily,
        status: "fallback",
        error: new Error(`${selection.webFont} is not registered`),
      };
    }
    return { fontFamily: selection.fontFamily, status: "loaded" };
  } catch (error) {
    return {
      fontFamily: selection.fallbackFamily,
      status: "fallback",
      error: fontLoadError(`${selection.webFont} failed to load`, error),
    };
  }
}
