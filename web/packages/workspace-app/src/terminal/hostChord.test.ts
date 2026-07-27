import { describe, expect, test } from "vitest";
import { isHostOwnedChord } from "./hostChord";

type ChordEvent = Parameters<typeof isHostOwnedChord>[0];

function chord(overrides: Partial<ChordEvent> = {}): ChordEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: "",
    code: "",
    ...overrides,
  };
}

describe("isHostOwnedChord", () => {
  test.each([
    ["Cmd+`", chord({ metaKey: true, key: "`", code: "Backquote" })],
    [
      "Cmd+Shift+N",
      chord({ metaKey: true, shiftKey: true, key: "N", code: "KeyN" }),
    ],
  ])("%s is host-owned on macOS when chan does not claim it", (_name, event) => {
    expect(isHostOwnedChord(event, { os: "mac", claimedByChan: false })).toBe(true);
  });

  test("a chan claim keeps macOS meta chords in the app", () => {
    const events = [
      chord({ metaKey: true, key: "`", code: "Backquote" }),
      chord({ metaKey: true, shiftKey: true, key: "N", code: "KeyN" }),
    ];
    for (const event of events) {
      expect(isHostOwnedChord(event, { os: "mac", claimedByChan: true })).toBe(false);
    }
  });

  test("terminal copy and paste remain claimed by chan", () => {
    for (const code of ["KeyC", "KeyV"]) {
      expect(
        isHostOwnedChord(chord({ metaKey: true, key: code.at(-1) ?? "", code }), {
          os: "mac",
          claimedByChan: true,
        }),
      ).toBe(false);
    }
  });

  test("a Ctrl chord off macOS is not host-owned", () => {
    expect(
      isHostOwnedChord(chord({ ctrlKey: true, key: "n", code: "KeyN" }), {
        os: "linux",
        claimedByChan: false,
      }),
    ).toBe(false);
  });

  test("an unmodified key is not host-owned", () => {
    expect(
      isHostOwnedChord(chord({ key: "n", code: "KeyN" }), {
        os: "mac",
        claimedByChan: false,
      }),
    ).toBe(false);
  });

  test("Cmd+Ctrl is not host-owned", () => {
    expect(
      isHostOwnedChord(
        chord({ metaKey: true, ctrlKey: true, key: "n", code: "KeyN" }),
        {
          os: "mac",
          claimedByChan: false,
        },
      ),
    ).toBe(false);
  });
});
