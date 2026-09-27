# A gate's refusal of a wrong method lists the route's methods

Status: raised for a decision on 2026-09-27 by the independent review of the conversion of the framework's refusals ([refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md); `dev/v0101-team/reviews/review-Runtime-13.md` in the development tree, finding 2, with the lead's notes), which read axum 0.8.9's source and the server at the conversion's later commits and at `2aa3dfeca`, before it, and found the answers the same at both; read again in the server at `dcc5670e0`, where neither the fallback for a wrong method nor the order that keeps each gate first has landed and the routers are placed as at `2aa3dfeca`, so it holds here by the same reading. Not run. Recommendation: a later version.

## What was seen

The devserver's management routes sit behind its bearer check, placed with `Router::route_layer` (`crates/chan-server/src/devserver.rs:2542-2560`; the check's refusal, 401 "missing or invalid devserver bearer token", at `require_bearer`, `:3044-3066`), and the workspace tenant's settings writes behind the settings gate, placed the same way (`crates/chan-server/src/lib.rs:1728-1766`). No router in the crate calls `method_not_allowed_fallback` at this sha, so each route keeps the framework's own fallback for a method it does not serve.

As the reviews read the framework, `Router::route_layer` wraps each method router's fallback as well as its methods, so a method a route does not serve meets the gate first, as a served method does; and a request for such a method is answered through the method router's fallback, whose future adds the route's `Allow` header to whatever response comes back without one, of any status. So when the gate refuses, its refusal carries `Allow`. Without the bearer, `PUT /api/devserver/workspaces` answers the bearer check's 401 with `Allow: GET,HEAD,POST`, where a `GET` answers the same 401 with no `Allow`: one request with a method a route does not serve lists every method it does. On a tenant served with its settings disabled, a wrong method on a settings write answers the gate's 403 with the route's `Allow`.

By the review's reading the same holds for the gates placed with `Router::layer`: the tenants' authentication (`auth_middleware`, `lib.rs:1297-1300`, `:1976-1979`) and the tunnel's assertion layer (`mark_tunnel_origin`, `devserver.rs:2647-2651`), through which callers never carry the devserver's bearer. The launcher's gates are placed with `route_layer` too (`crates/chan-server/src/routes/library.rs:366-374`, `:988`), so by the same reading their refusals carry it as well (inferred).

No handler runs and nothing changes state; the methods named are the ones the public source routes. The earlier review's notes said that a caller without the devserver's bearer learns nothing of a management route's methods; by this reading that was false before the conversion and is false here. The lead accepted the header as it is for the conversion, whose next part leaves each gate's answer as it is here, and raised the question for a decision.

## Desired contract

A gate that refuses a request answers the same whatever its method: its status and its envelope, with no `Allow` that names the methods of a route the caller may not use. If the owner rules the header acceptable instead, `crates/chan-server/design.md` says that a gate's refusal of a wrong method carries the route's `Allow`, and a pin asserts it.

## What to do

Decide whether a gate's refusal may carry `Allow`. If not: as the lane's probe and the reviews read the framework, the header is added outside every layer a router takes, so no gate or layer inside the router can remove it; it needs a mechanism outside the method router, such as a service around each assembled router that drops `Allow` from an answer that is not a 405 (a suggestion, not read against the framework). If so: say it beside the envelope in `crates/chan-server/design.md`. Either way, pin it for each gate: a wrong method without the bearer on a devserver management route, and on a settings write with settings disabled, asserting the status, the body and the header as ruled.

## Boundaries

`crates/chan-server/src/devserver.rs` (`build_devserver_app`, `tunnel_app`), `src/lib.rs` (the terminal and workspace tenants' routers), `src/routes/library.rs` (`launcher_router`), `crates/chan-server/design.md`, and their tests. Each gate's own refusal, its status and its sentence, is unchanged.

## Acceptance

1. Without the bearer, a wrong method on each devserver management route answers the bearer check's 401 as a served method does, with or without `Allow` as ruled; pinned through the assembled router.
2. The same for the settings gate on a tenant served with its settings disabled, the tenants' authentication, the tunnel's assertion layer and the launcher's gates.
3. `crates/chan-server/design.md` states the ruled behaviour.
