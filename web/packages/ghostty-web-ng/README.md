# @chan/ghostty-web-ng

chan's terminal widget: the sources of [ghostty-web](https://github.com/coder/ghostty-web) (MIT, by Coder), imported into chan as a workspace package, with the libghostty-vt core chan runs it over and chan's binding of that core. chan's workspace app imports it from source as `@chan/ghostty-web-ng` and `@chan/ghostty-web-ng/vt`; nothing here is built or published on its own.

## Provenance

- Upstream: `https://github.com/coder/ghostty-web`, commit `1858a5947767a3e1c9e98dbf53b2ff87fedb2aab` (2026-06-28, "ci: fix release please notes setup (#183)"). Upstream's `package.json` at that commit says version `0.4.0`.
- npm: the same commit was published as `ghostty-web@0.4.0-next.20.g1858a59`, tarball `https://registry.npmjs.org/ghostty-web/-/ghostty-web-0.4.0-next.20.g1858a59.tgz`, integrity `sha512-NXA9H3IJlx+DGJukXbOPQWFkigYdAatTqkoIvM8tvhfbaYoDf3gGKxXLLyXtLYOBt5qzGdEZa294TU36gULjVg==`.
- The tarball's `ghostty-vt.wasm`, upstream's build of its patched Ghostty snapshot (423,939 bytes, SHA-256 `794191ccd9f469ed0d49ebcb3e6b326d64279b91752b71ad80a3d89ff1f26416`, at the tarball's root and in `dist/`, and inlined in its `dist/ghostty-web.js`), was carried here as the oracle of the binding's differential tests until part 2 of the move onto libghostty-vt recorded what it reads back and removed it with upstream's binding of it (`lib/ghostty.ts`). The recording, `vt/__tests__/differential-oracle.json`, names it by that hash.
- Imported on 2026-11-11. Every file of upstream's tree is here byte for byte, except the entries listed below. Upstream changes are taken by hand, if at all.
- `LICENSE` is upstream's MIT notice, unchanged.

## What was left out or changed, and why

- The `ghostty` submodule, a pointer to `https://github.com/ghostty-org/ghostty.git` at `5714ed07a1012573261b7b7e3ed2add9c1504496`. It is the Ghostty snapshot that upstream's patched wasm build (`scripts/build-wasm.sh`, `patches/`) compiles. chan neither runs that build nor carries its wasm.
- `.gitignore`, `.gitmodules` and `.github/`. Upstream's `.gitignore` would ignore `ghostty-vt.wasm` and `dist/` inside chan's tree, `.gitmodules` names the submodule, and GitHub runs only the workflows at chan's root.
- `AGENTS.md`, upstream's instructions for agents working in its own repository. It names bun scripts this package no longer has, and its `bun install` would rewrite `bun.lock`; agents working here follow chan's `AGENTS.md`.
- The tarball's `dist/`: the ES and UMD builds and the type declarations are build output, not source. chan compiles `lib/` itself, and TypeScript reads the sources (below).
- `package.json` is chan's. It names the package `@chan/ghostty-web-ng` at chan's version, keeps it private, exports `lib/index.ts` from source, and chan's own files below. Upstream's scripts (all run under `bun`) and development dependencies are gone, so the workspace neither installs those dependencies nor runs those scripts; the package's `check` and `test` scripts are chan's.
- `lib/` is typed against chan's binding of the core (`vt/ghosttyVt.ts`) instead of upstream's own: `Terminal`'s `ghostty` option is a required `GhosttyVt`, the input handler, selection manager, buffer and OSC 8 link provider name the binding's `VtTerminal` and `VtKeyEncoder`, and upstream's module-level `init()` and `getGhostty()` and its default loader, `Ghostty.load()`, are gone, and so is upstream's binding of its own wasm (`lib/ghostty.ts`: `Ghostty`, `GhosttyTerminal`, `KeyEncoder`), with that wasm and the types in `lib/types.ts` that described its ABI and cell format (`GhosttyCell`, `CellFlags`, `DirtyState`, the render-state structs, `GhosttyWasmExports`, the SGR types). `vt/oldCellFormat.test.ts`, and the workspace app's `src/ghostty_old_format.test.ts` for the app, fail if a source names them again. The names the workspace app's type check finds unused (imports, never-read fields and locals, an uncalled method) are removed, so the sources pass the app's rules. Upstream's tests, `lib/test-helpers.ts`, `bench/versus.ts` and the demo, which nothing in chan runs, still import `lib/ghostty.ts` or call `init()` or `Ghostty.load()`, none of which exists.
- The renderer, the buffer API and the selection manager read the core's render state through the binding's frame reader, not upstream's cell format: `CanvasRenderer.render` takes the binding's `VtTerminal`, begins and ends each frame with it (`beginFrame`, `endFrame`), asks it which rows changed (`isRowDirty`, the core's own dirty iteration), and paints from rows read into `VtCells` views (`readRow`, `readHistoryRow`): the core's style flags, colours as 0xRRGGBB, each cell's cluster. Upstream's `IRenderable` and scrollback-provider interfaces and `Terminal.getScrollbackLine` are gone. What it paints is upstream's, call for call.
- `Terminal.open()` takes no focus, as xterm.js's does not. Upstream's ends with `focus()`, which focuses the element it opened in at once and again on a zero-delay timer, so with upstream's a terminal opening where it is not the one being typed into blurs whatever holds the keyboard, and a field that ends its edit on blur ends it. The caller focuses the terminal when it should have the keyboard; chan's `TerminalTab` does when the terminal's pane is the focused one. `blur()` gives the keyboard up from whichever element inside the host holds it, the hidden textarea a middle or right press focuses included, and cancels a pending `focus()` retry; upstream's blurred the host alone.
- `.shellcheckrc` is chan's, with `disable=all`. The repository's shell lint covers every tracked `*.sh`, and upstream's `demo/showcase.sh` and `scripts/build-wasm.sh` are imported as they are; nothing in chan runs them.
- `README.md`: the sections above the rule are chan's. Below it is upstream's README, unchanged, which describes the npm package `ghostty-web`, not this one.

## chan's own files

- `vt/`: chan's binding of libghostty-vt (`vt/ghosttyVt.ts`), the core the widget's `Terminal` takes as its `ghostty` option, with its frame reader and the filter copies read text through (`vt/ghosttyCopy.ts`), and their tests. Every reader of its cells, the widget's, chan's adapters' and the tests', reads rows through the frame reader into `VtCells` views; ghostty-web's cell format (`GhosttyCell`, `getLine`, `getScrollbackLine`, `getColors`) is gone from it. `vt/index.ts` is the package's `./vt` export.
- `vt/__tests__/differential-oracle.json`: what ghostty-web's own binding over its own wasm read back for the differential tests' corpus, modes, replies and key encodings, recorded once at `bd0141278` by a recorder that went with the wasm (its header names the commit and the command); `vt/__tests__/oracleFixture.ts` describes its form. The differential tests in `vt/ghosttyVt.test.ts` hold the binding to it.
- `vendor/ghostty-vt/`: Ghostty's own signed release build of libghostty-vt 1.0.1, the core chan's terminals run, exported as `./vendor/ghostty-vt/ghostty-vt.wasm`. Its README records where it comes from, its hash, and how to verify and re-pin it.
- `vt/tsconfig.json` and `vitest.config.ts`: how `vt/` compiles, how the package is type-checked, and the package's test run (below).

## Notes for chan

- TypeScript reads `lib/` from source for the `.` export, as vite and vitest compile it, and the binding's sources for `./vt`; the package ships no declarations. Both are type-checked under the workspace app's rules: by the app's own check through its imports, and by the package's `npm run check` through `vt/tsconfig.json`, which includes `lib/index.ts`.
- `tsconfig.json` is upstream's and is read by the build. Vite compiles each file with the nearest `tsconfig.json` that includes it, and this one's ES2020 target turns `useDefineForClassFields` off, so class fields are assigned in constructors as in upstream's npm build. Without it, vite emits native class fields: a field declared without an initializer, such as `Terminal`'s `selectionManager`, then exists as an own `undefined` property from construction. `src/terminal/ghosttyWidget.test.ts` in the workspace app pins the assigned form. It includes only `lib/`. `vt/tsconfig.json` compiles chan's binding with the workspace app's settings, an ES2022 target with class fields defined as fields, as the app's build compiles its own sources; `npm run check` type-checks `vt/` and `lib/` by it under the app's rules, which vite never applies to `lib/`, since it looks for a `tsconfig.json` only in the directories above the file it compiles.
- Upstream's tests are not run. They import `bun:test`, and `bunfig.toml` preloads Happy DOM with a canvas mock (`happydom.ts`), so none of them runs under the workspace's vitest unchanged. `vitest.config.ts` runs chan's tests under `vt/` alone, and keeps vitest from loading upstream's `vite.config.js`, which imports a build plugin the workspace does not install; `make web-check` runs them with the package's type check. The workspace app's own terminal suites run its adapters against this package.
- The workspace app uses `lib/` through the `.` export and the binding through `./vt`. The app, its tests, the binding's tests and the terminal pixel harness (`scripts/e2e/terminal-pixels/`) run the vendored libghostty-vt in `vendor/ghostty-vt/`, the one wasm the package carries. Upstream's demo server (`demo/bin/demo.js`) still serves a `ghostty-vt.wasm` from the package root and `scripts/build-wasm.sh` still writes one there; chan runs neither.

---

# ghostty-web

[![NPM Version](https://img.shields.io/npm/v/ghostty-web)](https://npmjs.com/package/ghostty-web) [![NPM Downloads](https://img.shields.io/npm/dw/ghostty-web)](https://npmjs.com/package/ghostty-web) [![npm bundle size](https://img.shields.io/bundlephobia/minzip/ghostty-web)](https://npmjs.com/package/ghostty-web) [![license](https://img.shields.io/github/license/coder/ghostty-web)](./LICENSE)

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility — giving you a proper VT100 implementation in the browser.

- Migrate from xterm by changing your import: `@xterm/xterm` → `ghostty-web`
- WASM-compiled parser from Ghostty—the same code that runs the native app
- Zero runtime dependencies, ~400KB WASM bundle

Originally created for [Mux](https://github.com/coder/mux) (a desktop app for isolated, parallel agentic development), but designed to be used anywhere.

## Try It

- [Live Demo](https://ghostty.ondis.co) on an ephemeral VM (thank you to Greg from [disco.cloud](https://disco.cloud) for hosting).

- On your computer:

  ```bash
  npx @ghostty-web/demo@next
  ```

  This starts a loopback-only HTTP server with a real shell on `http://127.0.0.1:8080`. The demo protects `/ws` with a per-run same-origin token and rejects cross-origin WebSocket handshakes. Works best on Linux and macOS.

  To intentionally bind somewhere else, set `HOST=<host>`. If you serve the demo through extra hostnames or a wildcard bind such as `HOST=0.0.0.0`, also set `GHOSTTY_ALLOWED_HOSTS=host1,host2`. Avoid remote exposure unless you understand the risk: the demo starts a real local shell.

![ghostty](https://github.com/user-attachments/assets/aceee7eb-d57b-4d89-ac3d-ee1885d0187a)

## Comparison with xterm.js

xterm.js is everywhere—VS Code, Hyper, countless web terminals. But it has fundamental issues:

| Issue                                    | xterm.js                                                         | ghostty-web                |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| **Complex scripts** (Devanagari, Arabic) | Rendering issues                                                 | ✓ Proper grapheme handling |
| **XTPUSHSGR/XTPOPSGR**                   | [Not supported](https://github.com/xtermjs/xterm.js/issues/2570) | ✓ Full support             |

xterm.js reimplements terminal emulation in JavaScript. Every escape sequence, every edge case, every Unicode quirk—all hand-coded. Ghostty's emulator is the same battle-tested code that runs the native Ghostty app.

## Installation

```bash
npm install ghostty-web
```

## Usage

ghostty-web aims to be API-compatible with the xterm.js API.

```javascript
import { init, Terminal } from 'ghostty-web';

await init();

const term = new Terminal({
  fontSize: 14,
  theme: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
  },
});

term.open(document.getElementById('terminal'));
term.onData((data) => websocket.send(data));
websocket.onmessage = (e) => term.write(e.data);
```

For a comprehensive client <-> server example, refer to the [demo](./demo/index.html#L141).

## Development

ghostty-web builds from Ghostty's source with a [patch](./patches/ghostty-wasm-api.patch) to expose additional
functionality.

> Requires Zig and Bun.

```bash
bun run build
```

Mitchell Hashimoto (author of Ghostty) has [been working](https://mitchellh.com/writing/libghostty-is-coming) on `libghostty` which makes this all possible. The patches are very minimal thanks to the work the Ghostty team has done, and we expect them to get smaller.

This library will eventually consume a native Ghostty WASM distribution once available, and will continue to provide an xterm.js compatible API.

At Coder we're big fans of Ghostty, so kudos to that team for all the amazing work.

## License

[MIT](./LICENSE)
