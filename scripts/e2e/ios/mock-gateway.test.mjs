import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMockGatewayServer } from "./mock-gateway.mjs";

const ORIGIN = "http://127.0.0.1:45555";
const here = dirname(fileURLToPath(import.meta.url));

function invoke(server, method, path, body = null, headers = {}, extraReq = {}) {
    const req = new EventEmitter();
    Object.assign(req, { method, url: path, headers, ...extraReq });
    let response;
    const res = {
        writeHead(status, resHeaders = {}) {
            response = { status, headers: resHeaders };
        },
        end(chunk = "") {
            response.body = chunk;
        },
    };
    server.emit("request", req, res);
    if (body !== null) {
        req.emit("data", typeof body === "string" ? body : JSON.stringify(body));
    }
    req.emit("end");
    assert.ok(response && "body" in response, "mock handler must finish response");
    return response;
}

function s256(verifier) {
    return createHash("sha256").update(verifier).digest("base64url");
}

function completeAuthAndRedeem(server, { auto = false, wgKey = Buffer.alloc(32, 7).toString("base64"), verifier = "pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyz" } = {}) {
    const q = new URLSearchParams({
        redirect_uri: "chan://auth/callback",
        state: "state-123",
        label: "iphone-e2e",
        code_challenge_method: "S256",
        code_challenge: s256(verifier),
        scopes: "mobile.account",
        expires_in: "3600",
    });
    if (wgKey) q.set("wireguard_public_key", wgKey);
    if (auto) q.set("auto", "1");

    const auth = invoke(server, "GET", `/mobile/authorize?${q.toString()}`);
    assert.equal(auth.status, 302);
    let callbackUrl;
    if (auto) {
        callbackUrl = auth.headers.location;
    } else {
        const consent = invoke(server, "GET", auth.headers.location);
        assert.equal(consent.status, 200);
        const id = /name="id" value="([^"]+)"/.exec(consent.body)[1];
        const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)[1];
        const confirm = invoke(
            server,
            "POST",
            "/mobile/authorize/confirm",
            new URLSearchParams({ id, csrf, action: "allow" }).toString(),
        );
        assert.equal(confirm.status, 200);
        callbackUrl = /url=([^"]+)"/.exec(confirm.body)[1];
    }
    const code = new URL(callbackUrl).searchParams.get("code");
    const redeem = invoke(server, "POST", "/mobile/authorize/redeem", { code, code_verifier: verifier });
    return { code, verifier, redeem };
}

test("F2 happy: discovery, consent confirm, PKCE redeem, and single-use 410 replay guard", () => {
    const { server } = createMockGatewayServer();
    server.address = () => ({ port: 45555 });

    const disc = invoke(server, "GET", "/.well-known/chan-gateway");
    assert.equal(disc.status, 200);
    const discJson = JSON.parse(disc.body);
    assert.equal(discJson.wireguard.mobile_enrollment, true);
    assert.equal(discJson.mobile_authorize_url, `${ORIGIN}/mobile/authorize`);
    assert.equal(discJson.devserver_proxy_host_depth, 2);

    const { code, verifier, redeem } = completeAuthAndRedeem(server);
    assert.equal(redeem.status, 200);
    const body = JSON.parse(redeem.body);
    assert.ok(body.secret.startsWith("pat-"));
    assert.equal(body.wireguard.ingresses.length, 1);

    // Replay must return 410 Gone.
    const replay = invoke(server, "POST", "/mobile/authorize/redeem", { code, code_verifier: verifier });
    assert.equal(replay.status, 410);
});

test("F2 negative: rejects invalid redirect_uri, bad WG key, PKCE mismatch, and unoffered WG", () => {
    const { server } = createMockGatewayServer();
    server.address = () => ({ port: 45555 });
    const challenge = s256("verifier-for-negative-tests-0123456789abcdef");

    for (const badRedirect of [
        "http://127.0.0.1:8080/auth/callback",
        "chan:///auth/callback",
        "chan://auth/callback?",
        "chan://auth/callback#",
        "chan://auth/callback?x=1",
        "chan://auth:443/callback",
        "chan://user@auth/callback",
    ]) {
        const q = new URLSearchParams({
            redirect_uri: badRedirect,
            state: "s1",
            label: "ios",
            code_challenge: challenge,
            code_challenge_method: "S256",
            scopes: "mobile.account",
            expires_in: "600",
        });
        assert.equal(invoke(server, "GET", `/mobile/authorize?${q}`).status, 400);
    }

    const badKeyQ = new URLSearchParams({
        redirect_uri: "chan://auth/callback",
        state: "s2",
        label: "ios",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scopes: "mobile.account",
        expires_in: "600",
        wireguard_public_key: "bad-key",
    });
    assert.equal(invoke(server, "GET", `/mobile/authorize?${badKeyQ}`).status, 400);

    // PKCE mismatch returns 410 and invalidates code.
    const goodQ = new URLSearchParams({
        redirect_uri: "chan://auth/callback",
        state: "s3",
        label: "ios",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scopes: "mobile.account",
        expires_in: "600",
        auto: "1",
    });
    const auth = invoke(server, "GET", `/mobile/authorize?${goodQ}`);
    const code = new URL(auth.headers.location).searchParams.get("code");
    assert.equal(
        invoke(server, "POST", "/mobile/authorize/redeem", { code, code_verifier: "wrong-verifier" }).status,
        410,
    );

    // WireGuard disabled refuses wireguard_public_key.
    const noWg = createMockGatewayServer({ noWireguard: true });
    noWg.server.address = () => ({ port: 45555 });
    const wgKey = Buffer.alloc(32, 5).toString("base64");
    assert.equal(
        invoke(noWg.server, "GET", `/mobile/authorize?${goodQ}&wireguard_public_key=${encodeURIComponent(wgKey)}`).status,
        400,
    );
});

test("F4/F7 happy + negative: entry exchange, cookies, window ops, labels, and tmux encoding", () => {
    const { server } = createMockGatewayServer();
    server.address = () => ({ port: 45555 });
    const { redeem } = completeAuthAndRedeem(server, { auto: true });
    const pat = JSON.parse(redeem.body).secret;

    // Unauthorized roster returns 401.
    assert.equal(invoke(server, "GET", "/mobile/v1/devservers").status, 401);
    const roster = invoke(server, "GET", "/mobile/v1/devservers", null, { authorization: `Bearer ${pat}` });
    assert.equal(roster.status, 200);
    const ds = JSON.parse(roster.body).devservers[0];
    assert.match(ds.proxy_origin, /^http:\/\/alice--0123456789ab\.p1\.localtest\.me:45555$/);

    // Entry + /_chan/entry session cookie exchange.
    const entry = invoke(
        server,
        "POST",
        "/mobile/v1/devserver/entry",
        { path: "/api/notes-1a2b3c/index.html", devserver_id: ds.devserver_id },
        { authorization: `Bearer ${pat}` },
    );
    assert.equal(entry.status, 200);
    const entryBody = JSON.parse(entry.body);
    const exchange = invoke(
        server,
        "POST",
        "/_chan/entry",
        new URLSearchParams({ credential: entryBody.entry_credential }).toString(),
    );
    assert.equal(exchange.status, 303);
    assert.equal(exchange.headers.location, "/api/notes-1a2b3c/index.html");
    const cookieHeader = exchange.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
    const csrf = /__Host-devserver_csrf=([^;]+)/.exec(cookieHeader)[1];

    // Mutations without CSRF header fail 401.
    assert.equal(
        invoke(server, "POST", "/api/library/windows/w-hidden-ws/visibility", { hidden: false }, { cookie: cookieHeader })
            .status,
        401,
    );

    // Unhide, label, tmux percent-encoding, and idempotent delete.
    assert.equal(
        invoke(
            server,
            "POST",
            "/api/library/windows/w-hidden-ws/visibility",
            { hidden: false },
            { cookie: cookieHeader, "x-chan-csrf": csrf },
        ).status,
        204,
    );
    assert.equal(
        invoke(
            server,
            "PUT",
            "/api/library/windows/w-hidden-ws/label",
            { label: "dev / box" },
            { cookie: cookieHeader, "x-chan-csrf": csrf },
        ).status,
        204,
    );
    // Reject >64 chars, control chars, and control terminal rename.
    assert.equal(
        invoke(
            server,
            "PUT",
            "/api/library/windows/w-hidden-ws/label",
            { label: "a".repeat(65) },
            { cookie: cookieHeader, "x-chan-csrf": csrf },
        ).status,
        400,
    );
    assert.equal(
        invoke(
            server,
            "PUT",
            "/api/library/windows/w-hidden-ws/label",
            { label: "bad\x07bell" },
            { cookie: cookieHeader, "x-chan-csrf": csrf },
        ).status,
        400,
    );
    assert.equal(
        invoke(
            server,
            "PUT",
            "/api/library/windows/w-ctrl/label",
            { label: "nope" },
            { cookie: cookieHeader, "x-chan-csrf": csrf },
        ).status,
        400,
    );
    // Percent-encoded tmux connection segment ("term/one" -> "term%2Fone").
    assert.equal(
        invoke(
            server,
            "POST",
            "/api/library/tmux/term%2Fone/request",
            { request: "new-window" },
            { cookie: cookieHeader, "x-chan-csrf": csrf },
        ).status,
        204,
    );
    assert.equal(
        invoke(
            server,
            "DELETE",
            "/api/library/windows/w-hidden-ws",
            null,
            { cookie: cookieHeader, "x-chan-csrf": csrf },
        ).status,
        204,
    );
    assert.equal(
        invoke(
            server,
            "DELETE",
            "/api/library/windows/w-hidden-ws",
            null,
            { cookie: cookieHeader, "x-chan-csrf": csrf },
        ).status,
        404,
    );

    // Tenant navigation records query params in ledger.
    const nav = invoke(
        server,
        "GET",
        "/api/notes-1a2b3c/index.html?w=w-1&lib=lib-e2e001&h=0123456789abcdef0123456789abcdef&start=terminal&pane=%233b82f6",
        null,
        { cookie: cookieHeader },
    );
    assert.equal(nav.status, 200);
    const ledger = JSON.parse(invoke(server, "GET", "/_test/ledger").body);
    assert.equal(ledger.navigations.length, 1);
    assert.equal(ledger.navigations[0].params.start, "terminal");
    assert.equal(ledger.navigations[0].params.pane, "#3b82f6");
});

test("HTTPS/TLS dual server emits https proxy origins, Secure cookies, and fixed tenant HTML controls", async () => {
    const e2eTmpRoot = join(here, "../../../target/e2e-ios");
    mkdirSync(e2eTmpRoot, { recursive: true });
    const certDir = mkdtempSync(join(e2eTmpRoot, "tls-test."));
    try {
        const keyPath = join(certDir, "server.key");
        const certPath = join(certDir, "server.pem");
        execFileSync("openssl", [
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localtest.me",
            "-keyout",
            keyPath,
            "-out",
            certPath,
        ], { stdio: "ignore" });
        const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
        const { server, tlsServer } = createMockGatewayServer({ autoConfirm: true, tls });
        assert.ok(tlsServer, "tlsServer must be created when tls option is passed");
        server.address = () => ({ port: 45555 });
        tlsServer.address = () => ({ port: 45556 });

        const disc = JSON.parse(invoke(server, "GET", "/.well-known/chan-gateway").body);
        assert.equal(disc.identity_origin, "http://127.0.0.1:45555");
        assert.equal(disc.devserver_proxy_origin, "https://localtest.me:45556");

        const { redeem } = completeAuthAndRedeem(server, { auto: true });
        const pat = JSON.parse(redeem.body).secret;
        const roster = JSON.parse(
            invoke(server, "GET", "/mobile/v1/devservers", null, { authorization: `Bearer ${pat}` }).body,
        );
        assert.equal(
            roster.devservers[0].proxy_origin,
            "https://alice--0123456789ab.p1.localtest.me:45556",
        );

        const entry = JSON.parse(
            invoke(
                server,
                "POST",
                "/mobile/v1/devserver/entry",
                { path: "/api/notes-1a2b3c/index.html", devserver_id: "0123456789abcdef0001" },
                { authorization: `Bearer ${pat}` },
            ).body,
        );
        assert.equal(
            entry.entry_exchange_url,
            "https://alice--0123456789ab.p1.localtest.me:45556/_chan/entry",
        );

        // Encrypted TLS request to /_chan/entry must set ; Secure on both __Host-devserver_* cookies.
        const tlsExchange = invoke(
            tlsServer,
            "POST",
            "/_chan/entry",
            new URLSearchParams({ credential: entry.entry_credential }).toString(),
            {
                host: "alice--0123456789ab.p1.localtest.me:45556",
                "content-type": "application/x-www-form-urlencoded",
            },
            { socket: { encrypted: true } },
        );
        assert.equal(tlsExchange.status, 303);
        const setCookies = tlsExchange.headers["set-cookie"] ?? [];
        assert.equal(setCookies.length, 2);
        assert.ok(setCookies.every((c) => c.includes("; Secure")));

        // Tenant HTML switches focus target, separates gateway_csrf_token vs mobile_deliver_pending_show_card,
        // and resets #e2e-result synchronously before invoke.
        const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
        const pageWs = invoke(
            tlsServer,
            "GET",
            "/api/notes-1a2b3c/index.html?w=w-hidden-ws",
            null,
            { cookie: cookieHeader },
            { socket: { encrypted: true } },
        );
        assert.equal(pageWs.status, 200);
        assert.ok(pageWs.body.includes("focus_library_window', { windowId: 'w-ctrl' }"));
        assert.ok(pageWs.body.includes('aria-label="Check gateway_csrf_token"'));
        assert.ok(pageWs.body.includes('aria-label="Probe disallowed mobile_deliver_pending_show_card"'));
        assert.ok(pageWs.body.includes("JSON.stringify({ pending: true, cmd })"));

        const pageCtrl = invoke(
            tlsServer,
            "GET",
            "/terminal/index.html?w=w-ctrl",
            null,
            { cookie: cookieHeader },
            { socket: { encrypted: true } },
        );
        assert.equal(pageCtrl.status, 200);
        assert.ok(pageCtrl.body.includes("focus_library_window', { windowId: 'w-hidden-ws' }"));
    } finally {
        rmSync(certDir, { recursive: true, force: true });
    }
});
