// Fixture writer and evidence readers for desktop-wireguard.sh. No sockets
// or child processes: the same assertions can be exercised with saved data.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const text = (path) => readFileSync(path, "utf8");
const require = (condition, message) => assert.ok(condition, message);

export function parameters(peers) {
    require(peers.length >= 2, "the fixture needs at least two peers");
    require(new Set(peers.map((p) => p.endpoint)).size === peers.length, "peer UDP endpoints must differ");
    require(new Set(peers.map((p) => p.public_key)).size === peers.length, "peer public keys must differ");
    const ingresses = peers.map((peer, i) => ({
        id: `p${i + 1}`, endpoint: peer.endpoint, server_public_key: peer.public_key,
        hosts: ["", "*."].map((prefix) => ({
            name: `${prefix}p${i + 1}.proxy.chan-e2e.invalid`, addresses: ["10.7.0.2"],
        })),
    }));
    return {
        endpoint: ingresses[0].endpoint, server_public_key: ingresses[0].server_public_key,
        addresses: ["10.7.0.1/32"], allowed_ips: ["10.7.0.2/32"], persistent_keepalive: 5,
        hosts: ingresses[0].hosts, ingresses,
    };
}

export function peerReady(log) {
    const lines = log.split("\n").filter((line) => line.startsWith("peer: ready "));
    require(lines.length === 1, "peer must print exactly one ready line");
    require(lines[0].includes("url=http://10.7.0.2:8080 "), "peers must share the inner address and port");
    const endpoint = / udp=(127\.0\.0\.1:\d+)(?: |$)/.exec(lines[0])?.[1];
    const public_key = / public_key=([A-Za-z0-9+/]{43}=)(?: |$)/.exec(lines[0])?.[1];
    require(endpoint && public_key, "peer ready line lacks its UDP endpoint or key");
    return { endpoint, public_key };
}

export function stored(config, fixture, id, keyFile) {
    const matches = config.gateways.filter((row) => row.id === id);
    require(matches.length === 1, "config must contain exactly one enrollment row");
    require(matches[0].wireguard == null, "an enrollment must not write a client file");
    assert.deepEqual(matches[0].wireguard_enrollment, {
        key_file: keyFile, addresses: fixture.addresses, allowed_ips: fixture.allowed_ips,
        persistent_keepalive: fixture.persistent_keepalive,
        ingresses: fixture.ingresses.map(({ server_public_key, ...ingress }) => ({
            ...ingress, public_key: server_public_key,
        })),
    }, "stored enrollment must match all served parameters in order");
}

export function projected(rows, fixture, id) {
    const matches = rows.filter((row) => row.id === id);
    require(matches.length === 1, "projection must contain exactly one enrollment row");
    const row = matches[0];
    require(row.status === "connected" && row.wireguard_enrolled === true &&
        row.wireguard == null && row.last_error == null, "enrollment row must be connected without an error or client file");
    require(row.wireguard_status === "up", "summary must be up after all handshakes");
    assert.deepEqual(row.wireguard_ingresses, fixture.ingresses.map(({ id }) => ({ id, status: "up" })),
        "every ingress must project up in discovery order");
}

export function requests(work, count) {
    return Object.fromEntries(Array.from({ length: count }, (_, i) => {
        const id = `p${i + 1}`;
        return [id, text(join(work, `peer-${id}.log`)).split("\n").filter((line) => line.startsWith("request: "))];
    }));
}

export function routed(before, after, target, path) {
    assert.deepEqual(Object.keys(after), Object.keys(before), "the route probe must inspect every peer");
    require(Object.keys(after).length >= 2, "a route probe needs at least two peer logs");
    require(target === "none" || target in after, "the expected peer is absent");
    for (const [id, lines] of Object.entries(after)) {
        assert.deepEqual(lines.slice(0, before[id].length), before[id], "peer log must not shrink or change");
        const seen = lines.slice(before[id].length).filter((line) => line.includes(`line=GET ${path} `));
        if (id === target) {
            require(seen.length > 0, `${path} did not reach ${id}`);
            require(seen.every((line) => /^request: from=10\.7\.0\.1:\d+ line=/.test(line)), `${id} did not receive traffic from the tunnel address`);
        } else {
            require(seen.length === 0, `${path} reached the wrong peer ${id}`);
        }
    }
}

export function started(log, fixture, gateway, keyFile) {
    const lines = log.split("\n").filter((line) => line.includes("gateway WireGuard tunnel started"));
    require(lines.length === fixture.ingresses.length, "there must be one start per ingress, with no restarted tunnel");
    for (const ingress of fixture.ingresses) {
        require(lines.filter((line) => line.includes(` gateway=${gateway} `) &&
            line.includes(` ingress=${gateway}/${ingress.id} `) && line.includes(` file=${keyFile} `) &&
            (line + " ").includes(` endpoint=${ingress.endpoint} `)).length === 1,
        `${ingress.id} must start exactly once with its own endpoint and the shared key file`);
    }
}

export function observed(log, rows, fixture, gateway) {
    const row = rows.find((row) => row.id === gateway);
    const starts = log.split("\n").filter((line) => line.includes("gateway WireGuard tunnel started"));
    return {
        status: row?.status ?? null,
        enrolled: row?.wireguard_enrolled ?? null,
        summary: row?.wireguard_status ?? null,
        ingresses: row?.wireguard_ingresses ?? null,
        starts: Object.fromEntries(fixture.ingresses.map(({ id }) => [id, starts.filter((line) =>
            line.includes(` gateway=${gateway} `) && line.includes(` ingress=${gateway}/${id} `)).length])),
    };
}

export function privateKeyUnique(work, keyFile) {
    const key = text(keyFile).trim();
    require(/^[A-Za-z0-9+/]{43}=$/.test(key), "the private key file is empty or invalid");
    require((lstatSync(keyFile).mode & 0o777) === 0o600, "key file must be owner-only");
    const holders = [];
    function scan(path) {
        const stat = lstatSync(path);
        if (stat.isDirectory()) {
            for (const entry of readdirSync(path)) scan(join(path, entry));
        } else if (stat.isFile() && readFileSync(path).includes(key)) {
            holders.push(path);
        }
    }
    scan(work);
    require(holders.length === 1 && holders[0] === keyFile, "the private key must occur only in its key file");
}

function main([command, ...args]) {
    if (command === "seed" || command === "fixture") {
        const [file, ...logs] = args;
        const peers = command === "seed"
            ? [9, 10].map((port) => ({ endpoint: `127.0.0.1:${port}`, public_key: randomBytes(32).toString("base64") }))
            : logs.map((file) => peerReady(text(file)));
        writeFileSync(`${file}.new`, JSON.stringify(parameters(peers)) + "\n");
        renameSync(`${file}.new`, file);
    } else if (command === "stored") {
        stored(read(args[0]), read(args[1]), args[2], args[3]);
    } else if (command === "projection") {
        projected(read(args[0]), read(args[1]), args[2]);
    } else if (command === "snapshot") {
        writeFileSync(args[2], JSON.stringify(requests(args[0], Number(args[1]))) + "\n");
    } else if (command === "routed") {
        routed(read(args[2]), requests(args[0], Number(args[1])), args[3], args[4]);
    } else if (command === "started") {
        started(text(args[0]), read(args[1]), args[2], args[3]);
    } else if (command === "observed") {
        console.log(JSON.stringify(observed(text(args[0]), read(args[1]), read(args[2]), args[3])));
    } else if (command === "private-key") {
        privateKeyUnique(args[0], args[1]);
    } else {
        throw new Error("usage: wireguard-enrollment-oracle.mjs seed FILE | fixture FILE LOG... | stored CONFIG FIXTURE ID KEYFILE | projection ROWS FIXTURE ID | snapshot WORK COUNT OUT | routed WORK COUNT SNAPSHOT ID|none PATH | started LOG FIXTURE ID KEYFILE | observed LOG ROWS FIXTURE ID | private-key WORK KEYFILE");
    }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try { main(process.argv.slice(2)); } catch (error) {
        // Assertions can contain private bytes; only explicit messages leave the reader.
        console.error(`wireguard-enrollment-oracle: ${error.message.split("\n")[0]}`);
        process.exitCode = 1;
    }
}
