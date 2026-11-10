# chan drives ghostty-web from outside, through its private internals

Status: accepted by the owner on 2026-11-09 as scope taken in parts over the next releases, starting in v0.128.0; nothing is built. v0.127.0 ships the libghostty-vt 1.0 core, find on ghostty terminals and the find follow-ups as they were tested ([the libghostty-vt 1.0 item](../done/the-ghostty-terminals-run-on-a-pre-1-0-libghostty-vt-build.md)); this item does not reopen them.

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
- **A feed can blow the frame.** At the largest scrollback, with a needle that matches often, one feed costs 30 to 57 ms in a single frame. This is its own item, [a find frame runs long at the largest scrollback](a-ghostty-find-frame-runs-long-while-output-streams-at-the-largest-scrollback.md).
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
