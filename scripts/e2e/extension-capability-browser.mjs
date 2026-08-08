// Headless-Chrome half of the extension-capability scenario: proves
// the opaque-origin story a curl probe cannot. A REAL sandboxed
// iframe (allow-scripts, no allow-same-origin) loads the extension
// entry doc through the gateway, its module script boots, its
// cookieless fetches read TRUE statuses (a bogus capability is a
// readable 404, not a CORS mask), and the tenant watch socket drops
// when the devserver restarts -- the client-side trigger the SPA's
// staleness recovery hangs off.
//
// Env: CHROME_BIN, TENANT_BASE (https://host:port), NODE_IP, PREFIX
// (workspace slug, no slashes), ENTRY_PATH (tenant-relative extension
// entry path), GATE_COOKIE (cookie value only), VERDICT (output JSON
// path).
//
// Protocol: prints one line "ws-open" once the watch socket is
// connected; the harness then restarts the devserver. The script
// waits for the socket to close, writes the verdict JSON, and exits
// 0. Content assertions stay in the harness so the log reads as one
// assert list.
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const { CHROME_BIN, TENANT_BASE, NODE_IP, PREFIX, ENTRY_PATH, GATE_COOKIE, VERDICT } =
    process.env;
if (!CHROME_BIN || !TENANT_BASE || !NODE_IP || !PREFIX || !ENTRY_PATH || !GATE_COOKIE || !VERDICT) {
    console.error("missing CHROME_BIN / TENANT_BASE / NODE_IP / PREFIX / ENTRY_PATH / GATE_COOKIE / VERDICT");
    process.exit(2);
}
const host = new URL(TENANT_BASE).hostname;
const WS_CLOSE_TIMEOUT_MS = 45_000;

const browser = await puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: "new",
    args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // Per-run CA; only this test launch may cross the loopback TLS edge.
        "--ignore-certificate-errors",
        // Pin the tenant host to the owning node's loopback alias.
        `--host-resolver-rules=MAP ${host} ${NODE_IP}`,
    ],
});

const verdict = {};
try {
    const page = await browser.newPage();
    await page.setCookie({
        name: "__Host-devserver_gate",
        value: GATE_COOKIE,
        url: `${TENANT_BASE}/`,
        secure: true,
        httpOnly: true,
        path: "/",
    });

    // Any devserver-served document works here -- the SPA when bundles
    // are built, the no-bundle banner otherwise. What matters is the
    // tenant origin, so the iframe below is same-URL-but-opaque and
    // the watch socket's Origin header matches the gateway's check.
    await page.goto(`${TENANT_BASE}/${PREFIX}/`, { waitUntil: "domcontentloaded" });

    // Sandboxed iframe: the entry doc's own scripts report back over
    // postMessage; the parent cannot reach into the opaque frame.
    const iframeResult = await page.evaluate(
        ({ prefix, entryPath }) =>
            new Promise((resolve) => {
                const results = {};
                window.addEventListener("message", (event) => {
                    if (!event.data || event.data.kind !== "e2e-extension") return;
                    Object.assign(results, event.data);
                    if (results.appModule && (results.bogusStatus || results.bogusError)) {
                        resolve(results);
                    }
                });
                const frame = document.createElement("iframe");
                frame.setAttribute("sandbox", "allow-scripts");
                frame.src = `/${prefix}${entryPath}`;
                document.body.append(frame);
                setTimeout(() => resolve({ timeout: true, ...results }), 20_000);
            }),
        { prefix: PREFIX, entryPath: ENTRY_PATH },
    );
    Object.assign(verdict, iframeResult);

    // Watch-socket probe: the SPA's staleness recovery triggers on
    // watch reconnect, so the socket MUST drop when the devserver
    // bounces; a gateway that held it open would strand a surviving
    // page on a dead capability with no client-side signal.
    const wsBase = TENANT_BASE.replace(/^https:/, "wss:");
    const wsProbe = page.evaluate(
        ({ wsUrl, timeoutMs }) =>
            new Promise((resolve) => {
                const socket = new WebSocket(wsUrl);
                const opened = Date.now();
                socket.addEventListener("open", () => {
                    document.title = "e2e-ws-open";
                });
                socket.addEventListener("close", () => {
                    resolve({ wsOpened: true, wsClosed: true, wsMs: Date.now() - opened });
                });
                socket.addEventListener("error", () => {
                    // close always follows; resolve there so wsMs is real.
                });
                setTimeout(() => {
                    resolve({
                        wsOpened: document.title === "e2e-ws-open",
                        wsClosed: false,
                    });
                }, timeoutMs);
            }),
        { wsUrl: `${wsBase}/${PREFIX}/ws`, timeoutMs: WS_CLOSE_TIMEOUT_MS },
    );
    await page.waitForFunction(() => document.title === "e2e-ws-open", { timeout: 15_000 });
    console.log("ws-open");
    Object.assign(verdict, await wsProbe);
} catch (error) {
    verdict.scriptError = String(error);
} finally {
    fs.writeFileSync(VERDICT, JSON.stringify(verdict));
    await browser.close();
}
