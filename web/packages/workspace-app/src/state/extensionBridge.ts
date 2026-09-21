// Narrow host bridge for sandboxed extension iframes. Cross-document keyboard
// events never bubble into Chan, so the extension relays only the shell chords
// Chan tells it are currently claimed. The parent still validates the sending
// frame, and reads the relayed keydown itself under the same keyboard contract
// as every other matcher, before recreating the event on its own document.

import { shiftedPunctuationBase, shortcutKey } from "@chan/web-shared/keyboard";
import type { Command } from "./commands";
import { overrideChordFor, resolvedKeymapEntries } from "./keymapOverrides.svelte";
import { currentOS, SHORTCUTS, type OS } from "./shortcuts";

export const EXTENSION_KEYMAP_MESSAGE = "chan:extension-host-keymap:v2";
export const EXTENSION_KEYDOWN_MESSAGE = "chan:extension-keydown:v2";
export const EXTENSION_SESSION_CONTEXT_MESSAGE = "chan:extension-session-context:v1";
export const EXTENSION_VIEW_STATE_MESSAGE = "chan:extension-view-state:v1";
export const EXTENSION_PRESENTATION_REQUEST = "chan:extension-presentation:v1";

export type ExtensionPresentationAction = "enter" | "exit" | "toggle";

/// One chord the host claims while an extension has focus: the key token the
/// shared keyboard contract names (`T`, `/`, `1`, `Enter`) and the exact
/// modifiers. Letters and punctuation are the symbols the layout types; digits
/// are top-row positions.
export type ExtensionHostKey = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/// A keydown an extension relays: its raw fields, which the host resolves on
/// its own. No identity or command the extension computed is trusted.
export type ExtensionKeydownMessage = {
  type: typeof EXTENSION_KEYDOWN_MESSAGE;
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  altGraph: boolean;
};

const SHELL_SHORTCUT_IDS = new Set(
  SHORTCUTS.filter((shortcut) =>
    shortcut.group === "App" || shortcut.group === "Tabs" || shortcut.group === "Panes"
  ).map((shortcut) => shortcut.id),
);

/// The modifier chords the host shell owns while an extension has focus.
/// User overrides remain global by definition, including overrides for a
/// command that has no built-in shell chord.
export function extensionHostKeys(commands: readonly Command[]): ExtensionHostKey[] {
  const os = currentOS();
  const keys: ExtensionHostKey[] = [];
  for (const entry of resolvedKeymapEntries(commands)) {
    if (!SHELL_SHORTCUT_IDS.has(entry.id) && !overrideChordFor(entry.id)) continue;
    for (const key of hostKeysForChord(entry.chord, os)) {
      if (key.ctrlKey || key.altKey || key.metaKey || key.shiftKey) keys.push(key);
    }
  }
  return dedupeHostKeys(keys);
}

export function isExtensionKeydownMessage(value: unknown): value is ExtensionKeydownMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ExtensionKeydownMessage>;
  return (
    message.type === EXTENSION_KEYDOWN_MESSAGE &&
    typeof message.key === "string" &&
    message.key.length <= 32 &&
    typeof message.code === "string" &&
    /^[A-Za-z0-9]{0,32}$/.test(message.code) &&
    typeof message.ctrlKey === "boolean" &&
    typeof message.altKey === "boolean" &&
    typeof message.metaKey === "boolean" &&
    typeof message.shiftKey === "boolean" &&
    typeof message.repeat === "boolean" &&
    typeof message.isComposing === "boolean" &&
    typeof message.altGraph === "boolean"
  );
}

export function extensionPresentationAction(
  value: unknown,
): ExtensionPresentationAction | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type !== EXTENSION_PRESENTATION_REQUEST) return null;
  return message.action === "enter" ||
    message.action === "exit" ||
    message.action === "toggle"
    ? message.action
    : null;
}

export function keyboardEventFromExtension(message: ExtensionKeydownMessage): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: message.key,
    code: message.code,
    ctrlKey: message.ctrlKey,
    altKey: message.altKey,
    metaKey: message.metaKey,
    shiftKey: message.shiftKey,
    repeat: message.repeat,
    isComposing: message.isComposing,
    modifierAltGraph: message.altGraph,
    bubbles: true,
    cancelable: true,
  });
}

function hostKeysForChord(chord: string, os: OS): ExtensionHostKey[] {
  const tokens = chord.split("+");
  const rawKey = tokens.pop();
  if (!rawKey) return [];
  const modifiers = new Set(tokens);
  // A shifted glyph such as `?` names Shift plus its base symbol, the one
  // spelling a relayed keydown resolves to.
  const base = shiftedPunctuationBase(rawKey);
  if (base) modifiers.add("Shift");
  const keys =
    rawKey === "1..9"
      ? Array.from({ length: 9 }, (_, index) => String(index + 1))
      : [base ?? rawKey];

  const modIsMeta = os === "mac";
  return keys.map((key) => ({
    key,
    ctrlKey: modifiers.has("Ctrl") || (modifiers.has("Mod") && !modIsMeta),
    altKey: modifiers.has("Alt"),
    metaKey: modifiers.has("Cmd") || (modifiers.has("Mod") && modIsMeta),
    shiftKey: modifiers.has("Shift"),
  }));
}

/// Stable identity of one host chord. Used to dedupe the advertised set and
/// to allowlist relayed keydowns against it.
export function hostKeyId(key: ExtensionHostKey): string {
  return `${key.ctrlKey}:${key.altKey}:${key.metaKey}:${key.shiftKey}:${key.key}`;
}

/// The host chords a relayed keydown can stand for under Chan's own reading
/// of its raw fields: the exact chord, and the chord without Shift when Shift
/// only typed a punctuation symbol. Empty for a keydown that enters text (a
/// composition, a dead key, AltGr), which no shortcut may claim.
function relayedHostKeys(message: ExtensionKeydownMessage): ExtensionHostKey[] {
  const id = shortcutKey(keyboardEventFromExtension(message));
  if (!id) return [];
  const { ctrlKey, altKey, metaKey } = message;
  const exact = { key: id.key, ctrlKey, altKey, metaKey, shiftKey: message.shiftKey || id.shifted };
  if (!(message.shiftKey && id.consumable)) return [exact];
  return [exact, { ...exact, shiftKey: false }];
}

/// A relayed keydown is honored only when it resolves to a chord that was
/// advertised to the frame; the empty set (before the first keymap post)
/// rejects all. The recreated event is then matched like any local keydown,
/// so the advertised set is a gate, not a dispatch table.
export function isAdvertisedHostKey(
  advertisedKeys: ReadonlySet<string>,
  message: ExtensionKeydownMessage,
): boolean {
  return relayedHostKeys(message).some((key) => advertisedKeys.has(hostKeyId(key)));
}

function dedupeHostKeys(keys: ExtensionHostKey[]): ExtensionHostKey[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    const id = hostKeyId(key);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
