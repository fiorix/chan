// Apply the active editor theme as a `data-editor-theme` attribute
// on document.documentElement. The editor CSS (themes/*.css) keys
// every typography + chrome rule off that attribute crossed with
// the existing `data-theme` (light/dark) and `data-editor-density`
// (tight/standard) attributes.

import type { EditorTheme } from "../api/types";

export const DEFAULT_EDITOR_THEME: EditorTheme = "github";
export const EDITOR_FONT_SIZE_MIN = 10;
export const EDITOR_FONT_SIZE_MAX = 32;

export function clampEditorFontSize(size: number): number {
  return Math.min(
    EDITOR_FONT_SIZE_MAX,
    Math.max(EDITOR_FONT_SIZE_MIN, Math.round(size)),
  );
}

export function applyEditorTheme(theme: EditorTheme): void {
  document.documentElement.setAttribute("data-editor-theme", theme);
}

/** Apply or clear the absolute editor body/source sizes above the theme. */
export function applyEditorFontSize(size: number | null | undefined): void {
  const style = document.documentElement.style;
  if (size === null || size === undefined || !Number.isFinite(size)) {
    style.removeProperty("--chan-editor-body-size");
    style.removeProperty("--chan-editor-source-size");
    return;
  }
  const body = clampEditorFontSize(size);
  style.setProperty("--chan-editor-body-size", `${body}px`);
  style.setProperty("--chan-editor-source-size", `${body - 2}px`);
}

/** Resolve the active theme's body size without the inline user override. */
export function resolvedEditorThemeBodySizePx(): number {
  const root = document.documentElement;
  const style = root.style;
  const bodyValue = style.getPropertyValue("--chan-editor-body-size");
  const bodyPriority = style.getPropertyPriority("--chan-editor-body-size");
  const sourceValue = style.getPropertyValue("--chan-editor-source-size");
  const sourcePriority = style.getPropertyPriority("--chan-editor-source-size");
  style.removeProperty("--chan-editor-body-size");
  style.removeProperty("--chan-editor-source-size");
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;font-size:var(--chan-editor-body-size);";
  try {
    root.appendChild(probe);
    const resolved = Number.parseFloat(getComputedStyle(probe).fontSize);
    return Number.isFinite(resolved) ? resolved : 16;
  } finally {
    probe.remove();
    if (bodyValue) style.setProperty("--chan-editor-body-size", bodyValue, bodyPriority);
    if (sourceValue) {
      style.setProperty("--chan-editor-source-size", sourceValue, sourcePriority);
    }
  }
}
