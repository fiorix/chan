# Updater TLS fixtures

These files are a test CA, a leaf for `localhost` and `127.0.0.1`, and the leaf's unencrypted PKCS#8 private key. They are public test material, never production credentials. The CA's private key is not retained here. The leaf verifies for server authentication from 2026-11-14 through 2056-11-06.

The fixture was made with OpenSSL. To replace it, generate an ECDSA P-256 CA with critical `basicConstraints=CA:TRUE` and `keyUsage=keyCertSign,cRLSign`; sign an ECDSA P-256 leaf carrying critical `basicConstraints=CA:FALSE`, `keyUsage=digitalSignature`, `extendedKeyUsage=serverAuth`, and `subjectAltName=DNS:localhost,IP:127.0.0.1`. Export both certificates as DER and the leaf's key as unencrypted PKCS#8 DER. The tests load the CA only into their own clients and do not modify any system trust store.
