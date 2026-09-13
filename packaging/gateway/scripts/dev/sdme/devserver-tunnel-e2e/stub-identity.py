#!/usr/bin/env python3
"""Narrow identity fixture for the cross-container tunnel E2E.

The real proxy still verifies signed admission and entry credentials. This
fixture owns only the omitted postgres-backed identity boundary: one exact PAT,
one immutable devserver owner, and two binary callers (owner or grantee). Each
caller can enter as the desktop, through the desktop entry route, or as a
browser, through a share landing; the credential names which, as identity's
does.
"""

from datetime import datetime, timedelta, timezone
import hmac
from html import escape
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import subprocess
import sys


USER_ID = os.environ["STUB_USER_ID"]
USERNAME = os.environ["STUB_USERNAME"]
GRANTEE_USER_ID = os.environ["STUB_GRANTEE_USER_ID"]
DEVSERVER_ID = os.environ["STUB_DEVSERVER_ID"]
PROXY_ID = os.environ["STUB_PROXY_ID"]
PROXY_ORIGIN = os.environ["STUB_PROXY_ORIGIN"]
AUDIENCE = os.environ["STUB_AUDIENCE"]
TUNNEL_PAT = os.environ["STUB_TUNNEL_PAT"]
INTERNAL_TOKEN = os.environ["STUB_IDENTITY_INTERNAL_TOKEN"]
OWNER_PAT = os.environ["STUB_DESKTOP_OWNER_PAT"]
GRANTEE_PAT = os.environ["STUB_DESKTOP_GRANTEE_PAT"]
# Stand-ins for identity's browser session cookie, one per caller.
OWNER_BROWSER_SESSION = os.environ["STUB_BROWSER_OWNER_SESSION"]
GRANTEE_BROWSER_SESSION = os.environ["STUB_BROWSER_GRANTEE_SESSION"]
BROWSER_SESSION_COOKIE = "stub_identity_session"
ADMISSION_SIGNING_KEY = os.environ["STUB_ADMISSION_SIGNING_KEY"]
ENTRY_SIGNING_KEY = os.environ["STUB_ENTRY_SIGNING_KEY"]
MINT = "/root/mint-signed-credential.py"


def mint(*args: str) -> str:
    result = subprocess.run(
        [sys.executable, MINT, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()


def bearer(headers) -> str:
    value = headers.get("Authorization", "")
    return value[7:] if value.startswith("Bearer ") else ""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[stub-identity] " + (fmt % args) + "\n")

    def json_response(self, code: int, value: dict):
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def request_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > 8192:
            return None
        try:
            value = json.loads(self.rfile.read(length))
        except Exception:
            return None
        return value if isinstance(value, dict) else None

    def do_POST(self):
        body = self.request_json()
        if body is None:
            return self.json_response(400, {"error": "bad request"})
        if self.path == "/internal/v1/tokens/validate":
            return self.validate_token(body)
        if self.path == "/desktop/v1/devserver/entry":
            return self.desktop_entry(body)
        return self.json_response(404, {"error": "not found"})

    def validate_token(self, body: dict):
        if not hmac.compare_digest(bearer(self.headers), INTERNAL_TOKEN):
            return self.json_response(401, {"error": "unauthorized"})
        token = body.get("token")
        if not isinstance(token, str) or not hmac.compare_digest(token, TUNNEL_PAT):
            return self.json_response(401, {"error": "unauthorized"})

        response = {
            "user_id": USER_ID,
            "username": USERNAME,
            "devserver_id": DEVSERVER_ID,
            "scopes": ["tunnel"],
        }
        registration_id = body.get("registration_id")
        proxy_id = body.get("proxy_id")
        if registration_id is not None or proxy_id is not None:
            if not isinstance(registration_id, str) or proxy_id != PROXY_ID:
                return self.json_response(400, {"error": "invalid admission binding"})
            try:
                lease = mint(
                    "admission",
                    f"--secret={ADMISSION_SIGNING_KEY}",
                    "--owner-user-id",
                    USER_ID,
                    "--user",
                    USERNAME,
                    "--devserver-id",
                    DEVSERVER_ID,
                    "--registration-id",
                    registration_id,
                    "--proxy-id",
                    PROXY_ID,
                )
            except Exception as error:
                sys.stderr.write(f"[stub-identity] admission mint failed: {error}\n")
                return self.json_response(503, {"error": "admission unavailable"})
            response["admission_lease"] = lease
            response["admission_lease_expires_at"] = (
                datetime.now(timezone.utc) + timedelta(seconds=120)
            ).isoformat().replace("+00:00", "Z")
        self.json_response(200, response)

    def mint_entry(self, subject: str, client: str, next_path: str) -> str:
        return mint(
            "entry",
            f"--secret={ENTRY_SIGNING_KEY}",
            "--sub",
            subject,
            "--owner-user-id",
            USER_ID,
            "--client",
            client,
            "--devserver-id",
            DEVSERVER_ID,
            "--audience",
            AUDIENCE,
            "--proxy-id",
            PROXY_ID,
            "--next-path",
            next_path,
        )

    def desktop_entry(self, body: dict):
        presented = bearer(self.headers)
        if hmac.compare_digest(presented, OWNER_PAT):
            subject = USER_ID
        elif hmac.compare_digest(presented, GRANTEE_PAT):
            subject = GRANTEE_USER_ID
        else:
            return self.json_response(401, {"error": "unauthorized"})
        if body.get("owner_user_id") != USER_ID or body.get("devserver_id") != DEVSERVER_ID:
            return self.json_response(404, {"error": "not found", "reason": "access_denied"})
        next_path = body.get("path") or "/"
        if (
            not isinstance(next_path, str)
            or not next_path.startswith("/")
            or next_path.startswith("//")
            or "://" in next_path
        ):
            return self.json_response(400, {"error": "invalid entry path"})
        try:
            credential = self.mint_entry(subject, "desktop", next_path)
        except Exception as error:
            sys.stderr.write(f"[stub-identity] entry mint failed: {error}\n")
            return self.json_response(503, {"error": "entry unavailable"})
        self.json_response(
            200,
            {
                "owner_user_id": USER_ID,
                "username": USERNAME,
                "devserver_id": DEVSERVER_ID,
                "proxy_origin": PROXY_ORIGIN,
                "entry_exchange_url": f"{PROXY_ORIGIN}/_chan/entry",
                "entry_credential": credential,
                "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=30))
                .isoformat()
                .replace("+00:00", "Z"),
            },
        )

    def share_landing(self):
        """`GET /s/{owner}` and `GET /s/{owner}/{workspace}`: identity's
        browser handoff, a no-store page whose form POSTs a browser credential
        to the proxy. The whole-devserver landing is the owner's alone."""
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        session = cookie[BROWSER_SESSION_COOKIE].value if BROWSER_SESSION_COOKIE in cookie else ""
        if session and hmac.compare_digest(session, OWNER_BROWSER_SESSION):
            subject = USER_ID
        elif session and hmac.compare_digest(session, GRANTEE_BROWSER_SESSION):
            subject = GRANTEE_USER_ID
        else:
            return self.json_response(401, {"error": "unauthorized"})
        segments = self.path.split("?", 1)[0].split("/")[2:]
        if not segments or segments[0] != USERNAME or len(segments) > 2:
            return self.json_response(404, {"error": "not found"})
        if len(segments) == 1:
            if subject != USER_ID:
                return self.json_response(404, {"error": "not found"})
            next_path = "/"
        elif segments[1] and "." not in segments[1]:
            next_path = f"/{segments[1]}/"
        else:
            return self.json_response(404, {"error": "not found"})
        try:
            credential = self.mint_entry(subject, "browser", next_path)
        except Exception as error:
            sys.stderr.write(f"[stub-identity] entry mint failed: {error}\n")
            return self.json_response(503, {"error": "entry unavailable"})
        body = (
            '<!doctype html><html><body><form method="post" action="'
            + escape(f"{PROXY_ORIGIN}/_chan/entry")
            + '"><input type="hidden" name="credential" value="'
            + escape(credential)
            + '"></form></body></html>'
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            return self.json_response(200, {"ok": True})
        if self.path.startswith("/s/"):
            return self.share_landing()
        return self.json_response(404, {"error": "not found"})


def main():
    bind = os.environ.get("STUB_BIND", "127.0.0.1:7799")
    host, port = bind.rsplit(":", 1)
    server = ThreadingHTTPServer((host, int(port)), Handler)
    sys.stderr.write(
        f"[stub-identity] listening on {bind}; "
        f"devserver_id={DEVSERVER_ID[:12]} proxy_id={PROXY_ID}\n"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
