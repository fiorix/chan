# libghostty-vt for the ghostty terminal backend

`ghostty-vt.wasm` is Ghostty's own WebAssembly build of libghostty-vt, the terminal emulator core of Ghostty (parser, terminal state, scrollback, encoders, search) with no renderer. chan's ghostty terminals run ghostty-web's renderer, input and selection over it; `vt/ghosttyVt.ts` in this package binds it, and the widget's sources in `lib/` are typed against that binding. The workspace app's `src/terminal/backend.ts` loads it through the package's `./vendor/ghostty-vt/ghostty-vt.wasm` export. It is the only wasm the package carries: ghostty-web's own build, which upstream's npm tarball bundles, left the package with upstream's binding of it.

| Field   | Value                                                              |
| ------- | ------------------------------------------------------------------ |
| Source  | libghostty-vt 1.0.1 release, asset `ghostty-vt-1.0.1.wasm`         |
| URL     | `https://release.files.ghostty.org/libghostty-vt/1.0.1/`           |
| Tag     | `vt-1.0.1` in ghostty-org/ghostty                                  |
| Commit  | `108cacb17ed8990840cd14abfce43d8ed8503ca1`                         |
| Signed  | 2026-11-11T20:12:46Z (minisign trusted comment)                    |
| Build   | ReleaseFast                                                        |
| SHA-256 | `2ee8434a58866aa3ce43cebbbf284d684f5f5b64c4f6040fa031cfe789e11646` |
| Size    | 1,243,719 bytes                                                    |
| License | MIT, `LICENSE` beside it                                           |

libghostty-vt's C ABI is stable from 1.0: a 1.x minor only adds functions, types, enum values and trailing fields of sized structs, nothing is removed, resized, reordered or re-typed, and a behavior change ships as a new function. Each release's wasm is published with its signature and a `SHA256SUMS` file at `release.files.ghostty.org`, Ghostty's release file host; the GitHub release assets are not the source of this file. The binding refuses a core whose major version is not 1 or that lacks the search feature when it loads, and the terminal falls back to xterm.js.

## Verifying

`ghostty-vt.wasm.minisig` is the signature from the same release. The public key is the one Ghostty's `PACKAGING.md` lists:

```bash
minisign -Vm ghostty-vt.wasm -x ghostty-vt.wasm.minisig -P RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV
sha256sum ghostty-vt.wasm
```

## Re-pinning

1. Download `ghostty-vt-<version>.wasm`, `ghostty-vt-<version>.wasm.minisig` and `SHA256SUMS` from `https://release.files.ghostty.org/libghostty-vt/<version>/` into an empty directory outside the repository. Check the hash (`grep ' ghostty-vt-<version>.wasm$' SHA256SUMS | sha256sum -c -`) and the signature (`minisign -Vm ghostty-vt-<version>.wasm -P <key>`).
2. Copy the wasm over `ghostty-vt.wasm` and the signature over `ghostty-vt.wasm.minisig`; the names stay, since the package's export, the workspace app's import in `src/terminal/backend.ts` and the tests use them. Verify again in place with the command above.
3. Update the table: the version and URL, the tag and its commit (`gh api repos/ghostty-org/ghostty/commits/vt-<version> --jq .sha`), the trusted comment's timestamp, the hash and the size.
4. Run `npm run test -w @chan/ghostty-web-ng` and `npm run test -w @chan/workspace-app` under `web/`. The package's tests check every enum value, struct offset, cell bit and style flag bit the binding uses against the new build's `ghostty_type_json()`, ghostty-web's key and encoder option numbering against upstream's, and the binding's output over a corpus of byte streams against a recording of ghostty-web's own build (`vt/__tests__/differential-oracle.json`); the app's run its terminal adapters over the new build. A 1.x minor adds and never changes, so the binding needs work only for a feature chan wants to use.
