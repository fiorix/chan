# A PAT minted by the redeem is orphaned when the desktop refuses the answer

Status: raised on 2026-11-07 from the v0.125.0 release's reading of the desktop enrollment; accepted by the owner for v0.126.0 at the v0.125.0 cut; moved to v0.127.0 by the owner on 2026-11-08; not started.

## What is there now

A desktop sign-in ends with the redeem: identity mints the PAT and answers it with the WireGuard enrollment (the peer's tunnel address and the server's key), and the desktop prepares the enrollment, records it and stores the token (`desktop/src-tauri/src/auth.rs` at the redeem's completion, `config::record_wireguard_enrollment`, and `GatewayAttempt::commit_credentials` in `gateway.rs`). Three paths leave a minted token that nobody holds. When the desktop refuses the answer after a successful redeem (another peer's key in the answer, a missing key file, a parameter that does not parse), `prepare_enrollment` fails the sign-in and stores nothing, the token included, and nothing tells identity: the PAT lives in `api_tokens` until it expires. When the token store fails after `record_wireguard_enrollment` wrote the client file and saved the row, the file stays and the next sign-in enrolls the same key again, which moves the peer to the new token, but the first token is never revoked. And a cancel that arrives during the credential commit does not stop it: `commit_credentials` refuses a commit that has not started, and a commit under way runs to its end, so a Disconnect mid-redeem records the enrollment and stores the token though the user asked for neither. identity revokes a token at `DELETE /api/tokens/{id}` (`tokens_revoke`, a soft revoke kept for audit), but that route reads the caller from the browser session, which the desktop does not hold once the redeem has answered.

## Desired contract

1. A PAT the desktop will not keep is revoked at identity before the sign-in fails: after a refused answer, and after a token store that fails. The revoke is bounded; its own failure is logged at the sign-in's level and does not change the sign-in's outcome, which is already a failure.
2. The credential commit ends in one of two states and no third: the client file, the row and the token all kept, or none kept and the token revoked. A cancel that arrives while the commit runs lets the commit finish (a committed PAT is acknowledged, never silently abandoned) and then undoes it: the enrollment removed, the token revoked, the sign-in reported as cancelled.
3. A sign-in that failed or was cancelled leaves no gateway row enrolled and no token in the store, so a later sign-in starts clean.

## Boundaries

- The desktop's redeem completion and credential commit, and the identity route the revoke needs. How the desktop authenticates a revoke of a token it holds the secret of (a bearer self-revoke on the token itself, or the redeem endpoint taking back the token it minted) is the design's first question, with the owner.
- No change to the redeem's answer shape or to the enrollment contract; the revoke goes through the desktop's shared HTTP client and the WireGuard proxy decision, like the redeem.

## Acceptance

1. Against a stand-in identity that records every request: a redeem answered with another peer's key ends in a failed sign-in, no stored token, no row change and one revoke for the minted id; the same for a redeem whose token store is made to fail after the client file is written.
2. A cancel during the credential commit: the commit's writes are undone (no client file, no enrolled key on the row, no stored token), the revoke is sent, and the sign-in reports cancelled.
3. The three tests red at a test-only snapshot without the revoke and the undo, green at the fix; the existing redeem tests unchanged and green.
4. Against a real gateway: a refused answer leaves the minted id with `revoked_at` set in identity's token audit.
