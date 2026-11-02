// Byte streams for the ghostty binding's text reads: scrolling, scroll
// regions, insert and delete, erases, the alternate screen, resets, margins,
// palette and default color changes, synchronized output, erased scrollback
// and a pending wrap (SCREEN_STREAMS), and UTF-8, wide characters, ZWJ and
// combining clusters, SGR with OSC 8, and a wide character at the last column
// (TEXT_STREAMS).

export const SCREEN_STREAMS: Record<string, string> = {
  "scrolling output": Array.from({ length: 60 }, (_, i) => `line ${i} \x1b[3${i % 8}mcolor\x1b[0m`).join("\r\n"),
  "scroll region newlines": "\x1b[2J\x1b[H" + Array.from({ length: 10 }, (_, i) => `r${i}`).join("\r\n") + "\x1b[3;8r\x1b[8;1H" + Array.from({ length: 12 }, (_, i) => `\nreg${i}`).join("\r") + "\x1b[r",
  "insert/delete lines and chars": "aaaa\r\nbbbb\r\ncccc\r\ndddd\r\neeee\x1b[2;1H\x1b[2L\x1b[4;1H\x1b[M\x1b[1;2H\x1b[2@XY\x1b[3;1H\x1b[2P\x1b[5;1H\x1b[3X",
  "erase variants": "1111111111\r\n2222222222\r\n3333333333\r\n4444444444\x1b[2;5H\x1b[1K\x1b[3;5H\x1b[0K\x1b[1;5H\x1b[2K\x1b[3;3H\x1b[1J",
  "reverse index at top": "top\r\nmid\r\nbot\x1b[H\x1bM\x1bMnew",
  "scroll up/down": "a\r\nb\r\nc\r\nd\x1b[2S\x1b[1T",
  "alternate screen round trip": "primary row\r\nsecond\x1b[?1049h\x1b[2J\x1b[Halt 1\r\nalt 2\x1b[?1049lback",
  "RIS mid-stream": "\x1b[41mbefore reset\r\nmore\x1bcafter",
  "DECALN": "x\x1b#8",
  "wide char overwritten": "日本語\x1b[1;2Hab",
  "left/right margins": "\x1b[?69h\x1b[3;10s" + "0123456789ABCDEF\r\n".repeat(4) + "\x1b[2;3H\x1b[L\x1b[?69l",
  "palette change after colored text (OSC 4)": "\x1b[31mred\x1b[0m\r\n\x1b[42mgreen bg\x1b[0m\x1b]4;1;rgb:12/34/56\x1b\\\x1b]4;2;rgb:65/43/21\x07",
  "default colors change (OSC 10/11)": "plain\r\n\x1b[1mbold\x1b[0m\x1b]11;rgb:20/30/40\x1b\\\x1b]10;rgb:a0/b0/c0\x1b\\",
  "reverse video (DECSCNM)": "text\x1b[?5h",
  "synchronized output": "\x1b[?2026hframe\r\nrows\x1b[?2026l",
  "erase scrollback (ED 3)": Array.from({ length: 30 }, (_, i) => `l${i}`).join("\r\n") + "\x1b[3J",
  "pending wrap then CR": "x".repeat(80) + "\ry",
};

export const TEXT_STREAMS: Record<string, string> = {
  "utf-8 and wide": "héllo 日本語 ｗｉｄｅ 한국어 ✓ €",
  "zwj cluster": "a👨‍👩‍👧b👍🏽c🇯🇵d",
  "combining": "é ñ å",
  "sgr and osc 8": "\x1b[38;2;10;20;30mrgb\x1b[0m \x1b]8;;https://x.test/\x1b\\link\x1b]8;;\x1b\\ done",
  "wide at last column": "x".repeat(79) + "日" + "after",
};
