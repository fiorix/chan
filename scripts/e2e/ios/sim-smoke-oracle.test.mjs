import assert from "node:assert/strict";
import test from "node:test";
import {
    REQUIRED_SIM_VERDICTS,
    verifySimulatorLedger,
    verifySimulatorVerdicts,
} from "./sim-smoke-oracle.mjs";

const H = "0123456789abcdef0123456789abcdef";

function allPassVerdictsText(names = REQUIRED_SIM_VERDICTS) {
    return names.map((name) => `verdict tier4 ${name} 0 PASS ok`).join("\n") + "\n";
}

function validLedger() {
    return {
        navigations: [
            {
                url: `https://alice--0123456789ab.p1.localtest.me:45556/api/notes-1a2b3c/index.html?w=w-hidden-ws&h=${H}&start=terminal&lib=lib-e2e001&pane=%233b82f6`,
                params: { w: "w-hidden-ws" },
            },
            {
                url: `https://alice--0123456789ab.p1.localtest.me:45556/terminal/index.html?w=w-ctrl&h=${H}&kind=control&lib=lib-e2e001&pane=%233b82f6`,
                params: { w: "w-ctrl" },
            },
            {
                url: `https://alice--0123456789ab.p1.localtest.me:45556/terminal/index.html?w=w-2&h=${H}&kind=terminal&lib=lib-e2e001&pane=%233b82f6`,
                params: { w: "w-2" },
            },
            {
                url: `https://alice--0123456789ab.p1.localtest.me:45556/terminal/index.html?w=w-3&h=${H}&kind=terminal&lib=lib-e2e001&pane=%233b82f6`,
                params: { w: "w-3" },
            },
            {
                url: `https://alice--0123456789ab.p1.localtest.me:45556/terminal/index.html?w=w-tmux-4&h=${H}&kind=terminal&seed=0&client_name=iPhone-E2E&lib=lib-e2e001&pane=%233b82f6`,
                params: { w: "w-tmux-4" },
            },
        ],
        tmuxRequests: [
            {
                rawSegment: "term%2Fone",
                connection: "term/one",
                request: { request: "new-window" },
            },
        ],
    };
}

test("verifySimulatorVerdicts accepts full 9 PASS lines and rejects empty, partial, FAIL, PREREQ, and nonzero xcodeRc", () => {
    assert.equal(REQUIRED_SIM_VERDICTS.length, 9);
    const res = verifySimulatorVerdicts(allPassVerdictsText(), { xcodeRc: 0 });
    assert.equal(res.passCount, 9);
    assert.equal(res.requiredCount, 9);

    assert.throws(() => verifySimulatorVerdicts("", { xcodeRc: 0 }), /empty/);
    assert.throws(() => verifySimulatorVerdicts("   \n", { xcodeRc: 0 }), /empty/);

    const partial = allPassVerdictsText(REQUIRED_SIM_VERDICTS.slice(0, 3));
    assert.throws(() => verifySimulatorVerdicts(partial, { xcodeRc: 0 }), /missing required/);

    const withFail = `${allPassVerdictsText()}verdict tier4 sim-extra 1 FAIL boom\n`;
    assert.throws(() => verifySimulatorVerdicts(withFail, { xcodeRc: 0 }), /contain FAIL/);

    const withPrereq = `${allPassVerdictsText()}verdict tier4 sim-extra 2 PREREQ skipped\n`;
    assert.throws(() => verifySimulatorVerdicts(withPrereq, { xcodeRc: 0 }), /contain PREREQ/);

    assert.throws(() => verifySimulatorVerdicts(allPassVerdictsText(), { xcodeRc: 65 }), /rc=65/);
});

test("verifySimulatorLedger validates full navigations and rejects empty, leaked client_name, wrong pane, unexpected w, or missing tmux", () => {
    const res = verifySimulatorLedger(validLedger());
    assert.equal(res.navigationCount, 5);
    assert.equal(res.tmuxNavCount, 1);

    assert.throws(() => verifySimulatorLedger(null), /JSON object/);
    assert.throws(() => verifySimulatorLedger({ navigations: [], tmuxRequests: [] }), /missing or empty/);

    const leaked = validLedger();
    leaked.navigations[0].url += "&client_name=attacker";
    assert.throws(() => verifySimulatorLedger(leaked), /client_name must be omitted/);

    const wrongPane = validLedger();
    wrongPane.navigations[1].url = wrongPane.navigations[1].url.replace("pane=%233b82f6", "pane=%23ff0000");
    assert.throws(() => verifySimulatorLedger(wrongPane), /pane color/);

    const unexpectedW = validLedger();
    unexpectedW.navigations.push({
        url: `https://alice--0123456789ab.p1.localtest.me:45556/terminal/index.html?w=w-bogus&h=${H}&kind=terminal&lib=lib-e2e001&pane=%233b82f6`,
        params: { w: "w-bogus" },
    });
    assert.throws(() => verifySimulatorLedger(unexpectedW), /unexpected recorded navigation/);

    const missingTmuxNav = validLedger();
    missingTmuxNav.navigations = missingTmuxNav.navigations.filter((n) => n.params.w !== "w-tmux-4");
    assert.throws(() => verifySimulatorLedger(missingTmuxNav), /missing tmux terminal/);

    const missingTmuxReq = validLedger();
    missingTmuxReq.tmuxRequests = [];
    assert.throws(() => verifySimulatorLedger(missingTmuxReq), /tmuxRequests missing/);
});
