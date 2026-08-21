# Updater Signing Runbook

The updater key is separate from Apple Developer ID signing and notarization. Apple signing controls whether macOS trusts the app bundle. The updater minisign key controls whether an installed Chan app accepts a downloaded update payload.

Two updater keypairs have existed: an early DEV key, and the production key whose pubkey is embedded in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey` (rotated in commit `3c1435b`; a one-time bridge release signed with the old key carried existing installs across). Every updater payload, the macOS `.app.tar.gz` and each Linux `.AppImage`, is signed with the production key.

## Key And Secret Rules

Private key values and passwords must not be printed, committed, or pasted into logs.

Public key material is not secret. To inspect the currently embedded updater pubkey without printing the full key:

```sh
cd desktop
node -e 'const c=require("./src-tauri/tauri.conf.json"); const crypto=require("crypto"); const k=c.plugins.updater.pubkey; console.log(`updater pubkey length=${k.length} sha256=${crypto.createHash("sha256").update(k).digest("hex")}`)'
```

To confirm local key files by presence only:

```sh
test -f ~/.tauri/chan-desktop.key && echo old-dev-key-file-present
test -f ~/.tauri/chan-desktop-prod.key && echo prod-key-file-present
test -f ~/.tauri/chan-desktop-prod.key.pub && echo prod-pubkey-file-present
```

## Signing An Updater Payload

```sh
cd desktop/src-tauri
TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/chan-desktop-prod.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
cargo tauri signer sign <UPDATE_PAYLOAD_FILE>
```

CI may use key contents instead of a filesystem path:

```sh
TAURI_SIGNING_PRIVATE_KEY="<secret key contents>" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<secret password or empty>" \
cargo tauri signer sign <UPDATE_PAYLOAD_FILE>
```

For a no-password key, set the password variable to an explicit empty string; the Tauri signer can otherwise prompt or fail in non-interactive runs. Only the env var names belong in docs and workflow comments. Values belong in the release owner's local secret store or CI secrets.

macOS packaging and notarization also need the Apple signing variables documented in `.agents/desktop.md`, but those are not updater signature keys.

## Identifying Which Key Signed A Payload

Given an updater payload and its signature, verify against each public key. The key that verifies the signature is the signing key.

The production public key is the current `plugins.updater.pubkey` value in `src-tauri/tauri.conf.json`.

The old DEV public key is the value from the parent of the production pubkey rotation commit:

```sh
git show 3c1435b^:desktop/src-tauri/tauri.conf.json \
  | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => console.log(JSON.parse(s).plugins.updater.pubkey))'
```

With `minisign` available, write the public key and detached signature to files, then verify:

```sh
minisign -Vm <UPDATE_PAYLOAD_FILE> -P '<PUBLIC_KEY>' -x <SIGNATURE_FILE>
```

If the updater manifest stores the signature inline, copy only that signature string into a temporary signature file for verification.

## Failure Modes

An install old enough to still trust the DEV pubkey (pre-`3c1435b`, never bridged) rejects production-signed updater payloads. There is no auto-update path for it; update it with a manual DMG install (macOS) or a manual AppImage download (Linux).

If update-feed generation or publishing needs GitHub Actions changes, stop and coordinate with the release owner: workflow files are shared repo infrastructure, not desktop-local.
