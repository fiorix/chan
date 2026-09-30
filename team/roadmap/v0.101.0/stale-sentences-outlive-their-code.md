# Five families of sentences still describe code that changed under them

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where each family was found by an independent review and parked as documentation work. Every site below was read against `main` at `d3de0180b`; two clauses are marked as reported and were not re-verified.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, as a docs lane of its own.

On 2026-09-29 the owner ruled that the five comments added below on 2026-09-28, a sixth family, join this item: its boundary widens to the files that hold them, and the acceptance points cover the sixth family as they cover the five. The owner accepted in one answer every recommendation the lead had put to them that day. For these it was to take them here, under the same acceptance, and not as an item of their own.

## What was seen

The embed phase. `build_all`'s doc in `crates/chan-workspace/src/index/facade.rs` says a cancelled build leaves the on-disk index as it was at the start, which stops being true once an in-loop flush has committed. `AppStatusBar.svelte` in `web/packages/workspace-app/src/components/` calls the status chip's done and total "real chunk counts"; they are file counts.

The tunnel-only devserver's local listener. `.agents/principles.md` says tunnel mode "keeps the local management listener"; `crates/chan-library/design.md` says a tunnel-only devserver with no local bind has nowhere to mount and answers 503, and `crates/chan-server/src/devserver.rs` prints "tunnel-only (no local listener)" on that path. The documents disagree on a fact a reader needs.

The PAT revoke. `Tokens.svelte` in `web/packages/profile/src/views/` tells the user only that existing devserver sessions using that token will be disconnected. Profile's revocation worker is reported to repeat the owner-wide cut after the commit, so one revoke can cut every tunnel of the owner; that mechanism is reported and not re-verified here.

Which content holds which native command. `desktop/src-tauri/capabilities/launcher-events.json`'s `description` says the launcher is "otherwise pure HTTP ... never a Tauri invoke", and `desktop/src-tauri/src/main.rs` repeats it, while the launcher's invokes are now pinned to its effective grants by a test in that crate. `desktop/src-tauri/permissions/app.toml` calls the gateway-window permission set "runtime-minted"; the set is static and it is the capability that is minted. A fourth site, the reload bridge's comment in `main.rs`, is reported to document only the absent-bridge fallback and was not re-verified.

The edge inventory. `.agents/gateway.md` tells a contributor to keep new plaintext PAT paths in `gateway/design.md`'s inventory, and the same file then states one such path, the TLS-terminating edge, which was deliberately left out of it. One sentence saying so removes the tension.

**Added on 2026-09-28, at the landing of the desktop's mint and of `cs` in a moved terminal:** comments in files that those two ranges did not own, which the ranges made stale, read at `d440ab656`. They are a sixth family, and this item's boundary names the five above, so taking them widens it, which the owner ruled on 2026-09-29: they join this item.

- `crates/chan-library/src/host.rs:2513-2514`, the doc of `WorkspaceHost::mint_window`, says that chan-desktop mints through it, its workspace windows included, with the key it computed. The desktop's handoff, `serve::start` and `cs window new` mint a workspace window through `mint_workspace_window` (`desktop/src-tauri/src/main.rs:2979`; `serve.rs:86`, `:109`, `:120`; `window_ops.rs:174`), and the command deck and the two menu commands mint through `mint_window` with a registry row's root or the path of a window they copy (`main.rs:4405-4408`, `:6474-6478`).
- `desktop/src-tauri/src/embedded.rs:686-687`, the doc of `EmbeddedServer::mint_window`, says that a workspace window resolves its live tenant and that the workspace must be running; the host's mint creates the record with no such check (`mint_window_with_origin`, `host.rs:2536-2556`).
- `crates/chan-server/src/handoff.rs:85-88`, the doc of `OpenWorkspace.workspace_path`, says that the desktop canonicalizes the path and registers it; the desktop asks its host by the path as sent and, when no runtime goes by it, registers it as sent (`main.rs:2978`, `:2985-2986`).
- `crates/chan/src/lib.rs:3295-3297`, the doc of `absolutize_serve_root`, and the test's doc at `:11165-11166` say that chan-desktop titles the window with the root the CLI hands it; the desktop titles a window with the path its record stores (`desktop/src-tauri/src/serve.rs:226-241`), which for a relinked root is the registered path and not the one handed.
- `crates/chan-server/src/control_socket.rs:391-392`, the doc of `stable_socket_name`, says that the stable-candidate classifier is in the `chan` CLI; it is chan-shell's (`stable_control_socket_name`, `crates/chan-shell/src/control.rs:281-296`), which the CLI calls (`crates/chan/src/lib.rs:2659`, `:2685`).

The first four are the independent review's (`dev/v0101-team/reviews/review-Services-17.md` in the development tree, F5, and the report it reviewed, `dev/v0101-team/reports/report-Services-36.md`, "Residuals"); the fifth is the report of `cs` in a moved terminal (`dev/v0101-team/reports/report-Services-35.md`, "Residuals").

## Desired contract

Each family says one true thing, checked against the code it describes, and the edge exception is stated where the inventory rule is.

## Boundaries

The files named above and no others. A capability `description` is a JSON string, so that one edit is not comment-only.

## Acceptance

1. Every rewritten sentence is recorded with the `function` or item it describes, and each citation is checked against that code at the head under review; a sentence with no citation is not accepted.
2. An independent reader re-reads all five families and reports zero false living sentences, naming what was read.
3. The capability files still load: a test parses `launcher-events.json` and the permissions file after the edit.
4. The diff changes no behaviour: comments, documents and one JSON description only.
