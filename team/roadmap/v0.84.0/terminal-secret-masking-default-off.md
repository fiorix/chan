# Terminal secret masking defaults off

Status: REGISTERED for v0.84.0, implemented 2026-08-04, focused validation complete, integrated release gate pending.

## What

Secret masking makes large terminal scrollback replay materially less usable when enabled. v0.84.0 uses an opt-in default: new configurations and configurations that omit `terminal.secret_masking` resolve to `false`.

Users who need masking can set `terminal.secret_masking = true`. The terminal context-menu switch is ephemeral and changes only the mounted tab.

## Contract

- The library and server defaults are `false`.
- A missing `terminal.secret_masking` field deserializes to `false`.
- An explicit `terminal.secret_masking = true` resolves to `true`.
- The preferences API reports the effective default as `false`.
- The Settings display and terminal startup fallback agree with the server default.
- The context-menu switch is ephemeral and does not persist configuration.
- When enabled, masking uses the configured suffix list and the visual-only matching algorithm.

## Acceptance

- Rust tests cover the library default, server default, missing-field behavior, explicit `true`, and preferences response.
- Web tests pin the Settings display fallback, terminal startup fallback, and context-menu switch.
- The config reference states the new default and the two opt-in paths.
- The integrated release gate passes.

## Evidence

- `cargo test --locked -p chan-library secret_masking_defaults_off_and_preserves_explicit_true` passed 1 test on 2026-08-05.
- `cargo test --locked -p chan-server terminal_config_` passed 5 tests, and `cargo test --locked -p chan-server global_config_view_keeps_host_fields_on_local_serve` passed 1 test on 2026-08-05.
- The focused workspace-app run passed 36 tests across `SettingsOverlay.test.ts`, `terminalRightClickRevamp.test.ts`, and `languageInspectorDetail.test.ts` on 2026-08-05. The masking assertions cover the Settings fallback, terminal startup fallback, and existing ephemeral per-tab toggle.
