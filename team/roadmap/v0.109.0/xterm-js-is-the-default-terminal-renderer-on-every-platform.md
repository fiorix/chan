# xterm.js is the default terminal renderer on every platform

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the owner's word in the lead's terminal; the tooling and native-evidence seat builds it; closes in the version.

## What was seen

`terminal.ghostty` (`crates/chan-library/src/config.rs`, `default_terminal_ghostty()` at 268) defaults to `cfg!(target_os = "linux")`, pinned at 718 and 727, so a new terminal on a Linux server parses and renders through ghostty-web unless a choice is stored, and through xterm.js on macOS and Windows. The Settings hint (`components/settings/TerminalSection.svelte` 286) and the browser suite's README (line 74: "new terminals use ghostty on Linux unless a choice is stored") state that default, and the suite's helpers (`lib/terminal-prefs.mjs`, `lib/terminal-attach.mjs`) and checks 93, 94, 97, 105, 137, 152 and 170 name ghostty. The Linux default came in with the measurement in the changelog's v0.89.0 entry: the Linux desktop's xterm.js DOM renderer defers box-drawing and block characters to the font, which leaves an unpainted scanline at every cell boundary (96.0 percent rule continuity and 95.2 percent block coverage against a 99.5 percent bar), while ghostty draws them itself. Since v0.93.0 the AppImage uses the WebGL renderer, which measures 100 percent, where its driver supports the accelerated path, so the DOM renderer's gap is the deb's and the RPM's, and an AppImage's on a driver that keeps WebKit off dma-buf (the NVIDIA proprietary driver). `docs/config-reference.md` 31 states the default for a person, and a test comment in `crates/chan-library/src/terminal_sessions.rs` (11017) names it; `lib/program-status.mjs` sets each backend explicitly and restores it. The typed-input broadcast item routes a person's input through xterm.js's user-input mark and leaves ghostty's route as it is, so a ghostty terminal keeps that loss.

## Owner's word 2026-10-21

In the lead's terminal: "i think what i want about the xterm vs ghostty is to make xterm.js the default on all platforms, this is a change to linux.. and from this change if ghostty loses functionality like the secret masking, it is fine". Read as the product's word: one default, xterm.js, on every platform; ghostty stays the opt-in it is on macOS and Windows; a feature ghostty lacks or loses is accepted, the typed-input broadcast included. The block characters under xterm.js's DOM renderer on the Linux deb and RPM, and on an AppImage whose driver keeps WebKit off dma-buf, are the known cost of the default, by the measurements above.

## Desired contract

A new terminal uses xterm.js on every platform unless `terminal.ghostty` is stored as true; a stored choice is kept; the Settings control and its hint offer ghostty as the renderer that draws block characters itself; the browser suite's README and helpers say xterm.js is the default everywhere and a check that needs ghostty sets the preference; the design documents and the changelog say so.

## What to do

Make `default_terminal_ghostty()` return `false` and reword its doc comment at 95 to say why ghostty is the opt-in (the Linux desktop's block characters). Turn the two pins at 718 and 727 into `false` on every platform, red first; one mutant restores the Linux default and is red there. Grep the `chan` and `chan-server` crates and the web packages for a reader of that default (`cfg!(target_os = "linux")` beside ghostty, a test fixture pinning it, the Settings hint at 286 and the comment at 40) and move each; the configuration reference's row at `docs/config-reference.md` 31 and the test comment in `terminal_sessions.rs` move with them, while `lib/program-status.mjs` needs nothing. Rewrite the suite README's line 74 and read `lib/terminal-prefs.mjs`, `lib/terminal-attach.mjs` and the seven checks for a Linux-default assumption; a check that needs ghostty sets the preference and restores it, as line 74 already asks. Run the whole `chan-library`, `chan` and `chan-server` suites and `make web-check` at the commit, and the affected checks alone at the commit under the new default. The design documents that state the default follow in the same commit; the changelog line is the lead's.

## Boundaries

`crates/chan-library/src/config.rs` and its tests, any reader of the default in `crates/chan/` and `crates/chan-server/`, `components/settings/TerminalSection.svelte`'s hint and comment, `docs/config-reference.md`, `scripts/e2e/browser-smoke/README.md`, its helpers and the checks' preference set-up, the design documents that state the default. Not changed: the two renderers, ghostty-web, the Settings control itself, the secret masking, the typed-input broadcast route, the desktop shell.

## Acceptance

1. The two pins red at the parent and green at the commit, the mutant red, the whole `chan-library`, `chan` and `chan-server` suites green at the commit, with the commands and logs recorded here.
2. `make web-check` green at the commit; the checks that mount a terminal without a stored choice green alone at the commit under xterm.js, and the whole browser suite at the freeze under the new default.
3. The README, the Settings hint, the configuration reference and the design documents state the default; the changelog names the change.
