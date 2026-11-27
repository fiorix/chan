import assert from "node:assert/strict";
import test from "node:test";
import {
    buildPeerFixture,
    parsePeerReady,
    verifyEnrollmentRedeemMatch,
    verifyPeerRouting,
    verifyStoppedTunnelView,
    verifyWindowNavigationParams,
} from "./ios-wireguard-oracle.mjs";

const p1 = { endpoint: "127.0.0.1:51001", public_key: Buffer.alloc(32, 1).toString("base64") };
const p2 = { endpoint: "127.0.0.1:51002", public_key: Buffer.alloc(32, 2).toString("base64") };

test("peerReady and buildPeerFixture validate peer identities and refuse duplicates", () => {
    const parsed = parsePeerReady(
        `peer: ready url=http://10.7.0.2:8080 udp=${p1.endpoint} public_key=${p1.public_key} forward=10.7.0.2:8080->127.0.0.1:9000\n`,
    );
    assert.deepEqual(parsed, p1);
    const fixture = buildPeerFixture([p1, p2]);
    assert.equal(fixture.ingresses.length, 2);
    assert.throws(() => buildPeerFixture([p1]), /at least two/);
    assert.throws(() => buildPeerFixture([p1, { ...p2, endpoint: p1.endpoint }]), /distinct/);
    assert.throws(() => buildPeerFixture([p1, { ...p2, public_key: p1.public_key }]), /distinct/);
    assert.throws(() => parsePeerReady("peer: ready url=http://10.7.0.9:8080"), /10\.7\.0\.2/);
});

test("verifyPeerRouting catches leaked, missing, and non-tunnel traffic", () => {
    const req = "request: from=10.7.0.1:5555 line=GET /api/library/windows?via=p2 HTTP/1.1";
    const before = { p1: [req], p2: [] };
    verifyPeerRouting(before, { p1: [req], p2: [req] }, "p2", "/api/library/windows?via=p2");
    verifyPeerRouting(before, before, "none", "/api/library/windows?via=p2");
    assert.throws(() => verifyPeerRouting(before, before, "p2", "via=p2"), /to reach/);
    assert.throws(() => verifyPeerRouting(before, { p1: [req, req], p2: [req] }, "p2", "HTTP/1.1"), /wrong peer p1/);
    assert.throws(
        () => verifyPeerRouting(before, { p1: [req], p2: [req.replace("10.7.0.1", "127.0.0.1")] }, "p2", "via=p2"),
        /tunnel client address/,
    );
});

test("verifyEnrollmentRedeemMatch rejects discovery/redeem skew", () => {
    const fixture = buildPeerFixture([p1, p2]);
    const discovery = {
        kind: "chan-gateway",
        api_version: 1,
        devserver_proxy_host_depth: 2,
        mobile_authorize_url: "http://127.0.0.1:9000/mobile/authorize",
        mobile_entry_url: "http://127.0.0.1:9000/mobile/v1/devserver/entry",
        mobile_roster_url: "http://127.0.0.1:9000/mobile/v1/devservers",
        wireguard: {
            mobile_enrollment: true,
            endpoint: fixture.endpoint,
            public_key: fixture.server_public_key,
            allowed_ips: fixture.allowed_ips,
            persistent_keepalive: fixture.persistent_keepalive,
            ingresses: fixture.ingresses.map(({ server_public_key, ...rest }) => ({
                ...rest,
                public_key: server_public_key,
            })),
        },
    };
    const redeem = { wireguard: structuredClone(fixture) };
    verifyEnrollmentRedeemMatch(discovery, redeem);

    const skewed = structuredClone(redeem);
    skewed.wireguard.ingresses[1].endpoint = "127.0.0.1:59999";
    assert.throws(() => verifyEnrollmentRedeemMatch(discovery, skewed), /must match discovery/);

    const noEnroll = structuredClone(discovery);
    noEnroll.wireguard.mobile_enrollment = false;
    assert.throws(() => verifyEnrollmentRedeemMatch(noEnroll, redeem), /mobile_enrollment=true/);
});

test("verifyWindowNavigationParams enforces R3 query params and detects missing/mutated params", () => {
    const h = "0123456789abcdef0123456789abcdef";
    verifyWindowNavigationParams(
        `http://alice--0123456789ab.p1.localtest.me:9000/api/notes/index.html?w=w-1&lib=lib-1&h=${h}&start=terminal&client_name=ipad&pane=%233b82f6`,
        {
            windowId: "w-1",
            kind: "workspace",
            startTerminal: true,
            libraryId: "lib-1",
            clientName: "ipad",
            pane: "#3b82f6",
        },
    );
    verifyWindowNavigationParams(
        `http://alice--0123456789ab.p1.localtest.me:9000/terminal/index.html?w=w-2&kind=terminal&seed=0&lib=lib-1&h=${h}`,
        { windowId: "w-2", kind: "terminal", tmux: true, libraryId: "lib-1" },
    );
    verifyWindowNavigationParams(
        `http://alice--0123456789ab.p1.localtest.me:9000/terminal/index.html?w=w-3&kind=control&h=${h}`,
        { windowId: "w-3", kind: "control" },
    );

    assert.throws(
        () =>
            verifyWindowNavigationParams(`http://x.localtest.me/api/notes/index.html?h=${h}`, {
                windowId: "w-1",
                kind: "workspace",
            }),
        /w param/,
    );
    assert.throws(
        () =>
            verifyWindowNavigationParams(`http://x.localtest.me/api/notes/index.html?w=w-1&kind=terminal&h=${h}`, {
                windowId: "w-1",
                kind: "workspace",
            }),
        /omit kind/,
    );
    assert.throws(
        () =>
            verifyWindowNavigationParams(`http://x.localtest.me/terminal/index.html?w=w-2&kind=terminal&h=${h}`, {
                windowId: "w-2",
                kind: "terminal",
                tmux: true,
            }),
        /seed=0/,
    );
    assert.throws(
        () =>
            verifyWindowNavigationParams(
                `http://x.localtest.me/api/notes/index.html?w=w-1&h=${h}&client_name=attacker`,
                { windowId: "w-1", kind: "workspace" },
            ),
        /client_name must be omitted/,
    );
    assert.throws(
        () =>
            verifyWindowNavigationParams(
                `http://x.localtest.me/api/notes/index.html?w=w-1&h=${h}&client_name=attacker`,
                { windowId: "w-1", kind: "workspace", clientName: "" },
            ),
        /client_name must be omitted/,
    );
    assert.throws(
        () =>
            verifyWindowNavigationParams(
                `http://x.localtest.me/api/notes/index.html?w=w-1&h=${h}&client_name=attacker&client_name=ipad`,
                { windowId: "w-1", kind: "workspace", clientName: "ipad" },
            ),
        /without duplicates/,
    );
});

test("verifyStoppedTunnelView validates stopped status string", () => {
    verifyStoppedTunnelView(
        {
            wireguard_status: "stopped; connect the gateway again",
            wireguard_ingresses: [
                { id: "p1", status: "stopped; connect the gateway again" },
                { id: "p2", status: "connected" },
            ],
        },
        "p1",
    );
    assert.throws(
        () =>
            verifyStoppedTunnelView(
                {
                    wireguard_status: "connecting",
                    wireguard_ingresses: [{ id: "p1", status: "connected" }],
                },
                "p1",
            ),
        /stopped gateway view/,
    );
    assert.throws(
        () =>
            verifyStoppedTunnelView(
                {
                    wireguard_status: "stopped; connect the gateway again",
                    wireguard_ingresses: [
                        { id: "p1", status: "stopped" },
                        { id: "p2", status: "connected" },
                    ],
                },
                "p1",
            ),
        /must report stopped; connect the gateway again/,
    );
    assert.throws(
        () =>
            verifyStoppedTunnelView(
                {
                    wireguard_status: "stopped; connect the gateway again",
                    wireguard_ingresses: [
                        { id: "p1", status: "connected" },
                        { id: "p2", status: "stopped; connect the gateway again" },
                    ],
                },
                "p1",
            ),
        /must report stopped; connect the gateway again/,
    );
});
