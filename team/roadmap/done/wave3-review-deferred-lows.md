# Wave-3 review: deferred LOW findings from v0.76.0

> Status: shipped in [v0.77.0](../../release/release-v0.77.0.md): (1) recovery sidecars coalesce on the flusher tick off push acknowledgements; (2) conflicted document and scene recovery collapses when disk matches authority or baseline; (3) desired systemd units stay typed while inherited AppImage trust accepts only chan-named AppImages; (4) generated desktop sinks are window-owned and canonical stale foreign temporaries are reaped at startup; (5) the 64 KiB generated-download chunk size is documented and pinned as a client-cooperative contract, while the true raw-frame pre-deserialization allocation-cap rewrite is deferred to v0.79.0; and (6) escaped literal gitignore components extend the fixed pruning prefix.

Six LOW-severity findings from the v0.76.0 wave-3 adversarial review (each confirmed by skeptic-verify, none of which drops user data) were deferred rather than fixed in that round. They are accepted v0.77.0 scope. The v0.76.0 release report records the triage; the full finding text is in that round's `dev/v0.76.0/team/review-wave3-findings.md`.

## Items

1. **Editor recovery persistence is on the ack path.** The full-document recovery sidecar is written on every push, defeating the flush debounce and sitting on the client ack path. Debounce/coalesce it onto the flusher tick or on detach, off the ack path. (`crates/chan-server/src/routes/doc.rs`, doc_sessions.)

2. **Conflicted rehydration re-prompts after a lost resolution.** A `Conflicted` session that rehydrates on restart rebuilds the conflict unconditionally, re-prompting even when the fresh disk now matches authority/baseline (a resolution that crashed before its persist). Collapse to Clean/Dirty when disk matches, like the Dirty arm. (`crates/chan-server/src/*_sessions/mod.rs`.)

3. **classify_rendered can mark chan's own unit foreign.** A renamed chan binary or a non-`chan` AppImage can make the systemd unit classifier run its untrusted-input exec-name heuristic against chan's OWN desired render and refuse to rewrite its own unit. Derive the desired canonical form directly from the trusted renderer instead of re-parsing it. (`crates/chan/src/lib.rs`.)

4. **Desktop generated-download temp/sink leak on window teardown.** A generated-download temp file and its sink can leak when the WebView window is torn down between begin and finish/cancel, since cleanup relies on the pagehide IPC. Reap orphaned `.chan-download-*.tmp` on desktop startup and/or key each sink to its window label and drop it from a window-destroyed handler. (`desktop/src-tauri/src/download.rs`.)

5. **Desktop 64 KiB chunk bound is post-deserialization.** `append_generated_download` enforces the 64 KiB chunk bound only after the whole `Vec<u8>` is deserialized, so the bound is client-cooperative rather than an allocation cap. Either length-check the raw frame before materializing it, or document it explicitly as a cooperative limit. (`desktop/src-tauri/src/download.rs`.)

6. **Gitignore over-descent on an escaped leading component (fail-safe).** An escaped leading path component collapses the fixed prefix to `base`, so an anchored deep negation still forces descent into every configured-excluded dir. This is fail-safe -- it over-descends, it does not drop files -- but decoding the escaped literal when extending the prefix would restore pruning. (`crates/chan-workspace/src/fs_ops.rs`.)
