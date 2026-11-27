import Foundation
import XCTest

final class ChanSmokeUITests: XCTestCase {
    private var verdictLines: [String] = []

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    override func tearDownWithError() throws {
        writeVerdicts()
        XCUIApplication(bundleIdentifier: "app.chan.ios").terminate()
    }

    private func env(_ key: String) -> String {
        ProcessInfo.processInfo.environment[key] ?? ""
    }

    private func recordVerdict(caseName: String, passed: Bool, detail: String) {
        let rc = passed ? 0 : 1
        let status = passed ? "PASS" : "FAIL"
        let cleanDetail = detail.replacingOccurrences(of: "\n", with: " ")
        let line = "verdict tier4 \(caseName) \(rc) \(status) \(cleanDetail)"
        verdictLines.append(line)
        print(line)
        if !passed {
            XCTFail("\(caseName): \(cleanDetail)")
        }
    }

    private func writeVerdicts() {
        let path = env("CHAN_E2E_VERDICT_FILE")
        guard !path.isEmpty else { return }
        let content = verdictLines.joined(separator: "\n") + (verdictLines.isEmpty ? "" : "\n")
        try? content.write(toFile: path, atomically: true, encoding: .utf8)
    }

    private func fetchLedger() -> [String: Any]? {
        let raw = env("CHAN_E2E_LEDGER_URL")
        guard let url = URL(string: raw) else { return nil }
        let sem = DispatchSemaphore(value: 0)
        var result: [String: Any]?
        let task = URLSession.shared.dataTask(with: url) { data, _, _ in
            if let data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                result = obj
            }
            sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + 5)
        return result
    }

    private func readGeneratedWireguardPublicKey(chanHome: String) -> String? {
        guard !chanHome.isEmpty else { return nil }
        let path = URL(fileURLWithPath: chanHome).appendingPathComponent("desktop/config.json")
        guard let data = try? Data(contentsOf: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let gateways = obj["gateways"] as? [[String: Any]],
              let key = gateways.first?["wireguard_public_key"] as? String,
              !key.isEmpty else {
            return nil
        }
        return key
    }

    private func startWgPeer(gatewayUrl: String, clientPublicKey: String) -> Bool {
        guard let url = URL(string: "\(gatewayUrl)/_test/start-wg-peer") else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["client_public_key": clientPublicKey])
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        let task = URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 {
                ok = true
            }
            sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + 12)
        return ok
    }

    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return condition()
    }

    private func ensureE2eBoxCardFront(app: XCUIApplication, webview: XCUIElement) {
        let showComputersBtn = app.buttons["Show computers"]
        if showComputersBtn.exists && showComputersBtn.isHittable {
            showComputersBtn.tap()
        }
        for _ in 0..<5 {
            if webview.staticTexts["e2e-box"].exists ||
                webview.buttons.matching(NSPredicate(format: "label CONTAINS 'e2e-box'")).firstMatch.exists {
                break
            }
            let nextCardBtn = webview.buttons["Next card"]
            if nextCardBtn.exists && nextCardBtn.isHittable {
                nextCardBtn.tap()
                RunLoop.current.run(until: Date().addingTimeInterval(0.6))
            }
        }
    }

    private func tapTenantButtonAndWaitResult(
        webview: XCUIElement,
        label: String,
        cmd: String
    ) -> String? {
        let btn = webview.buttons[label]
        guard btn.waitForExistence(timeout: 6) else { return nil }
        btn.tap()
        let pred = NSPredicate(
            format: "label CONTAINS %@ AND NOT (label CONTAINS %@)",
            "\"cmd\":\"\(cmd)\"",
            "\"pending\":true"
        )
        let resultNode = webview.staticTexts.matching(pred).firstMatch
        guard resultNode.waitForExistence(timeout: 6) else { return nil }
        return resultNode.label
    }

    private func hasNavigation(windowId: String, kind: String? = nil) -> Bool {
        guard let ledger = fetchLedger(),
              let navs = ledger["navigations"] as? [[String: Any]] else {
            return false
        }
        return navs.contains { nav in
            guard let params = nav["params"] as? [String: Any],
                  (params["w"] as? String) == windowId else {
                return false
            }
            if let kind {
                return (params["kind"] as? String) == kind
            }
            return true
        }
    }

    private func hasWindowOp(op: String, windowId: String? = nil, hidden: Bool? = nil, label: String? = nil, deleted: Bool? = nil) -> Bool {
        guard let ledger = fetchLedger(),
              let ops = ledger["windowOps"] as? [[String: Any]] else {
            return false
        }
        return ops.contains { entry in
            guard (entry["op"] as? String) == op else { return false }
            if let windowId, (entry["window_id"] as? String) != windowId { return false }
            if let hidden, (entry["hidden"] as? Bool) != hidden { return false }
            if let label, (entry["label"] as? String) != label { return false }
            if let deleted, (entry["deleted"] as? Bool) != deleted { return false }
            return true
        }
    }

    func testSimulatorEndToEndSmoke() throws {
        let chanHome = env("CHAN_E2E_HOME")
        let gatewayUrl = env("CHAN_E2E_GATEWAY_URL")
        let sslCertFile = env("CHAN_E2E_SSL_CERT_FILE")
        let probeRed = env("CHAN_E2E_PROBE_RED") == "1"

        let app = XCUIApplication(bundleIdentifier: "app.chan.ios")
        if !chanHome.isEmpty {
            app.launchEnvironment["CHAN_HOME"] = chanHome
        }
        if !sslCertFile.isEmpty {
            app.launchEnvironment["SSL_CERT_FILE"] = sslCertFile
        }
        app.launchEnvironment["CHAN_LOG"] = "info"
        app.launchEnvironment["RUST_BACKTRACE"] = "full"
        app.launch()

        // 1. Boot & WebView render check.
        let webview = app.webViews.firstMatch
        let hasWebView = webview.waitForExistence(timeout: 25)
        let showGatewaysBtn = app.buttons["Show gateways"]
        let launcherRendered = hasWebView && (
            showGatewaysBtn.waitForExistence(timeout: 20) ||
            app.staticTexts["All windows"].waitForExistence(timeout: 5) ||
            app.staticTexts["This machine"].exists
        )
        recordVerdict(
            caseName: "sim-boot-render",
            passed: launcherRendered,
            detail: launcherRendered ? "Chan.app launched with WKWebView launcher" : "WKWebView launcher did not render"
        )
        guard launcherRendered else { return }

        // 2. Launcher local controls hidden on iOS (advance Carousel past "All windows" so card 1 is non-inert).
        let nextCardBtn = webview.buttons["Next card"]
        if nextCardBtn.exists && nextCardBtn.isHittable {
            nextCardBtn.tap()
            _ = waitUntil(timeout: 2) {
                app.staticTexts["This machine"].exists || app.buttons["Add devserver"].exists
            }
        }
        let hasThisMachine = app.staticTexts["This machine"].exists || app.buttons["This machine"].exists
        let hasNewLocalTerm = app.buttons["New local terminal"].exists
        let hasNewLocalWs = app.buttons["New local workspace"].exists
        let localHidden = !probeRed && !hasThisMachine && !hasNewLocalTerm && !hasNewLocalWs
        recordVerdict(
            caseName: "sim-launcher-hide-local",
            passed: localHidden,
            detail: "this_machine=\(hasThisMachine) new_local_term=\(hasNewLocalTerm) new_local_ws=\(hasNewLocalWs)"
        )

        // 3. Gateway addition, WireGuard key generation, and ASWebAuthenticationSession enrollment.
        var enrolled = false
        if !gatewayUrl.isEmpty && showGatewaysBtn.exists {
            showGatewaysBtn.tap()
            let addGwBtn = webview.buttons["Add gateway"]
            if addGwBtn.waitForExistence(timeout: 8) {
                addGwBtn.tap()
                let urlField = webview.textFields.firstMatch
                if urlField.waitForExistence(timeout: 5) {
                    urlField.tap()
                    urlField.typeText(gatewayUrl)
                    if app.toolbars.buttons["Done"].exists {
                        app.toolbars.buttons["Done"].tap()
                    }
                    let genKeyBtn = webview.buttons["Generate WireGuard key"]
                    if genKeyBtn.waitForExistence(timeout: 4) && genKeyBtn.isHittable {
                        genKeyBtn.tap()
                        _ = webview.textFields["WireGuard public key"].waitForExistence(timeout: 8)
                    }
                    let submitBtn = webview.buttons["Done"].exists ? webview.buttons["Done"] : webview.buttons["Add gateway"]
                    if submitBtn.exists {
                        submitBtn.tap()
                    }
                }
            }

            // Start wg-peer admitting Chan.app's newly generated public key before tapping Connect.
            var generatedPubKey: String?
            _ = waitUntil(timeout: 3) {
                generatedPubKey = self.readGeneratedWireguardPublicKey(chanHome: chanHome)
                return generatedPubKey != nil
            }
            if let pubKey = generatedPubKey {
                _ = startWgPeer(gatewayUrl: gatewayUrl, clientPublicKey: pubKey)
            }

            let connectGwBtn = webview.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Connect '")).firstMatch
            if connectGwBtn.waitForExistence(timeout: 8) {
                connectGwBtn.tap()
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                let continueBtn = springboard.alerts.buttons["Continue"]
                if continueBtn.waitForExistence(timeout: 8) {
                    continueBtn.tap()
                }
                enrolled = waitUntil(timeout: 20) {
                    guard let ledger = self.fetchLedger(),
                          let auths = ledger["authorizeCalls"] as? [[String: Any]],
                          let redeems = ledger["redeemCalls"] as? [[String: Any]],
                          let reqs = ledger["requests"] as? [[String: Any]] else {
                        return false
                    }
                    let hasRoster = reqs.contains { ($0["path"] as? String) == "/mobile/v1/devservers" }
                    return !auths.isEmpty && !redeems.isEmpty && hasRoster
                }
            }
        }
        recordVerdict(
            caseName: "sim-gateway-enroll",
            passed: enrolled,
            detail: enrolled ? "mock /mobile/authorize, /redeem, and /mobile/v1/devservers completed" : "gateway enrollment did not complete"
        )

        // 4. Computers view: advance carousel to e2e-box, connect devserver, check remote buttons.
        ensureE2eBoxCardFront(app: app, webview: webview)
        let connectDsBtn = webview.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Connect '")).firstMatch
        if connectDsBtn.waitForExistence(timeout: 6) {
            connectDsBtn.tap()
        }
        let remoteTermBtn = webview.buttons.matching(NSPredicate(format: "label BEGINSWITH 'New terminal on '")).firstMatch
        let remoteWsTermBtn = webview.buttons.matching(NSPredicate(format: "label BEGINSWITH 'New terminal window of '")).firstMatch
        let remoteButtonsOk = remoteTermBtn.waitForExistence(timeout: 10) && remoteWsTermBtn.waitForExistence(timeout: 4)
        recordVerdict(
            caseName: "sim-remote-buttons",
            passed: remoteButtonsOk,
            detail: "remote_terminal=\(remoteTermBtn.exists) remote_ws_terminal=\(remoteWsTermBtn.exists)"
        )

        // 5. Expand notes, unhide & open w-hidden-ws, verify URL query params + unhide in ledger.
        var navParamsOk = false
        var unhideOk = false
        let expandNotesBtn = webview.buttons["Expand notes"]
        if expandNotesBtn.waitForExistence(timeout: 4) {
            expandNotesBtn.tap()
            let window1Btn = webview.buttons["Window 1"]
            let showWindowBtn = webview.buttons["Show window"]
            if window1Btn.waitForExistence(timeout: 4) && showWindowBtn.waitForExistence(timeout: 4) {
                let focusBtns = webview.buttons.matching(NSPredicate(format: "label == 'Focus window'"))
                if waitUntil(timeout: 4, condition: { focusBtns.count >= 2 }) {
                    focusBtns.element(boundBy: 1).tap()
                    navParamsOk = waitUntil(timeout: 12) {
                        guard let ledger = self.fetchLedger(),
                              let navs = ledger["navigations"] as? [[String: Any]] else {
                            return false
                        }
                        let hasNav = navs.contains { nav in
                            guard let params = nav["params"] as? [String: Any] else { return false }
                            let w = (params["w"] as? String) ?? ""
                            let h = (params["h"] as? String) ?? ""
                            let lib = (params["lib"] as? String) ?? ""
                            let start = (params["start"] as? String) ?? ""
                            let pane = (params["pane"] as? String) ?? ""
                            return w == "w-hidden-ws" && h.count == 32 && lib == "lib-e2e001" && start == "terminal" && pane == "#3b82f6"
                        }
                        unhideOk = self.hasWindowOp(op: "visibility", windowId: "w-hidden-ws", hidden: false)
                        return hasNav && unhideOk
                    }
                }
            }
        }
        recordVerdict(
            caseName: "sim-remote-window-url",
            passed: navParamsOk,
            detail: navParamsOk ? "w-hidden-ws unhid and carried w/h/lib/start=terminal/pane=#3b82f6" : "missing hidden workspace unhide or URL params"
        )

        // 6. Valid ACLs, all 8 single-webview commands, and left-edge swipe over WKWebView.
        var commandsOk = false
        var swipeOk = false
        var abandonNeeded = false
        if webview.buttons["Check native_vocabulary"].waitForExistence(timeout: 6) {
            let expectedCmds = [
                "native_vocabulary",
                "focus_library_window",
                "create_library_window",
                "open_new_window",
                "toggle_launcher_panel",
                "show_computers_for_window",
                "reconnect_devserver_for_window",
                "abandon_devserver_for_window",
            ]
            let vocabOut = tapTenantButtonAndWaitResult(webview: webview, label: "Check native_vocabulary", cmd: "native_vocabulary")
            let vocabOk = vocabOut.map { out in
                out.contains("\"ok\":true") && expectedCmds.allSatisfy { out.contains($0) }
            } ?? false

            let csrfOut = tapTenantButtonAndWaitResult(webview: webview, label: "Check gateway_csrf_token", cmd: "gateway_csrf_token")
            let csrfOk = csrfOut.map { $0.contains("\"ok\":true") && $0.contains("\"csrf-") } ?? false

            let deniedOut = tapTenantButtonAndWaitResult(
                webview: webview,
                label: "Probe disallowed mobile_deliver_pending_show_card",
                cmd: "mobile_deliver_pending_show_card"
            )
            let deniedOk = deniedOut.map {
                $0.contains("\"ok\":false") && $0.contains("not allowed") && !$0.contains("Command not found")
            } ?? false

            var focusOk = false
            let focusCmdBtn = webview.buttons["Focus library window"]
            if focusCmdBtn.exists {
                focusCmdBtn.tap()
                focusOk = waitUntil(timeout: 8) {
                    self.hasNavigation(windowId: "w-ctrl", kind: "control") &&
                        webview.staticTexts.matching(NSPredicate(format: "label CONTAINS 'w-ctrl'")).firstMatch.exists
                }
            }

            var createOk = false
            let createBtn = webview.buttons["Create terminal window"]
            if createBtn.exists {
                createBtn.tap()
                createOk = waitUntil(timeout: 8) {
                    self.hasWindowOp(op: "create", windowId: "w-2") &&
                        self.hasNavigation(windowId: "w-2", kind: "terminal")
                }
            }

            var openNewOk = false
            let openNewBtn = webview.buttons["Open new window"]
            if openNewBtn.exists {
                openNewBtn.tap()
                openNewOk = waitUntil(timeout: 8) {
                    self.hasWindowOp(op: "create", windowId: "w-3") &&
                        self.hasNavigation(windowId: "w-3", kind: "terminal")
                }
            }

            var reconnectOk = false
            let beforeLedger = fetchLedger()
            let entryBefore = (beforeLedger?["entryCalls"] as? [[String: Any]])?.count ?? 0
            let navBefore = (beforeLedger?["navigations"] as? [[String: Any]])?.count ?? 0
            let reconnectBtn = webview.buttons["Reconnect devserver for window"]
            if reconnectBtn.exists {
                reconnectBtn.tap()
                reconnectOk = waitUntil(timeout: 12) {
                    let afterLedger = self.fetchLedger()
                    let entryAfter = (afterLedger?["entryCalls"] as? [[String: Any]])?.count ?? 0
                    let navAfter = (afterLedger?["navigations"] as? [[String: Any]])?.count ?? 0
                    let allComputersBtn = webview.buttons["All computers..."]
                    return entryAfter > entryBefore &&
                        navAfter > navBefore &&
                        allComputersBtn.exists &&
                        allComputersBtn.isHittable
                }
            }

            var toggleOk = false
            let allComputersBtn = webview.buttons["All computers..."]
            if allComputersBtn.exists {
                allComputersBtn.tap()
                toggleOk = showGatewaysBtn.waitForExistence(timeout: 6)
            }

            var showCardOk = false
            ensureE2eBoxCardFront(app: app, webview: webview)
            let reopenBtn = webview.buttons.matching(NSPredicate(format: "label == 'Focus window'")).firstMatch
            if reopenBtn.waitForExistence(timeout: 6) {
                reopenBtn.tap()
                let showCardBtn = webview.buttons["Show computers for window"]
                if showCardBtn.waitForExistence(timeout: 6) {
                    showCardBtn.tap()
                    showCardOk = showGatewaysBtn.waitForExistence(timeout: 6) && webview.staticTexts["e2e-box"].waitForExistence(timeout: 6)
                }
            }

            // Re-open remote window and verify left-edge swipe returns to Computers.
            ensureE2eBoxCardFront(app: app, webview: webview)
            let reopenForSwipeBtn = webview.buttons.matching(NSPredicate(format: "label == 'Focus window'")).firstMatch
            if reopenForSwipeBtn.waitForExistence(timeout: 6) {
                reopenForSwipeBtn.tap()
                if webview.buttons["Abandon devserver for window"].waitForExistence(timeout: 6) {
                    let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
                    let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.5))
                    start.press(forDuration: 0.05, thenDragTo: end)
                    swipeOk = showGatewaysBtn.waitForExistence(timeout: 6)
                    if !swipeOk && webview.buttons["All computers..."].exists {
                        webview.buttons["All computers..."].tap()
                        _ = showGatewaysBtn.waitForExistence(timeout: 6)
                    }
                }
            }

            commandsOk = vocabOk && csrfOk && deniedOk && focusOk && createOk && openNewOk && reconnectOk && toggleOk && showCardOk
            abandonNeeded = true
        }
        recordVerdict(
            caseName: "sim-edge-swipe",
            passed: swipeOk,
            detail: "left_edge_swipe_returned=\(swipeOk)"
        )

        // 7. Drive real Hide, Rename (SetWindowLabel), Close (CommandLauncher), and abandon_devserver_for_window.
        var hideOk = false
        var renameOk = false
        var closeOk = false
        var abandonOk = false

        ensureE2eBoxCardFront(app: app, webview: webview)

        let hideBtn = webview.buttons["Hide window"].firstMatch
        if hideBtn.waitForExistence(timeout: 5) {
            hideBtn.tap()
            hideOk = waitUntil(timeout: 6) {
                self.hasWindowOp(op: "visibility", hidden: true) && webview.buttons["Show window"].exists
            }
        }

        let term2Btn = webview.buttons["Terminal Window 2"]
        if term2Btn.waitForExistence(timeout: 5) {
            term2Btn.tap()
            let labelField = webview.textFields["Text for Terminal Window 2"]
            if labelField.waitForExistence(timeout: 5) {
                labelField.tap()
                labelField.typeText("e2e-renamed\n")
                if !webview.buttons["Terminal Window 2 [e2e-renamed]"].waitForExistence(timeout: 3) {
                    let blurTarget = webview.staticTexts["Terminals"].firstMatch
                    if blurTarget.exists { blurTarget.tap() }
                }
                renameOk = waitUntil(timeout: 6) {
                    webview.buttons["Terminal Window 2 [e2e-renamed]"].exists &&
                        self.hasWindowOp(op: "label", windowId: "w-2", label: "e2e-renamed")
                }
            }
        }

        let cmdLauncherBtn = webview.buttons["Open command launcher"]
        if cmdLauncherBtn.waitForExistence(timeout: 5) {
            cmdLauncherBtn.tap()
            let primarySearchField = webview.textFields.firstMatch
            let fallbackSearchField = webview.descendants(matching: .any).matching(
                NSPredicate(format: "label == 'Computers'")
            ).firstMatch
            let searchField = primarySearchField.waitForExistence(timeout: 3)
                ? primarySearchField
                : fallbackSearchField
            if searchField.exists || searchField.waitForExistence(timeout: 2) {
                searchField.tap()
                searchField.typeText("Close Terminal Window 3")
                let optionPred = NSPredicate(
                    format: "elementType != %d AND label CONTAINS 'Close Terminal Window 3'",
                    XCUIElement.ElementType.textField.rawValue
                )
                let optionRow = webview.descendants(matching: .any).matching(optionPred).firstMatch
                let confirmCloseBtn = webview.buttons["Close"]
                if optionRow.waitForExistence(timeout: 3) && optionRow.isHittable {
                    optionRow.tap()
                }
                if !confirmCloseBtn.waitForExistence(timeout: 2) {
                    searchField.typeText("\n")
                }
                if confirmCloseBtn.waitForExistence(timeout: 5) {
                    confirmCloseBtn.tap()
                    closeOk = waitUntil(timeout: 6) {
                        !webview.buttons["Terminal Window 3"].exists &&
                            self.hasWindowOp(op: "delete", windowId: "w-3", deleted: true)
                    }
                }
            }
        }

        if abandonNeeded {
            ensureE2eBoxCardFront(app: app, webview: webview)
            let focusForAbandon = webview.buttons.matching(NSPredicate(format: "label == 'Focus window'")).firstMatch
            if focusForAbandon.waitForExistence(timeout: 5) {
                focusForAbandon.tap()
                let abandonBtn = webview.buttons["Abandon devserver for window"]
                if abandonBtn.waitForExistence(timeout: 6) {
                    abandonBtn.tap()
                    abandonOk = showGatewaysBtn.waitForExistence(timeout: 6) &&
                        webview.buttons["Connect e2e-box"].waitForExistence(timeout: 6)
                }
            }
        }

        let allCommandsOk = commandsOk && abandonOk
        recordVerdict(
            caseName: "sim-single-webview-commands",
            passed: allCommandsOk,
            detail: "commands_and_acl=\(allCommandsOk) (inner=\(commandsOk) abandon=\(abandonOk))"
        )

        let windowOpsOk = unhideOk && hideOk && renameOk && closeOk
        recordVerdict(
            caseName: "sim-remote-window-ops",
            passed: windowOpsOk,
            detail: "unhide=\(unhideOk) hide=\(hideOk) rename=\(renameOk) close=\(closeOk)"
        )
    }
}
