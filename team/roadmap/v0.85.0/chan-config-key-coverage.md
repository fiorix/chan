# `chan config` accepts only a third of the keys it prints

Status: REGISTERED for v0.85.0, grounded 2026-08-04, implemented, integrated validation pending.

## What

`chan config get` with no key dumps the whole editor plus server config as TOML. Feed any of those dotted paths back to `chan config get <key>` or `chan config set <key>` and most of them are rejected as unknown, by an error that points back at the dump that just printed them:

```
$ chan config get
...
[server.terminal]
secret_masking = true
...
$ chan config get server.terminal.secret_masking
Error: unknown key `server.terminal.secret_masking`; try `chan config get` to list current values
```

This surfaced live on 2026-08-04 during the v0.83.4 replay-storm hunt, where the owner needed to turn `secret_masking` off from the CLI to A/B the slow reattach and had no way to do it. The workaround was to hand-edit `~/.chan/preferences.toml`, which is what the CLI exists to avoid.

## Verified current state (2026-08-04)

Read in code and reproduced against the installed v0.83.3 binary.

- The key table is hand-maintained and triplicated. `read_config_key` (`crates/chan/src/lib.rs:6947`) is a flat `match` over 12 string literals; `write_pref_key` (`:6975`) repeats 9 of them and `write_server_config_key` (`:7011`) repeats the other 3. Adding a field to `EditorPrefs` (`crates/chan-server/src/preferences.rs:53`) or `ServerConfig` reaches the dump automatically (it is plain `serde` serialization) but reaches `get <key>` and `set <key>` only if someone remembers all three arms. Nothing fails when they do not.
- Coverage today is 12 of the 31 keys the dump prints:
  - `[editor]`: `theme`, `editor_theme`, `line_spacing`, `date_format` are accepted. `strip_trailing_whitespace_on_save`, `bubble_overlay_mode`, `empty_pane_carousel_cycling`, `page_width_ratio`, `overlay_maximized`, `cs_dismissed` are printed and rejected.
  - `[editor.pane_widths]`: all 5 accepted.
  - `[editor.browser_side_panes]` (`left`, `right`) and `[editor.hybrid_surface_themes]`: printed and rejected.
  - `[server]` `attachments_dir` and `[server.search]` `aggression`: accepted.
  - `[server.terminal]`: `idle_timeout_secs`, `session_cap`, `ring_bytes` accepted. `scrollback_mb`, `default_term`, `font`, `mcp_env`, `mouse_capture`, `ghostty`, `secret_masking`, `secret_mask_suffixes` printed and rejected.
- The two surfaces disagree on the namespace, independently of coverage. `TerminalConfig` is a field of `ServerConfig`, so the CLI dumps it as `[server.terminal]`, while `PreferencesView` (`crates/chan-server/src/routes/preferences.rs:41`) carries it at the top level, so `PATCH /api/config` and `docs/config-reference.md:19-29` name the same fields `terminal.*`. A user who reads the config reference and types the documented key gets the same unknown-key error. The reference is not wrong: its "How to set" column says `PATCH /api/config`, never the CLI. But the two spellings for one field are a trap.
- The long help promises more than the code does: "Keys are dotted and split across two namespaces" and "An unknown key is an error on both sides, pointing you back at `chan config get`" (`crates/chan/src/help.rs:74-85`). The pointer is the defect, since the dump is not a list of settable keys.
- The existing tests pin only round trips of already-covered keys (`crates/chan/src/lib.rs:9736-9770`). No test asserts that the dump and the key table agree, which is why the drift was invisible.

## Contract

- Every key `chan config get` prints is readable by `chan config get <key>` and writable by `chan config set <key>`, with two deliberate exceptions that must be stated in help rather than silently rejected: `shortcuts` (an opaque per-command override map the server stores without parsing; it is `skip_serializing_if` empty, so it reaches the dump only once a chord is overridden) and `cs_dismissed` (a one-shot UI acknowledgement, readable but not usefully settable). Any other exception is a bug.
- One source of truth. The dump, the reader, and the writer derive from the same key set, so a new config field cannot reach the dump without reaching `get`/`set`. Whether that is a derive, a table walked by all three, or `serde_json` pointer traversal over the serialized value is the implementer's call; three hand-kept `match` arms is the thing being removed.
- Typed values keep their validation. `set` still rejects a bad enum, a zero where nonzero is required, and an out-of-range number with the message it does today; the parse layer is not what is being generalized away.
- Collection-valued keys get a defined spelling. `secret_mask_suffixes` is a `Vec<String>` and `hybrid_surface_themes` is a map; decide and document whether `set` takes a comma-separated list, repeated flags, or refuses collections and points at the TOML. Refusing is acceptable for v1 provided the refusal names the file and the field.
- The namespace collision is resolved rather than lived with. Either the CLI accepts the documented `terminal.*` spelling as an alias for `server.terminal.*`, or `docs/config-reference.md` grows a CLI column naming the CLI spelling for every row. Two spellings with no cross-reference does not survive this item.

## Acceptance

- A test enumerates the serialized dump and asserts that every leaf path except the documented exceptions round trips through `read_config_key` and the matching writer. It fails if a field is added to `EditorPrefs`, `ServerConfig`, or `TerminalConfig` without CLI coverage; prove it by adding a field in the test and watching it red.
- `chan config set server.terminal.secret_masking false` succeeds, persists, and a running server picks it up without a restart (the directory watcher already does this; assert the file, not the reload).
- `chan config get <key>` succeeds for every key the no-key dump prints, driven from the dump itself rather than a second hand-written list.
- The unknown-key error, when it does fire, names how to list settable keys in a way that is actually true.

## Rough size

Small to medium. The mechanism change is confined to `crates/chan/src/lib.rs` plus its tests; the docs half is one column in `docs/config-reference.md` and a correction to the `chan config` long help. No wire, server, or SPA change: `PATCH /api/config` already covers every field, which is why the web Settings overlay was never affected.

## Open

- Whether `chan config set` should reach a *running* server's in-memory config directly instead of relying on the file watcher. Today the file is the interface and the watcher is the propagation; that is coherent and out of scope here.
