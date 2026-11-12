# chan drives ghostty-web from outside, through its private internals

Status: carried to v0.129.0 at the v0.128.0 cut on 2026-11-12: part 1, the fork of ghostty-web into the tree, shipped in [v0.128.0](../../release/release-v0.128.0.md); parts 2 to 6 follow.

Record before the v0.128.0 release: accepted by the owner on 2026-11-09 as scope taken in parts over the next releases, starting in v0.128.0; part 1 (the import) is built in v0.128.0, below; parts 2 to 6 follow. v0.127.0 ships the libghostty-vt 1.0 core, find on ghostty terminals and the find follow-ups as they were tested ([the libghostty-vt 1.0 item](../done/the-ghostty-terminals-run-on-a-pre-1-0-libghostty-vt-build.md)); this item does not reopen them.

## What is there now

chan's ghostty terminals, the default backend, render with ghostty-web: the npm package `ghostty-web`, MIT, from `coder/ghostty-web`, pinned at the prerelease `0.4.0-next.20.g1858a59` (upstream commit `1858a5947`, 2026-06-28). Its last release is v0.4.0 (2025-12-09), and its 0.5.0 candidate has been open since 2026-06-28.

chan does not use ghostty-web's core. It vendors libghostty-vt 1.0 and binds it itself in `src/terminal/ghosttyVt.ts`, which plays the part of ghostty-web's private `Ghostty` interface and translates the core's cells and styles into ghostty-web's format. ghostty-web's own wasm, built from a patched Ghostty snapshot, still ships in the package. chan uses it only as the oracle of the binding's differential tests and as the core of the terminal pixel harness.

chan reaches into ghostty-web's private internals wherever it needs behavior the package does not offer. Each access is feature-detected and pinned by tests:

- **Selection:** the private SelectionManager, for Select all and for find's active match, which is the terminal's selection because ghostty-web has no highlight or decoration layer. Its public `select()` adds the viewport offset as an absolute row and is never called.
- **Painting:** secret masking paints over each frame by wrapping the private `renderer.render`. ghostty-web repaints only rows marked dirty, so a moved highlight must clear the old selection first. Its `onRender` never fires in the pinned build.
- **Viewport:** `scrollToLine(n)` sets the number of lines scrolled back from the bottom, not the line its doc comment describes.
- **Focus:** `Terminal.focus()` focuses again from a `setTimeout(0)`, which took the keyboard from the launcher and from a reopened find bar.
- **Clicks:** a page-wide click listener drops the selection on any click outside the canvas, which took find's highlight on a click in the find bar.
- **Core access:** `wasmTerm`, to reach chan's own binding behind ghostty-web.

The done archive records a run of ghostty-web behaviors fixed from outside, among them [no focus report](../done/ghostty-web-sends-no-focus-report.md), [X10 mouse reports reaching the PTY as text](../done/x10-mouse-reports-on-the-ghostty-renderer-reach-the-pty-as-text.md), [typed input during a live write](../done/typed-input-during-a-live-write-is-not-broadcast-on-the-ghostty-renderer.md) and [a blank terminal after its window sat off screen](../done/a-ghostty-terminal-comes-back-blank-after-its-window-sits-off-screen.md).

chan's ghostty adapter code outside tests is about 3,800 lines: the binding, the compatibility layer, keys, paste, wheel, selection, viewport, find and secret masking. Upstream's `lib/` is about 260 KB of TypeScript outside tests, and its repository also carries the patched Ghostty build, which chan does not use: a submodule, patches, and Zig and Nix tooling.

The find work left gaps the owner deferred on 2026-11-09, recorded in that work's follow-up report. A further defect found there, a find step that wrapped among the matches found so far while the scan ran, so that Shift+Enter after reopening landed on the wrong match, was fixed for v0.127.0 on the follow-up branch (`7f8fa29bb`) and is not part of this item. The deferred gaps:
- **A resize restarts the walk.** The core forgets its selected match on any resize; its tracked grid refs could keep it.
- **A feed can blow the frame.** At the largest scrollback, with a needle that matches often, one feed costs 30 to 57 ms in a single frame. This is its own item, [a find frame runs long at the largest scrollback](../done/a-ghostty-find-frame-runs-long-while-output-streams-at-the-largest-scrollback.md).
- **Wrapped lines can double-count.** The core counts some matches twice across soft wraps.
- **Only the active match is highlighted.** Highlighting every match waits for a highlight layer.

## Desired contract

1. `web/packages/ghostty-web-ng` is a workspace package inside chan. It is a terminal widget over libghostty-vt 1.0 that keeps only what chan uses of ghostty-web, its MIT notice, and the upstream commit it started from. Whether to extract it later to a standalone `fiorix/ghostty-web-ng` repository is a separate decision.
2. The widget owns the vendored libghostty-vt core and its binding, moved from chan, and its renderer reads the core's render state directly. ghostty-web's patched Ghostty build, its own binding and wasm, and chan's imitation of its `Ghostty` interface are gone, and so is ghostty-web as an npm dependency.
3. Everything chan reaches privately today is public API of the widget:
   - a highlight layer separate from the selection;
   - ordered paint layers, with secret masking painted last;
   - focus without a timer;
   - pointer and click handling scoped to the terminal element;
   - explicit viewport positioning;
   - one change event for writes and resizes.
4. chan reads no private field of the widget, and its adapters keep only what is chan's own.
5. Behavior holds through every part: the ghostty browser checks, the pixel harness, and the owner's desktop walk.
6. The code is modernised and simplified along the way. The input handler, which holds the most platform knowledge (IME composition, WKWebView, Option as Alt, Windows), moves as it is and is modernised last, behind tests.

## Parts

Each part lands in a release once it is green, in this order; one release can take more than one.

1. **Import.** ghostty-web's sources at the pinned commit become the package's first commit, with the MIT notice and a pointer to that commit. chan depends on the workspace package instead of the npm one, with no behavior change.
2. **Re-seat the core.**
   - Move chan's libghostty-vt binding and the vendored core into the package.
   - Have the renderer read the render state directly.
   - Drop ghostty-web's binding and wasm, and chan's imitation layer.
   - Move the pixel harness onto the widget's core.
   - Decide whether the binding's differential tests keep the old wasm as a pinned fixture or retire it.
3. **Prune.** Drop what chan does not use: the xterm.js compatibility surface chan never calls, the UMD build, the demo, benches and docs, the patched-build tooling, and any provider chan replaces.
4. **Public hooks.** Add the highlight layer, the paint layers, focus, scoped events, the viewport API and the change event. chan's adapters move onto them and drop their private access.
5. **Find on the widget.**
   - Highlight every match.
   - Keep the active match across a resize through tracked grid refs.
6. **Modernise the input handler** behind tests.

## Boundaries

- v0.127.0 keeps what is tested and working; nothing in this item lands there.
- xterm.js stays as chan's second backend. Whether chan drops it once the widget is solid is a separate decision.
- The vendored libghostty-vt stays at 1.0.0 unless a part needs a 1.x minor. The core's own issues (the selection lost on a resize, an unbounded feed, double counts across soft wraps) can be reported upstream separately.
- After the import, upstream ghostty-web changes are taken by hand, if at all.

## Acceptance

1. Each part lands with chan's web gate green, and with checks 211, 93, 94, 105 and 204 and the terminal pixel harness green in an isolated guest at the integration tip.
2. After parts 2 to 4, ghostty-web is not an npm dependency, and a source scan proves chan reads no private field of the widget.
3. After part 5, find highlights every match and keeps the active match across a resize.
4. The owner walks chan-desktop on every part that changes rendering or input.

## Parts taken in v0.128.0, 2026-11-11

This release takes part 1 alone: the import of ghostty-web's sources at the pinned commit into `web/packages/ghostty-web-ng`, with the MIT notice and the upstream commit pointer, chan depending on the workspace package instead of the npm one, with no behaviour change. It is scheduled last in the terminal lane and moves to the next release without loss if the lane runs out of time; parts 2 to 6 go to the following releases. The four ghostty rows of this release (a theme switch's colours, the wrapped copy, find across a resize, the find frame's feed) land on today's widget first: each changes chan's own binding, controllers or paste path and the renderer's existing hooks, which part 2 moves rather than rebuilds, and built first they ship as small tasks instead of waiting on the import.

## Part 1 built, 2026-11-11

ghostty-web's tree at `1858a5947` (2026-06-28, the commit npm's `ghostty-web@0.4.0-next.20.g1858a59` was published from) is the workspace package `@chan/ghostty-web-ng` in `web/packages/ghostty-web-ng`, byte for byte, with the MIT notice unchanged and the provenance in its README. Left out: the `ghostty` submodule (`ghostty-org/ghostty` at `5714ed07a`, recorded in the README), `.gitignore`, `.gitmodules` and `.github/`. The package's `package.json` is chan's (private, the workspace version, `lib/index.ts` and the wasm exported from source, upstream's bun scripts and development dependencies dropped), and it carries the npm tarball's `ghostty-vt.wasm` (sha256 `794191cc...`) and its `dist/index.d.ts` under the `types` condition. TypeScript reads those declarations because the app's type check fails on upstream's sources (18 errors: unused names, the default loader's `Bun` global and `fs/promises`). `index.d.ts` describes `lib/` only while `lib/` is upstream's at `1858a5947`; the part that first edits `lib/` (part 2 or 3) retires it once the sources pass the app's own check. The package keeps upstream's `tsconfig.json`, whose ES2020 target keeps class fields assigned in constructors as the npm build did (pinned by `ghosttyWidget.test.ts`). The workspace app depends on the package, no chan file imports `ghostty-web`, and the lock holds no registry entry for it. The app's bundle still carries one wasm, the vendored core, and names the widget's chunk `ghostty-web-*.js` for checks 211 and 223. The pixel harness bundles the widget from the package, and the Nix `npmDeps.hash` is re-pinned for the lock without the npm package (the cargo pins are the integration branch's). Upstream's `AGENTS.md` is left out too, with `.github/`, as automation for upstream's repository, and a package-local `.shellcheckrc` keeps the repository's shellcheck off upstream's demo script. Upstream's tests import `bun:test` and are not run; part 3 decides their fate.

Proofs: the import's `git ls-tree` equals upstream's minus the eight left-out entries (the submodule gitlink, `.gitignore`, `.gitmodules` and the five files of `.github/`); base and tip production builds at one path emit the same 230 files, the same wasm and identical CSS; svelte-check 0; the terminal suites green (1,319), and the same 1,209 tests at base and tip; six mutations red; the pixel harness's PNGs byte-identical at base and tip on the host and in an isolated guest, its ghostty arms green, its xterm DOM arms failing four seam assertions at base and tip alike under Xvfb; checks 93, 94, 105, 204, 211 and 223 and `make web-check` green in the guest. Not run here: the pixel harness's Windows driver (with the milestone candidate's VM check). Taken into the integration branch as c4f057295 after an independent review (`dev/v0128-team/reviews/review-ghosttyng-part1.md`); the merge gate ran `make web-check`, the Nix hash checks on the merged pins, `make web-lock-check`, `npm ls ghostty-web` (empty), e2e-check and shell-check. Parts 2 to 6 go to the following releases.
