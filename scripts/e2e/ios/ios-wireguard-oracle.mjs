// Evidence parsers and contract oracles for iOS WireGuard and remote window E2E suites.
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const B64_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const HEX_32_RE = /^[0-9a-f]{32}$/;

export function parsePeerReady(logText) {
    const lines = String(logText)
        .split("\n")
        .filter((line) => line.startsWith("peer: ready "));
    assert.equal(lines.length, 1, "peer log must contain exactly one peer: ready line");
    const line = lines[0];
    assert.ok(line.includes("url=http://10.7.0.2:"), "peer must bind inner tunnel address 10.7.0.2");
    const endpoint = / udp=(127\.0\.0\.1:\d+)(?: |$)/.exec(line)?.[1];
    const public_key = / public_key=([A-Za-z0-9+/]{43}=)(?: |$)/.exec(line)?.[1];
    assert.ok(endpoint && B64_KEY_RE.test(public_key ?? ""), "peer ready line lacks UDP endpoint or public_key");
    return { endpoint, public_key };
}

export function buildPeerFixture(peers, domain = "wg-e2e.invalid") {
    assert.ok(Array.isArray(peers) && peers.length >= 2, "fixture requires at least two peers");
    assert.equal(new Set(peers.map((p) => p.endpoint)).size, peers.length, "peer UDP endpoints must be distinct");
    assert.equal(new Set(peers.map((p) => p.public_key)).size, peers.length, "peer public keys must be distinct");

    const ingresses = peers.map((peer, idx) => ({
        id: `p${idx + 1}`,
        endpoint: peer.endpoint,
        server_public_key: peer.public_key,
        hosts: [
            { name: `p${idx + 1}.${domain}`, addresses: ["10.7.0.2"] },
            { name: `*.p${idx + 1}.${domain}`, addresses: ["10.7.0.2"] },
        ],
    }));

    return {
        endpoint: ingresses[0].endpoint,
        server_public_key: ingresses[0].server_public_key,
        addresses: ["10.7.0.1/32"],
        allowed_ips: ["10.7.0.2/32"],
        persistent_keepalive: 5,
        hosts: ingresses[0].hosts,
        ingresses,
    };
}

export function parsePeerRequests(logText) {
    return String(logText)
        .split("\n")
        .filter((line) => line.startsWith("request: "));
}

export function verifyPeerRouting(beforeByPeer, afterByPeer, expectedPeer, pathFragment) {
    const keysBefore = Object.keys(beforeByPeer).sort();
    const keysAfter = Object.keys(afterByPeer).sort();
    assert.deepEqual(keysAfter, keysBefore, "route oracle must inspect the same peer set");
    assert.ok(keysAfter.length >= 2, "route oracle requires at least two peers");
    assert.ok(expectedPeer === "none" || expectedPeer in afterByPeer, "expected peer not in logs");

    for (const [id, lines] of Object.entries(afterByPeer)) {
        const prior = beforeByPeer[id];
        assert.deepEqual(lines.slice(0, prior.length), prior, `peer ${id} log mutated historical entries`);
        const fresh = lines.slice(prior.length).filter((line) => line.includes(pathFragment));
        if (id === expectedPeer) {
            assert.ok(fresh.length > 0, `expected ${pathFragment} to reach ${id}`);
            assert.ok(
                fresh.every((line) => /^request: from=10\.7\.0\.1:\d+ line=/.test(line)),
                `traffic on ${id} did not originate from tunnel client address 10.7.0.1`,
            );
        } else {
            assert.equal(fresh.length, 0, `traffic ${pathFragment} leaked to wrong peer ${id}`);
        }
    }
}

export function verifyEnrollmentRedeemMatch(discoveryDoc, redeemPayload) {
    assert.equal(discoveryDoc?.kind, "chan-gateway", "discovery kind must be chan-gateway");
    assert.equal(discoveryDoc?.api_version, 1, "discovery api_version must be 1");
    assert.equal(discoveryDoc?.devserver_proxy_host_depth, 2, "proxy host depth must be 2");
    for (const field of ["mobile_authorize_url", "mobile_entry_url", "mobile_roster_url"]) {
        assert.ok(typeof discoveryDoc[field] === "string" && discoveryDoc[field].length > 0, `missing ${field}`);
    }
    const discWg = discoveryDoc?.wireguard;
    const redWg = redeemPayload?.wireguard;
    assert.ok(discWg && discWg.mobile_enrollment === true, "discovery must advertise wireguard.mobile_enrollment=true");
    assert.ok(redWg, "redeem payload must contain wireguard parameters");
    assert.equal(redWg.endpoint, discWg.endpoint, "redeem endpoint must match discovery");
    assert.equal(redWg.server_public_key, discWg.public_key, "redeem server_public_key must match discovery");
    assert.deepEqual(redWg.allowed_ips, discWg.allowed_ips, "redeem allowed_ips must match discovery");
    assert.equal(redWg.persistent_keepalive, discWg.persistent_keepalive, "redeem persistent_keepalive must match discovery");
    assert.deepEqual(
        redWg.ingresses.map(({ server_public_key, ...rest }) => ({ ...rest, public_key: server_public_key })),
        discWg.ingresses,
        "redeem ingresses must match discovery ingresses",
    );
}

export function verifyWindowNavigationParams(rawUrl, spec) {
    const url = new URL(rawUrl);
    const p = url.searchParams;

    assert.equal(p.get("w"), spec.windowId, "w param must match window_id");
    assert.match(p.get("h") ?? "", HEX_32_RE, "h param must be a 32-char lowercase hex holder tag");

    if (spec.kind === "workspace") {
        assert.equal(p.get("kind"), null, "workspace window must omit kind");
        assert.equal(p.get("seed"), null, "workspace window must omit seed");
        if (spec.startTerminal) {
            assert.equal(p.get("start"), "terminal", "workspace with start_terminal must stamp start=terminal");
        } else {
            assert.equal(p.get("start"), null, "workspace without start_terminal must omit start");
        }
    } else if (spec.kind === "control") {
        assert.equal(p.get("kind"), "control", "control terminal must stamp kind=control");
        assert.equal(p.get("start"), null, "control terminal must omit start");
    } else if (spec.kind === "terminal") {
        assert.equal(p.get("kind"), "terminal", "terminal window must stamp kind=terminal");
        assert.equal(p.get("start"), null, "terminal window must omit start");
        if (spec.tmux) {
            assert.equal(p.get("seed"), "0", "tmux terminal must stamp seed=0");
        } else {
            assert.equal(p.get("seed"), null, "plain terminal must omit seed");
        }
    } else {
        assert.fail(`unknown expected kind: ${spec.kind}`);
    }

    if (spec.libraryId) {
        assert.equal(p.get("lib"), spec.libraryId, "lib param must match library_id");
    }
    if (spec.clientName) {
        const names = p.getAll("client_name");
        assert.deepEqual(names, [spec.clientName], "client_name must be replaced cleanly without duplicates");
    } else {
        assert.equal(p.get("client_name"), null, "client_name must be omitted when empty or unset");
    }
    if (spec.pane) {
        assert.equal(p.get("pane"), spec.pane, "pane color param must match");
    }
    if (spec.preservedToken) {
        assert.equal(p.get("t"), spec.preservedToken, "existing raw query token t must be preserved");
    }
}

export function verifyStoppedTunnelView(gatewayRow, expectedStoppedIngressId) {
    assert.ok(gatewayRow, "gateway row must exist");
    assert.equal(
        gatewayRow.wireguard_status,
        "stopped; connect the gateway again",
        "stopped gateway view must report stopped message",
    );
    if (expectedStoppedIngressId) {
        const ing = (gatewayRow.wireguard_ingresses ?? []).find((x) => x.id === expectedStoppedIngressId);
        assert.ok(ing && ing.status === "stopped", `ingress ${expectedStoppedIngressId} must report stopped`);
    }
}

function main([cmd, ...args]) {
    if (cmd === "peer-ready") {
        const info = parsePeerReady(readFileSync(args[0], "utf8"));
        console.log(JSON.stringify(info));
    } else if (cmd === "fixture") {
        const [outFile, domain, ...logs] = args;
        const peers = logs.map((p) => parsePeerReady(readFileSync(p, "utf8")));
        const data = buildPeerFixture(peers, domain);
        writeFileSync(`${outFile}.new`, JSON.stringify(data) + "\n");
        renameSync(`${outFile}.new`, outFile);
    } else if (cmd === "window-url") {
        verifyWindowNavigationParams(args[0], JSON.parse(args[1]));
    } else if (cmd === "enrollment-match") {
        verifyEnrollmentRedeemMatch(
            JSON.parse(readFileSync(args[0], "utf8")),
            JSON.parse(readFileSync(args[1], "utf8")),
        );
    } else {
        throw new Error(
            "usage: ios-wireguard-oracle.mjs peer-ready LOG | fixture OUT DOMAIN LOG... | window-url URL SPEC_JSON | enrollment-match DISC_JSON REDEEM_JSON",
        );
    }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(`ios-wireguard-oracle: ${error.message.split("\n")[0]}`);
        process.exitCode = 1;
    }
}
