import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("./desktop-wireguard.sh", import.meta.url), "utf8");
function shellFunction(name) {
    const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m").exec(source);
    assert.ok(match, `missing shell function ${name}`);
    return match[0];
}
function shell(code, extraEnv = {}) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CHAN_")));
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", code], {
        env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
}

test("sign-in guard accepts one authorization and refuses another browser, authorize or redeem", (t) => {
    const work = mkdtempSync(join(tmpdir(), "wg-signin-test-"));
    t.after(() => rmSync(work, { recursive: true, force: true }));
    const authorize = "identity: authorize wireguard_public_key=test\n";
    const redeem = "identity: redeem pkce=ok wireguard=sent\n";
    const roster = "identity: roster bearer=minted\n";
    const code = shellFunction("single_sign_in") + "\nsingle_sign_in";
    for (const [urls, log, status] of [
        ["test\n", authorize + redeem + roster, 0],
        ["test\ntest\n", authorize + redeem + roster, 1],
        ["test\n", authorize + authorize + redeem + roster, 1],
        ["test\n", authorize + redeem + redeem + roster, 1],
        ["test\n", authorize + redeem, 1],
    ]) {
        writeFileSync(join(work, "browser.urls"), urls);
        writeFileSync(join(work, "identity.log"), log);
        assert.equal(shell(code, { WORK: work }).status, status);
    }
});

test("desktop continuity guard rejects a changed pid, listener count or proxy address", () => {
    const code = `desktop_pid() { echo "$PID_AFTER"; }
count() { echo "$LISTENERS"; }
proxy_addresses() { echo "$PROXY_AFTER"; }
${shellFunction("same_desktop")}
same_desktop 1234`;
    const base = { PID_AFTER: "1234", LISTENERS: "1", PROXY: "127.0.0.1:40000", PROXY_AFTER: "127.0.0.1:40000" };
    assert.equal(shell(code, base).status, 0);
    for (const extra of [{ PID_AFTER: "1235" }, { LISTENERS: "2" }, { PROXY_AFTER: "127.0.0.1:40001" }]) {
        assert.equal(shell(code, { ...base, ...extra }).status, 1);
    }
});

test("webview probe waits for success or failure and rejects stale URLs", async () => {
    const expression = (name) => {
        const match = /"([^\n]+)" \\\n\s+> "\$WORK\/probe-/.exec(shellFunction(name));
        assert.ok(match, `missing inspector expression in ${name}`);
        return match[1].replaceAll("$1", "http://probe.p2.proxy.chan-e2e.invalid:8080/probe");
    };
    for (const outcome of ["resolve", "reject"]) {
        let settle;
        const context = vm.createContext({ window: {}, fetch: (url) => {
            assert.equal(url, "http://probe.p2.proxy.chan-e2e.invalid:8080/probe");
            return new Promise((resolve, reject) => { settle = outcome === "resolve" ? resolve : reject; });
        } });
        assert.equal(vm.runInContext(expression("enrollment_fetch"), context), "dispatched");
        assert.equal(vm.runInContext(expression("enrollment_probe_settled"), context), false);
        settle();
        await Promise.resolve();
        assert.equal(vm.runInContext(expression("enrollment_probe_settled"), context), true);
        context.window.__chanWireguardEnrollmentProbe.url = "http://old-probe.invalid";
        assert.equal(vm.runInContext(expression("enrollment_probe_settled"), context), false);
    }
});

test("tenant arm propagates missing, misrouted and undispatched probes into its verdict", () => {
    const code = `${shellFunction("enrollment_tenant_arm")}
fail() { exit 99; }
library_call() { echo 409; }
grep() { [ "$FAILURE" != response ]; }
enrollment_fetch() { [ "$FAILURE" != fetch ]; }
enrollment_oracle() {
    if [ "$1" = snapshot ]; then return 0; fi
    [ "$FAILURE" != route ];
}
verdict() { echo "$1 rc=$2"; }
enrollment_tenant_arm enrolled 2 1 2 live`;
    for (const failure of ["none", "response", "fetch", "route"]) {
        const result = shell(code, { WORK: "/unused", FAILURE: failure });
        assert.equal(result.status, 0);
        const want = failure === "none" ? 0 : 1;
        assert.equal(result.stdout, `tenant-enrolled-p1 rc=${want}\ntenant-enrolled-p2 rc=${want}\n`);
    }
});
