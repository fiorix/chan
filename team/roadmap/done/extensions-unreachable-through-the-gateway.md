# Extension module scripts are unreachable through the gateway

Status: SHIPPED in [v0.86.0](../release/release-v0.86.0.md). The gateway admits the exact extension capability path shape; the devserver's capability check authorizes cookieless sandboxed-iframe fetches, proven by a committed e2e scenario.

## What

The gateway's tenant session gate answers 404 (`{"error":"not found"}`, no ACAO) to every request without the gate cookie, including the tenant root; probed live. An extension iframe is deliberately opaque-origin, and a module-script fetch from an opaque origin is CORS-mode with credentials omitted by spec, so it can never carry that cookie. The iframe document itself navigates with credentials and loads; its `app.js` then dies before any response headers reach the browser. Extensions therefore render their shell and never boot through the gateway, on every binary; loopback windows are unaffected, which is why extensions-v1 shipped working.

The devserver side already holds the answer: the 256-bit per-process path capability (`extensions.rs:656`) exists precisely to authenticate requests that cannot carry cookies, and the devserver's own capability check enforces it. The gateway simply never learned to admit that path shape, so the request dies one hop before the component designed to authorize it.

## Contract

- A request matching the extension capability path shape (`/{tenant}/_chan/extensions/{id}/{64-hex}/...`) is admitted through the gateway without the session gate and forwarded to the devserver, whose capability check is the authorization. An invalid capability still produces the devserver's 404, now CORS-readable per the extension response policy.
- The admission is exactly that path shape; no other tenant path loosens. The 256-bit random capability is the credential, and the gateway does not weaken it (no logging of the capability segment, same anti-enumeration response shape for a miss as the session gate's).
- Gateway responses on this path carry the extension response policy, closing the gateway half of the CORS-mask item for this namespace.

## Acceptance

- A sandboxed-iframe module-script fetch (cookieless, `Origin: null`, `Sec-Fetch-Mode: cors`) retrieves `app.js` through a real gateway tenant, proven against a live tunnel.
- The tenant root and every non-extension path still 404 cookieless, byte-identical to today.
- A wrong capability through the gateway yields a CORS-readable 404 indistinguishable in shape from the session gate's.
- An end-to-end extension boot through the gateway: the Doomit tab reaches its running state in a gateway-served window.

## Rough size

Small to medium, all in `gateway/crates/devserver-proxy`: one path-shape admission in the tenant router plus response-policy application, with the no-database test recipe covering it.
