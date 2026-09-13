#!/usr/bin/env python3
"""The smallest local extension the devserver tunnel e2e needs.

chan spawns it from ~/.chan/extensions/e2e.toml. It serves an entry document
at `/` and an echo endpoint at `/echo` on 127.0.0.1, refuses any request
without the upstream token chan appends, and appends one JSON line per
request it serves to E2E_EXTENSION_LOG, so the harness can prove from the
extension's side exactly which requests reached it.
"""

import http.server
import json
import os
import secrets
import urllib.parse

TOKEN = secrets.token_hex(32)
LOG = os.environ.get("E2E_EXTENSION_LOG", "/root/e2e-extension-requests.log")
ENTRY = b"<!doctype html><meta charset=utf-8><title>e2e extension</title><p>e2e-extension-entry</p>\n"


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, body, content_type="text/plain; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve(self):
        path, _, query = self.path.partition("?")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if urllib.parse.parse_qs(query).get("t") != [TOKEN]:
            self.reply(401, b"")
            return
        with open(LOG, "a") as log:
            log.write(json.dumps({
                "method": self.command,
                "path": path,
                "body": body.decode(errors="replace"),
            }) + "\n")
        if path == "/" and self.command == "GET":
            self.reply(200, ENTRY, "text/html; charset=utf-8")
        elif path == "/echo":
            self.reply(200, f"e2e-extension-echo {self.command} {body.decode(errors='replace')}".encode())
        else:
            self.reply(404, b"")

    do_GET = serve
    do_POST = serve


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    print("CHAN_EXTENSION_V1=" + json.dumps({"url": f"http://127.0.0.1:{port}/", "token": TOKEN}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
