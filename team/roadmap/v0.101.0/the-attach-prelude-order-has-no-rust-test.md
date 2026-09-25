# The terminal attach prelude order has no Rust test

Status: raised during v0.101.0 on 2026-09-25 from the second source-text test lane's second round, which traced each assertion of `terminal/protocol.test.ts` to a Rust test and found three with none.

## What was seen

`web/packages/workspace-app/src/terminal/protocol.test.ts` reads `crates/chan-server/src/routes/terminal.rs` with `node:fs` and matches its text. Two of its four checks are pinned in Rust and were dropped from the web test. Three remain with no Rust test behind them: the attach prelude sends the session frame before the replay, the alt-screen prelude sits between the replay and `ready`, and a Resize frame resizes the PTY. They stay as a listed source read in the webdev standards until a Rust test pins them.

## Desired contract

The attach prelude's frame order and the Resize handling are pinned by chan-server tests that drive a socket, and the web test reads no Rust source.

## Boundaries

`crates/chan-server/src/routes/terminal.rs` tests, `web/packages/workspace-app/src/terminal/protocol.test.ts`, and its entry in `.agents/skills/webdev/SKILL.md`.
