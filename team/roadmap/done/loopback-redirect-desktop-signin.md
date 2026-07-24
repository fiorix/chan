# Loopback Redirect For Desktop Gateway Sign-In

> Status: shipped in [v0.75.0](../../release/release-v0.75.0.md): the RFC 8252 loopback redirect + PKCE replaced the chan:// scheme outright.

Status: **NOT READY TO IMPLEMENT. Do not start coding from this item.** Accepted as scope for v0.74.0; the design is drafted and has been through a security review, and that review found three exploitable gaps in the naive shape of this change. The mitigations below are specified but have not been validated by an implementer, and the design needs one further refinement pass (a named owner walking the mitigations against the real call graph, settling the verifier-keyed variant, and producing the file-level plan) before any code is written. This item also must land **after** the distributed proxy control plane merges: see Sequencing.

## Problem

chan-desktop signs in by opening the user's default browser at the gateway consent page with a fixed custom-scheme redirect, `const REDIRECT_URI: &str = "chan://auth/callback"` (`desktop/src-tauri/src/auth.rs:60`), used by both the hosted flow (`desktop/src-tauri/src/auth.rs:209`) and the gateway flow (`desktop/src-tauri/src/auth.rs:281`). The OS is expected to route that URL back to the running app, where `app.deep_link().on_open_url(...)` (`desktop/src-tauri/src/main.rs:4792`) hands it to `auth::handle_callback`.

That routing does not hold on Linux or Windows, where the OS delivers a deep link by spawning a **new process** with the URL in argv. chan declares no single-instance plugin: the desktop plugin set is `tauri-plugin-deep-link`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-updater` (`desktop/src-tauri/Cargo.toml:24-27`), with no `tauri-plugin-single-instance`. So the callback arrives in a second process whose pending slot is empty. The pending sign-in lives in a process-global `Mutex<Option<PendingAuth>>` (`desktop/src-tauri/src/auth.rs:153-156`), and `classify_callback` returns `CallbackAction::Ignore` when that slot is `None` (`desktop/src-tauri/src/auth.rs:499-501`), which `handle_callback` maps to `CallbackOutcome::Ignored` with nothing stored and nothing emitted (`desktop/src-tauri/src/auth.rs:371`). The user sees a browser tab that says it worked and an app window that never signs in.

Registration is missing too. `tauri.conf.json` declares the scheme (`"deep-link": { "desktop": { "schemes": ["chan"] } }`, `desktop/src-tauri/tauri.conf.json:21-24`) and bundles `"targets": "all"` (`desktop/src-tauri/tauri.conf.json:35`) with a Linux block carrying only `deb.depends` (`desktop/src-tauri/tauri.conf.json:51-55`). The AppImage installs no scheme handler at all, and the Tauri-bundled `.deb`/`.rpm` install a generated `.desktop` whose `Exec` has no `%u`/`%U` field code, so even a registered handler is passed no URL. The distro-packaged path is closer but not a fix: `packaging/distros/shared/chan-desktop.desktop:5` does carry `Exec=chan-desktop %U` alongside `MimeType=x-scheme-handler/chan`, which means the URL is delivered, into a freshly spawned second process with an empty slot, which is exactly the ignore path above.

An RFC 8252 loopback redirect needs no OS registration on any platform and lands in the exact process that holds the pending nonce.

## Security findings that shape the design

These are why this is not a small change. Each is a property of the code as it stands today.

**1. The redemption code is bound to nothing.** `RedemptionStore` is a `HashMap<String, StoredRedemption>` keyed by a fresh random code and nothing else (`gateway/crates/identity/src/desktop_authorize.rs:173-212`), and `redeem` accepts `RedeemRequest { code }` with no session, no client identity and no proof of possession; its own doc comment states the position outright, "No session auth: possession of the code is the credential" (`gateway/crates/identity/src/desktop_authorize.rs:481-506`). On the desktop side the only thing standing between a pending sign-in and an arbitrary code is the `state` compare in `classify_callback` (`desktop/src-tauri/src/auth.rs:507-521`), after which `redeem_code` POSTs `{"code": code}` and stores whatever PAT comes back (`desktop/src-tauri/src/auth.rs:392-434`, `desktop/src-tauri/src/auth.rs:340-351`). An attacker who learns `state` can fire the callback with a code they minted from **their own** account, and the victim's desktop stores the **attacker's** PAT: the victim then works, and syncs, inside the attacker's account.

**2. The state nonce is not confidential, because it ships in argv.** Both sign-in entry points hand the full authorize URL, `state` included, to `app.opener().open_url(...)` (`desktop/src-tauri/src/auth.rs:217-219` and `desktop/src-tauri/src/auth.rs:289-291`), which on Linux is `xdg-open <url>`. The nonce is therefore an argv element visible in `/proc/<pid>/cmdline`, world-readable by default, while `/proc/net/tcp` exposes the uid owning each loopback listener. That makes finding 1 a **cross-user** attack on a shared machine, not a same-user one. There is no way to hand a URL to `xdg-open` without argv, so this leak cannot be closed; it must be made non-exploitable.

**3. Loosening `redirect_uri` deletes the last recipient pin.** The gateway today exact-matches a single literal, `if q.redirect_uri != EXPECTED_REDIRECT_URI { return Err(Error::BadRequest("invalid redirect_uri".into())) }` (`gateway/crates/identity/src/desktop_authorize.rs:121`, `:254-256`). Replacing that literal with a pattern that accepts any loopback port removes the only thing tying a consent to the real chan-desktop. A malicious local app then needs no `state`, no port guess and no race: it binds its own port, opens the browser at a genuine `id.chan.app` consent page with an attacker-chosen `label` that renders identically to the real one, and one user click mints a 30-day `desktop.account` PAT straight into the attacker's listener.

## Desired contract

**PKCE, RFC 7636, S256 only.** `plain` re-leaks the verifier through argv and is not acceptable. Generate a 256-bit `code_verifier` beside `new_state()` (`desktop/src-tauri/src/auth.rs:160-164`), hold it in `PendingAuth` (`desktop/src-tauri/src/auth.rs:143-151`), put `code_challenge=BASE64URL(SHA256(verifier))` and `code_challenge_method=S256` on the authorize URL, and send the verifier only on the back-channel redeem POST. This reduces a stolen `state` from account takeover to a denial of service.

**Preferred variant: key the store by the verifier hash, so the credential never travels through the browser at all.** Once PKCE exists the `code` is redundant, since it is only a map key. Key `RedemptionStore` by `BASE64URL(SHA256(verifier))` instead of a random code, have the callback carry **only** `state` (plus `error` on the failure arm), and let the desktop POST the verifier to redeem. This is a smaller diff than the code-in-query design, and it removes the log, browser-history and `Referer` exposure of the credential outright rather than bounding it.

**The verifier never leaves the process.** Never in the authorize URL, never in argv, never in the callback, never in a log line. Only the hash goes out, and only over the redeem POST does the verifier itself move, to an origin taken from the pending slot.

**The redeem target comes from the pending slot, never from the callback.** `PendingAuth::identity_origin` already carries it (`desktop/src-tauri/src/auth.rs:146-149`). A loopback callback is attacker-reachable; if any future version reads an origin out of the request, the desktop can be made to POST its credential to an attacker's server. Keep that invariant explicit in the code and in a test.

**Constant-time `state` compare, non-consuming on mismatch.** A mismatch must leave the pending slot untouched, otherwise any local process could cancel every sign-in. That makes the compare an oracle an attacker can query without limit over loopback, so the current short-circuiting `!=` (`desktop/src-tauri/src/auth.rs:508`) becomes a timing leak. Use one shared constant-time helper for both the `chan://` arm and the loopback arm so the two cannot drift. Do **not** add an attempt cap: that hands the denial of service back.

**Expire the pending slot.** It currently never expires. `GATEWAY_SIGNIN_TIMEOUT` (`desktop/src-tauri/src/main.rs:2259`) is consumed only by the gateway runtime-status sweeper (`desktop/src-tauri/src/gateway.rs:821`), which flips `pending_signin` and `status` on the runtime row and never touches the auth slot, so an abandoned sign-in leaves a live nonce for the process lifetime and the injection window is unbounded. Add `created_at` to `PendingAuth` and treat an older slot as absent inside `classify_callback`, returning `Ignore` rather than `Fail` so no banner fires at someone who simply walked away.

**A dedicated per-sign-in listener, not a route on the permanent embedded server.** The embedded server serves the full launcher surface including the workspace mutation API behind a per-launch bearer, and its port is presently known only to the WebView. Putting the callback there puts that port into the user's real browser history, omnibox and extensions, turning a port scan into a lookup. Bind a listener at sign-in time, keep its shutdown handle in `PendingAuth`, and drop it on the first accepted callback or on expiry. It also keeps the query out of the embedded server's `TraceLayer` logging.

**Route request rules, in this order, before anything else runs:** method is GET and path is exactly `/auth/callback`; `Host` parses as `127.0.0.1:<our port>` or `[::1]:<our port>`, with a missing `Host` a reject (400); if `Sec-Fetch-Dest` is present and is not `document`, 400; constant-time `state` compare against the pending slot **before** any redemption; on mismatch, missing state, or empty slot, leave the slot untouched, emit no `AUTH_ERROR`, and answer a neutral page.

Carry **no** `Access-Control-Allow-*` header. CORS stops nothing here: the legitimate callback is a top-level navigation and so is not subject to CORS, `fetch(..., {mode:'no-cors'})` still delivers the request, and the attacker never needs to read the response. Send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Answer the HTTP response **before** running redeem, so the 15s `REDEEM_TIMEOUT_SECS` round trip (`desktop/src-tauri/src/auth.rs:70`, `:392-434`) never sits inside the handler; that means the page copy must not claim success, only "You can close this tab".

Two doc comments become wrong with this change and must be corrected in the same commit: `handoff_response` says "the page embeds a PAT secret" when it embeds a code (`gateway/crates/identity/src/desktop_authorize.rs:428-431`), and `REDEEM_TTL` justifies its 120s window by "the OS to route the chan:// URL" (`gateway/crates/identity/src/desktop_authorize.rs:150-154`).

## The redirect_uri validator, exactly

Parsing with the `url` crate is necessary and nowhere near sufficient: every bypass in this class survives parsing. After `Url::parse`, require **all** of:

- `scheme() == "http"`, never `https`, because the listener has no certificate
- host matches `Host::Ipv4(Ipv4Addr::LOCALHOST)` or `Host::Ipv6(Ipv6Addr::LOCALHOST)` by **exact equality on the parsed enum**: never `host_str()`, never `is_loopback()`, never the name `localhost`
- `port()` is `Some(p)` with `p > 0`
- `path() == "/auth/callback"` exactly, not `starts_with`
- `query().is_none()`, `fragment().is_none()`, `username().is_empty()`, and no password

Why each rule exists: `http://127.0.0.1@evil.example/auth/callback` parses with host `evil.example` and the loopback text sitting harmlessly in `username()`, so a substring or text check hands the consent to `evil.example`; `http://0.0.0.0:1234/auth/callback` is a valid non-loopback IPv4 that `connect(2)` routes to localhost on Linux and Windows, so `is_loopback()` is not enough and exact equality is required; `http://[::ffff:127.0.0.1]:1234/auth/callback` is loopback in effect but `Ipv6Addr::is_loopback()` returns false for it, so a permissive IPv6 path must not be opened by falling back to `is_loopback()` either.

## Boundaries

`chan://` support **stays**. Plugin init, the `on_open_url` wiring (`desktop/src-tauri/src/main.rs:4792`), the cold-start `get_current` scan, and the scheme declaration in `desktop/src-tauri/tauri.conf.json:21-24` are untouched, and the gateway keeps emitting the fragment handoff shape when the `redirect_uri` is the `chan://` literal. An older desktop keeps working unchanged against a newer gateway. The gateway decides the handoff shape from the kind of `redirect_uri` it was given.

The verifier must never leave the process, as above. This is a boundary, not just a contract line: any future refactor that logs, emits, or forwards `PendingAuth` in full breaks it.

The redeem origin stays sourced from the pending slot, never from the request.

Scope is the desktop sign-in path plus the gateway's desktop-authorize module. This item does not change PAT scopes, does not change the consent page's approval model, and does not add server-side revoke.

## Sequencing: land after the distributed proxy control plane

This must merge **after** [distributed-proxy-control-plane](../v0.73.0/distributed-proxy-control-plane.md). That lane owns `gateway/**`, `scripts/e2e/gateway-zone.sh`, and `desktop/src-tauri/src/{config,gateway,main}.rs`, which is every file this change needs except `desktop/src-tauri/src/auth.rs`. Its identity step rewrites entry `aud`, `proxy_origin`, `entry_url`, the roster `proxy_origin`, and the discovery depth field in the same files and the same structs this change touches, and `gateway/` is a separate Cargo workspace with its own lock and gate. This is not a collision a careful reviewer resolves: it is the same functions in the same files in a separate workspace under an unfinished multi-step refactor, which is precisely the shape of this repository's shared-tree incident history.

If it ever has to go in parallel, the only defensible carve-out is that the loopback lane owns `desktop/src-tauri/src/auth.rs` alone and hands the gateway half over as a reviewed patch for the control-plane lane to apply on its own branch at a point of its choosing.

Waiting regresses nothing. Linux desktop deep-link sign-in does not work today and has not for as long as the AppImage has existed, so shipping without this changes nothing for any user; it simply does not fix it yet. The desktop `.deb`/`.rpm` drop waits behind it for the same reason, and keeping them costs only build time.

## Acceptance

Automatable on CI and on this host:

- Unit tests over the `redirect_uri` validator covering each rejection above by name: `http://127.0.0.1@evil.example/auth/callback`, `http://0.0.0.0:<port>/auth/callback`, `http://[::ffff:127.0.0.1]:<port>/auth/callback`, `https://127.0.0.1:<port>/auth/callback`, `http://localhost:<port>/auth/callback`, port `0`, a path prefix such as `/auth/callback/x`, and any of query, fragment, userinfo present.
- Gateway tests that a `chan://auth/callback` `redirect_uri` still produces today's fragment handoff, and that a valid loopback `redirect_uri` produces the loopback handoff, so the older-desktop compatibility claim is proven rather than asserted.
- A test that a `state` value containing `&`, `#`, `=`, a space and a newline round-trips through the loopback URL as one opaque parameter, given the authorize URL is built with `Url::parse_with_params` and on Windows passes through `cmd /c start`.
- Desktop tests that a mismatched, missing, or expired `state` leaves the pending slot intact, emits no `AUTH_ERROR`, and returns the neutral page; and that an expired slot classifies as `Ignore`, not `Fail`.
- A test that redemption targets the origin held in the pending slot even when the callback request names a different host.
- A test that the verifier appears in no authorize URL, no callback URL, and no emitted event, and that only the S256 challenge is sent outbound.
- The browser-to-local-listener hop end to end with headless Chrome against a real bound loopback listener. This part **is** runnable on this host.
- The full pre-push gate, plus the gateway workspace's own gate, both green.

Not provable on this host, owner-only, once per platform on **Linux, Windows, and macOS**: chan-desktop is a GUI binary and this host has no display server, no keyring service, and no browser with a real default-handler database. The owner smokes it **from a running app, never a cold start**, because cold start is the case that accidentally worked before. Per platform: Connect from the Gateways screen, confirm the system browser opens the consent page, click Authorize, confirm the tab lands on a plain page served from `127.0.0.1` (the URL bar reading `http://127.0.0.1:<port>/auth/callback` is itself the proof), and confirm the **original** window flips to signed-in with **no second dock or taskbar icon**. macOS is the regression check: it works today and must keep working.
