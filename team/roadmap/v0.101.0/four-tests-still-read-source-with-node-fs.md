# Four tests still read source with node:fs

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised during v0.101.0 on 2026-09-25 from the independent review of the first source-text test lane. The four files were outside both lanes' lists by construction (the round took the files that import with `?raw`), and the webdev standards name them as known exceptions until this item decides them.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, in one test hygiene lane with [the-attach-prelude-order-has-no-rust-test](the-attach-prelude-order-has-no-rust-test.md), which settles the rule for `table.test.ts`: it becomes a listed allowed case under the webdev standards' narrow rule if what it reads, `Wysiwyg.svelte`'s stylesheet, ships a visible failure when broken, and otherwise its assertion is dropped.

## What was seen

Four workspace-app tests read production or sibling-package source through `node:fs` and match its text:

- `editor/widgets/table.test.ts` reads `src/editor/Wysiwyg.svelte`'s stylesheet (`:328`, `:346`).
- `state/desktopBridgeLayout.test.ts` reads the desktop app's `serve.rs`, `main.rs`, `connecting.js` and `connecting.html`.
- `state/keyboardLayout.test.ts` reads the desktop app's `serve.rs`.
- `state/extensionRelayLayout.test.ts` reads `crates/chan-server/examples/echo-extension.rs`.

A rename or reformat on the read side turns `make web-check` red with no change in behaviour, the failure the source-text round removed elsewhere.

## Desired contract

Each case is either an allowed case under the webdev standards' narrow rule, listed with its contract, or replaced by a test on the side that owns the behaviour (a Rust test in the desktop crate or chan-server, a mounted test for the table widget).

## Boundaries

The four test files, the tests that would replace them in `desktop/src-tauri` or `crates/chan-server`, and the `## Tests` section of `.agents/skills/webdev/SKILL.md`.
