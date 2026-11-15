# Model download TLS fixtures

These files are copies of the public test CA, localhost leaf and unencrypted PKCS#8 leaf key used by the updater's TLS tests in `crates/chan/src/update/testdata/`. They are test material, never production credentials. The CA's private key is not retained. Tests add this CA only to their own injected client configuration and do not modify system trust.

The leaf covers `DNS:localhost` and `IP:127.0.0.1`, with server authentication validity from 2026-11-14 18:57:04 UTC through 2056-11-06 18:57:04 UTC. Both certificates and the private key are DER. Their SHA256 hashes identify the copied bytes:

- `ca.der`: `9aaf289a05ed5ee90e4c35d6ffe30f8d3d1132841e6839bd0eadcc322d6afb09`.
- `localhost.der`: `115eb1abb03e5ef69d4bd797c1478f1149e313e9039a3040884d4e1439fc72e1`.
- `localhost-key.pk8`: `bffa666b0956e2578c11f14825a0dc0a0fdbe2aaacde751cf0b6e134563c6d37`.

To regenerate, create an ECDSA P-256 CA with critical `basicConstraints=CA:TRUE` and `keyUsage=keyCertSign,cRLSign`. Sign an ECDSA P-256 leaf with critical `basicConstraints=CA:FALSE`, `keyUsage=digitalSignature`, `extendedKeyUsage=serverAuth`, and `subjectAltName=DNS:localhost,IP:127.0.0.1`; export the certificates and the leaf's unencrypted PKCS#8 key as DER.
