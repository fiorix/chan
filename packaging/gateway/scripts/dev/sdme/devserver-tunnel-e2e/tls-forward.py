#!/usr/bin/env python3
"""TLS-to-loopback forwarder with an exact public-http or tunnel-h2 ALPN."""

import argparse
import socket
import ssl
import threading


def copy(source: socket.socket, destination: socket.socket) -> None:
    try:
        while chunk := source.recv(64 * 1024):
            destination.sendall(chunk)
    except (OSError, ssl.SSLError):
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def forward(client: socket.socket, target_host: str, target_port: int) -> None:
    try:
        upstream = socket.create_connection((target_host, target_port), timeout=5)
    except OSError:
        client.close()
        return
    # create_connection leaves its connect deadline on the socket. A forwarded
    # connection carries nothing between uses, so the established socket gets none.
    upstream.settimeout(None)
    threading.Thread(target=copy, args=(client, upstream), daemon=True).start()
    threading.Thread(target=copy, args=(upstream, client), daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--protocol", choices=("http1", "h2"), required=True)
    args = parser.parse_args()

    listen_host, listen_port = args.listen.rsplit(":", 1)
    target_host, target_port = args.target.rsplit(":", 1)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(args.cert, args.key)
    context.set_alpn_protocols(["h2" if args.protocol == "h2" else "http/1.1"])

    with socket.create_server((listen_host, int(listen_port)), reuse_port=False) as server:
        while True:
            raw_client, _ = server.accept()
            try:
                client = context.wrap_socket(raw_client, server_side=True)
            except (OSError, ssl.SSLError):
                raw_client.close()
                continue
            forward(client, target_host, int(target_port))


if __name__ == "__main__":
    main()
