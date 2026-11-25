import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { GhosttyVt, type VtTerminal } from "@chan/ghostty-web-ng/vt";

// What the vendored core does with the prelude the server writes before a
// resumed view's live output (private_mode_recovery_prelude in
// crates/chan-library/src/terminal_sessions.rs): a head that leaves any
// alternate screen, then each private mode the server tracks set or reset
// to the session's state. Each case writes the prelude's bytes into a core
// terminal through chan's binding and reads the state the widget and chan's
// key encoder read: application cursor keys, mouse tracking, bracketed
// paste and the cursor. A re-asserted mode the core ignored would leave a
// resumed program's arrow keys, mouse reports and pastes in their defaults.

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;
const terminals: VtTerminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.free();
});

async function core(): Promise<VtTerminal> {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const terminal = vt.createTerminal(80, 24);
  terminals.push(terminal);
  return terminal;
}

describe("the core follows the re-asserted private modes", () => {
  test("one stream sets DECCKM, mouse tracking and bracketed paste, and one resets them", async () => {
    const term = await core();
    // A fresh core, as a reloaded view opens one, has each mode off.
    expect(term.getMode(1)).toBe(false);
    expect(term.hasMouseTracking()).toBe(false);
    expect(term.getMode(2004)).toBe(false);

    // The re-assert for an htop session: DECCKM, normal mouse tracking,
    // SGR mouse encoding and bracketed paste.
    term.write("\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[?2004h");
    expect(term.getMode(1)).toBe(true);
    expect(term.hasMouseTracking()).toBe(true);
    expect(term.getMode(2004)).toBe(true);

    term.write("\x1b[?1l\x1b[?1000l\x1b[?2004l");
    expect(term.getMode(1)).toBe(false);
    expect(term.hasMouseTracking()).toBe(false);
    expect(term.getMode(2004)).toBe(false);
  });
});

describe("the normal-screen head", () => {
  // The core's ?1049l restores the saved cursor whether or not a program
  // saved one, on the normal screen too, so the server's head saves the
  // cursor (ESC 7) before it leaves the alternate screens. That the saving
  // head keeps the cursor is a case of TerminalTab.ghosttySession.test.ts.
  test("without a cursor save moves the resumed cursor to the unset saved slot, the home cell", async () => {
    const term = await core();
    term.write("\x1b[24;40H");
    expect(term.getCursor()).toMatchObject({ x: 39, y: 23 });
    term.write("\x18\x1b[?1049;1047;47l");
    expect(term.getCursor()).toMatchObject({ x: 0, y: 0 });
  });
});
