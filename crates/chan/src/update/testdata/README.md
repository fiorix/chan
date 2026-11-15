# Updater TLS fixtures

These files are a test CA, a leaf for `localhost` and `127.0.0.1`, and the leaf's unencrypted PKCS#8 private key. They are public test material, never production credentials. The CA's private key is not retained here. The leaf verifies for server authentication from 2026-11-14 through 2056-11-06.

The tests load the CA only into their own clients and do not modify any system trust store. To replace all three files, run the following from the repository root with OpenSSL. The commands generate fresh random ECDSA P-256 keys and certificates valid for 10,950 days from generation; they preserve the fixture's subjects, serials, extensions and formats, but do not reproduce its bytes. Update the validity dates above after replacement. The temporary CA key is removed when the command finishes.

```sh
(
    set -eu
    fixture_dir="$PWD/crates/chan/src/update/testdata"
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
