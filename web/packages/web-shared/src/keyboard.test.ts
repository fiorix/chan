import { describe, expect, test } from "vitest";
import { shortcutKey, shortcutLetter } from "./keyboard";
import { KEY_VECTORS, keyVectorEvent } from "./keyboardVectors";

describe("shortcutKey against published layouts", () => {
  test.each(KEY_VECTORS.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const resolved = shortcutKey(keyVectorEvent(vector), vector.mac ?? false);
    if (vector.key === null) {
      expect(resolved).toBeNull();
      return;
    }
    expect(resolved).toEqual({
      key: vector.key,
      shifted: vector.shifted ?? false,
      consumable: vector.consumable ?? false,
    });
  });
});

describe("AltGr is a macOS-free notion", () => {
  const altGrBracket = KEY_VECTORS.find((v) => v.name.startsWith("QWERTZ AltGr ["))!;

  test("off macOS an AltGraph keydown is character entry and refused", () => {
    expect(shortcutKey(keyVectorEvent(altGrBracket), false)).toBeNull();
  });

  test("on macOS the same flags are Ctrl+Option and resolve", () => {
    // The digit row keeps its position, so this is digit 8, not `[`.
    expect(shortcutKey(keyVectorEvent(altGrBracket), true)?.key).toBe("8");
  });
});

describe("shortcutLetter", () => {
  test("names only letters", () => {
    expect(shortcutLetter({ key: "t", code: "KeyF", altKey: false })).toBe("T");
    expect(shortcutLetter({ key: ";", code: "KeyP", altKey: false })).toBeNull();
    expect(shortcutLetter({ key: ",", code: "KeyW", altKey: false })).toBeNull();
  });

  test("refuses AltGr character entry off macOS", () => {
    const polishS = new KeyboardEvent("keydown", {
      key: "ś",
      code: "KeyS",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    });
    expect(shortcutLetter(polishS)).toBeNull();
  });
});
