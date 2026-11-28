// Fail-closed verdict and navigation-ledger oracle for iOS Simulator smoke runs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { verifyWindowNavigationParams } from "./ios-wireguard-oracle.mjs";

export const REQUIRED_SIM_VERDICTS = [
    "sim-boot-render",
    "sim-launcher-hide-local",
    "sim-gateway-enroll",
    "sim-remote-buttons",
    "sim-remote-window-url",
    "sim-edge-swipe",
    "sim-single-webview-commands",
    "sim-remote-window-ops",
    "sim-tmux-request",
];

const DEFAULT_LIBRARY_ID = "lib-e2e001";
const DEFAULT_PANE_COLOR = "#3b82f6";

export function verifySimulatorVerdicts(verdictText, options = {}) {
    const { xcodeRc = 0, required = REQUIRED_SIM_VERDICTS } = options;
    const text = String(verdictText ?? "");
    assert.ok(text.trim().length > 0, "sim-verdicts.txt is empty");

    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const failLines = lines.filter((line) => /^verdict [^ ]+ [^ ]+ 1 FAIL /.test(line));
    assert.equal(failLines.length, 0, `UI verdicts contain FAIL: ${failLines.join("; ")}`);

    const prereqLines = lines.filter((line) => /^verdict [^ ]+ [^ ]+ 2 PREREQ /.test(line));
    assert.equal(prereqLines.length, 0, `UI verdicts contain PREREQ: ${prereqLines.join("; ")}`);

    const passLines = lines.filter((line) => /^verdict [^ ]+ [^ ]+ 0 PASS /.test(line));
    assert.ok(passLines.length > 0, "sim-verdicts.txt contains zero PASS verdicts");

    const missing = [];
    for (const name of required) {
        const pattern = new RegExp(`^verdict tier4 ${name} 0 PASS `);
        if (!lines.some((line) => pattern.test(line))) {
            missing.push(name);
        }
    }
    assert.equal(
        missing.length,
        0,
        `missing required Simulator UI PASS verdict(s): ${missing.join(", ")}`,
    );

    assert.equal(Number(xcodeRc), 0, `xcodebuild exited with rc=${xcodeRc}`);
    return { passCount: passLines.length, requiredCount: required.length };
}

export function verifySimulatorLedger(ledger, options = {}) {
    const {
        clientNameOnTmux = "iPhone-E2E",
        requireTmuxNav = true,
        libraryId = DEFAULT_LIBRARY_ID,
        paneColor = DEFAULT_PANE_COLOR,
    } = options;

    assert.ok(ledger && typeof ledger === "object" && !Array.isArray(ledger), "ledger must be a JSON object");
    assert.ok(
        Array.isArray(ledger.navigations) && ledger.navigations.length > 0,
        "ledger.navigations is missing or empty",
    );

    const seenWindowIds = new Set();
    let tmuxNavCount = 0;

    for (const nav of ledger.navigations) {
        assert.ok(nav && typeof nav.url === "string" && nav.url.length > 0, "navigation entry missing url");
        const w = nav.params?.w;
        assert.ok(typeof w === "string" && w.length > 0, `unexpected recorded navigation without w param: ${nav.url}`);

        let spec;
        if (w === "w-hidden-ws") {
            spec = {
                windowId: w,
                kind: "workspace",
                startTerminal: true,
                libraryId,
                pane: paneColor,
            };
        } else if (w === "w-ctrl") {
            spec = {
                windowId: w,
                kind: "control",
                libraryId,
                pane: paneColor,
            };
        } else if (w === "w-2" || w === "w-3") {
            spec = {
                windowId: w,
                kind: "terminal",
                tmux: false,
                libraryId,
                pane: paneColor,
            };
        } else if (/^w-tmux-\d+$/.test(w)) {
            tmuxNavCount += 1;
            spec = {
                windowId: w,
                kind: "terminal",
                tmux: true,
                libraryId,
                clientName: clientNameOnTmux,
                pane: paneColor,
            };
        } else {
            assert.fail(`unexpected recorded navigation window id '${w}': ${nav.url}`);
        }

        verifyWindowNavigationParams(nav.url, spec);
        seenWindowIds.add(w);
    }

    for (const expectedW of ["w-hidden-ws", "w-ctrl", "w-2", "w-3"]) {
        assert.ok(seenWindowIds.has(expectedW), `ledger.navigations missing expected window '${expectedW}'`);
    }

    if (requireTmuxNav) {
        assert.ok(tmuxNavCount > 0, "ledger.navigations missing tmux terminal window (/^w-tmux-\\d+$/)");
        assert.ok(Array.isArray(ledger.tmuxRequests), "ledger.tmuxRequests must be an array");
        const hasNewWindow = ledger.tmuxRequests.some(
            (entry) =>
                entry &&
                entry.rawSegment === "term%2Fone" &&
                entry.connection === "term/one" &&
                entry.request &&
                entry.request.request === "new-window",
        );
        assert.ok(hasNewWindow, "ledger.tmuxRequests missing term%2Fone new-window request");
    }

    return {
        navigationCount: ledger.navigations.length,
        seenWindowIds: [...seenWindowIds],
        tmuxNavCount,
    };
}

function readJsonFile(path, label) {
    assert.ok(path && existsSync(path), `${label} missing at ${path ?? "(unset)"}`);
    return JSON.parse(readFileSync(path, "utf8"));
}

function readTextFile(path, label) {
    assert.ok(path && existsSync(path), `${label} missing at ${path ?? "(unset)"}`);
    return readFileSync(path, "utf8");
}

function main([cmd, ...args]) {
    if (cmd === "check-verdicts") {
        const [verdictFile, xcodeRcArg = "0"] = args;
        const text = readTextFile(verdictFile, "sim-verdicts.txt");
        const res = verifySimulatorVerdicts(text, { xcodeRc: Number(xcodeRcArg) });
        console.log(
            `verified ${res.passCount} PASS verdicts covering all ${res.requiredCount} required Simulator UI checks`,
        );
    } else if (cmd === "check-ledger") {
        const [ledgerFile] = args;
        const ledger = readJsonFile(ledgerFile, "ledger.json");
        const res = verifySimulatorLedger(ledger);
        console.log(
            `validated ${res.navigationCount} recorded navigation URL(s) (${res.seenWindowIds.join(", ")})`,
        );
    } else if (cmd === "check-all") {
        const [verdictFile, ledgerFile, xcodeRcArg = "0"] = args;
        const text = readTextFile(verdictFile, "sim-verdicts.txt");
        const vRes = verifySimulatorVerdicts(text, { xcodeRc: Number(xcodeRcArg) });
        const ledger = readJsonFile(ledgerFile, "ledger.json");
        const lRes = verifySimulatorLedger(ledger);
        console.log(
            `validated ${vRes.passCount} PASS verdicts and ${lRes.navigationCount} navigation URL(s)`,
        );
    } else {
        throw new Error(
            "usage: sim-smoke-oracle.mjs check-verdicts VERDICT_FILE [XCODE_RC] | check-ledger LEDGER_FILE | check-all VERDICT_FILE LEDGER_FILE [XCODE_RC]",
        );
    }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(`sim-smoke-oracle: ${String(error?.message ?? error).split("\n")[0]}`);
        process.exitCode = 1;
    }
}
