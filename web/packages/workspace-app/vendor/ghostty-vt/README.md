# libghostty-vt for the ghostty terminal backend

`ghostty-vt.wasm` is Ghostty's own WebAssembly build of libghostty-vt, the terminal emulator core of Ghostty (parser, terminal state, scrollback, encoders) with no renderer. chan's ghostty terminals run ghostty-web's renderer, input and selection over it; `src/terminal/ghosttyVt.ts` binds it to the calls ghostty-web makes, and `src/terminal/backend.ts` loads it. ghostty-web's bundled wasm is not used.

| Field   | Value                                                              |
| ------- | ------------------------------------------------------------------ |
| Source  | ghostty-org/ghostty release `tip`, asset `ghostty-vt.wasm`         |
| Commit  | `ae0dc1b7136c2baddc3e067663aa041cd555cfda` (2026-10-31)            |
| Signed  | 2026-10-31T04:06:53Z (minisign trusted comment)                    |
| Build   | ReleaseFast, `wasm-opt -O3` (upstream's `build-lib-vt-wasm` job)   |
| SHA-256 | `2b76c02544cf52fa28f9583e85f527e8f840001b9ed391e93b5921f181573155` |
| Size    | 1,191,241 bytes                                                    |
| License | MIT, `LICENSE` beside it                                           |

The `tip` release is rebuilt on every commit to Ghostty's main branch and its assets are replaced, so the file here is the only copy of this pin. Ghostty publishes no tagged release of the wasm, and its C API is marked unstable.

## Verifying

`ghostty-vt.wasm.minisig` is the signature from the same release. The public key is the one Ghostty's `PACKAGING.md` lists:

```bash
minisign -Vm ghostty-vt.wasm -P RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV
sha256sum ghostty-vt.wasm
```

## Re-pinning

1. Download `ghostty-vt.wasm` and `ghostty-vt.wasm.minisig` from the `tip` release, verify the signature as above, and replace both files.
2. Update the table: the release's target commit (`gh api repos/ghostty-org/ghostty/releases/tags/tip --jq .target_commitish`), the trusted comment's timestamp, the hash and the size.
3. Run `npx vitest run src/terminal/ghosttyVt.test.ts` in `web/packages/workspace-app`. It checks every enum value, struct offset and cell bit the binding uses against the new build's `ghostty_type_json()`, ghostty-web's key numbering against upstream's, and the binding's output against ghostty-web's own build over a corpus of byte streams. Fix what it reports in `ghosttyVt.ts`.
