# Browser tenant entry always 403s: no-referrer vs the Origin gate

Status: REGISTERED for v0.81.0, grounded live against prod 2026-07-30, fix shape ruled, ready to implement.

## What

Clicking Open on a devserver in the gw.chan.app dashboard returns a plaintext `forbidden` in every browser, and always has (log evidence spans 0.77.0 through 0.80.0). chan-desktop's entry path works, which hid it. The credential is valid and never examined: identity's handoff page carries `Referrer-Policy: no-referrer` (both the response header and the `<meta name="referrer">` tag in `entry_handoff_response`, `gateway/crates/identity/src/http.rs`), and per the Fetch standard a cross-origin non-GET/HEAD form POST under that policy serializes the `Origin` header as `null`. devserver-proxy's `exchange_entry` (`gateway/crates/devserver-proxy/src/proxy.rs:436`) checks `exact_origin_matches` FIRST and rejects `null` by design (`proxy.rs:677`, intent pinned by the test `exact_origin_requires_one_exact_non_null_value` at `proxy.rs:1543`).

The failure is fail-closed; there is no security exposure. The full investigation (nginx/access.log evidence, the 403/404 gate-localization table, everything ruled out, and the gate-sequence triage table) is the case document this item was accepted from; its evidence held under verification against the live tree.

## Contract

- A real browser clicking Open on the dashboard reaches the tenant: the node's access.log shows `POST /_chan/entry ... 303` with a browser User-Agent.
- The proxy's Origin gate stays strict: absent, multiple, `null`, and non-exact `Origin` values all still 403. Accepting `null` is explicitly forbidden; it is the CSRF defense for an unauthenticated state-changing endpoint. Fix the sender, not the gate.
- The handoff page keeps the privacy intent: the referrer visible to the tenant is at most the bare origin (`https://gw.chan.app`), never a path.

## Fix shape (ruled)

In `entry_handoff_response`, change `no-referrer` to `strict-origin` in BOTH the `<meta name="referrer">` tag and the `Referrer-Policy` response header; the form submission inherits the document policy, so both must move together. `same-origin` is the wrong fix: it also serializes `Origin: null` on a cross-origin POST and leaves the bug intact. Of the Origin-preserving policies, `strict-origin` leaks the least.

## Regression tests (the gap is the integration seam)

- identity: assert `entry_handoff_response` emits a referrer policy from the Origin-preserving set in BOTH the header and the `<meta>` tag, so no future edit can silently re-null the Origin.
- devserver-proxy: assert a request carrying exactly what a browser sends under the new policy (`Origin: https://gw.chan.app`) passes the gate, alongside the existing null-rejection test, so the two halves are pinned together rather than independently.

## Boundaries

Both edits live in the `gateway/` cargo workspace (`crates/identity`, `crates/devserver-proxy` tests). Nothing outside `gateway/` changes; nothing in chan-prod-setup is misconfigured. Rollout (image rebuild, `CHAN_GATEWAY_VERSION` bump, pod replace, node re-stage under version lockstep) and the end-to-end browser verification against prod are the host's, post-release; the lane delivers the code and tests only.

## Follow-ups noted in passing (not this item)

- `devserver-proxy` logs entry-credential rejections at no level, even under `RUST_LOG=trace`; the node's nginx access.log is what localizes failures. Worth a debug-level rejection reason.
- chan-prod-setup `howto.md` instructs `sdme kube apply` for node updates, which joins the pod and never returns; the doc should use `kube create` + `start -t` + `enable`.
- OAuth starts accumulate never-authenticated `tower_sessions.session` rows (~4-week expiry, no pruning; one user had 66 stub rows). Worth a periodic cleanup.
