// Headless-Chrome half of the gateway-zone e2e: sign in through the
// stubbed OAuth, walk the account-mode desktop-authorize consent, and
// hand the chan:// callback URL back to the harness.
//
// Env: CHROME_BIN, ID_ORIGIN (https://id.localtest.me:PORT), and either
// AUTH_PATH (the /desktop/authorize?... query) or LOGIN_ONLY=1. Prints one JSON
// object on stdout:
//   { radios: [values...], consent_text: "...", handoff_url: "chan://..." }
// radios reports any input[name="devserver"] on the consent page so
// the harness can assert the consent renders no picker. Exits nonzero on
// navigation/shape failures; content assertions stay in the harness
// so the log reads as one assert list.
import puppeteer from "puppeteer-core";

const { CHROME_BIN, ID_ORIGIN, AUTH_PATH, LOGIN_ONLY } = process.env;
if (!CHROME_BIN || !ID_ORIGIN || (!LOGIN_ONLY && !AUTH_PATH)) {
    console.error("missing CHROME_BIN / ID_ORIGIN / AUTH_PATH");
    process.exit(2);
}

const browser = await puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: "new",
    args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // The local full-stack harness uses a fresh per-run CA. Chromium is
        // isolated from the host trust store, so permit only this test launch
        // to navigate the loopback TLS edge.
        "--ignore-certificate-errors",
        // The wildcard + id hosts must hit the loopback listeners even
        // if the sandbox resolver prefers AAAA records.
        "--host-resolver-rules=MAP *.localtest.me 127.0.0.1",
    ],
});

try {
    const page = await browser.newPage();

    if (LOGIN_ONLY) {
        await page.goto(`${ID_ORIGIN}/auth/github`, { waitUntil: "networkidle2" });
        if (new URL(page.url()).origin !== ID_ORIGIN) {
            console.error(`expected the identity origin after login, got ${page.url()}`);
            process.exitCode = 3;
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

        // Authorize. The handoff answers the form POST as a 200 page
        // whose primary button carries the chan:// URL (the meta refresh
        // to a custom scheme is a no-op in headless Chrome).
        await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2" }),
            page.click('button[name="action"][value="allow"]'),
        ]);
        const handoff = await page.$eval("a.btn.primary", (a) => a.getAttribute("href"));
        if (!handoff || !handoff.startsWith("chan://auth/callback#")) {
            console.error(`expected a chan:// handoff link, got ${handoff}`);
            process.exit(3);
        }

        console.log(
            JSON.stringify({
                radios,
                consent_text: consentText,
                handoff_url: handoff,
            }),
        );
    }
} finally {
    await browser.close();
}
