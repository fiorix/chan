# release-v0.83.1

v0.83.1 is a patch release with one theme: the desktop renders the command deck inline, the way the browser already did, instead of opening a separate Tauri overlay window.

## What shipped

**The desktop opens the command launcher inline.** `showCommandLauncher` in the workspace SPA routed Tauri desktop to a transparent, always-on-top, undecorated `command-launcher` window, while the inline deck ran only in the browser. The two surfaces therefore behaved differently, and the overlay could be left on screen with no way to dismiss it. Every surface now renders the same inline deck.

Three desktop short-circuits existed only to defer to the overlay, and each would have left the Computers scope advertised but empty once the overlay was out of the path. `refreshScopedLibrary` returned early on desktop, so the scoped snapshot never loaded. The effect that polls it skipped desktop for the same reason. The Computers scope declared itself available from `isTauriDesktop()` rather than from loaded data, so it appeared whether or not anything backed it. All three now derive from the scoped snapshot, which is what the browser already did, so Computers actions resolve on desktop instead of appearing empty.

**Escape releases a pending command instead of hanging the deck.** `pending` is the one operation kind with no button of its own, so a command left in the blocking "Working..." view could not be dismissed. Escape now drops the blocking view while the command it was waiting on keeps running. This fix existed on the overlay investigation branch and never reached the v0.83.0 tag; it applies to the shared deck, so it matters more now that every surface renders that deck.

## What did not ship

**The overlay host itself is still in the tree, unused.** `desktop/src-tauri/src/command_launcher.rs`, its eight Tauri commands, `capabilities/command-launcher.json`, the permission blocks in `permissions/app.toml`, the key handlers injected by `serve.rs`, and the native bridge functions in both SPAs' `api/desktop.ts` are all now unreachable, because nothing invokes `open_command_launcher`. Removing them is a v0.84.0 roadmap item rather than patch-release work.

Three further overlay fixes from the investigation branch are deliberately not carried: they touch `command_launcher.rs` and the native launcher plumbing only, which the release no longer executes.

## Provenance

v0.83.0 shipped the overlay. The inline deck was implemented first, at `b0817c61`, and `bf7abcd3` then reintroduced the desktop overlay dispatch; that commit reached `main` and therefore the tag. The SPA implementation was already complete and correct in the shipped tree, including the scoped library API behind the Computers scope, so this release changes which path desktop takes rather than building anything new.

## Verification

Frontend smoke only, by scope decision: `svelte-check` clean on both `workspace-app` (4,865 files) and `launcher` (3,868 files), plus the launcher-facing vitest suites in both packages, including the operation tests the Escape fix carries with it. The full gate, a Windows mingw cross-check, and a `release.yml` publish=false dry run run before the tag, because the Linux gate cannot see Windows or macOS and v0.83.0 shipped a Windows-only compile break for exactly that reason.
