# Desktop authorization strands the signed-in browser on a dead-end loopback page

Status: ACCEPTED for v0.86.0 by owner request on 2026-08-08; specced from a flow map of the current implementation.

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
