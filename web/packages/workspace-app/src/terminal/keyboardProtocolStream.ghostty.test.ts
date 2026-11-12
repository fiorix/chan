import { readFileSync } from "node:fs";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { beforeAll, describe, expect, test } from "vitest";
import { KeyboardProtocolObserver } from "./keyboardProtocolStream";
import { copyTerminalKeyboardProtocolState, createTerminalKeyboardProtocolState } from "./keymap";

/// Ghostty's release wasm, vendored in the ghostty widget package (vitest
/// runs in the package directory).
const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

async function upstream(): Promise<GhosttyVt> {
  return new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
}

describe("kitty replies use chan's encoding state", () => {
  test.each([
    ["soft reset", "\x1b[>5u\x1b[!p", 0],
    ["deep stack", Array.from({ length: 10 }, (_, i) => `\x1b[>${i + 1}u`).join("") + "\x1b[<9u", 1],
    ["flags beyond the core's supported bits", "\x1b[>63u", 63],
    ["alternate screen restored", "\x1b[>1u\x1b[?1049h\x1b[>3u\x1b[?1049l", 1],
  ] as const)("%s", async (_name, stream, flags) => {
    const t = (await upstream()).createTerminal(80, 24);
    const protocol = createTerminalKeyboardProtocolState();
    const replies: string[] = [];
    const observer = new KeyboardProtocolObserver(protocol, (reply) => replies.push(reply));
    try {
      const bytes = new TextEncoder().encode(stream + "\x1b[?u");
      // Split every byte so a query crossing output chunks is still answered.
      for (const byte of bytes) {
        observer.push(Uint8Array.of(byte));
        t.write(Uint8Array.of(byte));
      }
      expect(replies).toEqual([`\x1b[?${flags}u`]);
      expect(t.readResponse(), "the core adds no second answer").toBeNull();
    } finally {
      t.free();
    }
  });

  test("a cut replay restores chan's flags after RIS", async () => {
    const t = (await upstream()).createTerminal(80, 24);
    const protocol = createTerminalKeyboardProtocolState();
    const replies: string[] = [];
    const observer = new KeyboardProtocolObserver(protocol, (reply) => replies.push(reply));
    const write = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      observer.push(bytes);
      t.write(bytes);
    };
    try {
      write("\x1b[>5u");
      const saved = createTerminalKeyboardProtocolState();
      copyTerminalKeyboardProtocolState(protocol, saved);
      write("\x1bc");
      copyTerminalKeyboardProtocolState(saved, protocol);
      write("\x1b[?u");
      expect(replies).toEqual(["\x1b[?5u"]);
      expect(t.readResponse(), "the reset core's answer is suppressed").toBeNull();
    } finally {
      t.free();
    }
  });
});
