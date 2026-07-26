// Stub GitHub OAuth + API for the gateway-zone e2e. identity points
// at this origin via IDENTITY_OAUTH_ENDPOINTS_BASE; the stub answers
// the four endpoints the sign-in flow touches and asserts nothing.
//
//   node stub-oauth.mjs <port> <email> [provider-subject]
//
// The authorize endpoint bounces straight back to the caller-supplied
// redirect_uri with a fixed code and the echoed state, so a headless
// browser sails through "GitHub" without rendering anything.
import http from "node:http";

const [port, email, subject = "424242"] = process.argv.slice(2);
if (!port || !email) {
    console.error("usage: stub-oauth.mjs <port> <email> [provider-subject]");
    process.exit(2);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/login/oauth/authorize") {
        const redirect = new URL(url.searchParams.get("redirect_uri"));
        redirect.searchParams.set("code", "stub-code");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { location: redirect.toString() });
        res.end();
        return;
    }
    if (url.pathname === "/login/oauth/access_token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
            JSON.stringify({
                access_token: "stub-access",
                token_type: "Bearer",
                scope: "read:user,user:email",
            }),
        );
        return;
    }
    if (url.pathname === "/user") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
            JSON.stringify({
                id: Number(subject),
                login: "e2e-user",
                name: "E2E User",
                email,
            }),
        );
        return;
    }
    if (url.pathname === "/user/emails") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ email, primary: true, verified: true }]));
        return;
    }
    res.writeHead(404);
    res.end("stub-oauth: unknown path");
});

server.listen(Number(port), "127.0.0.1", () => {
    console.log(`stub-oauth listening on 127.0.0.1:${port} as ${email} (${subject})`);
});
