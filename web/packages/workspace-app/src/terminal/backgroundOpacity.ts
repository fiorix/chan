// Terminal background opacity.
//
// A percent, 100 opaque. It only has an effect in a window that chan-desktop
// built transparent: an opaque native window (a workspace window, a devserver
// window, a browser tab, a window built while the value was 100) would show
// black or its own background through a see-through page, so the page asks
// the window first and stays opaque otherwise.

/// Inclusive bounds the Settings slider exposes. Mirrored from the Rust
/// constants in `crates/chan-library/src/config.rs`
/// (`TERMINAL_BACKGROUND_OPACITY_MIN` / `TERMINAL_BACKGROUND_OPACITY_MAX`).
export const TERMINAL_BACKGROUND_OPACITY_MIN = 10;
export const TERMINAL_BACKGROUND_OPACITY_MAX = 100;

/// The URL flag chan-desktop appends to a window it built transparent.
export const TRANSPARENT_WINDOW_PARAM = "transparent";

/// Clamp a stored or typed value to the slider bounds. Anything that is not a
/// finite number reads as opaque.
export function clampBackgroundOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TERMINAL_BACKGROUND_OPACITY_MAX;
  }
  return Math.min(
    TERMINAL_BACKGROUND_OPACITY_MAX,
    Math.max(TERMINAL_BACKGROUND_OPACITY_MIN, Math.round(value)),
  );
}

/// Whether the native window under this page was built transparent, read off
/// the URL like `kind` and `seed`, so the answer is there before any request.
export function windowIsTransparent(href?: string): boolean {
  const source = href ?? (typeof window === "undefined" ? undefined : window.location.href);
  if (!source) return false;
  try {
    return new URL(source).searchParams.get(TRANSPARENT_WINDOW_PARAM) === "1";
  } catch {
    return false;
  }
}

/// The opacity this page paints terminal backgrounds at: the clamped
/// preference in a transparent window, `null` (paint opaque) in every other
/// window or when the preference is 100.
export function effectiveBackgroundOpacity(
  preference: unknown,
  transparentWindow: boolean,
): number | null {
  if (!transparentWindow) return null;
  const percent = clampBackgroundOpacity(preference);
  return percent >= TERMINAL_BACKGROUND_OPACITY_MAX ? null : percent;
}

/// The CSS custom property carrying the live opacity as a percentage.
export const TERMINAL_OPACITY_VAR = "--terminal-opacity";

/// The slice of an element the root marker writes, so a test can hand in a
/// plain object.
export type OpacityRoot = {
  dataset: Record<string, string | undefined>;
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): string;
  };
};

/// Mark the document root for the CSS that paints terminal backgrounds.
///
/// `data-transparent-window` is fixed for the page: the renderers paint a
/// transparent default background and `.terminal-tab` paints the tint at
/// `--terminal-opacity`, which also covers 100%, so a change to or from 100
/// applies live. `data-terminal-see-through` is set only below 100 and is
/// what makes the body transparent, so the gutters between panes stay opaque
/// at 100%.
export function markTerminalOpacityRoot(
  root: OpacityRoot,
  transparentWindow: boolean,
  preference: unknown,
): void {
  if (!transparentWindow) {
    delete root.dataset.transparentWindow;
    delete root.dataset.terminalSeeThrough;
    root.style.removeProperty(TERMINAL_OPACITY_VAR);
    return;
  }
  root.dataset.transparentWindow = "";
  root.style.setProperty(TERMINAL_OPACITY_VAR, `${clampBackgroundOpacity(preference)}%`);
  if (effectiveBackgroundOpacity(preference, true) === null) {
    delete root.dataset.terminalSeeThrough;
  } else {
    root.dataset.terminalSeeThrough = "";
  }
}

/// `color` with its alpha set to zero, for a renderer's default background in
/// a transparent window. The RGB is kept because both xterm.js renderers use
/// the background's opaque RGB as the text colour of inverse-video cells. A
/// colour this cannot read becomes transparent black.
export function transparentColor(color: string): string {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex[1];
    const r = Number.parseInt(digits.slice(0, 2), 16);
    const g = Number.parseInt(digits.slice(2, 4), 16);
    const b = Number.parseInt(digits.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0)`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, 0)`;
  return "rgba(0, 0, 0, 0)";
}
