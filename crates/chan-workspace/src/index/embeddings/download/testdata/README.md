# Model download TLS fixtures

These files are a test CA, a localhost leaf and the leaf's unencrypted PKCS#8 private key. They are public test material, never production credentials. The CA's private key is not retained. Tests add this CA only to their own injected client configuration and do not modify system trust.

The leaf covers `DNS:localhost` and `IP:127.0.0.1`, with server authentication validity from 2026-11-14 18:57:04 UTC through 2056-11-06 18:57:04 UTC. Both certificates and the private key are DER. Their SHA256 hashes identify the checked-in bytes:

- `ca.der`: `9aaf289a05ed5ee90e4c35d6ffe30f8d3d1132841e6839bd0eadcc322d6afb09`.
- `localhost.der`: `115eb1abb03e5ef69d4bd797c1478f1149e313e9039a3040884d4e1439fc72e1`.
- `localhost-key.pk8`: `bffa666b0956e2578c11f14825a0dc0a0fdbe2aaacde751cf0b6e134563c6d37`.

To replace all three files, run the following from the repository root with OpenSSL. The commands generate fresh random ECDSA P-256 keys and certificates valid for 10,950 days from generation; they preserve the fixture's subjects, serials, extensions and formats, but do not reproduce its bytes. The CA subject retains `chan updater test fixture CA` to match the subject in the checked-in `ca.der` bytes. Update the validity dates and hashes above after replacement. The temporary CA key is removed when the command finishes.

```sh
(
    set -eu
    fixture_dir="$PWD/crates/chan-workspace/src/index/embeddings/download/testdata"
    fixture_tmp=$(mktemp -d)
    trap 'rm -rf "$fixture_tmp"' EXIT

    openssl req -new -x509 -config /dev/null \
        -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
        -sha256 -days 10950 -set_serial 1 \
        -subj '/CN=chan updater test fixture CA' \
        -addext 'basicConstraints=critical,CA:TRUE' \
        -addext 'keyUsage=critical,keyCertSign,cRLSign' \
        -addext 'subjectKeyIdentifier=hash' \
        -addext 'authorityKeyIdentifier=keyid:always' \
        -keyout "$fixture_tmp/ca.key" -out "$fixture_tmp/ca.pem"
    openssl req -new -config /dev/null \
        -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
        -sha256 -subj '/CN=localhost' \
        -keyout "$fixture_tmp/localhost.key" -out "$fixture_tmp/localhost.csr"
    cat > "$fixture_tmp/localhost.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
    openssl x509 -req -in "$fixture_tmp/localhost.csr" \
        -CA "$fixture_tmp/ca.pem" -CAkey "$fixture_tmp/ca.key" \
        -set_serial 2 -days 10950 -sha256 \
        -extfile "$fixture_tmp/localhost.ext" -out "$fixture_tmp/localhost.pem"
    openssl verify -CAfile "$fixture_tmp/ca.pem" -purpose sslserver \
        -verify_hostname localhost "$fixture_tmp/localhost.pem"
    openssl verify -CAfile "$fixture_tmp/ca.pem" -purpose sslserver \
        -verify_ip 127.0.0.1 "$fixture_tmp/localhost.pem"
    openssl x509 -in "$fixture_tmp/ca.pem" -outform DER \
        -out "$fixture_dir/ca.der"
    openssl x509 -in "$fixture_tmp/localhost.pem" -outform DER \
        -out "$fixture_dir/localhost.der"
    openssl pkcs8 -topk8 -nocrypt -in "$fixture_tmp/localhost.key" \
        -outform DER -out "$fixture_dir/localhost-key.pk8"
)
```

`bge-small-en-v1.5-config.json` is `BAAI/bge-small-en-v1.5`'s `config.json` at the commit the model table pins, byte for byte: the inspecting-proxy test serves it to the production client, which accepts it only when its sha256 is the pinned one. When the pin moves, fetch it again from `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/<commit>/config.json`; the test names the commit when the file no longer matches.
