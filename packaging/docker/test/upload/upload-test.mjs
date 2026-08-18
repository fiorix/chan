// Browser-upload proof (D4).
//
// A real headless Chromium, from the chan page's own origin, POSTs a multipart
// file to /api/fs/upload exactly as the SPA's uploadFile() does (form fields
// `file` + `dir`). Success proves the browser client is NOT subject to
// chan-desktop's Tauri upload ACL: that ACL gates the desktop client only.
//
// The upload is driven inside page.evaluate so the request originates from the
// browser, not from Node. When the chan workspace volume is also mounted into
// this container (WORKSPACE_PATH), the landed file is stat'd as an independent
// on-disk confirmation.
//
// Diagnostics -> stderr; the final PASS/FAIL line -> stdout. Exit 0 on success.
import { statSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const CHAN_URL = process.env.CHAN_URL ?? "http://127.0.0.1:8787";
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? ".";
const TOKEN = process.env.CHAN_TOKEN ?? "";
const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? "/workspace";
const FILENAME = process.env.FILENAME ?? "browser-upload-proof.txt";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
const BODY_TEXT = `uploaded by headless chromium at run ${process.pid}\n`;

const log = (...a) => console.error("[upload-test]", ...a);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer (even 401/404) means the listener is up.
      const r = await fetch(url, { method: "GET" });
      log(`server reachable: GET ${url} -> ${r.status}`);
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  fail(`chan server not reachable at ${url} within ${timeoutMs}ms`);
}

async function main() {
  log(`target chan: ${CHAN_URL}  dir=${UPLOAD_DIR}  token=${TOKEN ? "yes" : "no"}`);
  await waitForServer(CHAN_URL);

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    // Establish the chan origin so the upload fetch below is same-origin, the
    // way a user's browser tab would issue it. A non-2xx root is fine; we only
    // need the document origin set.
    const resp = await page.goto(CHAN_URL, { waitUntil: "domcontentloaded" })
      .catch((e) => { log(`goto warning: ${e.message}`); return null; });
    log(`page origin established (root status ${resp ? resp.status() : "n/a"})`);

    const result = await page.evaluate(
      async (base, dir, filename, body, token) => {
        const form = new FormData();
        form.append("file", new File([body], filename, { type: "text/plain" }));
        form.append("dir", dir);
        const headers = {};
        if (token) headers["authorization"] = `Bearer ${token}`;
        const r = await fetch(`${base}/api/fs/upload`, {
          method: "POST",
          headers,
          body: form,
        });
        return { status: r.status, ok: r.ok, text: await r.text() };
      },
      CHAN_URL, UPLOAD_DIR, FILENAME, BODY_TEXT, TOKEN,
    );

    log(`upload response: ${result.status} ${result.text}`);
    if (!result.ok) fail(`upload returned HTTP ${result.status}: ${result.text}`);

    let parsed;
    try { parsed = JSON.parse(result.text); } catch { parsed = null; }
    if (!parsed || typeof parsed.size !== "number") {
      fail(`upload response is not the expected {path,size} JSON: ${result.text}`);
    }
    const expected = Buffer.byteLength(BODY_TEXT);
    if (parsed.size !== expected) {
      fail(`server reported size ${parsed.size}, expected ${expected}`);
    }
    log(`server accepted upload: path=${parsed.path} size=${parsed.size}`);

    // Independent on-disk confirmation when the workspace volume is shared in.
    const landed = join(WORKSPACE_PATH, UPLOAD_DIR === "." ? "" : UPLOAD_DIR, FILENAME);
    try {
      const st = statSync(landed);
      if (st.size !== expected) fail(`on-disk size ${st.size} != ${expected} at ${landed}`);
      log(`on-disk confirmation: ${landed} (${st.size} bytes)`);
    } catch (e) {
      log(`on-disk check skipped/failed (${landed}): ${e.message} -- server response already proves the upload`);
    }

    console.log(`PASS: browser upload landed (path=${parsed.path}, size=${parsed.size})`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => fail(e?.stack || String(e)));
