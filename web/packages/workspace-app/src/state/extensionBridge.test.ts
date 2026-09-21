// @vitest-environment jsdom

import { describe, expect, test } from "vitest";

import { allCommands } from "./commands";
import {
  EXTENSION_KEYDOWN_MESSAGE,
  EXTENSION_KEYMAP_MESSAGE,
  EXTENSION_PRESENTATION_REQUEST,
  extensionPresentationAction,
  extensionHostKeys,
  hostKeyId,
  isAdvertisedHostKey,
  isExtensionKeydownMessage,
  keyboardEventFromExtension,
  type ExtensionKeydownMessage,
} from "./extensionBridge";

/// A relayed keydown with every raw field the v2 contract carries.
function relayed(fields: Partial<ExtensionKeydownMessage>): ExtensionKeydownMessage {
  return {
    type: EXTENSION_KEYDOWN_MESSAGE,
    key: "",
    code: "",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    altGraph: false,
    ...fields,
  };
}

describe("extension host keyboard bridge", () => {
  test("speaks the v2 keyboard contract", () => {
    expect(EXTENSION_KEYMAP_MESSAGE).toBe("chan:extension-host-keymap:v2");
    expect(EXTENSION_KEYDOWN_MESSAGE).toBe("chan:extension-keydown:v2");
  });

  test("advertises the web launcher and new-terminal shell chords as key tokens", () => {
    const keys = extensionHostKeys(allCommands());
    expect(keys).toContainEqual({
      key: "K",
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      shiftKey: false,
    });
    expect(keys).toContainEqual({
      key: "T",
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: true,
    });
  });

  test("advertises `?` as Shift plus `/` and the tab range as digits", () => {
    const keys = extensionHostKeys(allCommands());
    // Web split down is Ctrl+Alt+?, the tab jump Ctrl+Alt+1..9.
    expect(keys).toContainEqual({
      key: "/",
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      shiftKey: true,
    });
    for (const digit of ["1", "5", "9"]) {
      expect(keys).toContainEqual({
        key: digit,
        ctrlKey: true,
        altKey: true,
        metaKey: false,
        shiftKey: false,
      });
    }
  });

  test("accepts a bounded relay message and recreates a bubbling keydown", () => {
    const message = relayed({ key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect(isExtensionKeydownMessage(message)).toBe(true);
    const event = keyboardEventFromExtension(message);
    expect(event.key).toBe("k");
    expect(event.code).toBe("KeyK");
    expect(event.ctrlKey).toBe(true);
    expect(event.altKey).toBe(true);
    expect(event.bubbles).toBe(true);
  });

  test("the recreated keydown carries composition and AltGraph", () => {
    const event = keyboardEventFromExtension(
      relayed({ key: "@", code: "KeyQ", isComposing: true, altGraph: true }),
    );
    expect(event.isComposing).toBe(true);
    expect(event.getModifierState("AltGraph")).toBe(true);
  });

  test("rejects malformed, oversized or v1-shaped relay messages", () => {
    expect(isExtensionKeydownMessage({ type: EXTENSION_KEYDOWN_MESSAGE })).toBe(false);
    expect(isExtensionKeydownMessage(relayed({ key: "x".repeat(33) }))).toBe(false);
    expect(isExtensionKeydownMessage(relayed({ code: "KeyX<script>" }))).toBe(false);
    expect(isExtensionKeydownMessage(relayed({ code: "K".repeat(33) }))).toBe(false);
    // The v1 shape: no composition or AltGraph state.
    const v1Fields = {
      type: EXTENSION_KEYDOWN_MESSAGE,
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      shiftKey: false,
      repeat: false,
    };
    expect(isExtensionKeydownMessage(v1Fields)).toBe(false);
    expect(
      isExtensionKeydownMessage({ ...relayed({ key: "k" }), type: "chan:extension-keydown:v1" }),
    ).toBe(false);
  });

  test("accepts only bounded presentation actions", () => {
    expect(
      extensionPresentationAction({
        type: EXTENSION_PRESENTATION_REQUEST,
        action: "toggle",
      }),
    ).toBe("toggle");
    expect(
      extensionPresentationAction({
        type: EXTENSION_PRESENTATION_REQUEST,
        action: "fullscreen",
      }),
    ).toBeNull();
  });
});

describe("extension keydown allowlist", () => {
  const advertised = new Set(extensionHostKeys(allCommands()).map(hostKeyId));
  const launcher = { key: "k", code: "KeyK", ctrlKey: true, altKey: true };

  test("accepts an advertised shell chord", () => {
    expect(isAdvertisedHostKey(advertised, relayed(launcher))).toBe(true);
  });

  test("accepts Colemak T on KeyF and rejects the G that now sits on KeyT", () => {
    const ctrlShift = { ctrlKey: true, shiftKey: true };
    expect(isAdvertisedHostKey(advertised, relayed({ key: "T", code: "KeyF", ...ctrlShift }))).toBe(
      true,
    );
    expect(isAdvertisedHostKey(advertised, relayed({ key: "G", code: "KeyT", ...ctrlShift }))).toBe(
      false,
    );
  });

  test("accepts AZERTY . typed with Shift through the consumed chord", () => {
    expect(
      isAdvertisedHostKey(
        advertised,
        relayed({ key: ".", code: "Comma", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    // US > keeps its Shift, and Ctrl+Shift+. is not a shell chord.
    expect(
      isAdvertisedHostKey(
        advertised,
        relayed({ key: ">", code: "Period", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
  });

  test("rejects a keydown that enters text", () => {
    const composing = relayed({ ...launcher, isComposing: true });
    expect(isAdvertisedHostKey(advertised, composing)).toBe(false);
    expect(isAdvertisedHostKey(advertised, relayed({ ...launcher, altGraph: true }))).toBe(false);
  });

  test("resolves the raw fields itself and ignores an identity the frame supplies", () => {
    const forged = {
      ...relayed({ key: "g", code: "KeyT", ctrlKey: true, shiftKey: true }),
      identity: "T",
      command: "app.terminal.toggle",
    };
    expect(isAdvertisedHostKey(advertised, forged)).toBe(false);
  });

  test("rejects a plain unmodified key", () => {
    expect(isAdvertisedHostKey(advertised, relayed({ key: "k", code: "KeyK" }))).toBe(false);
  });

  test("rejects a modifier chord the host never advertised", () => {
    const message = relayed({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true });
    expect(
      advertised.has(
        hostKeyId({ key: "K", ctrlKey: true, altKey: false, metaKey: false, shiftKey: true }),
      ),
    ).toBe(false);
    expect(isAdvertisedHostKey(advertised, message)).toBe(false);
  });

  test("an empty advertised set rejects everything", () => {
    expect(isAdvertisedHostKey(new Set(), relayed(launcher))).toBe(false);
  });
});
