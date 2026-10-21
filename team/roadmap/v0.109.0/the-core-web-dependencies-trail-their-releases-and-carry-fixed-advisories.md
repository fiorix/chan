# The core web dependencies trail their releases and carry fixed advisories

Status: raised for v0.109.0 by the owner's word of 2026-10-21 ("check which core dependencies we could upgrade, like xterm.js or the editor's libraries, svelte, excalidraw"; then "i will take your recommendations for what to upgrade and what to defer, write the item too"); owner the frontend seat.

## What was seen

Read on 2026-10-21 against the npm registry and each project's release notes, at `50b4dbee5`; `npm audit --package-lock-only` on copies of the lockfiles.

| Package | Today | Latest | Move |
| --- | --- | --- | --- |
| @xterm/xterm and its addons | 6.0.0 | 6.0.0 (6.1.0 beta) | none |
| ghostty-web | 0.4.0-next.20 | same | none |
| @excalidraw/excalidraw | 0.18.1 | 0.18.1 | none |
| @codemirror/view | 6.43.3 | 6.43.15 | patch |
| @codemirror/state | 6.7.0 | 6.7.6 | patch |
| @codemirror/language | 6.12.4 | 6.13.1 | minor |
| @codemirror/commands | 6.10.4 | 6.11.1 | minor |
| other @codemirror, @lezer/common, highlight, lr | various | patch | patch |
| @lezer/markdown (exact pin) | 1.7.2 | 1.8.1 | minor |
| svelte | 5.56.4 | 5.57.2 | minor |
| @sveltejs/vite-plugin-svelte | 7.1.2 | 7.3.1 | minor |
| svelte-check | 4.7.1 | 4.7.7 | patch |
| vite | 8.1.0 | 8.3.5 | minor |
| vitest | 4.1.11 | 4.1.12, 5.0.5 | patch, major |
| typescript | 5.9.3 | 6.0.3, 7.0.2 | major |
| jsdom | 29.1.1 | 30.1.3 | major |
| react, react-dom | 18.3.1 | 19.3.1 | major |
| mermaid | 11.17.2 | 12.2.0 | major |
| lucide-svelte | 1.0.1, deprecated | @lucide/svelte 1.61.0 | swap |
| puppeteer-core (browser suite) | 24.43.1 | 25.15.0 | major |
| marked, dompurify, cytoscape | various | in range | minor, patch |

The audit: the web lockfile holds 19 findings (11 high). Vite up to 8.1.5 carries three advisories in its dev server (GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm), fixed within the current range; the Excalidraw chain (lodash-es, nanoid, sass and its watchers, langium) has no forward fix, as recorded since v0.101; patch-package's micromatch is tooling only; katex (low) is fixed only by mermaid 12. The browser suite's lockfile holds 8 high findings, all cleared by puppeteer-core 25.

Constraints already on record: `@lezer/markdown` is pinned exactly because `editor/markdown/refAwareLink.ts` reads the `@internal` `parts` and `side` fields of its inline context (`refAwareLink.test.ts` holds the contract, and `team/roadmap/done/two-exact-pins-hold-back-web-upgrades.md` the reason); ghostty-web is pinned to the `next.20` build for mouse reporting (`team/roadmap/done/ghostty-terminal-backend.md`); the bundles build on Node 22 (`.nvmrc`); every web lockfile move invalidates the Nix `npmDeps.hash`.

## Desired contract

The core web dependencies sit at their current releases where the move is in range and proven, the fixed advisories are gone from the lockfiles, and each deferred move is written down with its reason.

## What to do

The owner took the recommendations as given ("i will take your recommendations for what to upgrade and what to defer"). Four stages, each landing on its own and each proven before the next:

1. One lockfile refresh within today's ranges: every `@codemirror/*` and `@lezer/*` package but `@lezer/markdown` (take `@codemirror/state` 6.7.6, not 6.7.3, which regressed), svelte 5.57.2, vite-plugin-svelte 7.3.1, svelte-check 4.7.7, vitest 4.1.12, marked, dompurify, cytoscape, and vite 8.3.4 or later for its three advisories (8.3.5 was published on the day of this reading). `@codemirror/commands` 6.11 moves the macOS default for `toggleBlockComment` from Alt-A to Ctrl-A through `defaultKeymap` (`editor/Source.svelte`, `editor/Wysiwyg.svelte`); a CHANGELOG line says so, or the keymap keeps Alt-A by the owner's word.
2. `@lezer/markdown` 1.8.1: run `refAwareLink.test.ts` against it first; 1.8.0 changed how strong and emphasis delimiters match, the area the `parts` and `side` reads depend on. Move the exact pin only if the contract test and the editor suites pass; otherwise record the failure here and keep 1.7.2.
3. `lucide-svelte` to `@lucide/svelte` (the old package is deprecated): the imports of 32 files under `web/packages/*/src`, the icons' size and class props read in a browser at each changed surface, and the webdev skill's line naming the package.
4. puppeteer-core 25 in the browser suite: 25 removes the `clickCount` click option, used at `checks/122-extension-echo.mjs` and twice in `lib/drafts.mjs`; replace it with `count`, check the launch's `executablePath` option in `run.mjs`, then the whole suite and every check alone.

Each stage re-harvests the Nix `npmDeps.hash` in both derivations and passes `make web-lock-check` and `make web-check`; stages 1 to 3 also run the whole browser suite.

The Tauri crates (tauri 2.11.2 to 2.12.4, tauri-build, and the dialog, opener and updater plugins) move with the carried `rcdesk` row, which touches the same Linux desktop jobs, not here.

## Deferred, with the reason

- vitest 5 and jsdom 30: both need a later Node 22 minor (jsdom 22.22.2 or later; the Nix `nodejs_22` version is unread against it); vitest 5 turns `clearMocks` on by default across about 820 `vi.mock` calls, and jsdom 30 rewrites focus, blur and computed styles, which the suite exercises. One later item for the two together.
- TypeScript 6 and 7: 6 deprecates `baseUrl` (both app `tsconfig.json` files) and defaults `types` to empty; 7 is outside svelte-check's peer range.
- mermaid 12: ELK becomes the default layout and the default theme changes, so every diagram moves; `@excalidraw/mermaid-to-excalidraw` 2.2.2 requires mermaid 11 and the repo's patch to it targets mermaid 11's cluster ids. The only gain is one low katex advisory.
- React 19: within Excalidraw's peer range, with nothing gained for the one `createRoot` in `editor/ExcalidrawCanvas.svelte`.
- xterm.js, ghostty-web and Excalidraw: no newer stable release.

## Boundaries

`web/package.json`, `web/packages/*/package.json`, `web/package-lock.json`, `scripts/e2e/browser-smoke/package.json` and its lockfile, the call sites named above, `packaging/nix/chan.nix` and `chan-desktop.nix` (the npm hash), the webdev skill's line. Not changed: the deferred packages, the Tauri crates, the ghostty-web pin.

## Acceptance

1. After each stage: `make web-lock-check`, `make web-check` and `make nix-hash-check` green, the npm hash re-harvested and proven, and the whole browser suite green but for the checks recorded as failing at the base.
2. `npm audit --package-lock-only` on the web lockfile shows none of the three vite advisories after stage 1, and on the browser suite's lockfile none of the eight after stage 4.
3. Stage 2's contract test result recorded here, whichever way it goes.
4. The block-comment key's decision in the CHANGELOG.
