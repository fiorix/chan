# Ctrl+Alt chords may be refused as AltGr typing on Windows

Status: landed on main at `0119a1912` (2026-10-27); the Windows measurement below is still open.

## What was asked

The owner's words of 2026-10-27, after the Rich Prompt moved to Ctrl+Alt+P off macOS: "i want to understand what options have we got for windows since these shortcuts may conflict with typing characters", then "ok let's go with your option A, i like it".

## Evidence

Read at `a75b8ffe5`. Windows reports AltGr as Ctrl+Alt. Every off-macOS resolver refused a keydown that reported `getModifierState("AltGraph")`: `web/packages/web-shared/src/keyboard.ts` (`shortcutKey`), `desktop/src-tauri/src/key_bridge.js` (`chordKey`) and the reference relay in `crates/chan-server/examples/echo-extension.html`, with the same rule in `docs/extensions.md`. If WebView2 also flags a physical Ctrl+Alt chord as AltGraph on an AltGr layout, every Ctrl+Alt shortcut there (command launcher, Search, Rich Prompt, close window, tab jump) is dead, even for keys whose AltGr layer types nothing. No reading from a real Windows host exists; the layout vectors are constructed.

## Desired contract

Off macOS an AltGraph keydown is text entry unless Ctrl and Alt are both held and the key is still a plain ASCII letter or digit: AltGr+S typing a Polish s-acute stays typing, Ctrl+Alt+P on German QWERTZ is P. Linux AltGr, which carries no Ctrl, stays text entry. macOS is unchanged.

## What landed

`0119a1912` applies the rule in the three resolvers and the extension contract, adds four shared layout vectors (QWERTZ Ctrl+Alt+P and Ctrl+Alt+5 typing nothing, Polish AltGr+S, Linux AltGr+P with no Ctrl) and a Windows Ctrl+Alt+W key bridge test. Reverting the guard fails the new vectors in `shortcutKey` and the relay, and the bridge test.

## Still open: measure on Windows

On a Windows host, in Chan Desktop (WebView2), log `key`, `code`, `ctrlKey`, `altKey` and `getModifierState("AltGraph")` on German QWERTZ and Polish (programmers) for: right AltGr plus a letter that types a character, right AltGr plus a letter that types nothing, left Ctrl+Alt plus each of those two letters. The rule holds if a key that typed nothing reports its plain letter and a key that typed a character reports that character. If WebView2 reports something else, the fallback is Windows-only Ctrl+Shift forms where they are free.

## Acceptance

- The Windows readings above recorded in this file.
- Ctrl+Alt+K, Ctrl+Alt+S and Ctrl+Alt+P fire on German QWERTZ in Chan Desktop on Windows; AltGr+Q still types `@` and AltGr+S on Polish still types its s-acute in a terminal and in the editor.
