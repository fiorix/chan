import { afterEach, describe, expect, test, vi } from "vitest";
import { shortcutLetter } from "@chan/web-shared/keyboard";
import { chordFromEvent, shouldEscapeTerminal } from "./shortcuts";
import { readFileSync } from "node:fs";

const desktopSource = readFileSync("../../../desktop/src-tauri/src/serve.rs", "utf8");

const bridge = desktopSource.match(/const KEY_BRIDGE_JS: &str = r#"([\s\S]*?)"#;/)![1];

afterEach(() => vi.unstubAllGlobals());

describe("layout-resolved letter shortcuts", () => {
  test.each([
    ["t", "KeyF", "T"],
    ["T", "KeyF", "T"],
    ["f", "KeyE", "F"],
    ["o", "Semicolon", "O"],
    [";", "KeyP", null],
    ["a", "KeyQ", "A"],
    ["z", "KeyY", "Z"],
  ] as const)("%s on %s resolves to %s", (key, code, expected) => {
    expect(shortcutLetter({ key, code, altKey: false })).toBe(expected);
  });

  test("Colemak new-terminal chord escapes with its logical letter", () => {
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
    const event = new KeyboardEvent("keydown", {
      key: "T", code: "KeyF", ctrlKey: true, shiftKey: true,
    });
    expect(chordFromEvent(event)).toBe("Ctrl+Shift+T");
    expect(shouldEscapeTerminal(event)).toBe(true);
    expect(shouldEscapeTerminal(new KeyboardEvent("keydown", {
      key: "g", code: "KeyT", ctrlKey: true, shiftKey: true,
    }))).toBe(false);
  });

  test.each([
    ["t", "KeyF", false, "app.terminal.toggle"],
    ["T", "KeyF", false, "app.terminal.toggle"],
    ["T", "KeyF", true, "app.tab.reopenClosed"],
    ["f", "KeyE", false, "app.find.open"],
    ["g", "KeyT", false, "app.find.next"],
    [";", "KeyP", false, undefined],
  ] as const)("desktop Cmd+%s on %s (shift=%s) dispatches %s", (key, code, shiftKey, command) => {
    const dispatchEvent = vi.fn();
    const addEventListener = vi.fn();
    // Execute the injected bridge with an isolated host so listeners cannot
    // leak into other tests or hide duplicate command dispatches.
    new Function("window", "location", "CustomEvent", bridge)(
      { addEventListener, dispatchEvent }, { pathname: "/" }, CustomEvent,
    );
    const onKey = addEventListener.mock.calls[0][1];
    const event = new KeyboardEvent("keydown", {
      key, code, shiftKey, metaKey: true, cancelable: true,
    });
    onKey(event);
    expect(dispatchEvent.mock.calls.map(([e]) => e.detail.name)).toEqual(
      command ? [command] : [],
    );
    expect(event.defaultPrevented).toBe(command !== undefined);
  });
});
