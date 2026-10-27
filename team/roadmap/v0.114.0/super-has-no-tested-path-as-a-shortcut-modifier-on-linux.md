# Super has no tested path as a shortcut modifier on Linux

Status: accepted for v0.114.0 by the owner's word of 2026-10-27; not started.

## What was asked

The owner asked on 2026-10-27 whether the Windows / Super key could be the app modifier on Windows and Linux, as Cmd is on macOS. The answer was no as a default (Windows reserves nearly every Win+letter in the shell and Win+L cannot be overridden; GNOME, KDE and tiling window managers bind Super), but possibly as an opt-in for Linux setups whose window manager leaves Super free.

## Evidence

Read at `0119a1912`. Off macOS the matcher already names a pressed Super key `Cmd` (`web/packages/workspace-app/src/state/shortcuts.ts`, `eventCandidates`), so a user override such as `Cmd+P` may already work in a browser. The desktop key bridge (`desktop/src-tauri/src/key_bridge.js`, `onKey`) treats `metaKey` like `ctrlKey` off macOS, and several of its arms are written for macOS Cmd (for example Cmd+W closes the tab), so a Super chord on Linux may fire a macOS-only action.

## What to do

1. On a Linux desktop with a window manager that leaves Super+letter free, assign a few overrides with Super in Settings > Keyboard Shortcuts and record which fire in Chan Desktop and in a browser, and which the key bridge intercepts.
2. Decide with the owner: document Super overrides as supported on Linux (fixing any bridge arm that misfires), or keep them unsupported and say so in the manual.

## Acceptance

- The readings from step 1 recorded here, and the owner's decision.
- If supported: a key bridge test that a Linux Super chord fires only its override, and a manual note on the Settings page.
