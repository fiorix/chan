# A held key in a macOS terminal opens the accent picker instead of repeating

Status: accepted for v0.134.0 by the owner on 2026-11-23; not started.

Record: the owner's report of 2026-11-23: since v0.13x, holding a key in a chan terminal on macOS opens the press-and-hold accent picker (holding `a` offers `a` with a grave, an acute and the other accents), drawn far from the terminal cursor, where a terminal should repeat the key. Accents in the file editor are fine; in a terminal a held key should repeat, and a character with an accent can be pasted.

## What is there now

Read at `f5657caab`, by reading; not run on a Mac. The terminal takes keys through a hidden text field, and WKWebView applies macOS press-and-hold to any focused text field. Nothing in chan handles press-and-hold: no `ApplePressAndHoldEnabled` default in chan-desktop and no handling of repeated key events in the terminal's input.

## Desired contract

1. In a chan terminal on macOS, holding a key repeats it at the system's key-repeat rate, and no accent picker opens.
2. The file editor and every other text field keep macOS press-and-hold accents.
3. IME composition, dead keys and Option as Meta in the terminal behave as before.

## Boundaries

- The terminal's input path in the widget and the app; chan-desktop only if a terminal-scoped fix cannot be made in WKWebView, and then only after the owner agrees to an app-wide change.
- Not here: the input handler's wider modernization.

## Acceptance

1. A diagnosis of where press-and-hold enters on WKWebView, with the change that removes it for the terminal alone.
2. An automated check where an engine allows it (repeated keydown with `repeat: true` reaching the PTY as repeated bytes), red at the base.
3. The owner's Mac reading: holding `a` in a terminal repeats it; holding `a` in the editor still offers accents; Japanese IME and a dead key still compose in the terminal.
