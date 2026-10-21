import { defaultKeymap, toggleBlockComment } from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";

/// CodeMirror's default keys with the block comment bound to Shift-Alt-A
/// alone. The default keymap binds it to Shift-Ctrl-A on macOS, where that
/// chord selects to the line start and, on a list item, to the item's text
/// start (`decorations/list_prefix.ts`); the view looks up `Ctrl-A` before
/// `Shift-Ctrl-a`, so that binding would take the chord from both selections.
/// On macOS an Option chord types a character, so there the block comment
/// has no key.
export const editorDefaultKeymap: readonly KeyBinding[] = [
  ...defaultKeymap.filter((binding) => binding.run !== toggleBlockComment),
  { key: "Alt-A", run: toggleBlockComment },
];
