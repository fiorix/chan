# A ghostty terminal runs a patched Ghostty snapshot and keeps one page of scrollback

Status: shipped in [v0.119.0](../../release/release-v0.119.0.md).

Record before the release: landed in `0.119.0-ga` on 2026-10-31 (`0535eb10b`) and fixed there after the review (the section Review, 2026-10-31).

Record before the review: built on 2026-10-31 at the owner's word ("let's do Option A") and placed in v0.119.0 the same day by the owner's word ("this isn't going onto v0.118, this will be in the next version"), rebased onto the v0.118.0 GA as `v0119/ghostty-vt-wasm`; the owner's macOS reading passed at `13da87ba9` on 2026-10-31 (the section macOS verification). Awaiting review; the actual gateway transport remains untested on macOS.

Record before the release: raised by the owner on 2026-10-31 while weighing an invitation to Ghostty's author to read chan's terminal code; investigated, built and tested the same day.

## What was seen

Read at `a0501366f` with ghostty-web `0.4.0-next.20.g1858a59`, the default terminal backend since v0.117.0.

1. ghostty-web compiles its own wasm from Ghostty at `5714ed07a` (2025-12-01) plus a 1,620-line patch (`patches/ghostty-wasm-api.patch` in coder/ghostty-web). The patch adds its own C entry points and a stream handler that dispatches a hand-picked subset of Ghostty's actions; anything outside the list is dropped. Its pending 0.5.0 release builds from the same snapshot.
2. Ghostty publishes its own signed `ghostty-vt.wasm` on its `tip` release, the libghostty-vt C API with Ghostty's full stream handler. Its exports share none of the 34 entry points the patch adds, so it cannot be dropped in under ghostty-web.
3. Scrollback ignores the setting. The patch passes ghostty-web's scrollback line count to Ghostty's byte limit, so every terminal keeps one page: measured with the pinned build, 1,128 lines at 80 columns and 305 at 200 columns for a limit of 1,000, 5,000, 10,000 or 100,000 lines. chan's setting (10 to 50 MB) maps to about 11,000 to 55,000 lines.
4. The pinned build hands a freed terminal's cells to the next terminal on a shared instance (coder/ghostty-web#142, open), which is why each terminal has its own instance.
5. ghostty-web's `Key` enum is older than upstream's: upstream added `FN` at 146, so every key from `FN_LOCK` up (Print Screen, Scroll Lock, Pause, the browser and media keys) is one lower in ghostty-web.

## Desired contract

A ghostty terminal runs Ghostty's own release build of libghostty-vt, pinned by hash with its signature and license in the tree, behind ghostty-web's renderer, input handler and selection unchanged. Everything ghostty-web reads from its binding reads the same as from its own build for the same bytes, except where its build is wrong (scrollback, item 3). The key encoder sends upstream's number for every ghostty-web key. A re-pin that moves an ABI number fails a unit test, not a user's terminal.

## What was done

- `web/packages/workspace-app/vendor/ghostty-vt/`: the wasm from `tip` at `ae0dc1b71` (2026-10-31), its minisign signature verified against the key in Ghostty's `PACKAGING.md`, Ghostty's MIT license, and a README with the hash, the verification command and the re-pin steps.
- `src/terminal/ghosttyVt.ts`: the `Ghostty` object ghostty-web's `Terminal` takes as its `ghostty` option, over the upstream C API: render state and row iterators for the screen, grid refs for history, hyperlinks, graphemes and wrap continuation, mode reads, replies through a `write_pty` callback installed in the module's function table, ghostty-web's DA1/DA2 answers through a device-attributes callback, ghostty-web's default colors and grapheme clustering (mode 2027), the scrollback line limit with the byte cap lifted, and the key renumbering.
- `src/terminal/backend.ts` loads the vendored wasm and the binding; ghostty-web's wasm is no longer loaded (its lazy chunk still carries it inline, the section Review).
- Comments that described ghostty-web's wasm (OSC 52, the shared instance, scrollback wrap flags) and the design doc's terminal backend section describe the new core.

## Evidence

- `ghosttyVt.test.ts`, 27 tests: every enum value, struct offset and packed cell bit the binding uses against the pinned build's `ghostty_type_json()`; every ghostty-web key name against upstream's number; twelve byte streams (SGR palette, 256 and truecolor, attributes, cursor movement and erase, wide characters, wrapping, scroll regions, the alternate screen, tabs, a screen and a half of output) through ghostty-web's build and the binding, every screen row, history row, wrap flag, cursor and screen equal; mode reads; DSR 5 and 6, DA1 and DA2 replies byte-equal, and DA3 answered with a zero unit id where the pinned build answers nothing; key encodings equal including Print Screen and Pause; dirty rows, OSC 8 links, a ZWJ cluster on screen and in history, a 3,000-line scrollback, reflow on resize, mode 2027 across a full reset, and two terminals on one instance answering their own queries.
- Browser checks in Chrome on the Linux host on the v0.118.0 GA base (ghostty is the default backend, so each runs on the new core): 93 secret masking, 94 the ghostty toggle (wasm fetched, canvas, keys, OSC 52 copy), 97 mouse, 105 appearance, 107 rename, 164 CLI terminal reload, 175 details passed. On the earlier `0.118.0-ga` base 164 failed on the old Files tree selector before reaching a terminal, which [filesel] fixed in v0.118.0.
- Whole workspace-app suite on the v0.118.0 GA base: 620 files, 8,000 tests passed; `svelte-check` 0 errors; production build emits the 1,191,241-byte vendored wasm only.
- At `0d632058d` (the [ghidle] repair on the branch), rerun on the Linux host on 2026-10-31: the whole workspace-app suite 620 files, 8,002 tests passed; browser checks 93, 94, 97, 105, 107, 164 and 175 green in Chrome against the debug binary and bundle rebuilt at that commit.
- WebKit's engine, short of a WebKit page: JavaScriptCore's shell from WebKitGTK 2.54.2 on the Linux host (`/usr/lib/webkit2gtk-4.1/jsc`, the JS and wasm engine WKWebView and WebKitGTK embed) compiled the vendored wasm (196 exports) and ran the binding bundled by rolldown as a plain script: the two callbacks installed through the core's function table took indices 160 and 161 and fired (`ESC [ 6 n` answered `ESC [ 4 ; 1 R`, `ESC [ c` answered `ESC [ ? 62 ; 22 c` through the device-attributes callback), the row reference passed as a BigInt read the wrap flag of a wrapped row and not of a plain one, a 20 by 4 terminal rendered `hello` in red and a 26-character line over two rows, and after six more lines the first history row read back. The harness and its output are in the branch's proofs directory (`dev/ghostty-vt/proofs/jsc/`, mirrored at the round's close). This earlier run did not exercise a WKWebView or WebKitGTK page; the macOS verification below supplies the WKWebView reading.
- A shared instance under the new build leaves 0 stale cells after a freed terminal (2,365 under the pinned build). Memory per instance: 0.4 MiB plus 1.3 MiB for an empty 120x40 terminal (pinned build: 1.2 plus 6.6 MiB); after 11,000 lines, 13.9 MiB holding 10,960 lines of history (pinned build: 8.6 MiB holding 716).
- Throughput through the same binding API, Node 26 (V8), 16 MiB per corpus, 120x40, median of three:

| Input                         | Pinned build | Upstream build |
| ----------------------------- | ------------ | -------------- |
| ASCII, parse                  | 75 MiB/s     | 528 MiB/s      |
| SGR-heavy, parse              | 34 MiB/s     | 102 MiB/s      |
| Unicode, parse                | 77 MiB/s     | 219 MiB/s      |
| ASCII, read rows each 64K     | 19 MiB/s     | 65 MiB/s       |
| SGR-heavy, read rows each 64K | 14 MiB/s     | 44 MiB/s       |
| Unicode, read rows each 64K   | 19 MiB/s     | 59 MiB/s       |

The upstream build does this while keeping fifteen times the history. The "read rows" figures include the binding's copy of every row ghostty-web asks for, so they bound the JS side as much as the core.

## macOS verification, 2026-10-31

Tested the clean `13da87ba9` tree on macOS 27.0.1. A freshly built debug chan-desktop reported `git-13da87ba9f34` and ran with a disposable `CHAN_HOME` and a separate `XDG_RUNTIME_DIR` for its handoff socket. The local workspace held only the terminal probes. A second workspace ran in an Ubuntu 24.04 sdme container in the local Lima VM, with its own `CHAN_HOME`, a Rust 1.95.0 `chan --no-default-features` debug build from the same source and the same freshly built web bundles. The desktop reached that devserver through a loopback SSH forward, not through chan-gateway.

- macOS JavaScriptCore's shell ran the transpiled binding against the pinned wasm, using ASCII-only encoder/decoder shims for the shell's missing Web APIs. Callback slots 160 and 161 answered DSR 6 and DA1; BigInt row references distinguished a wrapped continuation from a plain row; screen and history rows read back; 3,000 input lines retained 2,976 history rows in a 24-row terminal, with `line 0` still the oldest.
- In the actual WKWebView terminal, DSR 6 at row 3, column 7 answered `ESC [ 3 ; 7 R`, DSR 5 answered `ESC [ 0 n`, and DA1 answered `ESC [ ? 62 ; 22 c`. All three passed in both the local workspace and the sdme-backed workspace.
- The owner confirmed that the local 4,000-line history probe retained its start marker and that a long wrapped line remained intact when the window narrowed and widened and could be selected and copied from history.
- The owner confirmed the xterm-to-Ghostty Settings switch worked, then confirmed focus recovery and sleep/wake worked. The focus evidence and its limits are recorded in [ghidle].
- The wasm fetched through the sdme workspace's authenticated HTTP surface was 1,191,241 bytes with SHA-256 `2b76c02544cf52fa28f9583e85f527e8f840001b9ed391e93b5921f181573155`, matching the vendored pin.
- On macOS, the whole workspace-app suite passed: 620 files, 8,002 tests. The two targeted core/backend files also passed, 61 tests. `svelte-check` reported 0 errors and 0 warnings; the production web bundles, native debug desktop and Linux debug devserver built successfully. Browser checks 93, 94, 97, 105, 107, 164 and 175 were not rerun in this session; their Linux results above are the existing evidence.

This supplies the native WKWebView page reading missing from the earlier JavaScriptCore-only run. It does not establish gateway reconnect behavior or reproduce the original intermittent idle-keys failure.

## Not done here

- Each terminal keeps its own instance: a wasm memory never shrinks, so a shared one would hold the largest scrollback ever opened for the page's life. The instance no longer exists to work around #142.
- The core reports OSC 52, OSC 7501, the bell and the title through callbacks the binding does not install; chan keeps its byte observers for OSC 52 and OSC 7501 and ghostty-web keeps its own bell and title scanning. Routing them through the core is separate work.
- `scripts/e2e/terminal-pixels/harness.mjs` still loads ghostty-web's wasm. It measures glyph rendering, which the renderer owns, not the core.
- This does not touch focus or input handling. The branch carries the [ghidle] repair as its own commit, by the owner's word, in the host-resume focus recovery.

[ghidle]: a-ghostty-terminal-stops-taking-keys-after-idle.md
[filesel]: browser-checks-drive-the-files-tree-the-directory-view-replaced.md

## Review, 2026-10-31

Read at `afb83e7a4` by the review the owner asked for before the GA ("do an adversarial review"), whose reviewers were asked for evidence or a plain "nothing found"; the lead reproduced each finding acted on before its fix.

- Fixed, `0660097e8`: the core answered OSC 4, 10, 11 and 12 color queries, which ghostty-web's build never did and chan's xterm.js path suppresses on purpose (`xtermReports.ts`), and in a transparent window it answered black on any theme. The binding drops those replies and no other; the new differential case was red on the old binding and is green.
- Fixed, `34abc34f2`: a screen cell's grapheme cluster was read into a 32-codepoint scratch area while the core writes the whole cluster (up to 65 codepoints), up to 132 bytes past the allocation; and after OSC 10, 11 or 4 changed a color, rows drawn before kept the old colors. A longer cluster is read into its own buffer, and a change to the default colors or the palette re-reads every row; the two new cases were red and are green.
- Corrected: this item said ghostty-web's wasm is no longer in the bundle. It is never loaded, but ghostty-web's lazy chunk still carries it inline as base64 (565,252 of the chunk's 648,960 bytes, by the reviewer's `vite build`); the build's only wasm asset is the vendored one.
- Left open as minor, in [v0120review]: a stale spacer head from an upstream dirty miss, the write buffer's failed allocation, the SIMD requirement for a WebKit older than 16.4, history read cell by cell (Copy scrollback of 55,000 lines blocks the page 1.7 to 3.5 s), late in-band resize reports with zero pixel sizes, the inline wasm, and the core's XTVERSION answer.

The binding's reviewer then read the fixes. Both hold and add no re-reads: over 500 colored scrolling frames the binding re-reads the whole screen 477 times before and after, none of them from the new check, and every cluster buffer is freed once with its length. It found that the core also answers the OSC 21 query of kitty's color protocol, now dropped as well, and three plausible wrong fixes the tests passed (a check of the background alone, a buffer too short, a buffer taken only past 64 codepoints), which the tests now catch (`e53a4aeb8`).

[v0120review]: ../v0.120.0/ghostty-defects-the-v0119-review-left-open.md
