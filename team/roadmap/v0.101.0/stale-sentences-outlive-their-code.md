# Five families of sentences still describe code that changed under them

Status: raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where each family was found by an independent review and parked as documentation work. Every site below was read against `main` at `d3de0180b`; two clauses are marked as reported and were not re-verified.

## What was seen

The embed phase. `build_all`'s doc in `crates/chan-workspace/src/index/facade.rs` says a cancelled build leaves the on-disk index as it was at the start, which stops being true once an in-loop flush has committed. `AppStatusBar.svelte` in `web/packages/workspace-app/src/components/` calls the status chip's done and total "real chunk counts"; they are file counts.

The tunnel-only devserver's local listener. `.agents/principles.md` says tunnel mode "keeps the local management listener"; `crates/chan-library/design.md` says a tunnel-only devserver with no local bind has nowhere to mount and answers 503, and `crates/chan-server/src/devserver.rs` prints "tunnel-only (no local listener)" on that path. The documents disagree on a fact a reader needs.

The PAT revoke. `Tokens.svelte` in `web/packages/profile/src/views/` tells the user only that existing devserver sessions using that token will be disconnected. Profile's revocation worker is reported to repeat the owner-wide cut after the commit, so one revoke can cut every tunnel of the owner; that mechanism is reported and not re-verified here.

Which content holds which native command. `desktop/src-tauri/capabilities/launcher-events.json`'s `description` says the launcher is "otherwise pure HTTP ... never a Tauri invoke", and `desktop/src-tauri/src/main.rs` repeats it, while the launcher's invokes are now pinned to its effective grants by a test in that crate. `desktop/src-tauri/permissions/app.toml` calls the gateway-window permission set "runtime-minted"; the set is static and it is the capability that is minted. A fourth site, the reload bridge's comment in `main.rs`, is reported to document only the absent-bridge fallback and was not re-verified.

The edge inventory. `.agents/gateway.md` tells a contributor to keep new plaintext PAT paths in `gateway/design.md`'s inventory, and the same file then states one such path, the TLS-terminating edge, which was deliberately left out of it. One sentence saying so removes the tension.

## Desired contract

Each family says one true thing, checked against the code it describes, and the edge exception is stated where the inventory rule is.

## Boundaries

The files named above and no others. A capability `description` is a JSON string, so that one edit is not comment-only.

## Acceptance

1. Every rewritten sentence is recorded with the `function` or item it describes, and each citation is checked against that code at the head under review; a sentence with no citation is not accepted.
2. An independent reader re-reads all five families and reports zero false living sentences, naming what was read.
3. The capability files still load: a test parses `launcher-events.json` and the permissions file after the edit.
4. The diff changes no behaviour: comments, documents and one JSON description only.
