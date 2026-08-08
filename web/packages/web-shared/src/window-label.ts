// The display name of a library window, composed from its kind, ordinal, and
// optional user label WITHOUT parsing the library-composed `title` or the
// opaque `window_id`. The library titles every window from its own (local)
// perspective, so every surface that names a window recomposes it here: the
// launcher's rows and command deck, the workspace app's command deck, and the
// browser tab title.

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

/**
 * The generated part alone: "Window N" for a workspace window (the launcher
 * card already names the workspace, so the base is not repeated) or
 * "Terminal Window N" for a standalone terminal. No icon: the icon is the
 * machine's, so a row reads the same under any library.
 */
export function rowLabel(kind: WindowKind, ordinal: number): string {
  if (kind === "terminal") return `Terminal Window ${ordinal}`;
  return `Window ${ordinal}`;
}

/**
 * The generated label plus the user's optional text in brackets. A devserver's
 * connect control terminal reads as "Control terminal" rather than the
 * recomposed "Terminal Window 0", and carries no user text.
 */
export function windowDisplayName(w: WindowDisplayParts): string {
  if (w.control) return "Control terminal";
  const generated = rowLabel(w.kind, w.ordinal);
  const label = w.label?.trim();
  return label ? `${generated} [${label}]` : generated;
}
