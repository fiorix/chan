# The Computers screen shows every address and token while the screen is shared

Status: shipped in [v0.126.0](../../release/release-v0.126.0.md).

Record before the release: raised by the owner on 2026-11-08 with the code on `codex/privacy-mode` (`c94869906`); accepted for v0.126.0; built by the owner, merged into the integration branch, awaiting the release.

## What is there now

Recording or sharing a chan window shows whatever the Computers screen, the gateway forms, the connecting page and the window titles hold: computer names and addresses, connect scripts, gateway URLs, WireGuard paths and public keys, connection and retry errors, and the workspace paths in the Computers rows. Nothing in chan-desktop or the SPA conceals them; the only related control is the per-terminal secret masker in the terminal's menu.

## Desired contract

1. Settings > Global > Privacy mode, off by default, is the viewing client's policy: in chan-desktop it is the desktop's own setting (`privacy` in the desktop config: `enabled`, `mask_terminal_secrets`, a monotonic `revision`), shared live across every window the desktop shows, local and remote, through a bridge injected before page code; in a browser it is a per-origin setting shared across that origin's tabs. It changes no tenant preference.
2. On, the Computers screen, the gateway and devserver forms, the command deck's confirmations, the notice bubbles, the connecting page and the disconnect overlay show placeholders for computer and gateway names, addresses, connect scripts, WireGuard paths and keys, workspace paths and connection or retry errors; each placeholder carries an eye button that reveals that one field; a concealed value is absent from the rendered text, the input values and the hover titles; reveals survive a reload and are cleared by a mode change. Window titles and the Window menu read "Chan (privacy mode)". Fields stay concealed until the policy has been read, and a failed read keeps them concealed with a Retry.
3. Also enable terminal secret masking, a second toggle, turns the existing masker on in every terminal while privacy is on and gives each terminal its own setting back after.
4. Recording detection is not part of it; the mode is manual.

## Boundaries

- No change to the serving tenant's preferences, to the devserver or to the gateway; a remote page needs the updated frontend to conceal.
- The two desktop commands reach local and gateway-served windows alike, as the title bar preference pair does.

## Acceptance

1. The lead's scoped gate at the tip (fmt, clippy, rustdoc and the tests of chan-desktop; `make web-check`, `make e2e-check`, `make shortcuts-check`) green; the full gate on the integration branch after the merge.
2. The owner's validation on his Mac: the frontend checks, the desktop tests and clippy, browser checks for reveal, reload and live changes, the macOS package smoke.
