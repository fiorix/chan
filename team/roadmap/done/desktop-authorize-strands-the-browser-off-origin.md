# Desktop authorization strands the signed-in browser on a dead-end loopback page

Closed: shipped in [v0.87.0](../release/release-v0.87.0.md).

Status: ACCEPTED, deferred to v0.87.0 on 2026-08-08 before the v0.86.0 cut; specced from a flow map of the current implementation, not implemented.

## What

When chan-desktop connects to a gateway, the browser drives the OAuth flow and ends on a dead end: the gateway's handoff page meta-refreshes the tab to the desktop's loopback listener (`127.0.0.1:<port>/auth/callback`), whose response is a hardcoded neutral page reading "You can close this tab." (`desktop/src-tauri/src/auth.rs:120-122`). The user who just authorized is left on a blank local page, off the gateway origin, with no sign that they are signed in.

They are signed in. The IdP callback mints the real browser session before the consent page ever renders (`gateway/crates/identity/src/http.rs:590-612`), and `POST /desktop/authorize/confirm` refuses without it (`desktop_authorize.rs:746`). There is no session gap to fill; the whole defect is where the browser lands.

## Contract

- After a successful desktop authorization, the browser ends on the gateway profile page, signed in, showing a login-successful notification. No terminal "close this tab" resting page in the success path.
- The loopback hop stays: it is how the desktop receives its code, and the handoff page's automatic meta refresh feeds the desktop's 15-second redemption slot (`auth.rs:99-103`). What changes is the loopback response, which stops being terminal and sends the browser back to the gateway origin.
- The confirm POST keeps answering a 200 handoff page, never a 3xx. The ruling's rationale (`desktop_authorize.rs:36-44`: a redirect off the form POST would drag the loopback hop under the page's `form-action` CSP) is untouched by this change, because the loopback response answers a GET navigation that is outside any form chain. The module and handler docs and the test pin (`tests/desktop_authorize.rs:565-583`) are amended to say the ruling binds the confirm response specifically.
- Any transient page the user can see in the flow renders through the shared `pages` shell, so it is styled like the authorization consent page by construction.
- The loopback listener's neutrality invariant holds (`auth.rs:118-119`): the response must not let a local prober distinguish a state-matched callback from a mismatched one. Both may redirect identically to the origin held by the flow slot (the same origin rule `redeem_inner` already applies, `auth.rs:198-200`); a callback with no active slot keeps today's neutral 200, since there is no slot origin to name and no flow to complete.

## Recommended shape, and the fallback

**Recommended: no new page at all.** The loopback response for an active flow becomes a redirect to `https://<slot-origin>/profile?desktop_authorized=1`; the profile SPA (`web/packages/profile`) reads the marker, strips it from history, and shows the notification. The user's visible journey is authorize, a same-styled instant handoff, profile. This matches the owner's stated preference for landing on the profile page directly; the intermediate JS-redirect page discussed alongside it was a workaround for the no-3xx ruling, which does not bind this hop.

**Fallback, if the neutrality analysis rejects a slot-derived redirect target:** a gateway `GET /desktop/authorize/done` page rendered through `pages::render`, reached from the loopback response, which forwards to the profile page. Forwarding uses a meta refresh rather than script, because the shared CSP is byte-pinned at `default-src 'none'` with no script nonce (`pages.rs:27-28`, pin test `pages.rs:161-176`), and a meta refresh keeps that pin untouched.

## Acceptance

- A full desktop authorization against a real gateway ends with the browser on the profile page showing the notification, and the desktop connected; the redemption slot still receives its code within its window.
- The confirm response still answers 200 with no `Location`, the handoff target still appears exactly twice attribute-escaped, and no PAT material appears in any URL or page; the existing pins prove all three and are re-stated where their prose narrows.
- The neutral response for a callback with no active flow is byte-identical to today's, and the state-mismatch response remains indistinguishable from the state-match response, proven by the existing neutrality test extended to the redirect form (`auth.rs:1257-1268`).
- The deny and blocked arms keep their current handoff behaviour; only the success path lands on profile.
- The identity integration tests covering the flow (`tests/desktop_authorize.rs`, one of the Postgres-gated files) are executed against a throwaway database and their record kept, since no local or branch path runs them (`gateway-tests-do-not-run-off-main`).

## Rough size

Small to medium: the loopback response's redirect form with the neutrality rule, a profile SPA notification, doc and pin amendments on the confirm path, and the hand-run database-backed test record. No new session code, no schema change; the fallback page adds one handler, one route, and one copy function if it is needed at all.

## Implemented 2026-08-09 (`0559ba2e`)

The recommended shape held and the fallback page was not built. The loopback listener's answer stops being terminal: a callback that could complete a flow is answered with a 303 to the flow origin's `/profile?desktop_authorized=1`, and the profile SPA reads that marker, strips it from the URL, and shows a signed-in notice. Everything else keeps the neutral 200 it answers today. The gateway gained no route and no page, so `pages.rs` is untouched and nothing new renders through the shared shell.

Neutrality is held structurally rather than by equalising two arms after the fact. `callback_landing` reads exactly two things: whether a live, in-date flow slot exists, and whether the query carries a non-empty `code`. The slot's liveness is already implied by the port answering at all, and `code` is supplied by the caller, who therefore already knows it. The secret `state` never reaches the decision, so for any fixed query the state-match and state-mismatch arms are the same bytes by construction. The answer is built from a slot peek before `classify_callback` takes the slot, which is what keeps the two arms from diverging on the take. Gating the redirect on `code` rather than on the absence of `error` is what leaves the deny and blocked arms on the neutral page, and it also keeps a matching-state callback whose code is missing or empty off the profile page.

The redirect target is the slot's own `identity_origin`, the same rule `redeem_inner` already applies, so a callback still steers neither hop. It carries no trailing slash, which is load-bearing rather than cosmetic: the SPA is built with a relative asset base, so `/profile` resolves its bundle at `/assets/...` while `/profile/` would resolve it under `/profile/assets/...`, which the SPA fallback answers 404 for because it only falls back to `index.html` for extensionless paths. Checked by resolving the built `index.html`'s own `./assets/index-*.js` against all three candidate bases rather than by reading the URL spec.

The no-3xx ruling's prose now says what it always meant: it binds the confirm response specifically. A 3xx answering that form POST would drag the loopback hop into the form submission's redirect chain, which Chrome subjects to the page's `form-action` CSP. The loopback answer replies to a GET navigation outside any form chain, so the ruling never reached it. Amended in the module doc, the `confirm` and `render_handoff_html` docs, and the integration-test pin.

### New observable behaviour, accepted rather than fixed

A web attacker who guesses the ephemeral loopback port **while a flow is live** can navigate a tab at the callback and be bounced to the profile page, where the marker raises a false "Signed in" notice. Today that same probe yields a blank page reading "You can close this tab."

Stated plainly for the record: no credential crosses, because the response carries no token and the notice is a query marker the page trusts on sight; the desktop does not connect, because the redirect and the redeem are independent and a probe carries no valid code; and it needs both a live flow and a correct port guess, in a range the browser picks ephemerally. It is inherent to a query marker. Confirming the marker server-side would need a new route, which this item does not have, so it is recorded rather than mitigated.

### What was exercised, and against which acceptance line

- **Neutral response byte-identical, mismatch indistinguishable from match** (acceptance 3). `a_callback_with_no_live_flow_answers_todays_neutral_200_byte_for_byte` pins the no-slot and over-age answers against a literal, `Content-Length: 118` included, so a const moving under it fails the pin rather than being rebuilt around. `the_answer_is_byte_identical_for_a_state_match_and_a_mismatch` compares the listener's own bytes across five query shapes: code, error, both, bare state, and empty. `neutral_response_has_the_privacy_headers_and_no_cors` is the existing neutrality test extended to the redirect form, where `no-referrer` matters most because the URL being answered holds the one-time code and the next hop is the gateway.
- **Deny and blocked keep their handoff behaviour** (acceptance 4). `only_a_callback_carrying_a_code_lands_on_profile`.
- **Confirm still answers 200 with no `Location`, handoff target twice attribute-escaped, no PAT in any URL or page** (acceptance 2). The existing integration pins, re-stated where their prose narrows, executed and green.
- **The Postgres-gated identity suite executed and its record kept** (acceptance 5). `cargo test -p identity --test desktop_authorize` against a throwaway database, 13 passed 0 failed, run twice. Nothing in the project runs this file otherwise: it is one of the seven `TEST_DATABASE_URL` files and no local or branch path reaches it.

**Acceptance 1 is not proven here and is deferred to the host's production test.** A full desktop authorization against a real gateway ending with the browser on the profile page and the desktop connected was not exercised: this round had no host click-through and no real IdP, by host ruling. It is not restated as something the tests did prove.

Validation: `cargo test -p chan-desktop` 351 passed, the `auth` module 34 passed with all seven new and extended tests confirmed by name; `clippy -p chan-desktop --all-targets` and the separate gateway workspace's `fmt`, `clippy` and `build` all clean; `make web-check` green end to end. Ten mutation probes, each red on exactly the assertion it attacks and green again on revert: making the answer consult `state` (kills the byte-identity test alone), redirecting with no slot and with an over-age slot (each kills the byte-for-byte pin), dropping the `code` gate (kills the deny arm), letting the query steer the landing origin, answering 200 instead of 303, dropping `no-referrer` from the redirect form only, dropping the origin's trailing-slash trim, not stripping the marker (kills both tests that assert the strip), and matching the marker's presence instead of its value.

`@chan/profile` was wired into `make web-check` in the same commit. `gateway-spa` runs `npm run build -w @chan/profile` alone, so the package's `svelte-check` and its tests ran in no gate: without this the new marker suite would have passed once and never executed again.
