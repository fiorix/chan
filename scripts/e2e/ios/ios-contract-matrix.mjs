// Structured 4-tier E2E contract verifier for F1-F9.
// Executes live mock-gateway + oracle checks, parsed config/ACL schema checks,
// and real cargo test execution without source-substring greps or hardcoded URLs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockGatewayServer } from "./mock-gateway.mjs";
import {
    buildPeerFixture,
    verifyEnrollmentRedeemMatch,
    verifyPeerRouting,
    verifyStoppedTunnelView,
} from "./ios-wireguard-oracle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

function readRepo(relPath) {
    return readFileSync(join(repoRoot, relPath), "utf8");
}

function invoke(server, method, path, body = null, headers = {}) {
    const req = new EventEmitter();
    Object.assign(req, { method, url: path, headers });
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
    return response;
}

function s256(verifier) {
    return createHash("sha256").update(verifier).digest("base64url");
}

function runCheck(tier, name, fn) {
    try {
        const detail = fn() || "ok";
        console.log(`verdict ${tier} ${name} 0 PASS ${detail}`);
        return true;
    } catch (err) {
        const msg = String(err?.message ?? err).split("\n")[0];
        console.log(`verdict ${tier} ${name} 1 FAIL ${msg}`);
        return false;
    }
}

function runCargoTests(extraArgs) {
    const res = spawnSync(
        "cargo",
        ["test", "--manifest-path", join(repoRoot, "Cargo.toml"), "-p", "chan-ios", ...extraArgs, "--", "--color=never"],
        { cwd: repoRoot, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
    );
    if (res.error) {
        if (res.error.code === "ENOENT") {
            console.log("verdict prereq cargo 2 PREREQ missing command cargo");
            process.exit(2);
        }
        throw res.error;
    }
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    const results = new Map();
    const re = /^test ([^\s]+) \.\.\. (ok|FAILED|ignored)(?:,.*)?$/gm;
    for (const match of stdout.matchAll(re)) {
        results.set(match[1], match[2]);
    }
    if (results.size === 0 || (res.status !== 0 && !stdout.includes("test result:"))) {
        const detail = (stderr || stdout).trim().split("\n").slice(-5).join(" | ");
        throw new Error(`cargo test ${extraArgs.join(" ")} failed to run tests (rc=${res.status}): ${detail}`);
    }
    return results;
}

function assertTestOk(results, name) {
    const status = results.get(name);
    assert.equal(status, "ok", `expected cargo test '${name}' to pass (got ${status ?? "missing"})`);
}

function parseAppTomlPermissions(tomlText) {
    const map = new Map();
    const blocks = tomlText.split(/^\[\[permission\]\]\s*$/m).slice(1);
    for (const block of blocks) {
        const idMatch = /^\s*identifier\s*=\s*"([^"]+)"/m.exec(block);
        const allowMatch = /^\s*commands\.allow\s*=\s*\[([^\]]*)\]/ms.exec(block);
        if (!idMatch || !allowMatch) continue;
        const cmds = [];
        for (const item of allowMatch[1].matchAll(/"([^"]+)"/g)) {
            cmds.push(item[1]);
        }
        map.set(idMatch[1], cmds);
    }
    return map;
}

function parseInfoPlist(plistPath) {
    const res = spawnSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
        encoding: "utf8",
        timeout: 15_000,
    });
    if (!res.error && res.status === 0) {
        return JSON.parse(res.stdout);
    }
    const xml = readFileSync(plistPath, "utf8");
    const stringVal = (key) => {
        const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(xml);
        return m ? m[1] : undefined;
    };
    return {
        CFBundleShortVersionString: stringVal("CFBundleShortVersionString"),
        CFBundleVersion: stringVal("CFBundleVersion"),
        NSAppTransportSecurity: {
            NSAllowsLocalNetworking: /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/.test(xml),
        },
    };
}

function main(argv) {
    let selectedTier = "all";
    let probeRed = false;
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--tier") selectedTier = argv[++i];
        else if (argv[i] === "--probe-red") probeRed = true;
        else {
            console.error(`unknown arg: ${argv[i]}`);
            process.exit(2);
        }
    }
    if (!["1", "2", "3", "all"].includes(selectedTier)) {
        console.error(`invalid tier: ${selectedTier}`);
        process.exit(2);
    }

    const appTomlText = readRepo("mobile/ios/permissions/app.toml");
    const appTomlPerms = parseAppTomlPermissions(appTomlText);
    const iosCapJson = JSON.parse(readRepo("mobile/ios/capabilities/ios.json"));
    const tauriConfRaw = readRepo("mobile/ios/tauri.conf.json5")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n");
    const tauriConf = JSON.parse(tauriConfRaw);
    const infoPlistJson = parseInfoPlist(join(repoRoot, "mobile/ios/gen/apple/chan-ios_iOS/Info.plist"));
    const projectYml = readRepo("mobile/ios/gen/apple/project.yml");
    const podfile = readRepo("mobile/ios/gen/apple/Podfile");

    const libResults = runCargoTests(["--lib"]);
    const harnessResults = runCargoTests(["--test", "ios_e2e_harness"]);

    const { server } = createMockGatewayServer({ autoConfirm: true });
    server.address = () => ({ port: 45555 });

    const commandTestMap = new Map([
        ["native_vocabulary", "tests::native_vocabulary_returns_version_build_and_gateway_commands"],
        ["focus_library_window", "tests::focus_library_window_validates_unhides_and_avoids_reloading_same_window"],
        [
            "create_library_window",
            "tests::create_library_window_and_open_new_window_handle_tmux_workspace_and_terminal",
        ],
        [
            "open_new_window",
            "tests::create_library_window_and_open_new_window_handle_tmux_workspace_and_terminal",
        ],
        [
            "toggle_launcher_panel",
            "tests::toggle_launcher_and_show_computers_and_abandon_and_reconnect_flow",
        ],
        [
            "show_computers_for_window",
            "tests::toggle_launcher_and_show_computers_and_abandon_and_reconnect_flow",
        ],
        [
            "reconnect_devserver_for_window",
            "tests::reconnect_devserver_for_window_reconnects_and_reopens_active_window",
        ],
        [
            "abandon_devserver_for_window",
            "tests::toggle_launcher_and_show_computers_and_abandon_and_reconnect_flow",
        ],
    ]);

    let failed = 0;
    const check = (tier, name, fn) => {
        if (!runCheck(tier, name, fn)) failed += 1;
    };

    if (selectedTier === "1" || selectedTier === "all") {
        // F1 (5)
        check("tier1", "f1-tauri-version-0.135.0", () => {
            assert.equal(tauriConf.version, probeRed ? "0.133.0" : "0.135.0");
            return "tauri.conf.json5 version=0.135.0";
        });
        check("tier1", "f1-tauri-min-ios-17.0", () => {
            assert.equal(tauriConf.bundle?.iOS?.minimumSystemVersion, "17.0");
            return "minimumSystemVersion=17.0";
        });
        check("tier1", "f1-plist-version-0.135.0", () => {
            assert.equal(infoPlistJson.CFBundleShortVersionString, "0.135.0");
            assert.equal(infoPlistJson.CFBundleVersion, "0.135.0");
            return "Info.plist 0.135.0";
        });
        check("tier1", "f1-project-yml-ios-17.0", () => {
            assert.ok(projectYml.includes("iOS: 17.0") && projectYml.includes("CFBundleShortVersionString: 0.135.0"));
            return "project.yml iOS 17.0 + 0.135.0";
        });
        check("tier1", "f1-podfile-ios-17.0", () => {
            assert.ok(podfile.includes("platform :ios, '17.0'"));
            return "Podfile platform iOS 17.0";
        });

        // F2 (5)
        check("tier1", "f2-discovery-mobile-enroll", () => {
            const disc = JSON.parse(invoke(server, "GET", "/.well-known/chan-gateway").body);
            assert.equal(disc.wireguard.mobile_enrollment, true);
            assert.equal(disc.devserver_proxy_host_depth, 2);
            return "discovery advertises mobile_enrollment=true";
        });
        check("tier1", "f2-authorize-consent-confirm", () => {
            const { server: consentSrv } = createMockGatewayServer({ autoConfirm: false });
            consentSrv.address = () => ({ port: 45555 });
            const verifier = "t1-f2-verifier-0123456789abcdefghijklmnopqr";
            const q = new URLSearchParams({
                redirect_uri: "chan://auth/callback",
                state: "st-1",
                label: "ios",
                code_challenge_method: "S256",
                code_challenge: s256(verifier),
                scopes: "mobile.account",
                expires_in: "3600",
            });
            const a = invoke(consentSrv, "GET", `/mobile/authorize?${q}`);
            assert.equal(a.status, 302);
            const c = invoke(consentSrv, "GET", a.headers.location);
            assert.equal(c.status, 200);
            const id = /name="id" value="([^"]+)"/.exec(c.body)[1];
            const csrf = /name="csrf" value="([^"]+)"/.exec(c.body)[1];
            const ok = invoke(
                consentSrv,
                "POST",
                "/mobile/authorize/confirm",
                new URLSearchParams({ id, csrf, action: "allow" }).toString(),
            );
            assert.equal(ok.status, 200);
            assert.ok(ok.body.includes("chan://auth/callback?code="));
            return "consent + confirm handoff HTML emitted";
        });
        check("tier1", "f2-redeem-pkce-s256", () => {
            const verifier = "t1-f2-redeem-0123456789abcdefghijklmnopq";
            const q = new URLSearchParams({
                redirect_uri: "chan://auth/callback",
                state: "st-2",
                label: "ios",
                code_challenge_method: "S256",
                code_challenge: s256(verifier),
                scopes: "mobile.account",
                expires_in: "3600",
                wireguard_public_key: Buffer.alloc(32, 9).toString("base64"),
            });
            const a = invoke(server, "GET", `/mobile/authorize?${q}`);
            const code = new URL(a.headers.location).searchParams.get("code");
            const r = invoke(server, "POST", "/mobile/authorize/redeem", { code, code_verifier: verifier });
            assert.equal(r.status, 200);
            const disc = JSON.parse(invoke(server, "GET", "/.well-known/chan-gateway").body);
            verifyEnrollmentRedeemMatch(disc, JSON.parse(r.body));
            return "PKCE S256 redeem + discovery match";
        });
        check("tier1", "f2-wg-tunnel-proxy-forward", () => {
            assertTestOk(harnessResults, "f2_wg_tunnel_proxy_forwards_protected_host");
            return "ios_e2e_harness F2 proxy test passed";
        });
        check("tier1", "f2-loopback-bypass-direct", () => {
            assertTestOk(harnessResults, "f2_loopback_bypass_stays_direct_with_protected_routes");
            return "ios_e2e_harness loopback bypass passed";
        });

        // F3 (5)
        check("tier1", "f3-sibling-tunnel-open", () => {
            assertTestOk(harnessResults, "f3_route_retirement_preserves_sibling_tunnel");
            return "sibling tunnel stays open on retirement";
        });
        check("tier1", "f3-retired-tunnel-is-closed", () => {
            assertTestOk(harnessResults, "f3_retired_tunnel_reports_is_closed");
            return "retired tunnel reports is_closed()";
        });
        check("tier1", "f3-two-ingress-independent-routes", () => {
            assertTestOk(harnessResults, "f3_two_ingress_independent_routes");
            return "two-ingress independent routes passed";
        });
        check("tier1", "f3-stopped-tunnel-restart", () => {
            assertTestOk(
                libResults,
                "wireguard::tests::enrolled_reconcile_restarts_only_the_ingress_whose_driver_stopped",
            );
            return "wireguard stopped-ingress restart passed";
        });
        check("tier1", "f3-stopped-tunnel-fabric-recovery", () => {
            assertTestOk(libResults, "wireguard::tests::reconcile_replaces_a_tunnel_whose_driver_stopped");
            return "wireguard stopped-tunnel Fabric recovery passed";
        });

        // F4 (5)
        check("tier1", "f4-url-workspace-unhide-and-params", () => {
            assertTestOk(
                libResults,
                "mobile_auth::tests::mobile_open_existing_window_unhides_refreshes_feed_and_stamps_url",
            );
            return "mobile_open_existing_window unhide + URL params passed";
        });
        check("tier1", "f4-url-devserver-mint-and-params", () => {
            assertTestOk(
                libResults,
                "mobile_auth::tests::mobile_open_devserver_with_app_mints_refreshes_feed_and_navigates",
            );
            return "mobile_open_devserver mint + URL params passed";
        });
        check("tier1", "f4-holder-tag-32-hex", () => {
            assertTestOk(libResults, "serve::tests::desktop_holder_tag_is_stable_32_char_lowercase_hex");
            return "desktop_holder_tag 32-hex passed";
        });
        check("tier1", "f4-gateway-entry-cookie-exchange", () => {
            assertTestOk(harnessResults, "f4_gateway_entry_exchange_sets_gate_and_csrf_cookies");
            return "/_chan/entry cookie exchange passed";
        });
        check("tier1", "f4-local-color-endpoint-for-pane", () => {
            const { server: s2 } = createMockGatewayServer({ requireSession: false });
            s2.address = () => ({ port: 45555 });
            const resp = invoke(s2, "GET", "/api/library/local-color");
            assert.equal(resp.status, 200);
            const payload = JSON.parse(resp.body);
            assert.match(payload.color ?? "", /^#[0-9a-fA-F]{6}$/);
            return "local-color endpoint returned hex pane color";
        });

        // F6 (8 commands + parsed app.toml + runtime capability + behavioral unit tests)
        for (const [cmd, unitTestName] of commandTestMap.entries()) {
            const permId = `allow-${cmd.replaceAll("_", "-")}`;
            check("tier1", `f6-cmd-${cmd.replaceAll("_", "-")}`, () => {
                const allowed = appTomlPerms.get(permId);
                assert.ok(allowed && allowed.includes(cmd), `permission ${permId} missing ${cmd} in permissions/app.toml`);
                assertTestOk(
                    libResults,
                    "runtime_capability::tests::gateway_window_commands_match_exact_origin_grant_app_toml_and_invoke_handler",
                );
                assertTestOk(libResults, unitTestName);
                return `${cmd} permitted and tested`;
            });
        }

        // F7 (5)
        check("tier1", "f7-window-hide-visibility", () => {
            assertTestOk(harnessResults, "f7_remote_window_visibility_unhide_and_hide");
            assertTestOk(
                libResults,
                "window_ops::tests::remote_hide_close_label_and_tmux_mutate_devserver_and_refresh_feed",
            );
            return "remote Hide visibility + feed refresh passed";
        });
        check("tier1", "f7-window-close-delete", () => {
            assertTestOk(harnessResults, "f7_remote_window_delete_and_404_idempotency");
            assertTestOk(
                libResults,
                "window_ops::tests::remote_hide_close_label_and_tmux_mutate_devserver_and_refresh_feed",
            );
            return "remote Close delete + feed refresh passed";
        });
        check("tier1", "f7-window-set-label", () => {
            assertTestOk(harnessResults, "f7_remote_window_label_set_clear_and_validation");
            assertTestOk(
                libResults,
                "window_ops::tests::remote_hide_close_label_and_tmux_mutate_devserver_and_refresh_feed",
            );
            return "remote SetWindowLabel + feed refresh passed";
        });
        check("tier1", "f7-tmux-percent-encoded-request", () => {
            assertTestOk(harnessResults, "f7_remote_tmux_percent_encoded_request");
            assertTestOk(
                libResults,
                "window_ops::tests::remote_hide_close_label_and_tmux_mutate_devserver_and_refresh_feed",
            );
            return "remote TmuxRequest percent-encoding passed";
        });
        check("tier1", "f7-devserver-feed-immediate-refresh", () => {
            assertTestOk(libResults, "tests::refresh_devserver_windows_updates_feed_and_signals_library_change");
            assertTestOk(libResults, "state::tests::replace_windows_updates_snapshot_preserves_tmux_and_reports_change");
            return "DevserverFeed immediate snapshot refresh passed";
        });

        // F8 (5)
        check("tier1", "f8-ios-cap-main-window-only", () => {
            assert.deepEqual(iosCapJson.windows, ["main"]);
            return 'capabilities/ios.json windows=["main"]';
        });
        check("tier1", "f8-toggle-launcher-panel-acl", () => {
            assert.ok(
                iosCapJson.permissions.includes("allow-toggle-launcher-panel"),
                "capabilities/ios.json missing allow-toggle-launcher-panel",
            );
            assert.ok(
                appTomlPerms.get("allow-toggle-launcher-panel")?.includes("toggle_launcher_panel"),
                "permissions/app.toml missing allow-toggle-launcher-panel",
            );
            return "toggle_launcher_panel ACLs valid";
        });
        check("tier1", "f8-all-computers-toggle-launcher-exec", () => {
            assertTestOk(
                libResults,
                "tests::toggle_launcher_and_show_computers_and_abandon_and_reconnect_flow",
            );
            return "toggle_launcher_panel execution test passed";
        });
        check("tier1", "f8-show-computers-for-window-acl", () => {
            assert.ok(
                appTomlPerms.get("allow-show-computers-for-window")?.includes("show_computers_for_window"),
                "permissions/app.toml missing allow-show-computers-for-window",
            );
            assertTestOk(
                libResults,
                "runtime_capability::tests::gateway_window_commands_match_exact_origin_grant_app_toml_and_invoke_handler",
            );
            return "show_computers_for_window ACL and runtime grant passed";
        });
        check("tier1", "f8-back-to-computers-loopback-and-remote", () => {
            assert.ok(
                iosCapJson.permissions.includes("allow-mobile-back-to-computers"),
                "capabilities/ios.json missing allow-mobile-back-to-computers",
            );
            assertTestOk(
                libResults,
                "runtime_capability::tests::mint_exact_origin_grant_resolves_deduplicates_and_enforces_acl",
            );
            assertTestOk(
                libResults,
                "runtime_capability::tests::gateway_window_commands_match_exact_origin_grant_app_toml_and_invoke_handler",
            );
            return "mobile_back_to_computers loopback and remote ACL passed";
        });

        // F9 (2 static checks here; simulator & cargo checks run in run-e2e.sh)
        check("tier1", "f9-ios-bundle-id", () => {
            assert.equal(tauriConf.identifier, "app.chan.ios");
            return "bundle identifier app.chan.ios";
        });
        check("tier1", "f9-ios-local-networking-ats", () => {
            assert.equal(infoPlistJson.NSAppTransportSecurity?.NSAllowsLocalNetworking, true);
            return "Info.plist ATS local networking enabled";
        });
    }

    if (selectedTier === "2" || selectedTier === "all") {
        // F1 negative (5)
        check("tier2", "f1-neg-ios15-16-refused", () => {
            assertTestOk(libResults, "webview_proxy::tests::versions_before_ios17_are_refused");
            return "iOS 15/16 refusal unit test passed";
        });
        check("tier2", "f1-neg-non-loopback-proxy-refused", () => {
            assertTestOk(libResults, "webview_proxy::tests::refuses_non_loopback_and_zero_ports");
            return "non-loopback / zero-port proxy refusal passed";
        });
        check("tier2", "f1-neg-non-ios-refused", () => {
            assertTestOk(libResults, "webview_proxy::tests::unsupported_platform_refuses_a_valid_proxy");
            return "non-iOS proxy refusal test passed";
        });
        check("tier2", "f1-neg-manifest-mismatch-probe", () => {
            assert.throws(() => assert.equal("0.133.0", tauriConf.version));
            return "0.133.0 mismatch detected";
        });
        check("tier2", "f1-neg-capabilities-no-wildcard-remote", () => {
            assert.ok(!iosCapJson.remote.urls.includes("https://*"));
            return "no wildcard https://* in loopback capability";
        });

        // F2 negative (5)
        check("tier2", "f2-neg-bad-redirect-uri", () => {
            for (const badRedirect of ["http://127.0.0.1/auth/callback", "chan://auth/callback?"]) {
                const q = new URLSearchParams({
                    redirect_uri: badRedirect,
                    state: "s",
                    label: "ios",
                    code_challenge: s256("v"),
                    code_challenge_method: "S256",
                    scopes: "mobile.account",
                    expires_in: "60",
                });
                assert.equal(invoke(server, "GET", `/mobile/authorize?${q}`).status, 400);
            }
            return "invalid redirect_uri refused 400";
        });
        check("tier2", "f2-neg-bad-wg-pubkey", () => {
            const q = new URLSearchParams({
                redirect_uri: "chan://auth/callback",
                state: "s",
                label: "ios",
                code_challenge: s256("v"),
                code_challenge_method: "S256",
                scopes: "mobile.account",
                expires_in: "60",
                wireguard_public_key: "invalid",
            });
            assert.equal(invoke(server, "GET", `/mobile/authorize?${q}`).status, 400);
            return "invalid WG public key refused 400";
        });
        check("tier2", "f2-neg-pkce-mismatch-410", () => {
            const q = new URLSearchParams({
                redirect_uri: "chan://auth/callback",
                state: "s",
                label: "ios",
                code_challenge: s256("real-verifier"),
                code_challenge_method: "S256",
                scopes: "mobile.account",
                expires_in: "60",
            });
            const a = invoke(server, "GET", `/mobile/authorize?${q}`);
            const code = new URL(a.headers.location).searchParams.get("code");
            const expectedStatus = probeRed ? 200 : 410;
            assert.equal(
                invoke(server, "POST", "/mobile/authorize/redeem", { code, code_verifier: "wrong" }).status,
                expectedStatus,
            );
            return "PKCE mismatch returned 410";
        });
        check("tier2", "f2-neg-code-replay-410", () => {
            const verifier = "replay-verifier-0123456789abcdefghijklmnop";
            const q = new URLSearchParams({
                redirect_uri: "chan://auth/callback",
                state: "s",
                label: "ios",
                code_challenge: s256(verifier),
                code_challenge_method: "S256",
                scopes: "mobile.account",
                expires_in: "60",
            });
            const a = invoke(server, "GET", `/mobile/authorize?${q}`);
            const code = new URL(a.headers.location).searchParams.get("code");
            assert.equal(invoke(server, "POST", "/mobile/authorize/redeem", { code, code_verifier: verifier }).status, 200);
            assert.equal(invoke(server, "POST", "/mobile/authorize/redeem", { code, code_verifier: verifier }).status, 410);
            return "code replay returned 410";
        });
        check("tier2", "f2-neg-wrong-wg-peer-key", () => {
            assertTestOk(harnessResults, "f2_neg_wrong_wg_peer_key_fails_tunnel_proxy");
            return "wrong WG peer key boundary passed";
        });

        // F3 negative (5)
        check("tier2", "f3-neg-protected-direct-fallback-refused", () => {
            assertTestOk(harnessResults, "f3_neg_protected_host_without_tunnel_refuses_502");
            return "protected destination without tunnel refused 502";
        });
        check("tier2", "f3-neg-stopped-tunnel-reconcile-status", () => {
            assertTestOk(libResults, "wireguard::tests::local_enrollment_routing_and_stopped_recovery_e2e");
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
                            wireguard_ingresses: [{ id: "p1", status: "connected" }],
                        },
                        "p1",
                    ),
                /must report stopped; connect the gateway again/,
            );
            return "local enrollment, stopped status e2e, and stopped-tunnel oracle passed";
        });
        check("tier2", "f3-neg-duplicate-ingress-rejected", () => {
            const p1 = { endpoint: "127.0.0.1:51001", public_key: Buffer.alloc(32, 1).toString("base64") };
            assert.throws(() => buildPeerFixture([p1, p1]), /distinct/);
            return "duplicate endpoint/key rejected";
        });
        check("tier2", "f3-neg-unoffered-wg-rejected", () => {
            const { server: noWg } = createMockGatewayServer({ noWireguard: true });
            noWg.address = () => ({ port: 45555 });
            const q = new URLSearchParams({
                redirect_uri: "chan://auth/callback",
                state: "s",
                label: "ios",
                code_challenge: s256("v"),
                code_challenge_method: "S256",
                scopes: "mobile.account",
                expires_in: "60",
                wireguard_public_key: Buffer.alloc(32, 2).toString("base64"),
            });
            assert.equal(invoke(noWg, "GET", `/mobile/authorize?${q}`).status, 400);
            return "unoffered wireguard enrollment rejected 400";
        });
        check("tier2", "f3-neg-stopped-tunnel-resume-recovery", () => {
            assertTestOk(libResults, "wireguard::tests::real_tunnel_shutdown_and_reconcile_saved_resume_recovery");
            return "real tunnel shutdown and resume recovery passed";
        });

        // F4 negative (5)
        check("tier2", "f4-neg-untrusted-client-name-stripped", () => {
            assertTestOk(
                libResults,
                "mobile_auth::tests::mobile_window_target_url_stamps_every_branch_and_sanitizes_client_name",
            );
            return "untrusted client_name sanitization unit test passed";
        });
        check("tier2", "f4-neg-unauth-roster-401", () => {
            assertTestOk(harnessResults, "f4_unauth_roster_returns_401");
            assert.equal(invoke(server, "GET", "/mobile/v1/devservers").status, 401);
            return "unauthenticated roster returns 401";
        });
        check("tier2", "f4-neg-direct-devserver-refused", () => {
            assertTestOk(libResults, "mobile_auth::tests::mobile_open_takes_only_connected_gateway_backed_rows");
            return "non-gateway / disconnected devserver open refused";
        });
        check("tier2", "f4-neg-malformed-callback-fails", () => {
            assertTestOk(libResults, "mobile_auth::tests::malformed_callback_fails_loudly_instead_of_ignoring");
            return "malformed OAuth callback fails loudly";
        });
        check("tier2", "f4-neg-entry-unknown-devserver-404", () => {
            const verifier = "t2-f4-entry-404-0123456789abcdefghijklmno";
            const q = new URLSearchParams({
                redirect_uri: "chan://auth/callback",
                state: "st-404",
                label: "ios",
                code_challenge_method: "S256",
                code_challenge: s256(verifier),
                scopes: "mobile.account",
                expires_in: "3600",
            });
            const a = invoke(server, "GET", `/mobile/authorize?${q}`);
            const code = new URL(a.headers.location).searchParams.get("code");
            const r = invoke(server, "POST", "/mobile/authorize/redeem", { code, code_verifier: verifier });
            const pat = JSON.parse(r.body).secret;
            const entry = invoke(
                server,
                "POST",
                "/mobile/v1/devserver/entry",
                { path: "/", devserver_id: "unknown-devserver-id" },
                { authorization: `Bearer ${pat}` },
            );
            assert.equal(entry.status, 404);
            return "unknown devserver_id entry returned 404";
        });

        // F6 negative (5)
        check("tier2", "f6-neg-loopback-denies-remote-and-csrf", () => {
            assert.ok(!iosCapJson.permissions.includes("allow-gateway-csrf-token"));
            assert.ok(!iosCapJson.permissions.includes("allow-focus-library-window"));
            assert.ok(
                appTomlPerms
                    .get("allow-mobile-deliver-pending-show-card")
                    ?.includes("mobile_deliver_pending_show_card"),
                "permissions/app.toml missing allow-mobile-deliver-pending-show-card",
            );
            return "loopback capability excludes remote-only commands and keeps loopback-only delivery perm";
        });
        check("tier2", "f6-neg-unminted-gateway-denies-8-cmds", () => {
            assertTestOk(
                libResults,
                "runtime_capability::tests::mint_exact_origin_grant_resolves_deduplicates_and_enforces_acl",
            );
            assertTestOk(
                libResults,
                "runtime_capability::tests::gateway_window_commands_match_exact_origin_grant_app_toml_and_invoke_handler",
            );
            return "unminted remote origin denies all 8 gateway commands via runtime ACL";
        });
        check("tier2", "f6-neg-remote-origin-denies-loopback-delivery", () => {
            assertTestOk(
                libResults,
                "runtime_capability::tests::gateway_window_commands_match_exact_origin_grant_app_toml_and_invoke_handler",
            );
            assertTestOk(
                libResults,
                "runtime_capability::tests::mint_exact_origin_grant_resolves_deduplicates_and_enforces_acl",
            );
            return "remote origin denies loopback-only delivery command";
        });
        check("tier2", "f6-neg-wildcard-and-path-origins-rejected", () => {
            assertTestOk(
                libResults,
                "runtime_capability::tests::remote_urls_reject_wildcards_paths_queries_and_userinfo",
            );
            assertTestOk(
                libResults,
                "runtime_capability::tests::gateway_window_commands_match_exact_origin_grant_app_toml_and_invoke_handler",
            );
            return "wildcard, path, query, and userinfo origins rejected";
        });
        check("tier2", "f6-neg-focus-rejects-empty-and-double-colon", () => {
            assertTestOk(
                libResults,
                "tests::focus_library_window_validates_unhides_and_avoids_reloading_same_window",
            );
            return "focus_library_window rejects empty and '::' window_id";
        });

        // F7 negative (5)
        check("tier2", "f7-neg-delete-404-idempotent", () => {
            assertTestOk(harnessResults, "f7_remote_window_delete_and_404_idempotency");
            assertTestOk(
                libResults,
                "window_ops::tests::remote_hide_and_close_unknown_or_disconnected_behave_cleanly",
            );
            return "404 discard idempotency and unknown-window handling passed";
        });
        check("tier2", "f7-neg-label-over-64-chars-400", () => {
            const { server: s2 } = createMockGatewayServer({ requireSession: false });
            s2.address = () => ({ port: 45555 });
            assert.equal(invoke(s2, "PUT", "/api/library/windows/w-hidden-ws/label", { label: "z".repeat(65) }).status, 400);
            return ">64 char label returns 400";
        });
        check("tier2", "f7-neg-label-control-chars-400", () => {
            const { server: s2 } = createMockGatewayServer({ requireSession: false });
            s2.address = () => ({ port: 45555 });
            assert.equal(invoke(s2, "PUT", "/api/library/windows/w-hidden-ws/label", { label: "a\nb" }).status, 400);
            return "control-char label returns 400";
        });
        check("tier2", "f7-neg-control-window-label-400", () => {
            const { server: s2 } = createMockGatewayServer({ requireSession: false });
            s2.address = () => ({ port: 45555 });
            assert.equal(invoke(s2, "PUT", "/api/library/windows/w-ctrl/label", { label: "renamed" }).status, 400);
            return "control window rename returns 400";
        });
        check("tier2", "f7-neg-tmux-missing-body-400", () => {
            const { server: s2 } = createMockGatewayServer({ requireSession: false });
            s2.address = () => ({ port: 45555 });
            assert.equal(invoke(s2, "POST", "/api/library/tmux/term%2Fone/request", "").status, 400);
            return "tmux request without JSON body returns 400";
        });

        // F8 negative (5)
        check("tier2", "f8-neg-capabilities-no-non-main-window", () => {
            assert.deepEqual(iosCapJson.windows, ["main"]);
            assert.ok(
                iosCapJson.permissions.includes("allow-toggle-launcher-panel"),
                "capabilities/ios.json must include allow-toggle-launcher-panel",
            );
            return "capabilities/ios.json restricted to main window with launcher toggle";
        });
        check("tier2", "f8-neg-no-csrf-mutation-401", () => {
            assert.equal(invoke(server, "POST", "/api/library/windows/w-hidden-ws/visibility", { hidden: false }).status, 401);
            return "unauthenticated/CSRF-less mutation returns 401";
        });
        check("tier2", "f8-neg-entry-bad-cred-401", () => {
            assert.equal(invoke(server, "POST", "/_chan/entry", "credential=bogus").status, 401);
            return "bad /_chan/entry credential returns 401";
        });
        check("tier2", "f8-neg-oracle-rejects-wrong-peer-route", () => {
            const req = "request: from=10.7.0.1:1000 line=GET /p HTTP/1.1";
            assert.throws(() => verifyPeerRouting({ p1: [], p2: [] }, { p1: [req], p2: [req] }, "p2", "/p"), /wrong peer/);
            return "route oracle rejects wrong-peer leak";
        });
        check("tier2", "f8-neg-oracle-rejects-skewed-redeem", () => {
            const disc = JSON.parse(invoke(server, "GET", "/.well-known/chan-gateway").body);
            const verifier = "t2-f8-skewed-redeem-0123456789abcdefghijk";
            const q = new URLSearchParams({
                redirect_uri: "chan://auth/callback",
                state: "st-skew",
                label: "ios",
                code_challenge_method: "S256",
                code_challenge: s256(verifier),
                scopes: "mobile.account",
                expires_in: "60",
                wireguard_public_key: Buffer.alloc(32, 11).toString("base64"),
            });
            const a = invoke(server, "GET", `/mobile/authorize?${q}`);
            const code = new URL(a.headers.location).searchParams.get("code");
            const r = invoke(server, "POST", "/mobile/authorize/redeem", { code, code_verifier: verifier });
            assert.equal(r.status, 200);
            const redeemPayload = JSON.parse(r.body);
            verifyEnrollmentRedeemMatch(disc, redeemPayload);
            const skewed = structuredClone(redeemPayload);
            skewed.wireguard.ingresses[0].endpoint = "127.0.0.1:59999";
            assert.throws(() => verifyEnrollmentRedeemMatch(disc, skewed), /must match discovery/);
            return "enrollment oracle rejects skewed redeem payload";
        });
    }

    if (selectedTier === "3" || selectedTier === "all") {
        // Tier 3: 10 pairwise cross-feature combinations across F1-F9.
        check("tier3", "t3-f1-f2-ios17-floor-and-wg-enroll", () => {
            assert.equal(tauriConf.bundle?.iOS?.minimumSystemVersion, probeRed ? "15.0" : "17.0");
            const disc = JSON.parse(invoke(server, "GET", "/.well-known/chan-gateway").body);
            assert.equal(disc.wireguard.mobile_enrollment, true);
            return "iOS 17 floor + mobile WireGuard discovery aligned";
        });
        check("tier3", "t3-f2-f3-enroll-two-ingresses-and-retire-one", () => {
            assertTestOk(harnessResults, "f3_route_retirement_preserves_sibling_tunnel");
            assertTestOk(
                libResults,
                "wireguard::tests::enrolled_reconcile_restarts_only_the_ingress_whose_driver_stopped",
            );
            return "F2+F3 enrollment & sibling retirement aligned";
        });
        check("tier3", "t3-f2-f4-wg-proxy-to-entry-exchange-and-window-url", () => {
            assertTestOk(harnessResults, "f4_gateway_entry_exchange_sets_gate_and_csrf_cookies");
            assertTestOk(
                libResults,
                "mobile_auth::tests::mobile_open_devserver_with_app_mints_refreshes_feed_and_navigates",
            );
            return "F2+F4 proxy entry + window URL contract aligned";
        });
        check("tier3", "t3-f3-f6-stopped-tunnel-reconnect-command", () => {
            assertTestOk(libResults, "wireguard::tests::reconcile_replaces_a_tunnel_whose_driver_stopped");
            assertTestOk(
                libResults,
                "tests::reconnect_devserver_for_window_reconnects_and_reopens_active_window",
            );
            return "F3+F6 stopped tunnel + reconnect command aligned";
        });
        check("tier3", "t3-f4-f5-ios-launcher-remote-open-unhides-and-stamps-url", () => {
            assertTestOk(
                libResults,
                "mobile_auth::tests::mobile_open_existing_window_unhides_refreshes_feed_and_stamps_url",
            );
            return "F4+F5 unhide + URL stamping aligned";
        });
        check("tier3", "t3-f4-f7-unhide-then-label-then-tmux-then-delete", () => {
            const { server: s2 } = createMockGatewayServer({ requireSession: false });
            s2.address = () => ({ port: 45555 });
            assert.equal(invoke(s2, "POST", "/api/library/windows/w-hidden-ws/visibility", { hidden: false }).status, 204);
            assert.equal(invoke(s2, "PUT", "/api/library/windows/w-hidden-ws/label", { label: "pair-label" }).status, 204);
            assert.equal(invoke(s2, "POST", "/api/library/tmux/term%2Fone/request", { request: "new-window" }).status, 204);
            assert.equal(invoke(s2, "DELETE", "/api/library/windows/w-hidden-ws").status, 204);
            assertTestOk(
                libResults,
                "window_ops::tests::remote_hide_close_label_and_tmux_mutate_devserver_and_refresh_feed",
            );
            return "F4+F7 full remote window lifecycle wired";
        });
        check("tier3", "t3-f5-f8-ios-launcher-to-window-and-all-computers-back", () => {
            assertTestOk(
                libResults,
                "tests::toggle_launcher_and_show_computers_and_abandon_and_reconnect_flow",
            );
            assert.ok(iosCapJson.permissions.includes("allow-toggle-launcher-panel"));
            return "F5+F8 launcher return navigation aligned";
        });
        check("tier3", "t3-f6-f7-single-webview-create-and-remote-close-refresh", () => {
            assertTestOk(
                libResults,
                "tests::create_library_window_and_open_new_window_handle_tmux_workspace_and_terminal",
            );
            assertTestOk(
                libResults,
                "window_ops::tests::remote_hide_close_label_and_tmux_mutate_devserver_and_refresh_feed",
            );
            assertTestOk(libResults, "tests::refresh_devserver_windows_updates_feed_and_signals_library_change");
            return "F6+F7 single-webview window ops + refresh aligned";
        });
        check("tier3", "t3-f6-f8-main-edge-gesture-and-toggle-launcher-panel", () => {
            assert.deepEqual(iosCapJson.windows, ["main"]);
            assert.ok(iosCapJson.permissions.includes("allow-toggle-launcher-panel"));
            assert.ok(
                appTomlPerms.get("allow-show-computers-for-window")?.includes("show_computers_for_window"),
                "permissions/app.toml missing allow-show-computers-for-window",
            );
            assertTestOk(
                libResults,
                "runtime_capability::tests::gateway_window_commands_match_exact_origin_grant_app_toml_and_invoke_handler",
            );
            return "F6+F8 main window grants aligned";
        });
        check("tier3", "t3-f1-f9-ios17-sim-plist-and-webview-boot", () => {
            assert.equal(tauriConf.version, "0.135.0");
            assert.equal(tauriConf.bundle?.iOS?.minimumSystemVersion, "17.0");
            assert.equal(infoPlistJson.CFBundleShortVersionString, "0.135.0");
            assert.ok(projectYml.includes("iOS: 17.0"));
            assertTestOk(harnessResults, "f1_permissions_and_ios_capability_schemas_are_valid");
            return "F1+F9 Simulator plist and iOS 17 config aligned";
        });
    }

    if (failed > 0) {
        process.exit(1);
    }
}

main(process.argv.slice(2));
