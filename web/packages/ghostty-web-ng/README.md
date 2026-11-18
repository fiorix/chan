# @chan/ghostty-web-ng

chan's terminal widget is derived from [ghostty-web](https://github.com/coder/ghostty-web) (MIT, by Coder) and runs on the signed libghostty-vt core and chan's binding. The workspace app imports the widget and binding from source through `@chan/ghostty-web-ng` and `@chan/ghostty-web-ng/vt`. The package is private and has no standalone build or publication.

## Provenance

- Widget source: `coder/ghostty-web` at `1858a5947767a3e1c9e98dbf53b2ff87fedb2aab` (2026-06-28, "ci: fix release please notes setup (#183)"), whose manifest version is `0.4.0`. Upstream changes are taken by hand, if at all.
- npm source: `ghostty-web@0.4.0-next.20.g1858a59`, tarball `https://registry.npmjs.org/ghostty-web/-/ghostty-web-0.4.0-next.20.g1858a59.tgz`, integrity `sha512-NXA9H3IJlx+DGJukXbOPQWFkigYdAatTqkoIvM8tvhfbaYoDf3gGKxXLLyXtLYOBt5qzGdEZa294TU36gULjVg==`.
- Differential oracle: `vt/__tests__/differential-oracle.json` records the upstream binding's corpus, modes, replies and key encodings at `bd0141278`. Its header identifies the recording command and the upstream wasm by SHA-256 `794191ccd9f469ed0d49ebcb3e6b326d64279b91752b71ad80a3d89ff1f26416` (423,939 bytes). That upstream build derives from the Ghostty snapshot `5714ed07a1012573261b7b7e3ed2add9c1504496`; the package carries the recording, not that binary or its build tooling.
- Runtime core: `vendor/ghostty-vt/` contains Ghostty's signed release build of libghostty-vt 1.0.1. Its [README](vendor/ghostty-vt/README.md) records the source, hash, signature verification and update procedure. It is the package's only wasm.
- [LICENSE](LICENSE) is the widget's unchanged upstream MIT notice. The runtime core carries its own notice in `vendor/ghostty-vt/LICENSE`.

## Sources and consumers

`lib/` contains the widget, renderer, input handler, selection manager, buffer facade and both link providers. `Terminal` takes a required `GhosttyVt` instance as its `ghostty` option. The renderer, buffer and selection manager read the binding's `VtCells` views; each cell carries the core's styles, colours and complete grapheme cluster. Frame reads use `beginFrame`, `endFrame`, `isRowDirty`, `readRow` and `readHistoryRow`.

`vt/` contains the libghostty-vt binding, the copy filter and their tests. `vt/index.ts` is the separate `./vt` export. The workspace app, its terminal tests, the binding tests and the terminal pixel harness under `scripts/e2e/terminal-pixels/` all use the vendored core, exported as `./vendor/ghostty-vt/ghostty-vt.wasm`.

The widget exposes the subset chan uses rather than an xterm.js compatibility API. OSC 8 and plain URL links use the built-in providers. The widget owns viewport positioning and output following; the app supplies wheel calibration, selection, find, secret masking and theme updates. `Terminal.open()` does not take focus; the caller chooses when the terminal receives the keyboard. `blur()` releases focus from descendants, including the hidden input textarea, and cancels a pending focus retry.

## Viewport and content changes

`term.viewport.offset` is the fractional number of rows back from the bottom. `scrollTo(offset)` sets that distance, `scrollBy(rows)` adds to it (positive moves toward older output), and `scrollToBottom()` returns to live output. Explicit positioning cancels a pending smooth scroll and clamps to retained history. `reveal(row, align)` takes an absolute row, with row zero at the oldest retained history row; it leaves a visible row in place and positions an off-screen row at `"start"`, `"center"` (the default) or `"end"`, subject to the same clamp.

The viewport's `followOutput` policy is `"at-bottom"`. Writes keep a view anchored to its retained row, including when the core prunes older history. The visible row and an active smooth-scroll target are tracked independently; if either row is discarded, that position falls back to the oldest retained row. Their fractional distances are preserved within the retained-history bounds. An offset below one row follows the live screen while retaining its fractional distance, so successive pixel-wheel events can move into history while output streams. User input that emits bytes returns the view to the bottom before those bytes are emitted.

`term.onChange(({ kind }) => ...)` reports `"write"` after each non-empty synchronous core write and `"resize"` after a grid size change. The core and viewport are updated, terminal replies are sent and cached links are invalidated before the write event; the event precedes painting, including the immediate input-echo frame. An empty write queues its callback without emitting a change or consuming a pending input echo. Its subscription has `dispose()`, and disposing the terminal releases all change subscriptions. Emission uses a snapshot of subscribers, so a listener disposing itself does not skip the next listener. The dimension-bearing `onResize` event serves consumers that publish terminal size; an unchanged size emits neither resize event.

## Type checking and tests

TypeScript, Vite and Vitest read the sources through the package's export map. `vt/tsconfig.json` checks the binding, widget entry and widget test suites under the workspace app's strict settings. `vitest.config.ts` selects the binding, input-handler and viewport suites. `make web-check` runs these checks together with the workspace app's terminal suites and production build.

The package's `tsconfig.json` is a build input for `lib/`: its ES2020 target preserves constructor-assigned class fields. Vite uses the nearest configuration that includes each file. The binding's separate configuration targets ES2022; it does not change how Vite compiles the widget. The workspace app's `src/terminal/ghosttyWidget.test.ts` pins the widget's class-field behavior.

The input-handler suite keeps the upstream cases, pinned to the exact bytes the handler sends, and adds one case per composition-guard arm, the SHIFT and ALT mask bits, the AltGr fallthrough, each beforeinput kind and the SGR and X10 mouse release, each on a fresh vendored-core instance. Its container and input events are stand-ins, so it checks responses to supplied sequences rather than native IME, clipboard delivery or platform event ordering. `vt/oldCellFormat.test.ts` and the workspace app's `src/ghostty_old_format.test.ts` reject references to the unsupported upstream binding and cell format. The binding's differential tests compare against the recorded oracle.
