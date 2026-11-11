import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIdentityServer } from "./stub-identity.mjs";

const origin = "http://127.0.0.1:12345";
function ingress(n) {
    return {
        id: `p${n}`, endpoint: `127.0.0.1:${51820 + n}`,
        server_public_key: Buffer.alloc(32, n).toString("base64"),
        hosts: ["", "*."].map((prefix) => ({
            name: `${prefix}p${n}.proxy.chan-e2e.invalid`, addresses: ["10.7.0.2"],
        })),
    };
}
function parameters(count) {
    const ingresses = Array.from({ length: count }, (_, i) => ingress(i + 1));
    return {
        endpoint: ingresses[0].endpoint, server_public_key: ingresses[0].server_public_key,
        addresses: ["10.7.0.1/32"], allowed_ips: ["10.7.0.2/32"], persistent_keepalive: 5,
        hosts: ingresses[0].hosts, ingresses,
    };
}

// Drive the real request handler without binding a socket or starting a service.
function request(server, method, path, body, headers = {}) {
    const req = new EventEmitter();
    Object.assign(req, { method, url: path, headers });
    let response;
    const res = {
        writeHead(status, headers = {}) { response = { status, headers }; },
        end(body = "") { response.body = body; },
    };
    server.emit("request", req, res);
    if (body) req.emit("data", JSON.stringify(body));
    req.emit("end");
    assert.ok(response && "body" in response, "the handler must finish its response");
    return response;
}

test("discovery advertises every ingress and rereads an added node without sign-in", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "stub-identity-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "peer.json");
    const server = createIdentityServer(file);
    server.address = () => ({ port: 12345 });
    for (const count of [2, 3]) {
        const served = parameters(count);
        writeFileSync(file, JSON.stringify(served));
        const response = request(server, "GET", "/.well-known/chan-gateway");
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(response.body).wireguard, {
            endpoint: served.endpoint, public_key: served.server_public_key,
            allowed_ips: served.allowed_ips, persistent_keepalive: 5,
            ingresses: served.ingresses.map(({ server_public_key, ...entry }) => ({
                ...entry, public_key: server_public_key,
            })),
        });
    }
});

test("one PKCE redemption carries both ingresses and mints a usable single-use token", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "stub-identity-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "peer.json");
    const served = parameters(2);
    writeFileSync(file, JSON.stringify(served));
    const server = createIdentityServer(file);
    server.address = () => ({ port: 12345 });
    const verifier = "test-verifier";
    const url = new URL("/desktop/authorize", origin);
    url.search = new URLSearchParams({
        redirect_uri: "http://127.0.0.1:12346/auth/callback", state: "test-state",
        code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        wireguard_public_key: Buffer.alloc(32, 9).toString("base64"),
    });
    const authorization = request(server, "GET", url.pathname + url.search);
    assert.equal(authorization.status, 302);
    const code = new URL(authorization.headers.location).searchParams.get("code");
    const body = { code, code_verifier: verifier };
    const redemption = request(server, "POST", "/desktop/authorize/redeem", body);
    assert.equal(redemption.status, 200);
    const redeemed = JSON.parse(redemption.body);
    assert.deepEqual(redeemed.wireguard, served);
    assert.equal(request(server, "GET", "/desktop/v1/devservers", null, { authorization: `Bearer ${redeemed.secret}` }).status, 200);
    assert.equal(request(server, "POST", "/desktop/authorize/redeem", body).status, 400);
    assert.equal(request(server, "GET", "/desktop/v1/devservers").status, 401);
});
