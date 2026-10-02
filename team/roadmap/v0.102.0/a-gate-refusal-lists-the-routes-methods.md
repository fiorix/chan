# A gate's refusal of a wrong method lists the route's methods

Status: accepted by the owner on 2026-09-27 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-27 by the independent review of the conversion of the framework's refusals ([refusals-answer-in-four-shapes](../done/refusals-answer-in-four-shapes.md); `dev/v0101-team/reviews/review-Runtime-13.md` in the development tree, finding 2, with the lead's notes), which read axum 0.8.9's source and the server at the conversion's later commits and at `2aa3dfeca`, before it, and found the answers the same at both. Read again in the server at `d1fe06c86`, where the fallback for a wrong method and the order that keeps each gate first have landed and the two gates' refusals are pinned with their `Allow`; not run. This reading replaces the one at `dcc5670e0`, where neither had landed.

## Owner ruling

Accepted on 2026-09-27 for a later version, as the lead recommended: the owner accepted in one answer every recommendation the lead had put to them that day, and for this item the recommendation was a later version. It is not part of v0.101.0.

## What was seen

The devserver's management routes sit behind its bearer check, placed with `Router::route_layer` (`crates/chan-server/src/devserver.rs:2542-2562`; the check's refusal, 401 "missing or invalid devserver bearer token", at `require_bearer`, `:3047-3070`), and the workspace tenant's settings writes behind the settings gate, placed the same way (`crates/chan-server/src/lib.rs:1729-1770`). Each of the two sub-routers takes the crate's 405 with `method_not_allowed_fallback` before its gate, so the gate wraps it and answers a wrong method first (`devserver.rs:2556-2557`, `lib.rs:1764-1766`; `crates/chan-server/src/error.rs:29-31`).

As the reviews read the framework, a request for a method a route does not serve is answered through the method router's fallback, whose future adds the route's `Allow` header to whatever response comes back without one, of any status. So when the gate refuses, its refusal carries `Allow`, and two pins assert it with the gate's status and whole body. Without the bearer, `PUT /api/devserver/workspaces` answers the bearer check's 401 with `Allow: GET,HEAD,POST` (`wrong_method_without_the_bearer`, `devserver.rs:5050-5076`), where a `GET` answers the same 401 with no `Allow`, by the review's reading: one request with a method a route does not serve lists every method it does. On a tenant served with its settings disabled, `PUT /api/storage/reset` answers the settings gate's 403 with `Allow: POST` (`disabled_settings_refuse_a_wrong_method_first`, `crates/chan-server/src/routes/refusal_tests.rs:524-551`). `crates/chan-server/design.md:61` and `CHANGELOG.md:15` state that a gate that refuses a wrong method keeps its status and body with the route's `Allow`.

By the review's reading the same holds for the gates placed with `Router::layer`: the tenants' authentication (`auth_middleware`, `lib.rs:1298-1301`, `:1981-1984`) and the tunnel's assertion layer (`mark_tunnel_origin`, `devserver.rs:2650-2654`), through which callers never carry the devserver's bearer. No pin sends a wrong method through them. The launcher's gates are placed with `route_layer` too (`crates/chan-server/src/routes/library.rs:366-374`, `:988`), and its router sets no fallback for a wrong method, so the framework's own fallback answers there; by the same reading their refusals carry `Allow` as well (inferred).

No handler runs and nothing changes state; the methods named are the ones the public source routes. The earlier review's notes said that a caller without the devserver's bearer learns nothing of a management route's methods; by this reading that was false before the conversion and is false at this sha. The lead accepted the header as it is for the conversion, whose fix round pinned it and wrote it down, and raised the question for a decision.

## Desired contract

A gate that refuses a request answers the same whatever its method: its status and its envelope, with no `Allow` that names the methods of a route the caller may not use. If the owner rules the header acceptable instead, what `crates/chan-server/design.md:61` says of the two gates placed with `route_layer` is said of every gate, and a pin asserts it for each.

## What to do

Decide whether a gate's refusal may carry `Allow`. If not: as the lane's probe and the reviews read the framework, the header is added outside every layer a router takes, so no gate or layer inside the router can remove it; it needs a mechanism outside the method router, such as a service around each assembled router that drops `Allow` from an answer that is not a 405 (a suggestion, not read against the framework), and the two pins that assert the header now, the design document's sentence and the changelog's change with it. If so: the two pins and the sentence stand, and the gates placed with `layer` and the launcher's gates are stated and pinned the same way. Either way, pin it for each gate, asserting the status, the body and the header as ruled.

## Boundaries

`crates/chan-server/src/devserver.rs` (`build_devserver_app`, `tunnel_app`), `src/lib.rs` (the terminal and workspace tenants' routers), `src/routes/library.rs` (`launcher_router`), `crates/chan-server/design.md`, and their tests. Each gate's own refusal, its status and its sentence, is unchanged.

## Acceptance

1. Without the bearer, a wrong method on each devserver management route answers the bearer check's 401 as a served method does, with or without `Allow` as ruled; pinned through the assembled router.
2. The same for the settings gate on a tenant served with its settings disabled, the tenants' authentication, the tunnel's assertion layer and the launcher's gates.
3. `crates/chan-server/design.md` states the ruled behaviour.
