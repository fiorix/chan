// Stand-in gateway identity for desktop-wireguard.sh --enroll: the four
// endpoints a desktop's sign-in with a WireGuard key touches, on loopback
// http, in the shapes identity answers them with. One account, no OAuth and
// no consent page: the authorize request is answered at once with a
// redirect to the desktop's callback, as identity's handoff page does.
//
//   node stub-identity.mjs <peer-file>
//
// <peer-file> holds the WireGuard parameters a redeem answers (the redeem
// response's `wireguard` member); discovery offers enrollment with its
// `endpoint` and `server_public_key`. It is read on every request, so the
// caller can name a peer that starts only once the desktop has minted the
// key the peer admits. Listens on an ephemeral loopback port and prints
// `identity: ready origin=<origin>`, then one line per request; a minted
// token and a redemption code are never printed.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const [peerFile] = process.argv.slice(2);
if (!peerFile) {
    console.error("usage: stub-identity.mjs <peer-file>");
    process.exit(2);
}

// Redemption codes, single use, and the tokens they minted.
const codes = new Map();
const tokens = new Set();

const log = (line) => console.log(`identity: ${line}`);

function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

function peer() {
    return JSON.parse(readFileSync(peerFile, "utf8"));
}

// The key as identity accepts it: standard base64 with padding, 44
// characters, 32 bytes.
function validKey(key) {
    return /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, "base64").length === 32;
}

function discovery(origin) {
    const wireguard = peer();
    return {
        kind: "chan-gateway",
        api_version: 1,
        identity_origin: origin,
        desktop_authorize_url: `${origin}/desktop/authorize`,
        desktop_entry_url: `${origin}/desktop/v1/devserver/entry`,
        roster_url: `${origin}/desktop/v1/devservers`,
        devserver_proxy_origin: "https://proxy.chan-e2e.invalid",
        devserver_proxy_host_depth: 2,
        wireguard: { endpoint: wireguard.endpoint, public_key: wireguard.server_public_key },
    };
}

function authorize(url, res) {
    const params = url.searchParams;
    let callback;
    try {
        callback = new URL(params.get("redirect_uri") ?? "");
    } catch {
        callback = null;
    }
    const key = params.get("wireguard_public_key");
    if (
        callback?.protocol !== "http:" ||
        callback.hostname !== "127.0.0.1" ||
        callback.pathname !== "/auth/callback" ||
        params.get("code_challenge_method") !== "S256" ||
        !params.get("code_challenge") ||
        !params.get("state")
    ) {
        log("authorize refused: not a desktop sign-in request");
        return json(res, 400, { error: "invalid authorize request" });
    }
    if (key !== null && !validKey(key)) {
        log("authorize refused: invalid wireguard_public_key");
        return json(res, 400, { error: "invalid wireguard_public_key" });
    }
    const code = randomBytes(16).toString("hex");
    codes.set(code, {
        challenge: params.get("code_challenge"),
        key,
        label: params.get("label") ?? "",
    });
    log(`authorize wireguard_public_key=${key ?? "none"}`);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", params.get("state"));
    res.writeHead(302, { location: callback.toString() });
    res.end();
}

function redeem(body, res) {
    let request;
    try {
        request = JSON.parse(body);
    } catch {
        request = {};
    }
    const grant = codes.get(request.code);
    codes.delete(request.code);
    const challenge = createHash("sha256")
        .update(String(request.code_verifier ?? ""))
        .digest("base64url");
    if (!grant || grant.challenge !== challenge) {
        log(`redeem refused: ${grant ? "the verifier does not match" : "unknown code"}`);
        return json(res, 400, { error: "invalid_grant" });
    }
    const secret = randomBytes(24).toString("base64url");
    tokens.add(secret);
    const answer = { id: "pat-e2e", secret, label: grant.label, expires_at: null };
    if (grant.key !== null) answer.wireguard = peer();
    log(`redeem pkce=ok wireguard=${grant.key !== null ? "sent" : "none"}`);
    json(res, 200, answer);
}

function roster(req, res) {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokens.has(bearer)) {
        log("roster refused: not a minted token");
        return json(res, 401, { error: "unauthorized" });
    }
    log("roster bearer=minted");
    json(res, 200, {
        user_id: "00000000-0000-4000-8000-000000000001",
        username: "e2e",
        devservers: [],
    });
}

const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, origin);
    const route = `${req.method} ${url.pathname}`;
    let body = "";
    req.on("data", (chunk) => {
        body += chunk;
    });
    req.on("end", () => {
        try {
            if (route === "GET /.well-known/chan-gateway") {
                const doc = discovery(origin);
                log(`discovery wireguard_endpoint=${doc.wireguard.endpoint}`);
                return json(res, 200, doc);
            }
            if (route === "GET /desktop/authorize") return authorize(url, res);
            if (route === "POST /desktop/authorize/redeem") return redeem(body, res);
            if (route === "GET /desktop/v1/devservers") return roster(req, res);
            log(`unknown ${route}`);
            res.writeHead(404);
            res.end("stub-identity: unknown path");
        } catch (error) {
            log(`failed ${route}: ${error.message}`);
            json(res, 500, { error: "stub-identity failed" });
        }
    });
});

server.listen(0, "127.0.0.1", () => {
    log(`ready origin=http://127.0.0.1:${server.address().port}`);
});
