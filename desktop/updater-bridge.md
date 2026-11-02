# Updater key and bridge runbook

The updater key is separate from Apple Developer ID signing and notarization. Apple signing decides whether macOS trusts the app bundle; the updater minisign key decides whether an installed desktop accepts a downloaded update payload. The public key is embedded in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. The matching private key lives in the release owner's secret store and in CI secrets, never in the repo. Every updater payload, the macOS `.app.tar.gz`, each Linux `.AppImage` and the Windows `-setup.exe`, is signed with it and ships with a detached `.sig` release asset. How the desktop consumes these is in [design.md](./design.md); the CI wiring is in the [contributor guide](../.agents/desktop.md).

## Key and secret rules

Private key values and passwords must not be printed, committed, or pasted into logs. Only the env var names belong in docs and workflow comments.

Public key material is not secret. To inspect the embedded updater pubkey without printing the full key:

```sh
cd desktop
node -e 'const c=require("./src-tauri/tauri.conf.json"); const crypto=require("crypto"); const k=c.plugins.updater.pubkey; console.log(`updater pubkey length=${k.length} sha256=${crypto.createHash("sha256").update(k).digest("hex")}`)'
```

To confirm local key files by presence only:

```sh
test -f ~/.tauri/chan-desktop-prod.key && echo prod-key-file-present
test -f ~/.tauri/chan-desktop-prod.key.pub && echo prod-pubkey-file-present
```

## Signing an updater payload

```sh
cd desktop/src-tauri
TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/chan-desktop-prod.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
cargo tauri signer sign <UPDATE_PAYLOAD_FILE>
```

CI uses the key contents instead of a filesystem path:

```sh
TAURI_SIGNING_PRIVATE_KEY="<secret key contents>" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<secret password or empty>" \
cargo tauri signer sign <UPDATE_PAYLOAD_FILE>
```

For a key without a password, set the password variable to an explicit empty string; the Tauri signer can otherwise prompt or fail in a non-interactive run. macOS packaging and notarization need the Apple signing variables documented in the contributor guide as well, but those are not updater signature keys.

## Identifying which key signed a payload

Given a payload and its signature, verify against each candidate public key; the key that verifies the signature is the signing key. The current public key is the `plugins.updater.pubkey` value in `src-tauri/tauri.conf.json`. A previous key is the same field at the release tag that shipped it:

```sh
git show <tag>:desktop/src-tauri/tauri.conf.json \
  | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => console.log(JSON.parse(s).plugins.updater.pubkey))'
```

With `minisign` available, write the public key and the detached signature to files, then verify:

```sh
minisign -Vm <UPDATE_PAYLOAD_FILE> -P '<PUBLIC_KEY>' -x <SIGNATURE_FILE>
```

If the updater manifest stores the signature inline, copy only that signature string into a temporary signature file for verification.

## Rotating the key: the bridge release

An installed desktop trusts only the public key it was built with. A rotation therefore needs one bridge release that embeds the new public key but is signed with the old private key, so every existing install accepts it and learns the new key; every release after the bridge is signed with the new key. If the old private key is unavailable there is no bridge, and every install needs one manual reinstall.

An install that never took the bridge rejects payloads signed with the new key and stalls on its last version until it is reinstalled by hand: the current DMG on macOS (a Homebrew cask install recovers with `brew reinstall --cask fiorix/chan/chan-desktop`, since the cask is `auto_updates` and brew never refreshes it on its own), the current AppImage written over the old file on Linux, or the current `-setup.exe` run by hand on Windows. Plan the bridge window for how long that tail must be supported.

If update-feed generation or publishing needs GitHub Actions changes, coordinate with the release owner: workflow files are shared repo infrastructure, not desktop-local.
