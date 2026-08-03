// @vitest-environment jsdom

import { describe, expect, test } from "vitest";

import { allCommands } from "./commands";
import {
  EXTENSION_KEYDOWN_MESSAGE,
  EXTENSION_PRESENTATION_REQUEST,
  extensionPresentationAction,
  extensionHostKeys,
  hostKeyId,
  isAdvertisedHostKey,
  isExtensionKeydownMessage,
  keyboardEventFromExtension,
} from "./extensionBridge";

describe("extension host keyboard bridge", () => {
  test("advertises the web launcher and new-terminal shell chords", () => {
    const keys = extensionHostKeys(allCommands());
    expect(keys).toContainEqual({
      code: "KeyK",
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      shiftKey: false,
    });
    expect(keys).toContainEqual({
      code: "KeyT",
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: true,
    });
  });

  test("accepts a bounded relay message and recreates a bubbling keydown", () => {
    const message = {
      type: EXTENSION_KEYDOWN_MESSAGE,
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      shiftKey: false,
      repeat: false,
    } as const;
    expect(isExtensionKeydownMessage(message)).toBe(true);
    const event = keyboardEventFromExtension(message);
    expect(event.code).toBe("KeyK");
    expect(event.ctrlKey).toBe(true);
    expect(event.altKey).toBe(true);
    expect(event.bubbles).toBe(true);
  });

  test("rejects malformed or oversized relay messages", () => {
    expect(isExtensionKeydownMessage({ type: EXTENSION_KEYDOWN_MESSAGE })).toBe(false);
    expect(
      isExtensionKeydownMessage({
        type: EXTENSION_KEYDOWN_MESSAGE,
        key: "x".repeat(33),
        code: "KeyX<script>",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
      }),
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

  test("accepts an advertised shell chord", () => {
    expect(
      isAdvertisedHostKey(advertised, {
        code: "KeyK",
        ctrlKey: true,
        altKey: true,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  test("rejects a plain unmodified key", () => {
    expect(
      isAdvertisedHostKey(advertised, {
        code: "KeyK",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  test("rejects a modifier chord the host never advertised", () => {
    const chord = {
      code: "KeyK",
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: true,
    };
    expect(advertised.has(hostKeyId(chord))).toBe(false);
    expect(isAdvertisedHostKey(advertised, chord)).toBe(false);
  });

  test("an empty advertised set rejects everything", () => {
    expect(
      isAdvertisedHostKey(new Set(), {
        code: "KeyK",
        ctrlKey: true,
        altKey: true,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });
});
