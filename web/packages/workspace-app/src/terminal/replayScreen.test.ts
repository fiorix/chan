import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { GhosttyVt, type VtTerminal } from "@chan/ghostty-web-ng/vt";
import { replayScreenOf, replayScreenSwitch } from "./replayScreen";

// What the vendored core does with the switch the tab writes ahead of a
// reconciling replay: the screen it lands on, where the cursor stands, the
// screen modes, and the cursor the normal screen saved, which a program's
// later restore (ESC 8, or its own 1049 exit) reads back.

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";

let vendored: WebAssembly.Module;
const terminals: VtTerminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.free();
});

/// A core on the normal screen with the cursor saved at column 2, row 6 and
/// standing at column 4, row 9.
async function shell(): Promise<VtTerminal> {
  const term = new GhosttyVt(await WebAssembly.instantiate(vendored, {})).createTerminal(80, 24);
  terminals.push(term);
  term.write("\x1b[7;3H\x1b7\x1b[10;5H");
  return term;
}

const cursor = (term: VtTerminal) => {
  const { x, y } = term.getCursor();
  return { x, y };
};
const view = (term: VtTerminal) => ({ alternate: term.isAlternateScreen(), mode1049: term.getMode(1049) });
const screenModes = (term: VtTerminal) => [47, 1047, 1049].filter((mode) => term.getMode(mode));

describe("replayScreenSwitch", () => {
  test("writes nothing to a view already on the replay's screen", async () => {
    const term = await shell();
    expect(replayScreenSwitch(view(term), "normal")).toBe("");
    term.write("\x1b[?1049h");
    expect(replayScreenSwitch(view(term), "alternate")).toBe("");
  });

  test.each([
    // A program that entered by 1049 saved the cursor at its entry, and its
    // exit restores it.
    { enter: "\x1b[?1049h", at: { x: 4, y: 9 }, saved: { x: 4, y: 9 } },
    // One that entered by 1047 or 47 saved none, and its exit leaves the
    // cursor where it stands.
    { enter: "\x1b[?1047h", at: { x: 5, y: 2 }, saved: { x: 2, y: 6 } },
    { enter: "\x1b[?47h", at: { x: 5, y: 2 }, saved: { x: 2, y: 6 } },
  ])("takes a view that entered the alternate screen by $enter to the normal screen as the program's exit would", async ({ enter, at, saved }) => {
    const term = await shell();
    // The program moves the cursor on its alternate screen.
    term.write(`${enter}\x1b[3;6H`);
    term.write(replayScreenSwitch(view(term), "normal"));
    expect(term.isAlternateScreen(), "the normal screen").toBe(false);
    expect(screenModes(term), "no alternate-screen mode left set").toEqual([]);
    expect(cursor(term), "the cursor where the program's exit leaves it").toEqual(at);
    term.write("\x1b8");
    expect(cursor(term), "the normal screen's saved cursor is the one it had").toEqual(saved);
    term.write("\x1b[?1049h");
    expect(term.isAlternateScreen(), "a later entry still switches").toBe(true);
  });

  test("takes a view on the normal screen to the alternate screen without saving its cursor", async () => {
    const term = await shell();
    term.write(replayScreenSwitch(view(term), "alternate"));
    expect(term.isAlternateScreen(), "the alternate screen").toBe(true);
    expect(cursor(term), "the cursor stays").toEqual({ x: 4, y: 9 });
    term.write("\x1b[?1047l\x1b8");
    expect(cursor(term), "the normal screen's saved cursor is the one it had").toEqual({ x: 2, y: 6 });
  });

  test("ends a sequence the view was left inside before it switches", async () => {
    const term = await shell();
    term.write("\x1b[?1049h\x1b[?100");
    term.write(replayScreenSwitch(view(term), "normal"));
    expect(term.isAlternateScreen(), "the normal screen").toBe(false);
    expect(term.getMode(1000), "the cut sequence set no mode").toBe(false);
  });
});

describe("replayScreenOf", () => {
  test("reads the two screens and nothing else", () => {
    expect([replayScreenOf("normal"), replayScreenOf("alternate")]).toEqual(["normal", "alternate"]);
    expect([replayScreenOf(undefined), replayScreenOf("main"), replayScreenOf(1)]).toEqual([null, null, null]);
  });
});
