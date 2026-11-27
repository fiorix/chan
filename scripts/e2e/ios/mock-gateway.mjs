// Loopback mock chan-gateway + chan-devserver for iOS E2E and Simulator smoke tests.
// Zero external dependencies; runnable as a library (`createMockGatewayServer`) or CLI.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

const DEFAULT_USER_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_DEVSERVER_ID = "0123456789abcdef0001";
const DEFAULT_LIBRARY_ID = "lib-e2e001";
const TMUX_REQUEST_KINDS = new Set([
    "open-window",
    "new-window",
    "split",
    "focus",
    "window-size",
    "resize-pane",
    "detach",
    "end",
]);

function sha256Base64Url(input) {
    return createHash("sha256").update(String(input)).digest("base64url");
}

function validWgPublicKey(raw) {
    if (typeof raw !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) return false;
    const buf = Buffer.from(raw, "base64");
    return buf.length === 32 && buf.toString("base64") === raw;
}

function validMobileRedirectUri(raw) {
    return raw === "chan://auth/callback";
}

function hasControlChars(text) {
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

function parseCookies(headerValue) {
    const out = Object.create(null);
    if (!headerValue) return out;
    for (const part of String(headerValue).split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const k = part.slice(0, eq).trim();
        const v = part.slice(eq + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

function defaultSeedState() {
    return {
        windows: [
            {
                window_id: "w-ctrl",
                library_id: DEFAULT_LIBRARY_ID,
                kind: "terminal",
                title: "Control Terminal",
                ordinal: 1,
                label: "",
                prefix: "/terminal",
                token: "",
                persisted: true,
                connected: false,
                holders: [],
                active_transfer: false,
                control: true,
                hidden: false,
                origin: "native",
                start_terminal: false,
            },
            {
                window_id: "w-hidden-ws",
                library_id: DEFAULT_LIBRARY_ID,
                kind: "workspace",
                title: "chan Window 1",
                ordinal: 1,
                label: "",
                workspace_path: "/srv/notes",
                prefix: "/api/notes-1a2b3c",
                token: "",
                persisted: true,
                connected: false,
                holders: [],
                active_transfer: false,
                control: false,
                hidden: true,
                origin: "native",
                start_terminal: true,
            },
        ],
        workspaces: [
            {
                workspace_id: "notes-1a2b3c",
                path: "/srv/notes",
                label: "notes",
                on: true,
                library_id: DEFAULT_LIBRARY_ID,
                devserver_id: null,
                prefix: "notes-1a2b3c",
                status: "running",
            },
        ],
        tmuxConnections: [
            {
                connection: "term/one",
                library_id: DEFAULT_LIBRARY_ID,
                origin: { kind: "terminal", window_id: "w-ctrl" },
                version: "3.4",
                session: { name: "main", id: "$0" },
                windows: [],
                window_cap: 8,
                errors: [],
                control_window: "w-ctrl",
            },
        ],
    };
}

function renderTenantHtml(url) {
    const params = Object.fromEntries(url.searchParams.entries());
    const paramsJson = JSON.stringify(params);
    const currentW = params.w ?? "w-hidden-ws";
    const focusTarget = currentW === "w-ctrl" ? "w-hidden-ws" : "w-ctrl";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Chan E2E Tenant</title>
</head>
<body>
  <main data-testid="tenant-page">
    <h1>Chan E2E Tenant</h1>
    <pre id="query-params">${paramsJson.replace(/</g, "&lt;")}</pre>
    <div id="e2e-actions">
      <button type="button" aria-label="Check native_vocabulary" onclick="invokeCmd('native_vocabulary')">Check native_vocabulary</button>
      <button type="button" aria-label="Focus library window" onclick="invokeCmd('focus_library_window', { windowId: '${focusTarget}' })">Focus library window</button>
      <button type="button" aria-label="Create terminal window" onclick="invokeCmd('create_library_window', { kind: 'terminal', workspaceId: null })">Create terminal window</button>
      <button type="button" aria-label="Open new window" onclick="invokeCmd('open_new_window')">Open new window</button>
      <button type="button" aria-label="All computers..." onclick="invokeCmd('toggle_launcher_panel')">All computers...</button>
      <button type="button" aria-label="Show computers for window" onclick="invokeCmd('show_computers_for_window')">Show computers for window</button>
      <button type="button" aria-label="Reconnect devserver for window" onclick="invokeCmd('reconnect_devserver_for_window')">Reconnect devserver for window</button>
      <button type="button" aria-label="Abandon devserver for window" onclick="invokeCmd('abandon_devserver_for_window')">Abandon devserver for window</button>
      <button type="button" aria-label="Check gateway_csrf_token" onclick="invokeCmd('gateway_csrf_token')">Check gateway_csrf_token</button>
      <button type="button" aria-label="Probe disallowed mobile_deliver_pending_show_card" onclick="invokeCmd('mobile_deliver_pending_show_card')">Probe disallowed mobile_deliver_pending_show_card</button>
    </div>
    <pre id="e2e-result">ready</pre>
  </main>
  <script>
    async function invokeCmd(cmd, args = {}) {
      const out = document.getElementById("e2e-result");
      out.textContent = JSON.stringify({ pending: true, cmd });
      try {
        const invoker = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;
        if (!invoker) throw new Error("no Tauri invoke bridge");
        const res = await invoker(cmd, args);
        out.textContent = JSON.stringify({ ok: true, cmd, res });
      } catch (err) {
        out.textContent = JSON.stringify({ ok: false, cmd, error: String(err) });
      }
    }
  </script>
</body>
</html>`;
}

export const serverExitHooks = new Set();

export function createMockGatewayServer(options = {}) {
    const {
        peerFile = null,
        wireguard: staticWireguard = undefined,
        noWireguard = false,
        autoConfirm = false,
        requireSession = true,
        proxyApexOrigin = null,
        proxyHostTemplate = null,
        ledgerFile = null,
        devserverOnline = true,
        wgPeerBin = null,
        tls = null,
    } = options;

    let dynamicWireguard = null;
    let spawnedWgPeer = null;

    function stopSpawnedWgPeer() {
        if (spawnedWgPeer && !spawnedWgPeer.killed) {
            spawnedWgPeer.kill("SIGTERM");
            spawnedWgPeer = null;
        }
    }

    serverExitHooks.add(stopSpawnedWgPeer);

    async function startWgPeerForClientKey(clientPubKey, mockPort) {
        if (!wgPeerBin) throw new Error("wgPeerBin not configured");
        if (!validWgPublicKey(clientPubKey)) throw new Error("invalid client_public_key");
        stopSpawnedWgPeer();

        const child = spawn(
            wgPeerBin,
            ["--client-key", clientPubKey, "--port", "18089", "--forward", `${mockPort}=127.0.0.1:${mockPort}`],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        spawnedWgPeer = child;

        const readyLine = await new Promise((resolve, reject) => {
            let buf = "";
            const timer = setTimeout(() => reject(new Error("wg-peer ready timeout")), 10_000);
            child.stdout.on("data", (chunk) => {
                buf += chunk.toString("utf8");
                for (const line of buf.split("\n")) {
                    if (line.startsWith("peer: ready ")) {
                        clearTimeout(timer);
                        resolve(line);
                        return;
                    }
                }
            });
            child.stderr.on("data", (chunk) => {
                buf += chunk.toString("utf8");
            });
            child.once("exit", (code) => {
                clearTimeout(timer);
                reject(new Error(`wg-peer exited early with code ${code}: ${buf}`));
            });
        });

        const endpoint = / udp=(127\.0\.0\.1:\d+)(?: |$)/.exec(readyLine)?.[1];
        const serverPub = / public_key=([A-Za-z0-9+/]{43}=)(?: |$)/.exec(readyLine)?.[1];
        if (!endpoint || !serverPub) {
            throw new Error(`unexpected wg-peer ready line: ${readyLine}`);
        }

        const hosts = [
            { name: "p1.localtest.me", addresses: ["10.7.0.2"] },
            { name: "*.p1.localtest.me", addresses: ["10.7.0.2"] },
        ];
        dynamicWireguard = {
            endpoint,
            server_public_key: serverPub,
            addresses: ["10.7.0.1/32"],
            allowed_ips: ["10.7.0.2/32"],
            persistent_keepalive: 5,
            hosts,
            ingresses: [
                {
                    id: "p1",
                    endpoint,
                    server_public_key: serverPub,
                    hosts,
                },
            ],
        };
        return { endpoint, server_public_key: serverPub };
    }

    const state = {
        codes: new Map(),
        consents: new Map(),
        tokens: new Set(),
        entryCreds: new Map(),
        gateSessions: new Map(),
        nextWindowOrdinal: 2,
        ...defaultSeedState(),
        ledger: {
            requests: [],
            navigations: [],
            windowOps: [],
            tmuxRequests: [],
            authorizeCalls: [],
            redeemCalls: [],
            entryCalls: [],
        },
    };

    function flushLedger() {
        if (!ledgerFile) return;
        writeFileSync(
            ledgerFile,
            JSON.stringify(
                {
                    ...state.ledger,
                    windows: state.windows,
                    workspaces: state.workspaces,
                },
                null,
                2,
            ) + "\n",
        );
    }

    function readWireguard() {
        if (noWireguard) return null;
        if (dynamicWireguard) return dynamicWireguard;
        if (peerFile) {
            return JSON.parse(readFileSync(peerFile, "utf8"));
        }
        if (staticWireguard !== undefined) return staticWireguard;
        return {
            endpoint: "127.0.0.1:51820",
            server_public_key: Buffer.alloc(32, 3).toString("base64"),
            addresses: ["10.7.0.1/32"],
            allowed_ips: ["10.7.0.2/32"],
            persistent_keepalive: 5,
            hosts: [
                { name: "p1.localtest.me", addresses: ["10.7.0.2"] },
                { name: "*.p1.localtest.me", addresses: ["10.7.0.2"] },
            ],
            ingresses: [
                {
                    id: "p1",
                    endpoint: "127.0.0.1:51820",
                    server_public_key: Buffer.alloc(32, 3).toString("base64"),
                    hosts: [
                        { name: "p1.localtest.me", addresses: ["10.7.0.2"] },
                        { name: "*.p1.localtest.me", addresses: ["10.7.0.2"] },
                    ],
                },
            ],
        };
    }

    function currentOrigins(req) {
        const addr = server.address();
        const port = addr && typeof addr === "object" ? addr.port : 8080;
        const tlsAddr = tlsServer?.address();
        const tlsPort = tlsAddr && typeof tlsAddr === "object" ? tlsAddr.port : null;
        const identityOrigin = `http://127.0.0.1:${port}`;
        const apex = proxyApexOrigin ?? (tlsPort ? `https://localtest.me:${tlsPort}` : `http://localtest.me:${port}`);
        const apexUrl = new URL(apex);
        const tenantPrefix = `${"alice"}--${DEFAULT_DEVSERVER_ID.slice(0, 12)}.p1`;
        const proxyOrigin = proxyHostTemplate
            ? proxyHostTemplate.replace("{tenant}", tenantPrefix)
            : `${apexUrl.protocol}//${tenantPrefix}.${apexUrl.host}`;
        return { identityOrigin, apex, proxyOrigin, requestHost: req.headers.host ?? "" };
    }

    function json(res, status, body) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    }

    function html(res, status, body) {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
    }

    function bearerToken(req) {
        const auth = req.headers.authorization ?? "";
        if (!auth.startsWith("Bearer ")) return null;
        return auth.slice("Bearer ".length).trim();
    }

    function devserverAuthorized(req, isMutation) {
        if (!requireSession) return true;
        const tok = bearerToken(req);
        if (tok && state.tokens.has(tok)) return true;
        const cookies = parseCookies(req.headers.cookie);
        const gate = cookies["__Host-devserver_gate"];
        if (!gate || !state.gateSessions.has(gate)) return false;
        if (isMutation) {
            const csrfHeader = req.headers["x-chan-csrf"];
            const csrfSession = state.gateSessions.get(gate).csrf;
            if (!csrfHeader || csrfHeader !== csrfSession) return false;
        }
        return true;
    }

    function reset() {
        state.codes.clear();
        state.consents.clear();
        state.tokens.clear();
        state.entryCreds.clear();
        state.gateSessions.clear();
        const seeded = defaultSeedState();
        state.windows = seeded.windows;
        state.workspaces = seeded.workspaces;
        state.tmuxConnections = seeded.tmuxConnections;
        state.nextWindowOrdinal = 2;
        state.ledger = {
            requests: [],
            navigations: [],
            windowOps: [],
            tmuxRequests: [],
            authorizeCalls: [],
            redeemCalls: [],
            entryCalls: [],
        };
        flushLedger();
    }

    function handleDiscovery(req, res) {
        const { identityOrigin, apex } = currentOrigins(req);
        const wg = readWireguard();
        const doc = {
            kind: "chan-gateway",
            api_version: 1,
            identity_origin: identityOrigin,
            mobile_authorize_url: `${identityOrigin}/mobile/authorize`,
            mobile_entry_url: `${identityOrigin}/mobile/v1/devserver/entry`,
            mobile_roster_url: `${identityOrigin}/mobile/v1/devservers`,
            devserver_proxy_origin: apex,
            devserver_proxy_host_depth: 2,
        };
        if (wg) {
            doc.wireguard = {
                mobile_enrollment: true,
                endpoint: wg.endpoint,
                public_key: wg.server_public_key,
                allowed_ips: wg.allowed_ips,
                persistent_keepalive: wg.persistent_keepalive,
                ingresses: wg.ingresses.map(({ server_public_key, ...rest }) => ({
                    ...rest,
                    public_key: server_public_key,
                })),
            };
        }
        return json(res, 200, doc);
    }

    function handleAuthorize(url, res) {
        const p = url.searchParams;
        const redirectUri = p.get("redirect_uri") ?? "";
        const stateNonce = p.get("state") ?? "";
        const label = (p.get("label") ?? "").trim();
        const challenge = p.get("code_challenge") ?? "";
        const method = p.get("code_challenge_method") ?? "";
        const scopes = p.get("scopes") ?? "";
        const expiresIn = Number(p.get("expires_in"));
        const wgKey = p.get("wireguard_public_key");

        state.ledger.authorizeCalls.push({
            redirect_uri: redirectUri,
            state: stateNonce,
            label,
            has_wg_key: wgKey !== null,
        });

        if (!validMobileRedirectUri(redirectUri)) {
            return json(res, 400, { error: "invalid redirect_uri" });
        }
        if (method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
            return json(res, 400, { error: "invalid code_challenge" });
        }
        if (!stateNonce || stateNonce.length > 256 || !/^[\x21-\x7e]+$/.test(stateNonce)) {
            return json(res, 400, { error: "invalid state" });
        }
        if (!label || label.length > 64) {
            return json(res, 400, { error: "invalid label" });
        }
        if (scopes !== "mobile.account") {
            return json(res, 400, { error: "invalid scopes" });
        }
        if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
            return json(res, 400, { error: "invalid expires_in" });
        }
        const wg = readWireguard();
        if (wgKey !== null) {
            if (!validWgPublicKey(wgKey)) {
                return json(res, 400, { error: "invalid wireguard_public_key" });
            }
            if (!wg) {
                return json(res, 400, { error: "wireguard enrollment not offered" });
            }
        }

        if (autoConfirm || p.get("auto") === "1") {
            const code = randomBytes(16).toString("hex");
            state.codes.set(code, {
                challenge,
                label,
                wireguardKey: wgKey,
            });
            flushLedger();
            res.writeHead(302, {
                location: `chan://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateNonce)}`,
            });
            res.end();
            return;
        }

        const consentId = randomBytes(12).toString("hex");
        const csrf = randomBytes(12).toString("hex");
        state.consents.set(consentId, {
            challenge,
            label,
            stateNonce,
            wireguardKey: wgKey,
            csrf,
        });
        flushLedger();
        res.writeHead(302, {
            location: `/mobile/authorize/consent?id=${consentId}`,
        });
        res.end();
    }

    function handleConsent(url, res) {
        const consentId = url.searchParams.get("id") ?? "";
        const pending = state.consents.get(consentId);
        if (!pending) return json(res, 400, { error: "no pending mobile authorize" });
        return html(
            res,
            200,
            `<!doctype html><html><body><form method="post" action="/mobile/authorize/confirm">` +
                `<input type="hidden" name="id" value="${consentId}">` +
                `<input type="hidden" name="csrf" value="${pending.csrf}">` +
                `<button type="submit" name="action" value="allow">Allow</button>` +
                `<button type="submit" name="action" value="deny">Deny</button>` +
                `</form></body></html>`,
        );
    }

    function handleConfirm(body, res) {
        const form = new URLSearchParams(body);
        const consentId = form.get("id") ?? "";
        const csrf = form.get("csrf") ?? "";
        const action = form.get("action") ?? "";
        const pending = state.consents.get(consentId);
        state.consents.delete(consentId);
        if (!pending) return json(res, 400, { error: "no pending mobile authorize" });
        if (csrf !== pending.csrf) return json(res, 400, { error: "csrf mismatch" });
        if (action === "allow") {
            const code = randomBytes(16).toString("hex");
            state.codes.set(code, {
                challenge: pending.challenge,
                label: pending.label,
                wireguardKey: pending.wireguardKey,
            });
            const target = `chan://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(pending.stateNonce)}`;
            flushLedger();
            return html(
                res,
                200,
                `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${target}"></head></html>`,
            );
        }
        if (action === "deny") {
            const target = `chan://auth/callback?error=user_cancelled&state=${encodeURIComponent(pending.stateNonce)}`;
            flushLedger();
            return html(
                res,
                200,
                `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${target}"></head></html>`,
            );
        }
        return json(res, 400, { error: "invalid action" });
    }

    function handleRedeem(body, res) {
        let reqBody = {};
        try {
            reqBody = JSON.parse(body || "{}");
        } catch {
            return json(res, 400, { error: "invalid json" });
        }
        const code = typeof reqBody.code === "string" ? reqBody.code : "";
        const verifier = typeof reqBody.code_verifier === "string" ? reqBody.code_verifier : "";
        const grant = state.codes.get(code);
        state.codes.delete(code);

        state.ledger.redeemCalls.push({ code_present: Boolean(code), matched: Boolean(grant) });
        if (!grant || sha256Base64Url(verifier) !== grant.challenge) {
            flushLedger();
            return json(res, 410, { error: "unknown, expired, or already-redeemed code" });
        }
        const secret = `pat-${randomBytes(18).toString("base64url")}`;
        state.tokens.add(secret);
        const answer = {
            id: "00000000-0000-4000-8000-000000000099",
            secret,
            label: grant.label,
            expires_at: null,
        };
        if (grant.wireguardKey !== null) {
            const wg = readWireguard();
            if (!wg) return json(res, 400, { error: "wireguard enrollment not offered" });
            answer.wireguard = wg;
        }
        flushLedger();
        return json(res, 200, answer);
    }

    function handleRoster(req, res) {
        const tok = bearerToken(req);
        if (!tok || !state.tokens.has(tok)) {
            return json(res, 401, { error: "unauthorized" });
        }
        const { proxyOrigin } = currentOrigins(req);
        return json(res, 200, {
            user_id: DEFAULT_USER_ID,
            username: "alice",
            devservers: [
                {
                    owner_user_id: DEFAULT_USER_ID,
                    owner: "alice",
                    devserver_id: DEFAULT_DEVSERVER_ID,
                    label: "e2e-box",
                    online: devserverOnline,
                    proxy_origin: proxyOrigin,
                },
            ],
        });
    }

    function handleEntryMint(req, body, res) {
        const tok = bearerToken(req);
        if (!tok || !state.tokens.has(tok)) {
            return json(res, 401, { error: "unauthorized" });
        }
        let payload = {};
        try {
            payload = JSON.parse(body || "{}");
        } catch {
            return json(res, 400, { error: "invalid json" });
        }
        const requestedPath = typeof payload.path === "string" && payload.path.startsWith("/") ? payload.path : "/";
        const dsId = payload.devserver_id ?? DEFAULT_DEVSERVER_ID;
        if (dsId !== DEFAULT_DEVSERVER_ID) {
            return json(res, 404, { error: "devserver not found" });
        }
        const { proxyOrigin } = currentOrigins(req);
        const cred = `cred-${randomBytes(16).toString("hex")}`;
        state.entryCreds.set(cred, { requestedPath });
        state.ledger.entryCalls.push({ path: requestedPath, devserver_id: dsId });
        flushLedger();
        return json(res, 200, {
            owner_user_id: DEFAULT_USER_ID,
            username: "alice",
            devserver_id: dsId,
            proxy_origin: proxyOrigin,
            entry_exchange_url: `${proxyOrigin}/_chan/entry`,
            entry_credential: cred,
        });
    }

    function handleEntryExchange(req, body, res) {
        let cred = "";
        const contentType = String(req.headers["content-type"] ?? "");
        if (contentType.includes("application/json")) {
            try {
                cred = JSON.parse(body || "{}").credential ?? "";
            } catch {
                cred = "";
            }
        } else {
            cred = new URLSearchParams(body).get("credential") ?? "";
        }
        const item = state.entryCreds.get(cred);
        state.entryCreds.delete(cred);
        if (!item) {
            return json(res, 401, { error: "invalid entry credential" });
        }
        const gate = `gate-${randomBytes(12).toString("hex")}`;
        const csrf = `csrf-${randomBytes(12).toString("hex")}`;
        const secureAttr = req.socket?.encrypted ? "; Secure" : "";
        state.gateSessions.set(gate, { csrf });
        flushLedger();
        res.writeHead(303, {
            location: item.requestedPath,
            "set-cookie": [
                `__Host-devserver_gate=${gate}; Path=/; HttpOnly; SameSite=Lax${secureAttr}`,
                `__Host-devserver_csrf=${csrf}; Path=/; SameSite=Lax${secureAttr}`,
            ],
        });
        res.end();
    }

    function handleRequest(req, res) {
        const { identityOrigin, proxyOrigin } = currentOrigins(req);
        const baseOrigin = req.socket?.encrypted ? proxyOrigin : identityOrigin;
        const rawUrl = req.url ?? "/";
        const url = new URL(rawUrl, baseOrigin);
        const method = req.method ?? "GET";
        const route = `${method} ${url.pathname}`;

        state.ledger.requests.push({
            method,
            path: url.pathname,
            query: url.search,
            host: req.headers.host ?? "",
        });

        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            try {
                if (route === "GET /.well-known/chan-gateway") return handleDiscovery(req, res);
                if (route === "GET /mobile/authorize") return handleAuthorize(url, res);
                if (route === "GET /mobile/authorize/consent") return handleConsent(url, res);
                if (route === "POST /mobile/authorize/confirm") return handleConfirm(body, res);
                if (route === "POST /mobile/authorize/redeem") return handleRedeem(body, res);
                if (route === "DELETE /mobile/v1/token") {
                    const tok = bearerToken(req);
                    if (!tok || !state.tokens.delete(tok)) return json(res, 401, { error: "unauthorized" });
                    res.writeHead(204);
                    return res.end();
                }
                if (route === "GET /mobile/v1/devservers") return handleRoster(req, res);
                if (route === "POST /mobile/v1/devserver/entry") return handleEntryMint(req, body, res);
                if (route === "POST /_chan/entry") return handleEntryExchange(req, body, res);

                if (route === "GET /_test/ledger") {
                    return json(res, 200, {
                        ...state.ledger,
                        windows: state.windows,
                        workspaces: state.workspaces,
                    });
                }
                if (route === "POST /_test/reset") {
                    reset();
                    return json(res, 200, { ok: true });
                }
                if (route === "POST /_test/seed") {
                    const seed = JSON.parse(body || "{}");
                    if (Array.isArray(seed.windows)) state.windows = seed.windows;
                    if (Array.isArray(seed.workspaces)) state.workspaces = seed.workspaces;
                    if (Array.isArray(seed.tmuxConnections)) state.tmuxConnections = seed.tmuxConnections;
                    if (seed.token) state.tokens.add(seed.token);
                    flushLedger();
                    return json(res, 200, { ok: true });
                }
                if (route === "POST /_test/start-wg-peer") {
                    const reqBody = JSON.parse(body || "{}");
                    const forwardPort = tlsServer?.address()?.port ?? server.address()?.port ?? 8080;
                    startWgPeerForClientKey(reqBody.client_public_key, forwardPort)
                        .then((info) => json(res, 200, { ok: true, ...info }))
                        .catch((err) => json(res, 500, { error: err.message }));
                    return;
                }

                // Devserver / library endpoints
                const isMutation = method !== "GET" && method !== "HEAD";
                if (
                    url.pathname === "/" ||
                    url.pathname.startsWith("/api/") ||
                    url.pathname.startsWith("/terminal/")
                ) {
                    if (!devserverAuthorized(req, isMutation)) {
                        return json(res, 401, { error: "unauthorized devserver caller" });
                    }
                }

                if (route === "GET /") {
                    flushLedger();
                    return html(
                        res,
                        200,
                        '<!doctype html><html><head><meta charset="utf-8"><meta name="chan-launcher-host-os" content="linux"></head><body>Launcher Shell</body></html>',
                    );
                }

                if (route === "GET /api/library/local-color") {
                    flushLedger();
                    return json(res, 200, { color: "#3b82f6" });
                }

                if (
                    route === "GET /api/library/workspaces" ||
                    route === "GET /api/devserver/workspaces"
                ) {
                    flushLedger();
                    return json(res, 200, state.workspaces);
                }

                const wsToggle = /^\/api\/library\/workspaces\/([^/]+)\/(on|off)$/.exec(url.pathname);
                if (method === "POST" && wsToggle) {
                    const [, slug, op] = wsToggle;
                    const ws = state.workspaces.find((w) => w.prefix === slug || w.workspace_id === slug);
                    if (!ws) return json(res, 404, { error: "workspace not found" });
                    ws.on = op === "on";
                    ws.status = ws.on ? "running" : "stopped";
                    flushLedger();
                    return json(res, 200, ws);
                }

                const wsDel = /^\/api\/library\/workspaces\/([^/]+)$/.exec(url.pathname);
                if (method === "DELETE" && wsDel) {
                    const slug = wsDel[1];
                    const before = state.workspaces.length;
                    state.workspaces = state.workspaces.filter((w) => w.prefix !== slug && w.workspace_id !== slug);
                    flushLedger();
                    if (state.workspaces.length === before) return json(res, 404, { error: "workspace not found" });
                    res.writeHead(204);
                    return res.end();
                }

                if (route === "GET /api/library/windows") {
                    flushLedger();
                    return json(res, 200, state.windows);
                }

                if (route === "POST /api/library/windows") {
                    const reqBody = JSON.parse(body || "{}");
                    const kind = reqBody.kind === "workspace" ? "workspace" : "terminal";
                    const ordinal = state.nextWindowOrdinal++;
                    const win = {
                        window_id: `w-${ordinal}`,
                        library_id: DEFAULT_LIBRARY_ID,
                        kind,
                        title: kind === "workspace" ? `chan Window ${ordinal}` : `Terminal Window ${ordinal}`,
                        ordinal,
                        label: "",
                        workspace_path: kind === "workspace" ? reqBody.workspace_path ?? "/srv/notes" : undefined,
                        prefix: kind === "workspace" ? "/api/notes-1a2b3c" : "/terminal",
                        token: "",
                        persisted: true,
                        connected: false,
                        holders: [],
                        active_transfer: false,
                        control: false,
                        hidden: false,
                        origin: reqBody.origin ?? "native",
                        start_terminal: Boolean(reqBody.start_terminal),
                    };
                    state.windows.push(win);
                    state.ledger.windowOps.push({ op: "create", window_id: win.window_id, kind });
                    flushLedger();
                    return json(res, 200, win);
                }

                const visMatch = /^\/api\/library\/windows\/([^/]+)\/visibility$/.exec(url.pathname);
                if (method === "POST" && visMatch) {
                    const id = decodeURIComponent(visMatch[1]);
                    const win = state.windows.find((w) => w.window_id === id);
                    if (!win) return json(res, 404, { error: "window not found" });
                    const reqBody = JSON.parse(body || "{}");
                    if (typeof reqBody.hidden !== "boolean") {
                        return json(res, 400, { error: "hidden must be boolean" });
                    }
                    win.hidden = reqBody.hidden;
                    state.ledger.windowOps.push({ op: "visibility", window_id: id, hidden: win.hidden });
                    flushLedger();
                    res.writeHead(204);
                    return res.end();
                }

                const labelMatch = /^\/api\/library\/windows\/([^/]+)\/label$/.exec(url.pathname);
                if (method === "PUT" && labelMatch) {
                    const id = decodeURIComponent(labelMatch[1]);
                    const win = state.windows.find((w) => w.window_id === id);
                    if (!win) return json(res, 404, { error: "window not found" });
                    if (win.control) {
                        return json(res, 400, { error: "control terminals cannot have a label" });
                    }
                    const reqBody = JSON.parse(body || "{}");
                    const trimmed = String(reqBody.label ?? "").trim();
                    if ([...trimmed].length > 64) {
                        return json(res, 400, { error: "window label must be 64 characters or fewer" });
                    }
                    if (hasControlChars(trimmed)) {
                        return json(res, 400, { error: "window label cannot contain control characters" });
                    }
                    win.label = trimmed;
                    state.ledger.windowOps.push({ op: "label", window_id: id, label: trimmed });
                    flushLedger();
                    res.writeHead(204);
                    return res.end();
                }

                const winDel = /^\/api\/library\/windows\/([^/]+)$/.exec(url.pathname);
                if (method === "DELETE" && winDel) {
                    const id = decodeURIComponent(winDel[1]);
                    const before = state.windows.length;
                    state.windows = state.windows.filter((w) => w.window_id !== id);
                    state.ledger.windowOps.push({
                        op: "delete",
                        window_id: id,
                        deleted: state.windows.length < before,
                    });
                    flushLedger();
                    if (state.windows.length === before) return json(res, 404, { error: "window not found" });
                    res.writeHead(204);
                    return res.end();
                }

                if (route === "GET /api/library/tmux") {
                    flushLedger();
                    return json(res, 200, state.tmuxConnections);
                }

                const tmuxMatch = /^\/api\/library\/tmux\/([^/]+)\/request$/.exec(url.pathname);
                if (method === "POST" && tmuxMatch) {
                    const rawSegment = tmuxMatch[1];
                    let connId;
                    try {
                        connId = decodeURIComponent(rawSegment);
                    } catch {
                        return json(res, 400, { error: "malformed tmux connection segment" });
                    }
                    let reqBody;
                    try {
                        reqBody = JSON.parse(body || "");
                    } catch {
                        return json(res, 400, { error: "invalid tmux request json" });
                    }
                    if (!reqBody || typeof reqBody.request !== "string" || !TMUX_REQUEST_KINDS.has(reqBody.request)) {
                        return json(res, 400, { error: "unsupported tmux request kind" });
                    }
                    const found = state.tmuxConnections.some((c) => c.connection === connId);
                    if (!found) return json(res, 404, { error: "tmux connection not found" });
                    state.ledger.tmuxRequests.push({
                        rawSegment,
                        connection: connId,
                        request: reqBody,
                    });
                    flushLedger();
                    res.writeHead(204);
                    return res.end();
                }

                if (
                    method === "GET" &&
                    (url.pathname === "/terminal/index.html" ||
                        /^\/api\/[^/]+\/index\.html$/.test(url.pathname))
                ) {
                    const params = Object.fromEntries(url.searchParams.entries());
                    state.ledger.navigations.push({
                        path: url.pathname,
                        url: url.toString(),
                        params,
                    });
                    flushLedger();
                    return html(res, 200, renderTenantHtml(url));
                }

                flushLedger();
                res.writeHead(404);
                res.end("mock-gateway: unknown route");
            } catch (error) {
                json(res, 500, { error: error.message });
            }
        });
    }

    const server = http.createServer(handleRequest);
    const tlsServer = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handleRequest) : null;
    if (tlsServer) {
        server.on("close", () => tlsServer.close());
    }

    return { server, tlsServer, state, reset };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const args = process.argv.slice(2);
    let port = 0;
    let peerFile = null;
    let ledgerFile = null;
    let autoConfirm = false;
    let requireSession = true;
    let proxyApexOrigin = null;
    let proxyHostTemplate = null;
    let wgPeerBin = null;
    let tlsCert = null;
    let tlsKey = null;

    for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === "--port") port = Number(args[++i]);
        else if (a === "--peer-file") peerFile = args[++i];
        else if (a === "--ledger") ledgerFile = args[++i];
        else if (a === "--auto-confirm") autoConfirm = true;
        else if (a === "--no-session-auth") requireSession = false;
        else if (a === "--proxy-apex") proxyApexOrigin = args[++i];
        else if (a === "--proxy-host-template") proxyHostTemplate = args[++i];
        else if (a === "--wg-peer-bin") wgPeerBin = args[++i];
        else if (a === "--tls-cert") tlsCert = args[++i];
        else if (a === "--tls-key") tlsKey = args[++i];
        else {
            console.error(`unknown option: ${a}`);
            process.exit(2);
        }
    }

    if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
        console.error("--tls-cert and --tls-key must be provided together");
        process.exit(2);
    }

    const tls = tlsCert && tlsKey ? { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) } : null;
    const { server, tlsServer } = createMockGatewayServer({
        peerFile,
        ledgerFile,
        autoConfirm,
        requireSession,
        proxyApexOrigin,
        proxyHostTemplate,
        wgPeerBin,
        tls,
    });
    const cleanupHooks = () => {
        for (const fn of serverExitHooks) fn();
    };
    process.on("SIGTERM", () => {
        cleanupHooks();
        process.exit(0);
    });
    process.on("SIGINT", () => {
        cleanupHooks();
        process.exit(0);
    });
    process.on("exit", cleanupHooks);
    server.listen(port, "127.0.0.1", () => {
        const bound = server.address();
        if (tlsServer) {
            tlsServer.listen(0, "127.0.0.1", () => {
                const tlsBound = tlsServer.address();
                console.log(
                    `mock-gateway: ready origin=http://127.0.0.1:${bound.port} proxy_origin=https://localtest.me:${tlsBound.port}`,
                );
            });
        } else {
            console.log(`mock-gateway: ready origin=http://127.0.0.1:${bound.port}`);
        }
    });
}
