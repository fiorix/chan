# The grant-claim email fold merges distinct characters

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the Lead follow-ups ledger (2026-09-23 06:46Z, the gateway-lows corrections review of `9a0c3c794`) and the release report's documented residual. Carried as a documented residual, not a defect. A source reading against `main` at `6237c2677`.

## What was seen

Grant claims compare PostgreSQL `lower()` of both sides (`gateway/crates/profile/src/http.rs:1664`). Unicode lowering is not injective: U+212A KELVIN SIGN lowers to `k`, so a provider-verified address using it at the grantee's own domain claims a grant made to the ASCII address. `lower()` also folds only ASCII under a `C` or `POSIX` `LC_CTYPE`. Both are documented in `gateway/crates/profile/design.md` and `.agents/gateway.md`, and the fold on both sides was kept over an ASCII-only fold that would miss real non-ASCII case variants.

## What to do

Revisit only if an identity provider is found to verify such mailboxes, or if a normalization other than `lower()` (for example a compatibility-normalized, case-folded form stored beside the address) is adopted across the gateway. Until then nothing changes.
