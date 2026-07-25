// Imported from the leaf ./configWrite module, NOT ./store.svelte: store
// already imports this module, so importing store back would form a cycle.
import { updateGlobalConfigSerial } from "./configWrite";

export const editorToolsPrefs = $state({
  stripTrailingWhitespaceOnSave: false,
});

export function applyEditorToolPreferences(prefs: {
  strip_trailing_whitespace_on_save?: boolean;
}): void {
  editorToolsPrefs.stripTrailingWhitespaceOnSave =
    prefs.strip_trailing_whitespace_on_save ?? false;
}

export function persistStripTrailingWhitespaceOnSave(value: boolean): Promise<void> {
  editorToolsPrefs.stripTrailingWhitespaceOnSave = value;
  // Serialized with every other config write (shared chain) so a concurrent
  // config write can't clobber this field, or be clobbered by it.
  // Skips the PATCH when the value already matches.
  return updateGlobalConfigSerial((prefs) =>
    prefs.strip_trailing_whitespace_on_save === value
      ? null
      : { strip_trailing_whitespace_on_save: value },
  );
}
