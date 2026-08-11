export type RefreshableTerminal = {
  rows: number;
  refresh?: (start: number, end: number) => void;
};

export function refreshTerminalRows(term: RefreshableTerminal | null): void {
  if (!term) return;
  term.refresh?.(0, Math.max(0, term.rows - 1));
}

/// Escape hatch for the Linux desktop's renderer choice, read from
/// localStorage so trying it costs a devtools line rather than a rebuild.
/// `"1"` forces xterm.js's WebGL renderer on, `"0"` forces it off, anything
/// else defers to the platform rule.
///
/// WHY a hatch exists at all: WebGL is the only xterm renderer that draws box
/// drawing and block elements to the cell edge, and it measures 100% where the
/// DOM renderer measures 96.0% / 95.2%. It stays off by default on the Linux
/// desktop because of an unresolved present-stall question, and the only way
/// to settle that is readings from real hosts.
///
/// On the Linux desktop this is necessary but not sufficient: WebKit only
/// composites a GL layer when the dma-buf renderer is active, so an NVIDIA
/// host also needs `CHAN_LINUX_DMABUF=on` in the desktop app's environment.
/// Everywhere else dma-buf is already on.
export const WEBGL_RENDERER_OVERRIDE_KEY = "chan:terminal-webgl";

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
  os: string,
  override: boolean | null = null,
): boolean {
  if (override !== null) return override;
  return !(isDesktop && os === "linux");
}
