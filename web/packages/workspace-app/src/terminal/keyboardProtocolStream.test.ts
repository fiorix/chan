import { beforeAll, describe, expect, test } from "vitest";
import {
  createTerminalKeyboardProtocolState,
  installKeyboardProtocolHandlers,
  type TerminalKeyboardProtocolState,
} from "./keymap";
import { KeyboardProtocolObserver } from "./keyboardProtocolStream";

// xterm.js's own parser, from the TypeScript source its package ships
// (vite.config.ts aliases its imports), runs chan's xterm.js handlers as the
// reference. The specifier is a variable so svelte-check does not try to
// type xterm.js's source.
type Params = { toArray(): Array<number | number[]> };
type Parser = {
  registerCsiHandler(id: object, handler: (params: Params) => boolean): void;
  registerEscHandler(id: object, handler: () => boolean): void;
  parse(data: Uint32Array, length: number): void;
};
const XTERM_PARSER = "common/parser/EscapeSequenceParser";
let Parser: new () => Parser;

beforeAll(async () => {
  Parser = ((await import(/* @vite-ignore */ XTERM_PARSER)) as { EscapeSequenceParser: new () => Parser })
    .EscapeSequenceParser;
});

type Run = { protocol: TerminalKeyboardProtocolState; replies: string[] };

/// chan's xterm.js terminal: its handlers on xterm.js's parser, which hands
/// them params through the public API's toArray().
function xterm(stream: string): Run {
  const parser = new Parser();
  const protocol = createTerminalKeyboardProtocolState();
  const replies: string[] = [];
  const api = {
    registerCsiHandler: (id: object, cb: (params: Array<number | number[]>) => boolean) =>
      parser.registerCsiHandler(id, (params) => cb(params.toArray())),
    registerEscHandler: (id: object, cb: () => boolean) => parser.registerEscHandler(id, cb),
  };
  installKeyboardProtocolHandlers({ parser: api } as never, protocol, (r) => replies.push(r));
  const codes = Uint32Array.from([...stream].map((c) => c.codePointAt(0)!));
  parser.parse(codes, codes.length);
  return { protocol, replies };
}

/// The observer, fed the stream's UTF-8 bytes in the given pieces.
function observer(stream: string, cuts: number[] = []): Run {
  const protocol = createTerminalKeyboardProtocolState();
  const replies: string[] = [];
  const observe = new KeyboardProtocolObserver(protocol, (r) => replies.push(r));
  const bytes = new TextEncoder().encode(stream);
  let at = 0;
  for (const cut of [...cuts, bytes.length]) {
    observe.push(bytes.subarray(at, cut));
    at = cut;
  }
  return { protocol, replies };
}

/// The VT answers the kitty query on ghostty, so the observer leaves it.
function withoutKittyQueryReplies(run: Run): Run {
  return { ...run, replies: run.replies.filter((r) => !/^\x1b\[\?\d+u$/.test(r)) };
}

const CORPUS: Array<[string, string]> = [
  ["kitty push", "\x1b[>1u"],
  ["kitty push with no flags", "\x1b[>u"],
  ["kitty push, pop", "\x1b[>8u\x1b[>1u\x1b[<u"],
  ["kitty pop two", "\x1b[>8u\x1b[>1u\x1b[<2u"],
  ["kitty pop past the stack", "\x1b[>8u\x1b[<5u"],
  ["kitty set, or, and-not", "\x1b[=9u\x1b[=2;2u\x1b[=1;3u"],
  ["kitty query", "\x1b[>5u\x1b[?u"],
  ["kitty on the alternate screen", "\x1b[>1u\x1b[?1049h\x1b[>8u\x1b[?1049l"],
  ["alternate screen 47 and 1047", "\x1b[?47h\x1b[>2u\x1b[?47l\x1b[?1047h\x1b[=4u"],
  ["screen switch among other modes", "\x1b[?25;1049h\x1b[>3u"],
  ["modifyOtherKeys", "\x1b[>4;2m"],
  ["modifyOtherKeys query", "\x1b[>4;1m\x1b[?4m"],
  ["modifyOtherKeys query for another resource", "\x1b[?1m"],
  ["modifyOtherKeys reset by the empty form", "\x1b[>4;2m\x1b[>m"],
  ["modifyOtherKeys disable", "\x1b[>4;2m\x1b[>4n"],
  ["modifyOtherKeys disable all", "\x1b[>4;2m\x1b[>n"],
  ["modifyOtherKeys for another resource", "\x1b[>1;2m"],
  ["DECSTR", "\x1b[>4;2m\x1b[>1u\x1b[!p"],
  ["RIS", "\x1b[>4;2m\x1b[>1u\x1bc"],
  ["RIS after an intermediate is not RIS", "\x1b[>1u\x1b#c"],
  ["sub-params", "\x1b[>4:1;2m\x1b[=5:3:2;2u"],
  ["empty params", "\x1b[>;2m\x1b[=;u"],
  ["a big param", "\x1b[>4;99999999999m\x1b[?4m"],
  ["many params", `\x1b[>4;${"1;".repeat(40)}2m\x1b[?4m`],
  ["many sub-params", `\x1b[>4:${"1:".repeat(40)}9;2m\x1b[?4m`],
  ["a prefix after a param is ignored", "\x1b[>4?2m\x1b[?4m"],
  ["a param after an intermediate is ignored", "\x1b[> 1u\x1b[>1 2u"],
  ["intermediates change the sequence", "\x1b[?1049$h\x1b[>1$u"],
  ["SGR is not a protocol sequence", "\x1b[4;2m\x1b[38;5;1m"],
  ["CAN aborts", "\x1b[>1\x18u\x1b[>2u"],
  ["SUB aborts", "\x1b[>1\x1au"],
  ["ESC restarts", "\x1b[>1\x1b[>2u"],
  ["C0 inside a CSI runs and keeps it", "\x1b[>\x071\nu"],
  ["DEL inside a CSI is ignored", "\x1b[>1\x7fu"],
  ["DEL after ESC is ignored", "\x1b\x7f[>1u"],
  ["non-ASCII inside a CSI ends it", "\x1b[>1éu\x1b[>2u"],
  ["non-ASCII after ESC ends it", "\x1bé[>1u"],
  ["OSC text is skipped", "\x1b]0;\x1b[>1u-ish title\x07[>2u\x1b[>4u"],
  ["OSC ended by ST", "\x1b]2;[>1u\x1b\\\x1b[>3u"],
  ["OSC ended by BEL", "\x1b]2;x\x07\x1b[>3u"],
  ["DCS text is skipped", "\x1bP1$r[>1u\x07[>2u\x1b\\\x1b[>4u"],
  ["APC text is skipped", "\x1b_Ga=q;[>1u\x07[>2u\x1b\\\x1b[>4u"],
  ["SOS and PM text is skipped", "\x1bX[>1u\x1b\\\x1b^[>2u\x1b\\\x1b[>4u"],
  ["UTF-8 text around sequences", "héllo ☃ \x1b[>1u wörld \u{1f600}\x1b[>2u"],
];

function same(stream: string, cuts?: number[]) {
  const want = withoutKittyQueryReplies(xterm(stream));
  const got = observer(stream, cuts);
  expect(got).toEqual(want);
}

describe("the observer follows the stream as chan's xterm.js handlers do", () => {
  test.each(CORPUS)("%s", (_name, stream) => {
    same(stream);
  });

  test.each(CORPUS)("%s, split at every byte", (_name, stream) => {
    const length = new TextEncoder().encode(stream).length;
    for (let cut = 1; cut < length; cut++) same(stream, [cut]);
    same(stream, Array.from({ length: length - 1 }, (_, i) => i + 1));
  });

  test("random streams over the protocol's alphabet", () => {
    // A fixed-seed LCG, so a failure names a reproducible stream.
    let seed = 0x5eed;
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const alphabet = [
      "\x1b", "[", "]", "P", "_", "X", "^", "\\", "?", ">", "<", "=", "!", "$", " ", "#",
      "0", "1", "2", "4", "7", "9", ";", ":", "u", "m", "n", "h", "l", "p", "c",
      "\x07", "\x18", "\x1a", "\x7f", "\n", "a", "é",
    ];
    for (let run = 0; run < 3000; run++) {
      const length = 1 + Math.floor(next() * 40);
      let stream = "";
      for (let i = 0; i < length; i++) stream += alphabet[Math.floor(next() * alphabet.length)];
      const want = withoutKittyQueryReplies(xterm(stream));
      const got = observer(stream, [Math.floor(next() * new TextEncoder().encode(stream).length)]);
      expect(got, JSON.stringify(stream)).toEqual(want);
    }
  });
});

test("the kitty query is left to the VT and the modifyOtherKeys query is answered", () => {
  const { replies } = observer("\x1b[>1u\x1b[?u\x1b[>4;2m\x1b[?4m");
  expect(replies).toEqual(["\x1b[>4;2m"]);
});
