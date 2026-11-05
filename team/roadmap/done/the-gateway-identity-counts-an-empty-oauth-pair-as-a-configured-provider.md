# The gateway identity counts an empty OAuth pair as a configured provider

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: raised on 2026-11-05 by the owner, after devsrv.io showed sign-in buttons for providers it never configured (brief `dev/gw-id-bug.md`). Built by a Claude subagent of the round's lead on `fix/gateway-identity-empty-oauth-pair` off `96d71d989`, merged into `v0124/int` as `cc6366ddc`, with the documentation in `3633e28d1`.

## What was seen

On devsrv.io, which runs v0.123.0, `GET /api/providers` answered `{"providers":["github","google","gitlab"]}` while only the GitHub pair was configured. The sign-in page offered Google and GitLab buttons from the first deploy on, and both sent the browser to the provider with an empty `client_id`, which fails with the provider's own error page.

The cause, read at `720b543c0`:

- `gateway/crates/identity/packaging/identity.env` shipped `GITHUB_CLIENT_ID=`, `GITHUB_CLIENT_SECRET=`, `GOOGLE_CLIENT_ID=`, `GOOGLE_CLIENT_SECRET=`, `GITLAB_CLIENT_ID=` and `GITLAB_CLIENT_SECRET=` as empty assignments. systemd loads the file through the unit's `EnvironmentFile=`, so all six variables existed in the process environment with empty values, and an operator's later `EnvironmentFile` overrode only the pairs it set.
- `Config::from_env` in `gateway/crates/identity/src/config.rs` registered each provider under `if let (Ok(id), Ok(secret)) = (std::env::var(...), std::env::var(...))`. `std::env::var` answers `Ok("")` for a set but empty variable, so every pair from the packaged file registered.
- The "no providers configured" guard after them never fired on a stock install, so the package's own promise ("identity-service refuses to start if none are set") did not hold: a fresh install with nothing configured started with three providers that cannot work.
- `IDENTITY_OAUTH_ENDPOINTS_BASE` already trimmed and dropped an empty value; the provider pairs did not. The `providers_list` handler returns the registered names, and both web clients render one button per name.

devsrv works around it by deleting those six lines from the packaged file when it builds its gateway image. Other deployments of the stock package had the same problem.

## Desired contract

A provider is registered only when both its client id and its secret are non-empty after trimming. If exactly one of the two is non-empty, the configuration is wrong: identity refuses to start and names the variable that is unset or empty, without printing either value. If no pair is complete, identity refuses to start with the existing "no providers configured" error, whether the variables are absent or empty. `/api/providers` lists exactly the registered providers. A deployment whose pairs are all complete registers the same providers, with the values trimmed.

## Boundaries

`gateway/crates/identity/src/config.rs` (`providers_from_vars`, which takes the variable lookup as a parameter, and `OAuthClientPair::from_raw`, which classifies each pair, so the rules are tested without process environment), its tests, `gateway/crates/identity/packaging/identity.env` (the six assignments commented out, the names kept as documentation), the identity README's pair rule, and `.agents/gateway.md` and the identity design naming `providers_from_vars` as where a provider is wired. Not changed: the provider implementations, the OAuth flow, the `/api/providers` shape, `IDENTITY_OAUTH_ENDPOINTS_BASE` and the web clients.

## Acceptance

1. With the stock packaged `identity.env`, and the other required values set, identity refuses to start with "no providers configured".
2. With only the GitHub pair set (the devsrv.io shape) and the other two pairs empty or absent, `/api/providers` answers `{"providers":["github"]}`, read from the real public router on a closed pool.
3. With exactly one half of a pair set, identity refuses to start naming the empty variable, and the message holds no input value.
4. The new tests red at the base and green at the tip; `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test -p identity` green in the gateway workspace.
5. The fix ships in the next gateway release.

## Built

Five commits: `c6d34dca0` (the pair read moved into `providers_from_vars` and `OAuthClientPair::from_raw`, behaviour unchanged), `8bfca252d` (the contract pinned: seven tests red before the fix, among them the router answering the three providers for the stock file plus a GitHub override, the devsrv.io response), `d439c50d0` (the fix: the seven green, 85 identity lib tests), `2a4c1c912` (the half-pair test asserts which half it names, since the refusal names both variables and a mutant that swapped them passed), `10d200309` (the packaged file stops setting the six; `make gateway-packaging-isolation-test` green); then `3633e28d1` for the documents. Gateway CI 41962616428 at `3633e28d1` was green, its gate job running the Postgres integration tests (`providers_endpoint_lists_configured` among them) and the new configuration tests.

Open: a half-set pair now refuses to start where it used to register a provider that could not work (an empty half) or skip it silently (an absent half), so a deployment with one is stopped at its next start by this release; the release notes say so. The stock `identity.env` alone stops earlier, at `BASE_URL`, so acceptance 1 needs the other required values set. `identity.env` is a conffile, so an existing install may keep its old copy with the empty assignments; the code is what covers that copy.
