# peer-http.py ADDR PORT LOG NONCE: the far side of desktop-wireguard-windows.sh,
# run on the kernel peer bound to its tunnel address. Every request is logged
# as one `request:` line with the client address, so a request that came
# through the tunnel reads from=<client tunnel address>. `/` serves a page that
# names the nonce, then fetches /beacon and opens a WebSocket to /ws from the
# page (a browser sends ws:// to a proxy as CONNECT, so that leg is the
# CONNECT path); everything else but /beacon and /ws answers 404.
import base64
import hashlib
import http.server
import os
import sys
import time

ADDR, PORT, LOG, NONCE = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
KERNEL = os.uname().release
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>wg-webview {nonce}</title>
<style>
body {{ font: 22px system-ui, sans-serif; margin: 40px; background: #0b3d2e; color: #e8fff4; }}
h1 {{ font-size: 40px; margin: 0 0 16px; }}
code {{ background: #14563f; padding: 2px 6px; }}
#ws, #beacon {{ font-weight: bold; }}
</style></head>
<body>
<h1>chan-wireguard webview proof</h1>
<p>nonce <code>{nonce}</code></p>
<p>served by the kernel WireGuard peer ({kernel}) on <code>{addr}:{port}</code></p>
<p>request came from <code>{client}</code></p>
<p>page origin <code id="origin"></code></p>
<p>beacon: <span id="beacon">pending</span></p>
<p>websocket: <span id="ws">pending</span></p>
<p id="ua" style="font-size:14px"></p>
<script>
document.getElementById('origin').textContent = location.origin;
document.getElementById('ua').textContent = navigator.userAgent;
fetch('/beacon?nonce={nonce}&kind=fetch').then(r => r.text()).then(t => {{
  document.getElementById('beacon').textContent = t;
}}).catch(e => {{ document.getElementById('beacon').textContent = 'failed: ' + e; }});
try {{
  const ws = new WebSocket('ws://' + location.host + '/ws?nonce={nonce}');
  ws.onmessage = ev => {{
    document.getElementById('ws').textContent = ev.data;
    fetch('/beacon?nonce={nonce}&kind=ws-' + encodeURIComponent(ev.data));
  }};
  ws.onerror = () => {{ document.getElementById('ws').textContent = 'error'; }};
}} catch (e) {{ document.getElementById('ws').textContent = 'threw: ' + e; }}
</script>
</body></html>
"""


def log(line):
    with open(LOG, "a") as f:
        f.write(line + "\n")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def record(self, status):
        client = "%s:%s" % self.client_address[:2]
        log(
            "request: at=%s from=%s line=%s status=%s host=%s upgrade=%s ua=%s"
            % (
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                client,
                self.requestline.replace(" ", "_"),
                status,
                self.headers.get("Host", "-"),
                self.headers.get("Upgrade", "-"),
                (self.headers.get("User-Agent", "-") or "-").replace(" ", "_"),
            )
        )

    def send_body(self, status, ctype, body):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
            self.record(101)
            key = self.headers.get("Sec-WebSocket-Key", "")
            accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            msg = ("hello-from-peer-" + NONCE).encode()
            self.wfile.write(bytes([0x81, len(msg)]) + msg)
            self.wfile.flush()
            time.sleep(2)
            self.wfile.write(bytes([0x88, 0x00]))
            self.close_connection = True
            return
        if path == "/":
            self.record(200)
            client = "%s:%s" % self.client_address[:2]
            self.send_body(
                200,
                "text/html; charset=utf-8",
                PAGE.format(nonce=NONCE, kernel=KERNEL, addr=ADDR, port=PORT, client=client),
            )
            return
        if path == "/beacon":
            self.record(200)
            self.send_body(200, "text/plain", "beacon-ok-" + NONCE)
            return
        self.record(404)
        self.send_body(404, "text/plain", "not found\n")

    do_POST = do_GET
    do_HEAD = do_GET


server = http.server.ThreadingHTTPServer((ADDR, PORT), Handler)
log("ready: addr=%s:%s nonce=%s kernel=%s" % (ADDR, PORT, NONCE, KERNEL))
server.serve_forever()
