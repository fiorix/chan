# Windows Deep-Link Second-Instance Gap

> Status: closed in [v0.75.0](../../release/release-v0.75.0.md): subsumed as suspected -- the chan:// scheme and deep-link plugin were removed outright.

Status: accepted scope for v0.74.0. Very likely subsumed by the loopback redirect item: if loopback lands first, this item reduces to a Windows confirmation smoke plus a decision on whether to keep the `chan://` registration at all. Inferred from source; nobody has reproduced it on Windows.

## Problem

Chan Desktop receives its OAuth-style sign-in callback as a `chan://auth/callback` deep link. The scheme is declared once, in `desktop/src-tauri/tauri.conf.json:21`-`desktop/src-tauri/tauri.conf.json:24` (`"deep-link": { "desktop": { "schemes": ["chan"] } }`), and delivered through `tauri-plugin-deep-link` (`desktop/src-tauri/Cargo.toml:24`), initialized at `desktop/src-tauri/src/main.rs:4657` and wired to a handler at `desktop/src-tauri/src/main.rs:4792` with a cold-start drain at `desktop/src-tauri/src/main.rs:4823`.

On Windows that delivery mechanism is a new process, not an event into the running one. The NSIS installer template in the vendored bundler writes the scheme to `HKCU`/`HKLM` classes with the executable and `%1`:

- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-bundler-2.9.4/src/bundle/windows/nsis/installer.nsi:675` writes `Software\Classes\{{protocol}}\shell\open\command` as `"$INSTDIR\${MAINBINARYNAME}.exe" "%1"`, fed by `.../src/bundle/windows/nsis/mod.rs:548`.
- The plugin states the same contract in `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-plugin-deep-link-2.4.9/README.md:147`: events are emitted only on macOS, iOS, and Android; on Windows and Linux the OS spawns a new instance with the URL as a CLI argument, and the `single-instance` plugin with the `deep-link` feature is the documented way to forward it.

The workspace does not depend on `tauri-plugin-single-instance` anywhere: no manifest, source, or lockfile reference exists (the only `single-instance` hits in the tree are `chan devserver --service=chan` daemon prose, for example `crates/chan/src/devserver_daemon.rs:2` and `crates/chan/src/lib.rs:90`). So nothing forwards the spawned process's URL back to the app that started the sign-in.

## Why it matters

The sign-in nonce lives in process memory, in a single global slot. `PendingAuth` is defined at `desktop/src-tauri/src/auth.rs:142`, held in the process-global `pending_state()` mutex at `desktop/src-tauri/src/auth.rs:153`, and filled by the two launch paths: `open_signin` at `desktop/src-tauri/src/auth.rs:194` and `open_gateway_signin` at `desktop/src-tauri/src/auth.rs:271`. Both send the browser to `id.chan.app` with `redirect_uri=chan://auth/callback` (`desktop/src-tauri/src/auth.rs:60`) and the nonce as `state`.

Both paths start from a running app: the user clicks sign-in in the UI, or a gateway connect parks a wait that `abandon_pending_signins` (`desktop/src-tauri/src/gateway.rs:924`) later settles. There is no cold-start sign-in.

`classify_callback` pops that slot at `desktop/src-tauri/src/auth.rs:499`, and an empty slot returns `CallbackAction::Ignore` at `desktop/src-tauri/src/auth.rs:500`, surfaced to the caller as `CallbackOutcome::Ignored` (`desktop/src-tauri/src/auth.rs:309`) and handled as a no-op at `desktop/src-tauri/src/main.rs:4818`. That branch is correct for its intended case, a duplicate delivery of an already-settled sign-in. A callback delivered to a freshly spawned second process hits the same branch for the wrong reason: that process never launched a sign-in, so its slot is empty, the code is discarded, and the original window keeps waiting until its timeout with no error shown. A second taskbar icon or window is the visible tell.

## Honesty about the evidence

This is a source-level inference, not an observation. No one has run a Windows installer build and attempted sign-in against it, so it is possible that some Windows-specific path already covers it: a Tauri or WebView2 behavior, an installer detail, or an OS reuse of an existing process. The finding is worth carrying precisely because the source offers no mechanism that would make it work, but the first step is to look, not to fix.

## Relationship to the loopback redirect item

A loopback redirect (`http://127.0.0.1:<port>/...` served by an ephemeral listener inside the running app) needs no OS scheme registration on any platform, and the callback necessarily lands in the process that opened the listener, which is the process holding the nonce in `pending_state()`. That closes this gap on Windows as a side effect, and removes Linux's identical `%1`-style exposure at the same time.

If loopback lands first, what remains here is: confirm on Windows hardware that sign-in completes in the original window, and decide whether `chan://` stays registered at all (`desktop/src-tauri/tauri.conf.json:23`). Keeping it costs an installer-written registry key and a live cold-start code path; dropping it removes a second, unproven delivery route. That decision is in scope for this item; the loopback implementation is not.

## Desired contract

A `chan://auth/callback` delivery on Windows, or whatever delivery mechanism replaces it, reaches the process that holds the pending nonce. Sign-in started from a running Chan Desktop window completes in that window. No second application instance is left running, and no sign-in attempt ends by silently timing out with no message.

## Boundaries

- No change to `classify_callback`, the nonce format, or the identity-side authorize and redeem contract. The gap is delivery, not validation.
- If loopback does not land in v0.74.0, the fallback fix is adding `tauri-plugin-single-instance` with its `deep-link` feature and forwarding the argv URL into the existing `on_open_url` handler at `desktop/src-tauri/src/main.rs:4792`. That is a delivery-layer change only, and it must not introduce a second single-instance guard that conflicts with the `chan devserver --service=chan` daemon lock, which guards a different process.
- macOS and Linux behavior must not regress: macOS already gets in-process events, and the cold-start drain at `desktop/src-tauri/src/main.rs:4823` must keep working for any URL that arrives before setup finishes.

## Acceptance

1. Reproduce first. On a Windows host, install a packaged build, start the app, and trigger sign-in. Record whether a second instance appears and whether the callback is ignored. If it already works, the item closes as not-a-bug with that evidence.
2. Owner smoke on Windows, after the fix: from an already-running Chan Desktop, complete sign-in in the browser, and confirm the app becomes signed in in the original window, with no second Chan taskbar icon and no timeout banner.
3. Same smoke for the gateway path (`open_gateway_signin`, `desktop/src-tauri/src/auth.rs:264`): the parked gateway connect resumes rather than being abandoned.
4. Record the `chan://` registration decision in the release report, with the reason.

Steps 1 through 3 require real Windows hardware and cannot be run from this Linux development host or in CI as configured; they are owner-run acceptance and must be named as such in the release report.
