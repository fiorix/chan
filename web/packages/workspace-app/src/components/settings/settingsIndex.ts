// The settings index: one entry per field of the Settings overlay, as data.
// The overlay's sections render their fields from the same labels and option
// words, and the command launcher lists the entries in its Settings scope, so
// a setting reads the same in both places. A toggle or a choice can be changed
// from the launcher in place; any other field opens the overlay on it.

import type { SettingsSectionId } from "./sections";

/// How the launcher treats a field: a toggle flips, a choice offers its
/// options, and an `open` field (a slider, text, a colour, a list, a button
/// flow) is edited in the overlay.
export type SettingKind = "toggle" | "choice" | "open";

export type SettingOption = {
  value: string;
  /// The option's word, verbatim as the overlay's control shows it.
  label: string;
};

export type SettingSpec = {
  /// Stable id, `<section>.<field>`. Also the anchor `openSettings` lands on.
  id: string;
  section: SettingsSectionId;
  /// The field's label, verbatim as the overlay renders it. A control inside
  /// a field with several reads `Field: control`.
  label: string;
  kind: SettingKind;
  /// A choice's options, in the overlay's order.
  options?: readonly SettingOption[];
  /// The current value: a boolean for a toggle, an option value for a choice,
  /// a display string for an `open` field, null while it has not loaded.
  read: () => boolean | string | null;
  /// Apply a value. Present on a toggle and a choice.
  write?: (value: boolean | string) => void | Promise<void>;
  /// Whether this window shows the field, by the overlay's own gates.
  available: () => boolean;
  /// The catalog command that changes the same setting, when one exists. The
  /// launcher then lists the command among typed results and keeps the
  /// setting to its Settings scope, so one change does not show twice.
  command?: string;
  /// Extra terms the launcher's search matches beyond the label.
  keywords?: readonly string[];
};

/// Every field the Settings overlay offers in this window, in rail and field
/// order.
export function settingsIndex(): readonly SettingSpec[] {
  return [];
}
