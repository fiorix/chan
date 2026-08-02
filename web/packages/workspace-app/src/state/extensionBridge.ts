// Narrow host bridge for sandboxed extension iframes. Cross-document keyboard
// events never bubble into Chan, so the extension relays only the shell chords
// Chan tells it are currently claimed. The parent still validates the sending
// frame before recreating the event on its own document.

import type { Command } from "./commands";
import { overrideChordFor, resolvedKeymapEntries } from "./keymapOverrides.svelte";
import { currentOS, SHORTCUTS, type OS } from "./shortcuts";

export const EXTENSION_KEYMAP_MESSAGE = "chan:extension-host-keymap:v1";
export const EXTENSION_KEYDOWN_MESSAGE = "chan:extension-keydown:v1";
export const EXTENSION_SESSION_CONTEXT_MESSAGE = "chan:extension-session-context:v1";
export const EXTENSION_VIEW_STATE_MESSAGE = "chan:extension-view-state:v1";
export const EXTENSION_PRESENTATION_REQUEST = "chan:extension-presentation:v1";

export type ExtensionPresentationAction = "enter" | "exit" | "toggle";

export type ExtensionHostKey = {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export type ExtensionKeydownMessage = ExtensionHostKey & {
  type: typeof EXTENSION_KEYDOWN_MESSAGE;
  key: string;
  repeat: boolean;
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
    /^[A-Za-z0-9]+$/.test(message.code) &&
    typeof message.ctrlKey === "boolean" &&
    typeof message.altKey === "boolean" &&
    typeof message.metaKey === "boolean" &&
    typeof message.shiftKey === "boolean" &&
    typeof message.repeat === "boolean"
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
    bubbles: true,
    cancelable: true,
  });
}

function hostKeysForChord(chord: string, os: OS): ExtensionHostKey[] {
  const tokens = chord.split("+");
  const rawKey = tokens.pop();
  if (!rawKey) return [];
  const modifiers = new Set(tokens);
  let key = rawKey;
  if (key === "?") {
    key = "/";
    modifiers.add("Shift");
  }
  const codes = key === "1..9"
    ? Array.from({ length: 9 }, (_, index) => `Digit${index + 1}`)
    : [codeForKey(key)];
  if (codes.some((code) => code === null)) return [];

  const modIsMeta = os === "mac";
  return (codes as string[]).map((code) => ({
    code,
    ctrlKey: modifiers.has("Ctrl") || (modifiers.has("Mod") && !modIsMeta),
    altKey: modifiers.has("Alt"),
    metaKey: modifiers.has("Cmd") || (modifiers.has("Mod") && modIsMeta),
    shiftKey: modifiers.has("Shift"),
  }));
}

function codeForKey(key: string): string | null {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const punctuation: Readonly<Record<string, string>> = {
    "`": "Backquote",
    "[": "BracketLeft",
    "]": "BracketRight",
    ",": "Comma",
    "=": "Equal",
    "-": "Minus",
    ".": "Period",
    ";": "Semicolon",
    "/": "Slash",
  };
  return punctuation[key] ?? (/^[A-Za-z][A-Za-z0-9]+$/.test(key) ? key : null);
}

/// Stable identity of one host chord. Used to dedupe the advertised set and
/// to allowlist relayed keydowns against it.
export function hostKeyId(key: ExtensionHostKey): string {
  return `${key.ctrlKey}:${key.altKey}:${key.metaKey}:${key.shiftKey}:${key.code}`;
}

/// A relayed keydown is honored only when its chord identity was advertised
/// to the frame; the empty set (before the first keymap post) rejects all.
export function isAdvertisedHostKey(
  advertisedKeys: ReadonlySet<string>,
  key: ExtensionHostKey,
): boolean {
  return advertisedKeys.has(hostKeyId(key));
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
