#!/usr/bin/env python3
"""Mint Ed25519 entry credentials and admission leases for the sdme rig.

The helper intentionally emits only immutable identifiers and protocol fields.
It never embeds display names, email addresses, grants, or bearer credentials.
"""

import argparse
import base64
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


ED25519_OID = b"\x2b\x65\x70"


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode_seed(encoded: str) -> bytes:
    padding = "=" * ((4 - len(encoded) % 4) % 4)
    try:
        seed = base64.urlsafe_b64decode(encoded + padding)
    except Exception as error:
        raise ValueError("secret must be canonical base64url") from error
    if len(seed) != 32 or b64u(seed) != encoded:
        raise ValueError("secret must be canonical base64url for exactly 32 bytes")
    return seed


def der_length(length: int) -> bytes:
    if length < 128:
        return bytes([length])
    encoded = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(encoded)]) + encoded


def tlv(tag: int, value: bytes) -> bytes:
    return bytes([tag]) + der_length(len(value)) + value


def pkcs8(seed: bytes) -> bytes:
    algorithm = tlv(0x30, tlv(0x06, ED25519_OID))
    return tlv(0x30, tlv(0x02, b"\x00") + algorithm + tlv(0x04, tlv(0x04, seed)))


def sign(secret: str, message: bytes) -> bytes:
    seed = decode_seed(secret)
    with tempfile.TemporaryDirectory(prefix="chan-e2e-ed25519-") as directory:
        key = Path(directory) / "key.der"
        message_file = Path(directory) / "message"
        key.write_bytes(pkcs8(seed))
        message_file.write_bytes(message)
        result = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-sign",
                "-rawin",
                "-keyform",
                "DER",
                "-inkey",
                str(key),
                "-in",
                str(message_file),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def json_bytes(value: dict) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def entry(args: argparse.Namespace) -> str:
    now = int(time.time())
    claims = {
        "purpose": "chan.devserver.entry",
        "version": 1,
        "iss": "chan-gateway-identity",
        "sub": str(uuid.UUID(args.sub)),
        "owner_user_id": str(uuid.UUID(args.owner_user_id)),
        # The client the credential is for: identity's desktop entry route
        # mints "desktop", its browser share landings mint "browser".
        "client": args.client,
        "drv": args.devserver_id,
        "aud": args.audience.lower(),
        "typ": "entry",
        "proxy_id": args.proxy_id,
        "jti": str(uuid.uuid4()),
        "next_path": args.next_path,
        "iat": now,
        "exp": now + 30,
    }
    if not args.next_path.startswith("/") or args.next_path.startswith("//"):
        raise ValueError("next path must be a clean relative absolute path")
    header = b64u(b'{"alg":"EdDSA","typ":"JWT"}')
    payload = b64u(json_bytes(claims))
    signed = f"{header}.{payload}".encode("ascii")
    return f"{signed.decode('ascii')}.{b64u(sign(args.secret, signed))}"


def admission(args: argparse.Namespace) -> str:
    now = int(time.time())
    claims = {
        "purpose": "chan.devserver.admission",
        # devserver-control-proto PROTOCOL_VERSION.
        "protocol_version": 2,
        "owner_user_id": str(uuid.UUID(args.owner_user_id)),
        "user": args.user,
        "devserver_id": args.devserver_id,
        "registration_id": str(uuid.UUID(args.registration_id)),
        "proxy_id": args.proxy_id,
        # Identity signs a positive per-user cap; the rig's control service
        # runs with MAX_DEVSERVERS_PER_USER=2, so mint the same bound.
        "max_connected_devservers": 2,
        "issued_at": now,
        "expires_at": now + 120,
    }
    payload = b64u(json_bytes(claims))
    signed = f"v1.{payload}".encode("ascii")
    return f"{signed.decode('ascii')}.{b64u(sign(args.secret, signed))}"


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="kind", required=True)

    entry_parser = subparsers.add_parser("entry")
    entry_parser.add_argument("--secret", required=True)
    entry_parser.add_argument("--sub", required=True)
    entry_parser.add_argument("--owner-user-id", required=True)
    entry_parser.add_argument("--client", required=True, choices=["desktop", "browser"])
    entry_parser.add_argument("--devserver-id", required=True)
    entry_parser.add_argument("--audience", required=True)
    entry_parser.add_argument("--proxy-id", required=True)
    entry_parser.add_argument("--next-path", required=True)

    admission_parser = subparsers.add_parser("admission")
    admission_parser.add_argument("--secret", required=True)
    admission_parser.add_argument("--owner-user-id", required=True)
    admission_parser.add_argument("--user", required=True)
    admission_parser.add_argument("--devserver-id", required=True)
    admission_parser.add_argument("--registration-id", required=True)
    admission_parser.add_argument("--proxy-id", required=True)

    args = parser.parse_args()
    print(entry(args) if args.kind == "entry" else admission(args))


if __name__ == "__main__":
    main()
