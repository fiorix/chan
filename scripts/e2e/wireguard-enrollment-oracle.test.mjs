import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observed, parameters, peerReady, privateKeyUnique, projected, routed, started, stored } from "./wireguard-enrollment-oracle.mjs";

const clone = structuredClone;
const peers = [1, 2, 3].map((n) => ({
    endpoint: `127.0.0.1:${40000 + n}`, public_key: Buffer.alloc(32, n).toString("base64"),
}));
const fixture = parameters(peers.slice(0, 2));
const keyFile = "/test/chan-home/desktop/wireguard/gw-e2e00001.key";
const id = "gw-e2e00001";
const config = { gateways: [{ id, wireguard_enrollment: {
    key_file: keyFile, addresses: ["10.7.0.1/32"], allowed_ips: ["10.7.0.2/32"], persistent_keepalive: 5,
    ingresses: [1, 2].map((n) => ({
        id: `p${n}`, endpoint: peers[n - 1].endpoint, public_key: peers[n - 1].public_key,
        hosts: ["", "*."].map((prefix) => ({ name: `${prefix}p${n}.proxy.chan-e2e.invalid`, addresses: ["10.7.0.2"] })),
    })),
} }] };
const rows = [{ id, status: "connected", wireguard_enrolled: true, wireguard_status: "up",
    wireguard_ingresses: [{ id: "p1", status: "up" }, { id: "p2", status: "up" }] }];

test("fixture pins a shared inner endpoint and distinct outer endpoints and keys", () => {
    assert.deepEqual(peerReady(`peer: ready url=http://10.7.0.2:8080 udp=${peers[0].endpoint} public_key=${peers[0].public_key}\n`), peers[0]);
    assert.equal(fixture.endpoint, peers[0].endpoint);
    assert.equal(fixture.server_public_key, peers[0].public_key);
    assert.deepEqual(fixture.hosts, config.gateways[0].wireguard_enrollment.ingresses[0].hosts);
    assert.equal(parameters(peers).ingresses.length, 3);
    assert.throws(() => parameters([peers[0]]), /at least two/);
    assert.throws(() => parameters([peers[0], { ...peers[1], endpoint: peers[0].endpoint }]), /endpoints must differ/);
    assert.throws(() => parameters([peers[0], { ...peers[1], public_key: peers[0].public_key }]), /keys must differ/);
    assert.throws(() => peerReady(`peer: ready url=http://10.7.0.3:8080 udp=${peers[0].endpoint} public_key=${peers[0].public_key}`), /inner address/);
    assert.throws(() => peerReady(""), /exactly one/);
});

test("storage and projection readers accept complete two- and three-ingress evidence", () => {
    stored(config, fixture, id, keyFile);
    projected(rows, fixture, id);
    const three = clone(config);
    three.gateways[0].wireguard_enrollment.ingresses.push({
        id: "p3", endpoint: peers[2].endpoint, public_key: peers[2].public_key,
        hosts: ["", "*."].map((prefix) => ({ name: `${prefix}p3.proxy.chan-e2e.invalid`, addresses: ["10.7.0.2"] })),
    });
    stored(three, parameters(peers), id, keyFile);
    projected([{ ...rows[0], wireguard_ingresses: [...rows[0].wireguard_ingresses, { id: "p3", status: "up" }] }], parameters(peers), id);
});

for (const [name, corrupt] of Object.entries({
    "missing second ingress": (p) => p.ingresses.pop(),
    "wrong order": (p) => p.ingresses.reverse(),
    "wrong client address": (p) => p.addresses.push("10.7.0.9/32"),
    "wrong allowed IPs": (p) => p.allowed_ips = [],
    "wrong keepalive": (p) => p.persistent_keepalive = 25,
    "wrong key file": (p) => p.key_file = "/elsewhere",
    "wrong ingress id": (p) => p.ingresses[1].id = "p1",
    "wrong peer key": (p) => p.ingresses[1].public_key = peers[0].public_key,
    "wrong peer endpoint": (p) => p.ingresses[1].endpoint = peers[0].endpoint,
    "wrong hosts": (p) => p.ingresses[1].hosts = p.ingresses[0].hosts,
})) {
    test(`storage refuses ${name}`, () => {
        const bad = clone(config);
        corrupt(bad.gateways[0].wireguard_enrollment);
        assert.throws(() => stored(bad, fixture, id, keyFile), /stored enrollment/);
    });
}

for (const [name, corrupt] of Object.entries({
    "summary without ingress statuses": (row) => delete row.wireguard_ingresses,
    "one ingress": (row) => row.wireguard_ingresses.pop(),
    "reversed ingresses": (row) => row.wireguard_ingresses.reverse(),
    "connecting ingress": (row) => row.wireguard_ingresses[1].status = "connecting",
    "refused ingress": (row) => row.wireguard_ingresses[1].status = "refused",
    "connecting summary": (row) => row.wireguard_status = "connecting",
    "not enrolled": (row) => row.wireguard_enrolled = false,
    "connect error": (row) => row.last_error = "failed",
})) {
    test(`projection refuses ${name}`, () => {
        const bad = clone(rows);
        corrupt(bad[0]);
        assert.throws(() => projected(bad, fixture, id));
    });
}

const path = "/probe-p2";
const request = `request: from=10.7.0.1:10000 line=GET ${path} HTTP/1.1`;
test("routing needs fresh matching traffic on exactly the selected peer", () => {
    const before = { p1: [request], p2: [] };
    routed(before, { p1: [request], p2: [request] }, "p2", path);
    routed(before, before, "none", path);
    assert.throws(() => routed(before, before, "p2", path), /did not reach/);
    assert.throws(() => routed(before, { p1: [request, request], p2: [request] }, "p2", path), /wrong peer p1/);
    assert.throws(() => routed(before, { p1: [request], p2: [request] }, "none", path), /wrong peer p2/);
    assert.throws(() => routed(before, { p1: [request], p2: [request.replace("10.7.0.1", "127.0.0.1")] }, "p2", path), /tunnel address/);
    assert.throws(() => routed(before, { p1: [], p2: [request] }, "p2", path), /must not shrink/);
    assert.throws(() => routed(before, { p2: [request] }, "p2", path), /every peer/);
});

// Native desktop trace from 2026-11-11; only the temporary key path and UDP port are normalized.
const startRecord = "2026-11-11T17:37:00.468921Z  INFO chan_desktop::wireguard: gateway WireGuard tunnel started gateway=gw-e2e00001 ingress=gw-e2e00001/p1 file=/test/chan-home/desktop/wireguard/gw-e2e00001.key endpoint=127.0.0.1:40001";
const start = (n) => startRecord.replace("/p1 ", `/p${n} `).replace(peers[0].endpoint, peers[n - 1].endpoint);
test("reconcile requires one start per ingress and no restart of existing peers", () => {
    started([start(1), start(2)].join("\n"), fixture, id, keyFile);
    started([start(1), start(2), start(3)].join("\n"), parameters(peers), id, keyFile);
    assert.throws(() => started(start(1), fixture, id, keyFile), /one start per ingress/);
    assert.throws(() => started([start(1), start(2), start(1)].join("\n"), parameters(peers), id, keyFile), /exactly once/);
    assert.throws(() => started([start(1), start(2), start(3), start(1)].join("\n"), parameters(peers), id, keyFile), /one start per ingress/);
    assert.throws(() => started([start(1), start(2).replace(peers[1].endpoint, peers[0].endpoint)].join("\n"), fixture, id, keyFile), /own endpoint/);
    assert.throws(() => started([start(1), start(2).replace(`ingress=${id}/p2`, `ingress=${id}/p1`)].join("\n"), fixture, id, keyFile), /exactly once/);
});

test("start records must use the gateway-qualified route id", () => {
    const bare = [start(1), start(2)].map((line) => line.replace(`ingress=${id}/`, "ingress=")).join("\n");
    assert.throws(() => started(bare, fixture, id, keyFile), /must start exactly once/);
    const otherGateway = [start(1), start(2)].map((line) => line.replace(`ingress=${id}/`, "ingress=gw-other/")).join("\n");
    assert.throws(() => started(otherGateway, fixture, id, keyFile), /must start exactly once/);
});

test("observations report missing, refused and restarted ingresses without asserting success", () => {
    const log = [start(1), start(1),
        start(2).replace(`gateway=${id}`, "gateway=gw-other"),
        start(2).replace(`ingress=${id}/p2`, "ingress=p2")].join("\n");
    const failed = [{ ...rows[0], status: "disconnected", wireguard_status: "connecting",
        wireguard_ingresses: [{ id: "p1", status: "connecting" }, { id: "p2", status: "refused" }] }];
    assert.deepEqual(observed(log, failed, fixture, id), {
        status: "disconnected", enrolled: true, summary: "connecting",
        ingresses: failed[0].wireguard_ingresses, starts: { p1: 2, p2: 0 },
    });
    assert.deepEqual(observed("", [], fixture, id), {
        status: null, enrolled: null, summary: null, ingresses: null, starts: { p1: 0, p2: 0 },
    });
});

test("key scan finds only an owner-only key file and refuses duplicates and empty keys", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "wg-key-oracle-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "client.key");
    const key = Buffer.alloc(32, 7).toString("base64");
    writeFileSync(file, key + "\n", { mode: 0o600 });
    privateKeyUnique(dir, file);
    writeFileSync(join(dir, "copy.conf"), `PrivateKey = ${key}\n`);
    assert.throws(() => privateKeyUnique(dir, file), /only in its key file/);
    rmSync(join(dir, "copy.conf"));
    chmodSync(file, 0o644);
    assert.throws(() => privateKeyUnique(dir, file), /owner-only/);
    chmodSync(file, 0o600);
    writeFileSync(file, "");
    assert.throws(() => privateKeyUnique(dir, file), /empty or invalid/);
});
