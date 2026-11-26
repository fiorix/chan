# libghostty-vt, the core of chan's terminals

`ghostty-vt.wasm` is Ghostty's own WebAssembly build of libghostty-vt, the terminal emulator core of Ghostty (parser, terminal state, scrollback, encoders, search) with no renderer. chan's terminals run ghostty-web's renderer, input and selection over it; `vt/ghosttyVt.ts` in this package binds it, and the widget's sources in `lib/` are typed against that binding. The workspace app's `src/terminal/backend.ts` loads it through the package's `./vendor/ghostty-vt/ghostty-vt.wasm` export. It is the only wasm the package carries: ghostty-web's own build, which upstream's npm tarball bundles, left the package with upstream's binding of it.

| Field   | Value                                                              |
| ------- | ------------------------------------------------------------------ |
| Source  | libghostty-vt 1.0.2 release, asset `ghostty-vt-1.0.2.wasm`         |
| URL     | `https://release.files.ghostty.org/libghostty-vt/1.0.2/`           |
| Tag     | `vt-1.0.2` in ghostty-org/ghostty                                  |
| Commit  | `573c4a21e02311ae87844af26b6a7a179f82858e`                         |
| Signed  | 2026-11-24T18:26:37Z (minisign trusted comment)                    |
| Build   | ReleaseFast                                                        |
| SHA-256 | `96b619798ad941835cb29326182a46fd68a0aa948ee13c1b16e9bae9d1c84031` |
| Size    | 1,228,525 bytes                                                    |
| License | MIT, `LICENSE` beside it                                           |

libghostty-vt's C ABI is stable from 1.0. Upstream's `dist/doxygen/pages/stability.md` says: "A program built against one 1.x release keeps working with every later 1.x release." A minor release may only add functions, types, enum values and fields at the end of a sized struct, and in upstream's words: "Nothing is removed, resized, reordered or re-typed. A behavior change ships as a new function with a new descriptive name, and the old function is marked GHOSTTY_DEPRECATED until the next major version." The releases keep that promise for the C interface and not for the emulation behind it: 1.0.1 and 1.0.2 changed what the same functions do with a program's output, under the same names and with no function marked deprecated, and their release notes list those changes as bug fixes (in 1.0.1, the prompts and scrollback a resize leaves; in 1.0.2, soft wraps kept across insert and delete lines, a skin tone modifier making an emoji two cells wide, in what `ghostty_unicode_grapheme_width` returns too, and Kitty's drag and drop queries left unanswered). How the core wraps, moves and measures cells and which queries it answers changes in patch releases, so a re-pin reads what changed (step 2 below).

Each release's wasm is published with its signature and a `SHA256SUMS` file at `release.files.ghostty.org`, Ghostty's release file host; the GitHub release assets are not the source of this file. The binding refuses a core whose major version is not 1 or that lacks the search feature when it loads; the workspace app then shows the refusal on the failure card in that terminal's place, with Reload window and Close, and opens no other terminal there.

## Verifying

`ghostty-vt.wasm.minisig` is the signature from the same release. The public key is the one Ghostty's `PACKAGING.md` lists:

```bash
minisign -Vm ghostty-vt.wasm -x ghostty-vt.wasm.minisig -P RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV
sha256sum ghostty-vt.wasm
```

## Re-pinning

1. Download `ghostty-vt-<version>.wasm`, `ghostty-vt-<version>.wasm.minisig` and `SHA256SUMS` from `https://release.files.ghostty.org/libghostty-vt/<version>/` into an empty directory outside the repository. Check the hash (`grep ' ghostty-vt-<version>.wasm$' SHA256SUMS | sha256sum -c -`) and the signature (`minisign -Vm ghostty-vt-<version>.wasm -P <key>`).
2. Read what the release changes: its notes (`dist/doxygen/pages/release-notes.md` at the tag) and the diff of `include`, `src/terminal` and `src/unicode` from the pinned tag (`git diff vt-<pinned>..vt-<version> -- include src/terminal src/unicode` in a clone of ghostty-org/ghostty); `include` holds the C headers, where additions, deprecations and upstream's notes on what a function does land. Decide per change what chan depends on (what a chan terminal shows, copies, finds or answers), and pin each behavior it depends on with a binding test in `vt/` that tells the pinned core from the new one.
3. Copy the wasm over `ghostty-vt.wasm` and the signature over `ghostty-vt.wasm.minisig`; the names stay, since the package's export, the workspace app's import in `src/terminal/backend.ts` and the tests use them. Verify again in place with the command above.
4. Update the table: the version and URL, the tag and its commit (`gh api repos/ghostty-org/ghostty/commits/vt-<version> --jq .sha`), the trusted comment's timestamp, the hash and the size.
5. Run `npm run test -w @chan/ghostty-web-ng` and `npm run test -w @chan/workspace-app` under `web/`. The package's tests check every enum value, struct offset, cell bit and style flag bit the binding uses against the new build's `ghostty_type_json()`, ghostty-web's key and encoder option numbering against upstream's, and the binding's output over a corpus of byte streams against a recording of ghostty-web's own build (`vt/__tests__/differential-oracle.json`); the app's run its terminal adapters over the new build. `vt/ghosttyVt.vendored.test.ts` checks the file in the tree against this table and its signature (the hash and size, the build's own version against the Source, URL and Tag rows and the signed file name, the Signed and Build rows, and the signature under Ghostty's key, which the test holds as a constant and the key above must equal), so a row left stale or a wrong or damaged file fails. It does not hold the Commit row, which rests on the tag alone since the build names no commit, or the License row. A 1.x minor adds to the C interface and never changes it, so the binding needs work only for a feature chan wants to use.
