import { expect, test } from "vitest";
import { GhosttyStatusGuard } from "./ghosttyStatusGuard";

const enc = new TextEncoder();
function bytes(text: string): Uint8Array { return enc.encode(text); }
function split(text: string): string {
  const guard = new GhosttyStatusGuard();
  const output: number[] = [];
  for (const byte of bytes(text)) output.push(...guard.push(Uint8Array.of(byte)));
  return new TextDecoder().decode(Uint8Array.from(output));
}

test("a byte-split BEL report and query are consumed without changing surrounding bytes", () => {
  expect(split("a\x1b]7501;state=working\x07b\x1b]7501;?\x07c")).toBe("abc");
});

test("an ESC ends capture and is passed to the engine", () => {
  expect(split("a\x1b]7501;state=done\x1b\\b")).toBe("a\x1b\\b");
});

test("CAN and SUB end capture and pass through", () => {
  expect(split("a\x1b]7501;state=working\x18b\x1b]7501;?\x1ac")).toBe("a\x18b\x1ac");
});

test("an overlong BEL report is discarded through its terminator", () => {
  expect(split(`a\x1b]7501;${"x".repeat(4088)}\x07b`)).toBe("ab");
});

test("an overlong ESC report passes the ending ESC to the engine", () => {
  expect(split(`a\x1b]7501;${"x".repeat(4088)}\x1b\\b`)).toBe("a\x1b\\b");
});

test("nonmatching, partial and adjacent escape sequences stay byte exact", () => {
  const sample = "a\x1b]7500;?\x07\x1b[?62;22c\x1b]7501x\x07z";
  expect(split(sample)).toBe(sample);
});
