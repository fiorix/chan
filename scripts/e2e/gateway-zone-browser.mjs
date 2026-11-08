// Headless-Chrome half of the gateway-zone e2e: sign in through the
// stubbed OAuth, walk the account-mode desktop-authorize consent, and
// hand the loopback callback URL or account setup hints back to the harness.
//
// Env: CHROME_BIN, ID_ORIGIN (https://id.localtest.me:PORT), and either
//   - AUTH_PATH (/desktop/authorize?...), LOOPBACK_PORT, and REDIRECT_URI
//     for the full consent + PKCE flow, or
//   - LOGIN_ONLY=1 to just sign in via /auth/github and print the URL, or
//   - HINT=1 to read the Devservers and Tokens setup hints after sign-in.
//
// In consent mode the script binds a tiny loopback listener on
// LOOPBACK_PORT so the consent handoff page's meta refresh has somewhere
// to land; it returns the captured callback URL for the harness to redeem
// with its PKCE verifier.
//
// Prints one JSON object on stdout:
//   consent mode: { radios: [...], consent_text: "...", callback_url: "..." }
//   login mode:   { login_url: "..." }
//   hint mode:    { command, devservers_intro, offline_hints, tokens_hint,
//                   tokens_command, discovery_requests }
// radios reports any input[name="devserver"] on the consent page so
// the harness can assert the consent renders no picker. Exits nonzero on
// navigation/shape failures; content assertions stay in the harness.
import http from "http";
import puppeteer from "puppeteer-core";

const {
    CHROME_BIN,
    ID_ORIGIN,
    AUTH_PATH,
    LOOPBACK_PORT,
    REDIRECT_URI,
    LOGIN_ONLY,
    HINT,
} = process.env;
if (!CHROME_BIN || !ID_ORIGIN) {
    console.error("missing CHROME_BIN / ID_ORIGIN");
    process.exit(2);
}
const hintMode = HINT === "1" || HINT === "true";
const loginOnly = hintMode || LOGIN_ONLY === "1" || LOGIN_ONLY === "true";
if (!loginOnly && (!AUTH_PATH || !LOOPBACK_PORT || !REDIRECT_URI)) {
    console.error(
        "missing AUTH_PATH / LOOPBACK_PORT / REDIRECT_URI (or set LOGIN_ONLY=1 / HINT=1)",
    );
    process.exit(2);
}

const CALLBACK_TIMEOUT_MS = 30000;

function startLoopbackListener(port) {
    return new Promise((resolve, reject) => {
        let captured = null;
        let timeout = null;
        const server = http.createServer((req, res) => {
            if (!captured) {
                captured = `http://127.0.0.1:${port}${req.url}`;
            }
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<!doctype html><html><body>You can close this tab.</body></html>");
            if (timeout) {
                clearTimeout(timeout);
            }
            server.closeAllConnections?.();
            server.close(() => resolve(captured));
        });
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => {
            timeout = setTimeout(() => {
                server.closeAllConnections?.();
                server.close(() => reject(new Error("loopback callback timeout")));
            }, CALLBACK_TIMEOUT_MS);
        });
    });
}

const capturedPromise = loginOnly ? null : startLoopbackListener(Number(LOOPBACK_PORT));
let browser = null;

try {
    browser = await puppeteer.launch({
        executablePath: CHROME_BIN,
        headless: "new",
        args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--ignore-certificate-errors",
            "--host-resolver-rules=MAP *.localtest.me 127.0.0.1",
        ],
    });

    const page = await browser.newPage();
    let discoveryRequests = 0;
    const pageErrors = [];
    if (hintMode) {
        page.on("request", (request) => {
            if (new URL(request.url()).pathname === "/.well-known/chan-gateway") {
                discoveryRequests += 1;
            }
        });
        page.on("pageerror", (error) => { pageErrors.push(error.message); });
    }

    if (loginOnly) {
        await page.goto(`${ID_ORIGIN}/auth/github`, { waitUntil: "networkidle2" });
        if (new URL(page.url()).origin !== ID_ORIGIN) {
            console.error(`expected the identity origin after login, got ${page.url()}`);
            process.exitCode = 3;
        } else if (hintMode) {
            await page.goto(`${ID_ORIGIN}/#workspaces`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".devservers .block > p");
            await page.waitForFunction(() =>
                [...document.querySelectorAll(".devservers .card.offline .label")]
                    .some((label) => label.textContent.trim() === "account-page-command"),
            );
            await page.waitForNetworkIdle({ idleTime: 200 });
            const devservers = await page.$eval(".devservers", (element) => {
                const intro = element.querySelector(".block > p");
                return {
                    devservers_intro: intro.textContent,
                    command: intro.querySelector(".tunnel-command")?.textContent ?? intro.textContent,
                    offline_hints: [...element.querySelectorAll(".card.offline .meta")]
                        .map((row) => row.textContent),
                };
            });
            await page.goto(`${ID_ORIGIN}/#tokens`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".page > p.muted");
            await page.waitForNetworkIdle({ idleTime: 200 });
            const tokens = await page.$eval(".page > p.muted", (element) => ({
                tokens_hint: element.textContent,
                tokens_command: element.querySelector(".tunnel-command")?.textContent ?? element.textContent,
            }));
            if (pageErrors.length) {
                throw new Error(`account page errors: ${pageErrors.join("; ")}`);
            }
            console.log(JSON.stringify({
                ...devservers,
                ...tokens,
                discovery_requests: discoveryRequests,
            }));
        } else {
            console.log(JSON.stringify({ login_url: page.url() }));
        }
    } else {
        // Stash the pending authorize (unauthenticated: bounces to /).
        await page.goto(`${ID_ORIGIN}${AUTH_PATH}`, { waitUntil: "networkidle2" });

        // Sign in via the stubbed provider; auth_callback resumes the
        // stashed authorize and lands on the consent page.
        await page.goto(`${ID_ORIGIN}/auth/github`, { waitUntil: "networkidle2" });
        if (!page.url().includes("/desktop/authorize/consent")) {
            console.error(`expected the consent page, got ${page.url()}`);
            process.exit(3);
        }

        const radios = await page.$$eval('input[name="devserver"]', (els) =>
            els.map((el) => el.value),
        );
        const consentText = await page.$eval("body", (el) => el.innerText);

        // Authorize. The consent POST answers a 200 handoff page that
        // meta-refreshes to the loopback callback; the loopback listener
        // captures the URL the browser actually navigates to.
        await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2" }),
            page.click('button[name="action"][value="allow"]'),
        ]);

        const callbackUrl = await capturedPromise;
        if (!callbackUrl) {
            console.error("loopback callback was not captured");
            process.exit(3);
        }
        if (!callbackUrl.startsWith(REDIRECT_URI)) {
            console.error(`expected callback at ${REDIRECT_URI}, got ${callbackUrl}`);
            process.exit(3);
        }

        console.log(
            JSON.stringify({
                radios,
                consent_text: consentText,
                callback_url: callbackUrl,
            }),
        );
    }
} finally {
    if (browser) {
        await browser.close();
    }
}
