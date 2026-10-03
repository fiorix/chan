// Compose window names from kind, ordinal and user label for a consistent
// perspective across the launcher, workspace command deck and browser title.

/** Window flavour, mirroring the Rust `WindowKind` wire tags. */
export type WindowKind = "terminal" | "workspace";

/**
 * The naming fields of a window record. Structural rather than tied to one
 * wire type: the launcher's `WindowRecord` and the workspace app's
 * `ScopedLibraryWindow` are independent mirrors of the same server state and
 * both satisfy this.
 */
export interface WindowDisplayParts {
  kind: WindowKind;
  ordinal: number;
  label?: string;
  control?: boolean;
}

/** The generated row label. The surrounding card supplies workspace and
 * machine identity. */
export function rowLabel(kind: WindowKind, ordinal: number): string {
  return kind === "terminal" ? `Terminal Window ${ordinal}` : `Window ${ordinal}`;
}

/** Append the user label in brackets. Control terminals use a fixed title. */
export function windowDisplayName(w: WindowDisplayParts): string {
  if (w.control) return "Control terminal";
  const generated = rowLabel(w.kind, w.ordinal);
  const label = w.label?.trim();
  return label ? `${generated} [${label}]` : generated;
}
