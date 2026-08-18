export type RefreshableTerminal = {
  rows: number;
  refresh?: (start: number, end: number) => void;
};

export function refreshTerminalRows(term: RefreshableTerminal | null): void {
  if (!term) return;
  term.refresh?.(0, Math.max(0, term.rows - 1));
}

/// Escape hatch for the desktop's renderer choice, read from
/// localStorage so trying it costs a devtools line rather than a rebuild.
/// `"1"` forces xterm.js's WebGL renderer on, `"0"` forces it off, anything
/// else defers to the capability in the served shell.
///
/// WHY a hatch exists at all: WebGL is the only xterm renderer that draws box
/// drawing and block elements to the cell edge, and it measures 100% where the
/// DOM renderer measures 96.0% / 95.2%. The hatch permits pixel readings in
/// both directions without making the SPA disagree with the desktop by default.
export const WEBGL_RENDERER_OVERRIDE_KEY = "chan:terminal-webgl";

/// The desktop computes WebKit's renderer capability before it builds any
/// webview. The serving tenant stamps that result into the shell so local and
/// remote windows make the same choice without probing the driver in the SPA.
export function webglRendererSignal(): boolean | null {
  if (typeof document === "undefined") return null;
  const raw = document
    .querySelector('meta[name="chan-webgl-renderer"]')
    ?.getAttribute("content")
    ?.trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function webglRendererOverride(): boolean | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(WEBGL_RENDERER_OVERRIDE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    // A storage-denied context has no override, which is the default.
    return null;
  }
}

export function shouldUseWebglRenderer(
  isDesktop: boolean,
  desktopRenderer: boolean | null,
  override: boolean | null = null,
): boolean {
  if (override !== null) return override;
  return !isDesktop || desktopRenderer === true;
}
