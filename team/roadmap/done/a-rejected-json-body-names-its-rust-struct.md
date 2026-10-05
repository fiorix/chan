# A rejected JSON body's refusal repeats the deserializer's message, which names the request's Rust type

Status: shipped in [v0.102.0](../../release/release-v0.102.0.md).

Record before the release: accepted by the owner on 2026-09-27 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-27 by the code map written for the framework's refusals (`dev/v0101-team/int24-docs/codemaps/runtime-next.md` in the development tree, section C), which read the framework's rejection texts in axum 0.8.9 at `4809d8d4d` and inferred the deserializer's words from serde's derive; the server's side read again at `b1ef073ae`. The words were not reproduced.

## Owner ruling

Accepted on 2026-09-27 for a later version, as the lead recommended: the owner accepted in one answer every recommendation the lead had put to them that day, and for this item the recommendation was a later version. It is not part of v0.101.0.

## What was seen

A handler that takes a `Json` body answers a body that does not match its type with the framework's rejection, whose text the refusal check recognizes by its fixed start: 422 "Failed to deserialize the JSON body into the target type: " followed by the deserializer's message, and 400 "Failed to parse the request body as JSON: " for one that does not parse (`FRAMEWORK_PENDING`, `crates/chan-server/src/refusal_check.rs:184-206`). The map read in axum that the 422 carries the path of the failing field and the deserializer's message, and inferred from serde's derive that for a body that is not an object the message names the handler's Rust type: for the devserver's open route, which takes `Json<OpenWorkspaceRequest>` (`handle_open`, `crates/chan-server/src/devserver.rs:2930-2933`; the type at `crates/chan-server/src/devserver_api.rs:137-144`), a body of `"x"` would read "invalid type: string \"x\", expected struct OpenWorkspaceRequest". The message can also name Rust's primitive types, such as `u64`, and a query string's refusal can carry a Rust parse error's text (the map, section C).

The map for converting the framework's refusals into the envelope proposes keeping each rejection's text as the envelope's sentence, so the conversion alone keeps these words. The server already treats a 422 as leaking a request's schema in one place: the settings writes are gated before their extractors run, so that a malformed body "cannot leak the request schema via 422" (`crates/chan-server/src/lib.rs:1719-1730`).

## Desired contract

A refusal of a request's body or query says what is wrong in the API's terms: it names no Rust type or Rust error text, and names a field only as the wire names it.

## What to do

Decide what the framework's rejections say once they are envelopes: a fixed sentence per kind of rejection, such as "the request body does not match what this route accepts", with the deserializer's message logged rather than sent; or the deserializer's message with its Rust type names filtered out. Decide also whether a field's path stays in the sentence. The texts that name Rust only on a misassembled router (a missing extension, a wrong number of path parameters) can take the same answer. Red first: a string body sent to the devserver's open route answers a sentence that names `OpenWorkspaceRequest`.

## Boundaries

The crate's own extractors that the conversion of the framework's refusals adds, and their rejection's sentence; `crates/chan-server/src/refusal_check.rs`; and the tests that pin the texts. The status of each rejection is unchanged.

## Acceptance

1. A body of the wrong JSON type sent to a JSON route answers a sentence that names no Rust type, pinned on one route of each assembled router that takes a JSON body.
2. What the deserializer said is logged at the server.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files, an independent review of its whole diff and the lead's own reading of the parts that review questioned. This record was written that day from those.

An extractor's rejection answers one fixed sentence for its kind and keeps the framework's status (`Rejection::sentence`, `crates/chan-server/src/extract.rs`): a body that is not JSON, a body of the wrong shape, a missing or wrong content type, a body over the limit, a body that could not be read, a query, a path, and a multipart request without a boundary. No sentence names a field or a Rust type, and the rejection displays as the same sentence, so the handlers that answer a rejection themselves send it too. A rejection the framework gives a server status, a wrong number of path parameters or an extension no layer carries, answers "this route cannot read its request"; the extension routes take the crate's own `Extension`. What the framework said is logged where the rejection is made (`Rejection::logged`): at debug for a 4xx, since the caller chooses that text and how often it is written, and at error for a 500. Pinned on one JSON route of each assembled router (`routes/refusal_tests.rs`, and `open_json_wrong_type` in `devserver.rs`, the item's own red) and at the extractors; the log's pin runs in a child process, since tracing caches a callsite's interest for the whole process. Left: the two sentences a handler writes itself around a multipart error (`routes/metadata.rs`) still carry the framework's multipart text; and no field is named, which would take a new dependency.
