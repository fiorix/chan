# A refusal answers in one of four shapes, and only one of them is the convention

Status: raised for v0.101.0 on the owner's instruction of 2026-09-20. Asked whether the locked 409 of [the-desktop-reads-any-409-as-live-terminals](../v0.100.0/the-desktop-reads-any-409-as-live-terminals.md) should become JSON, the owner ruled that it stays plain text in v0.100.0 and that the uniform answer is this version's, with v0.100.0 preparing the reading side. A source sweep of non-test code against `main` at `c03431432`; nothing was run. The counts are the sweep's and approximate. Re-read by hand afterwards: the module doc and `err_from` in `error.rs`, the locked arm of `handle_workspace_on`, the launcher's `refusalReason`, the workspace app's `isWorkspaceRootMissingError`, and the desktop's `ActiveTerminalsRejection`.

## What was seen

`crates/chan-server/src/error.rs` states the convention in its module doc: the `err_*` helpers shape uniform `{"error": "..."}` JSON bodies, and routes call them instead of building responses by hand. About 87 non-test 4xx answer sites do. The rest answer in three other shapes:

- **Plain text**, about 66 sites, concentrated in `routes/library.rs` (35), `routes/terminal.rs` (17), `devserver.rs` (7) and `static_assets.rs` (4), with one each in `auth.rs`, `routes/search.rs` and `routes/tunnel.rs`. One of them bypasses a helper that already covers it: `handle_workspace_on` builds the locked 409 by hand, while `err_from` maps `WorkspaceLocked` to a 409 in the JSON shape and the arm above it in the same match calls `err_from`.
- **No body**, about 38 sites, 29 of them in `routes/library.rs`: a bare `StatusCode::X.into_response()`, of which a client can say only `HTTP 409`.
- **Typed JSON**, six shapes over about 16 sites, each invented where it was needed: `LiveTerminalsRejection`, `ActiveTerminalsRejection`, `ModelNotDownloadedBody`, `ConfigConflictBody`, the inline `structured_conflict` of `routes/standalone_fs.rs`, and `WriteConflictBody`. Five put a machine token in `error` (`live_terminals`, `model_not_downloaded`, `config_conflict`, `directory_not_empty`, `protected_path`). `WriteConflictBody` has no `error` field.

So `error` is a sentence in the convention and a token in the typed bodies, and nothing tells a client which one arrived. The clients guess. Both web `ApiError`s take a JSON body's string `error` as the message and a text body verbatim, so a token reaches the user as if it were a sentence; the `live_terminals` banner in the v0.100.0 item is that. The launcher keeps the raw body beside the message so that `liveTerminalsCount` can parse it a second time. The workspace app classifies one refusal by the words of its message: `isWorkspaceRootMissingError` in `api/errors.ts` is a 404 whose message contains "workspace root does not exist". The desktop's other paths format `HTTP {status}` or append the raw body, and `chan` reads the status and concatenates the body.

The gateway workspace is uniform already: one `IntoResponse` per service ending in `Json({"error": message})`, with the raw-hyper edge of `devserver-proxy` as its plain-text exception. No document states a convention for either workspace. The only prose is the sentence in `crates/chan-server/design.md` that describes the one plain-text 409.

## Desired contract

Every refusal chan-server answers is JSON in one envelope: a sentence a client may show as it is, and, where a client has to branch, a stable machine token in a field of its own with any extra fields beside it. No client parses a body twice, shows a token as a sentence, or classifies a refusal by the words of its message. The envelope is written down once, in `crates/chan-server/design.md`.

Which field carries which is an owner ruling. Either the token takes `error` and the sentence moves to a new `message`, which matches five typed bodies and changes what about 87 sites send and what both web clients read; or the sentence keeps `error` and the token gets a field of its own, which leaves those sites, both web clients and the gateway's shape as they are and changes the five typed bodies and their readers. The sweep favours the second.

## Boundaries

`crates/chan-server/src/error.rs` (the envelope and its helpers); the seven files that hold the plain-text sites and the no-body sites of `routes/library.rs`; the six typed bodies where they are defined (`routes/library.rs`, `devserver_api.rs`, `routes/index.rs`, `routes/preferences.rs`, `routes/standalone_fs.rs`, `routes/files.rs`); the readers, `desktop/src-tauri/src/devserver.rs`, `web/packages/launcher/src/api/library.ts`, `web/packages/workspace-app/src/api/client.ts` and `api/errors.ts`, and `parse_live_terminals_refusal` in `crates/chan/src/lib.rs`; and the tests that pin a body's text. Whether a refusal no JSON client reads (a static asset 404, a refused WebSocket upgrade) joins the envelope is part of the work to decide and to state. The gateway workspace is out of scope unless the ruling makes its shape the different one.

v0.100.0 prepares the reading side only: its 409 item gives the desktop one refusal reader that understands the `{"error": ...}` envelope and the live-terminals body, as the launcher's already does. A server that moves its plain-text refusals into today's envelope then needs no desktop change, which matters because a desktop and the devserver it reaches can be of different versions.

## Acceptance

1. No 4xx answer from the assembled routers is plain text or empty, outside the exceptions the item names: pinned by a check driven through the routers that fails on a new one, not by reading source.
2. Each typed refusal keeps its extra fields and carries its token in the ruled field, and its reader branches on the token: tested for `live_terminals`, `model_not_downloaded`, `config_conflict`, the two standalone conflicts and the write conflict.
3. `isWorkspaceRootMissingError` classifies by token, and the launcher parses a refusal body once.
4. Where the server sent a sentence, the desktop and `chan` show it, not `HTTP 409` alone.
5. `crates/chan-server/design.md` states the envelope, its sentence about the plain-text 409 is gone, and the CHANGELOG records the wire change.
6. The mixed-version case is stated: what a v0.100.0 desktop shows against this server, shown by a test over that reader's inputs or named as unsupported.
