# The `cs` link bubble outlived the automation that replaced it

Status: accepted scope for v0.98.0, raised by the owner.

## What was seen

Opening a new workspace raises a card in the bottom right corner offering to put `cs` on `$PATH`, either as a Create button or as a manual `ln -s "<binary>" ~/.local/bin/cs` to copy into a terminal. Every supported install now creates `cs` on its own, so the card asks the user to finish a job that is already done.

## Why it is no longer earning its place

The card is gated purely on the server not finding `cs` on `$PATH`. `cs_link::detect` (`crates/chan-server/src/routes/cs_link.rs`) returns `None` the moment `cs_on_path()` resolves, and `showCsCard` in `web/packages/workspace-app/src/components/PreflightOverlay.svelte` is `!!csOffer && !locked && !csDismissed`. That gate was right when installs did not reliably ship the alias. Every path now does:

- `install.sh` links it directly: `ln -sf chan "$bindir/cs"`.
- `install.ps1` writes `cs.cmd` and a Git Bash `cs` shim.
- deb, rpm, AUR, Homebrew, and the Nix derivation all ship a `cs` symlink beside `chan`.
- chan-desktop writes and self-heals `~/.local/bin/{chan,cs}` on every launch (`desktop/src-tauri/src/cs_install.rs`), as symlinks for a `.app` or deb/rpm install and as wrapper scripts for the AppImage.

What remains is the case the card serves worst. A dev build run out of `target/debug` has a binary directory that is not on `$PATH`, so `classify` returns `can_create = false` with the note "the folder holding chan is not on your PATH", and the card renders the manual `ln -s` hint. That is a developer, on a build they compiled, being handed a shell command for a name they can already reach. The card fires exactly where it is least wanted and stays silent everywhere the automation ran.

`chan --help` already carries the same one-liner under EXAMPLES for anyone who genuinely needs it, and it does not need a first-boot overlay to deliver it.

## Desired contract

A new workspace comes up without a `cs` card. Nothing about `cs` detection is surfaced to the user during pre-flight.

The pre-flight surface itself is untouched: the locked boot layer, its phases, and the separate first-run onboarding nudge that points at the Dashboard all stay exactly as they are.

## Boundaries

The card and everything that exists only to feed it:

- `PreflightOverlay.svelte`: the card markup, `csOffer` / `csDismissed` / `csDismissedLocal` / `csBusy` / `csResult` / `csError` / `manualMode` state, `dismissCs`, `createCsLink`, and the `cs-card` styles.
- `crates/chan-server/src/routes/cs_link.rs` and the `POST /api/preflight/cs-link` route.
- The `cs_link` and `cs_dismissed` fields on the pre-flight snapshot (`crates/chan-server/src/routes/preflight.rs`), and their client types in `web/packages/workspace-app/src/api/types.ts`.
- The `createCsLink` and `setCsDismissed` client calls.
- The `cs_dismissed` editor preference (`crates/chan-server/src/preferences.rs` and `crates/chan-server/src/routes/preferences.rs`).

Nothing in `cs_install.rs`, the installers, or the packaging moves: those are the automation this item is retiring the card in favor of, and they keep working exactly as they do.

## The one decision this item needs

Whether to drop `cs_dismissed` from the persisted editor preferences outright, or leave the field parsed and ignored so an existing per-library preferences file does not fail to load. The preferences loader's tolerance for unknown keys decides this, and the answer belongs in the implementation rather than here. Removing the route and the snapshot fields is unambiguous either way: both are chan's own surfaces with no external consumer.

## Acceptance

1. A brand-new workspace boots to the editor with no bottom-right `cs` card, on a packaged install and on a `cargo run` dev build alike, and whether or not `cs` resolves on `$PATH`.
2. `POST /api/preflight/cs-link` is gone, and the pre-flight snapshot carries no `cs_link` or `cs_dismissed`.
3. A library whose persisted preferences file still contains `cs_dismissed = true` loads without error.
4. The pre-flight lock, its phase reporting, and the Dashboard onboarding nudge are unchanged, including the nudge's per-workspace dismissal.
5. `chan --help` still shows the manual `ln -s` line, which is now the only place chan mentions it.
