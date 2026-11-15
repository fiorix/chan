# Terminal session PTY fixtures

`terminal-conpty-sessions.json` contains three complete values emitted by the Rust `session_frame_with_pty` serializer at commit `7b20c36674d38de8b704beb7e547aabd1f61eeee`. A temporary test in `crates/chan-server/src/routes/terminal_pty_tests.rs` used that module's existing `Session` and `frame` helpers. The same live Linux shell handle supplied all three values; the supplied PTY descriptions exercise the Windows wire shape without claiming a native Windows execution. Only JSON indentation changed after capture.

The capture test was:

```rust
#[test]
fn session_pty_client_fixture_capture() {
    let session = Session::new();
    let absent = frame(&session.handle, None);
    let known = frame(
        &session.handle,
        Some(SessionPty::Conpty {
            windows_build_number: NonZeroU32::new(26300),
        }),
    );
    let unknown = frame(
        &session.handle,
        Some(SessionPty::Conpty {
            windows_build_number: None,
        }),
    );
    eprintln!(
        "CONPTY_CLIENT_FIXTURE={}",
        json!({ "absent": absent, "known": known, "unknown": unknown })
    );
}
```

Run with `cargo test --locked -p chan-server session_pty_client_fixture_capture -- --nocapture`, extract the JSON after `CONPTY_CLIENT_FIXTURE=`, and remove the temporary test. Session ids and program snapshots can differ between captures. Mounted tests use these complete frames and explicitly vary the generation or id to exercise session lifecycle delivery; their resize text is generated input, separate from these wire fixtures.

`terminal-conpty-older-session.json` is a second capture from the same serializer and commit, using `NonZeroU32::new(19045)`. It proves forwarding a changed known build across xterm.js's build 21376 reflow threshold. Its test replaces only the captured session id so both build values arrive on the same session and socket.
