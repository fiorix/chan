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

## Stage 1, the in-range lockfile refresh 2026-10-21

Evidence paths below are under `dev/v0109-team/evidence/Frontend109/` in the round's bus (`webdep1/` for the refresh, `nix-harvest/` for the hash). Built in the frontend seat's guest (Ubuntu 24.04, Node 22.23.3, npm 10.9.9, 2 CPUs, 6 GiB) at `980864e24`, as four `npm update` calls in `web/` and a strict `npm install` after them, which leave every manifest unchanged (`webdep1/refresh-2.sh`, `refresh-2.{log,status}`, rc 0):

1. Every `@codemirror/*` and `@lezer/*` package with a newer release in range but `@lezer/markdown`: autocomplete 6.20.4, commands 6.11.1, lang-html 6.4.12, lang-markdown 6.5.2, language 6.13.1 and legacy-modes 6.5.5 (both of which bring `@codemirror/streamparser` 6.0.0), merge 6.12.3, state 6.7.6, view 6.43.15; `@lezer/common` 1.5.3, css 1.3.9, highlight 1.2.5, javascript 1.5.6, lr 1.4.11, rust 1.0.3. The other `@codemirror` and `@lezer` packages are at their newest release already.
2. marked 18.1.1 (mermaid's own copy stays at 16.4.2, the newest in its range), dompurify 3.4.17, cytoscape 3.34.4.
3. svelte 5.57.2 and svelte-check 4.7.7.
4. vite 8.3.5, `@sveltejs/vite-plugin-svelte` 7.3.1 and vitest 4.1.12, with `--legacy-peer-deps`.

The fourth call carries the flag because npm 10.9.9 cannot resolve it otherwise: its arborist throws `Cannot read properties of null (reading 'edgesOut')` in `#loadPeerSet` on any update that names vite, the svelte plugin or vitest, alone or together (`webdep1/probe-1.log`; svelte and svelte-check update alone without it), since vite 8.3's optional peer `@vitejs/devtools` 0.7 or 0.8 opens an optional peer cycle through `@vitejs/devtools-vitest`, vitest and vitest's browser and DOM providers. The flag ignores peer edges, so on its own it marks svelte's dependencies dev-only, 19 of them, although svelte is reachable from production through lucide-svelte's peer; `make web-check`'s `npm install` rewrites those flags at once (`webdep1/gate-web-1.log`, `lock_unchanged=no`). The strict `npm install` after the fourth call writes the flags npm 10 computes: no package's `dev` flag differs from the base, one `optional` flag moves (`@types/trusted-types`, which svelte 5.57 does not list, is held only by dompurify's optional edge), the lock holds no peer-only entry, and a second strict install changes nothing (`second_install_lock_unchanged=yes`). The result is checked by npm 10 in strict mode: `npm ls --all` exit 0, `npm install --dry-run` exit 0 listing only other platforms' optional binaries, and `make web-lock-check` exit 0 (`webdep1/refresh-2-web-lock-check.log`).

The lock moves 77 entries, every one inside the manifests' ranges (`webdep1/refresh-2-lock-changes.txt`). Six leave it: rolldown 1.2.14 no longer ships its `wasm32-wasi` binding, which takes `@napi-rs/wasm-runtime`, `@emnapi/core`, `@emnapi/runtime`, `@emnapi/wasi-threads` and `@tybys/wasm-util` with it. Three enter it: rolldown's new `android-arm-eabi` binding, `@codemirror/streamparser`, and a `magic-string` 1.4.3 nested under the svelte plugin. `@lezer/markdown` (1.7.2, the exact pin), `@codemirror/state`, `@codemirror/view`, `@lezer/common`, svelte and vite each have one copy in the tree.

The audit (`npm audit --package-lock-only`): 19 vulnerable packages (11 high) at the base, 17 (9 high) after (`webdep1/survey-base-audit.json`, `webdep1/refresh-2-audit.json`). None of GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw and GHSA-587h-7wmj-h5pm remains, and source-map-js 1.2.2 clears GHSA-68fv-2mgg-jv7q as well. What remains is what this row already records: the Excalidraw chain (`@excalidraw/excalidraw` with its nested nanoid 3.3.3, sass 1.51.0, which Excalidraw pins exactly, and chokidar 3.6.0; `@excalidraw/mermaid-to-excalidraw` with its nested nanoid 4.0.2 and `@mermaid-js/parser`; langium, chevrotain and their lodash-es), patch-package with micromatch, braces and find-yarn-workspace-root, and katex through mermaid (low).

The `npmDeps.hash` of both derivations, by the capped-guest route of the release skill (`nix-harvest/README.md`; Nix 2.18.1 from `nix-bin`, `NIX_REMOTE=local`, sandbox on, two jobs and two cores, each build bounded at 1800 s). The route's positive control at the base with no patch harvests the committed pin itself (`nix-harvest/base-control-2.seq.log`, `npm_got_equals_committed=yes`). With the refresh as the patch (`nix-harvest/stage1-2.seq.log`, patch SHA-256 `f1085df718258a0c0dec7e2cc725387963b14ef6ef0f72f94fab9d18d6d9d155`): the npm arm ends at exactly one fixed-output mismatch on `chan-0.108.0-npm-deps`, build status 1, `got: sha256-NUlUbrx8CFF26LKEB49uce/JQkKdDKMSBuNuPdgvsOA=`, which differs from the stale pin `sha256-ophJYJH5MKSpgFjiFSbv8QpIeAIsoVm+5PihPvwDb8M=`; with that value pinned in both files, `chan.npmDeps` and `chan-desktop.npmDeps` each build (exit 0) and rebuild with `--rebuild` (exit 0), so Nix fetched the tree twice and checked the hash each time. The guest held its 6 GiB cap through the fetches by reclaiming page cache (`memory.events` max count up, no OOM). The same route over the lock with the 19 dev-only flags (`nix-harvest/stage1-1.seq.log`) gives `sha256-l2At75xIZ0GyZs4tPmxjgeqZBemFA79P1o3jYTqLHuE=`, so the npm deps output follows the lock's flags as well as its versions.

svelte 5.57 declares `$props()` with no type parameter, so svelte-check refuses the generic form `$props<T>()`; the one place that spelled it, the test harness `src/__tests__/ModalStackHarness.svelte`, takes the annotated form `let { ... }: T = $props()` the components use.

svelte 5.57 also queues a zero-delay task when one of its event handlers runs and none is queued, to release the slot that holds the last event (its `handle_event_propagation`), so a test that counts its component's fake timers after a click or a pointer event counts one more: `StyleToolbar.test.ts` ("unmount cancels pending collapse and hide timers") and `PreflightOverlay.test.ts` ("a decision cancels its pending poll timer") go red at this lock and green with svelte 5.56.4 under vitest 4.1.12 (`webdep1/timers/bisect-1.log`), and the pending timer's creating stack is svelte's `events.js` (`webdep1/timers/stacks-1.log`). Those two files and `AppStatusBar.dismiss.test.ts`, which counts after a click as well, count through `src/__tests__/fakeTimers.ts`, which runs the tasks due now before it counts, so the count is the component's own timers in any test order (`webdep1/timers/verify-1.log`): the three files green; one mutant per guard killed at its own assertion (the toolbar's teardown of its collapse timer and of its hide timer, the overlay's cancel at a decision, `dismissStatus`'s clear); green again with svelte 5.56.4. Five shuffled orders of the three files leave one red, "a poll that lands after an answer does not bring the answered step back" in four of them, and it is red under the same four seeds at `980864e24` with nothing of this stage applied (`webdep1/timers/shuffle-control-1.log`), so it is an order dependence of that file outside this row.

The block comment key. Both editors take `toggleBlockComment` only from `@codemirror/commands`' `defaultKeymap` (`editor/Source.svelte`, `editor/Wysiwyg.svelte`); the app binds neither chord itself. 6.11 binds it as `{ key: "Alt-A", mac: "Ctrl-A" }`, an uppercase letter meaning Shift. Measured with a jsdom probe that mounts a Markdown editor with the list-prefix keymap and the default keymap, the platform set before CodeMirror loads (`webdep1/bcprobe/`, `run-1.log`, rc 0), at the base lock (commands 6.10.4, view 6.43.3) and the refreshed one (6.11.1, 6.43.15). On macOS at the base, Shift-Ctrl-A selects to the text start of a list item (the list-prefix keymap, `editor/decorations/list_prefix.ts`) and to the line start elsewhere (the emacs-style keys CodeMirror gives macOS), and Shift-Option-A is left to type its character, since the view treats an Option chord on macOS as a typed character: block comment has no chord on macOS. With 6.11.1, Shift-Ctrl-A inserts `<!--  -->` at the caret on the item line and on the plain line alike, because the view looks up the exact `Ctrl-A` before the `Shift-Ctrl-a` the list-prefix and emacs bindings are filed under, and Shift-Option-A still types its character. Elsewhere nothing moves: Shift-Alt-A inserts the comment at both locks. So with 6.11's keys a macOS user would lose Shift-Ctrl-A's selection to the line start and the list-prefix selection to an item's text start, and gain a block comment chord. Acceptance 4's decision is the ruling below, which owes no CHANGELOG line: the editor keeps its keys. Both keymaps (`editor/Source.svelte`, `editor/Wysiwyg.svelte`) take `editorDefaultKeymap` (`editor/editorKeymap.ts`), CodeMirror's default keys without their `toggleBlockComment` entry and with `{ key: "Alt-A", run: toggleBlockComment }`, which has no macOS key. The pin, `editor/editorKeymap.macos.test.ts` and `editorKeymap.linux.test.ts` over the shared `src/__tests__/editorKeys.ts`, mounts both editors and dispatches real keydown events, one platform per file since CodeMirror reads the platform once, when Node first loads it, and `vi.resetModules()` does not reset it: on macOS Shift-Ctrl-A selects to the item's text start on a list item in Wysiwyg and to the line start elsewhere, inserting nothing; on Linux Shift-Alt-A inserts the comment in Markdown in both editors and Shift-Ctrl-A does nothing, which also shows each file's platform took effect. Red first over this stage's lock without the keymap change (the four macOS cases, the comment inserted; the Linux cases green), green with it, and each mutant red on its own platform only: the `mac: "Ctrl-A"` entry put back (the four macOS cases) and the Alt-A binding removed (the two Linux comment cases) (`webdep1/fold/redgreen-2.log`).

The whole browser suite at `aecacfa03`, this stage before the keymap change and the text above: in the frontend seat's guest at 2 CPUs, all green, 92 checks ran, none skipped or failed, 1781 s (`webdep1/browser/whole-1.{log,status}`, `whole-1-results.json`); and the lead's run in the integration guest (`dev/v0109-team/evidence/Lead109/int/browser-webdep1-tip/` in the round's bus). By the lead's ruling the suite is not run again for the keymap change: its delta, two keymap lines, the shared constant, the pins and text, is covered by `make web-check` at this commit and by the keydown pins.

## Stage 2, `@lezer/markdown` 1.8.1 2026-10-22

Evidence paths below are under `dev/v0109-team/evidence/Frontend109/` in the round's bus (`webdep2/` for the pin, `nix-harvest/stage2-1/` for the hash). Built in the frontend seat's guest (Ubuntu 24.04, Node 22.23.3, npm 10.9.9, 2 CPUs, 6 GiB) as one commit, `cf4fa993a`, over the frontend branch's `a092cb427`, whose web manifests and lockfile equal `v0109/int`'s.

The contract test first (`webdep2/probe.sh`, `webdep2/probe-1.{log,status}`, rc 0): a strict `npm ci`, then `npm install @lezer/markdown@1.8.1 --save-exact -w @chan/workspace-app` with no flag, then `refAwareLink.test.ts` alone, 10 of 10, and the whole `src/editor` directory, 112 files and 1285 tests, all passing at 1.8.1. So the exact pin moves to 1.8.1, as What to do 2 allows. The lock moves that one entry (`node_modules/@lezer/markdown` 1.7.2 to 1.8.1, beside the workspace app's dependency line), and a second `npm install` leaves it as it is.

The npm hash, by stage 1's route (`nix-harvest/stage2-1.seq.log`, patch SHA-256 `a8a3e944c9230fdf31e3cfb7e148aaa5c05054adba58982586da9362fd1db779`): the npm arm ends at exactly one fixed-output mismatch on `chan-0.108.0-npm-deps`, `got: sha256-Yunm8W8wIC9yKMt89Pi7UWouAlIIZkOOc6H2oXA6ttQ=`, which differs from the stage 1 pin; with that value pinned in both files, `chan.npmDeps` and `chan-desktop.npmDeps` each build and rebuild with `--rebuild`, exit 0 four times.

At the commit (`webdep2/gate-1.log`, rc 0): `make web-lock-check`, `make web-check` (svelte-check clean in every package; vitest green in web-shared, 7 files and 218 tests, the launcher, 57 and 619, the workspace app, 586 and 7456, and profile, 5 and 20; the builds made; the lockfile unchanged) and `make nix-hash-check` pass. `npm audit --package-lock-only` (`webdep2/audit-1.log`): 17 vulnerable packages, 9 high, the set stage 1 left, none of the three vite advisories, and `@lezer/markdown` not among them.

The whole browser suite at the commit, with strict `npm ci` in `web/` and in the suite directory first (`bin/browser-whole.sh`; this branch's suite lock, `puppeteer-core` 24.43.1; `webdep2/whole-1.{log,status}`, 1937 s): 96 checks, none skipped, 93 green and three red, each read to its wait. `163-file-browser-watch-refresh` counted three graph fetches for one burst ("the shared graph was fetched inside a burst or more than twice for one"), the count the base records as red under load and the graph refresh item's page half changes. `178-typed-broadcast` asserted the window's whole terminal roster as the broadcast group and met other checks' terminals in it, the fault of the check-178 row, repaired on the integration branch at `997115535` and absent from this branch. `62-binary-transfer-streaming` failed at its coalescing probe, a 256-file upload that did not land within the probe's 30 s bound ("coalescing probe upload did not finish", the check ending at 130.9 s). The check passed alone twice at the commit and once at the parent `a092cb427` (`webdep2/c62-tip-1`, `c62-tip-2`, `c62-parent-1`, 108 to 110 s each), and nothing in this stage reaches the upload path. The red is an I/O stall in the guest during the probe, read from the four runs' timelines (copied to `dev/v0109-team/evidence/Review109/webdep2/`): the runs' requests match within a second up to the probe; in the whole run the probe then landed 17 to 35 files a second for four seconds and 0 to 4 a second for about twenty while the guest's io full pressure rose to 30.7 and its CPU use fell to about 0.3 cores, and 235 of the 256 files had landed when the 30 s bound passed, where each solo run landed all 256 in under 7 s with io full at most 3.3. Other guests on the same storage pool were writing through the whole run's probe window and, by the bus's job markers, through none of the solo runs' (a whole `chan-server` test suite, two `npm ci` worktrees, a browser-suite `npm ci`); which of them stalled the upload is not established.

Acceptance 1 for this stage: `make web-lock-check`, `make web-check` and `make nix-hash-check` pass, the npm hash is re-harvested and proven, and the whole browser suite is green but for 163, the base's recorded load red, 178, the fault the check-178 row repairs, and 62, placed above as an I/O stall during its probe.

Acceptance 3: the contract test passes at 1.8.1 and the pin moved. It passes at 1.8.0 as well (one copy swapped in, `dev/v0109-team/evidence/Review109/webdep2/job-2.log`), so it shows that 1.8.1 keeps the delimiter parts and sides the editor reads, not how 1.8.0's change would reach them.

## Stage 4, Puppeteer 25 in the browser suite 2026-10-21

At `65435b4742aa3cacef5c480594eedc6557d6c046`, the browser suite uses `puppeteer-core` 25.15.0, and all three live triple-click call sites use its `count` option; the installed 25 API still accepts `run.mjs`'s `executablePath` launch option. Strict `npm ci`, `node --check` on both changed modules, `make web-lock-check`, and `make nix-hash-check` passed in the Hygiene guest. The suite lockfile's `npm audit --package-lock-only` result moved from eight high findings to zero findings. Neither Nix `npmDeps.hash` changed: both derivations take npm dependencies from `${finalAttrs.src}/web`, outside the browser suite. No path under `web/` moves in this stage, so `make web-check` is not rerun for it: the `web/` tree it lands on is the one the full gate at stage 1's landing passed.

At that code commit, the first whole run exercised 92 checks with zero skipped and failed only `133-drafts-two-windows.mjs` while waiting for the Close Draft dialog; check 133 passed alone in the first solo loop. That loop ran all 92 checks and failed only `103-slide-blank-band.mjs`, which had passed in the first whole run; a second solo run of 103 passed with the expected two spacers. The quieter whole rerun passed all 92 checks with zero skipped. Neither failing step calls an API that Puppeteer 25 changes: check 133 waits for the dialog after an in-page command event, and the guest's CPU pressure stayed near zero through that 15 s wait, with its memory near the guest's cap; check 103 read the first slide's heading with no spacers after its counter showed the third slide, and the failure screenshot taken after that read shows the third slide whole. Neither red's cause is established. Both first failures remain in the evidence, so the accepted reading includes a green whole run and every check green alone at the same code commit.

The first run's `whole.status`, 92 `solo-*.status` files, results and logs are under `dev/v0109-team/evidence/Hygiene109/webdep4/committed-run/`; the 103 retry's log, status and exported guest result are under `dev/v0109-team/evidence/Hygiene109/webdep4/solo-103-retry-1/`; the green whole rerun's log, status and exported guest result are under `dev/v0109-team/evidence/Hygiene109/webdep4/whole-rerun/`. The first failure screenshots are `whole-133-failure.png` and `solo-103-slide3.png` in `dev/v0109-team/evidence/Hygiene109/webdep4/`. The rerun used `whole-rerun-launch.sh` and `whole-rerun.guest.sh`, whose SHA-256 values are in `whole-rerun-scripts.sha256` beside them.

## Lead's rulings 2026-10-21

The block comment key, in the owner's answer's words, by survey at 12:26Z: "A: keep today's keys (recommended): block comment stays Shift-Alt-A everywhere, macOS Shift-Ctrl-A keeps selecting". The editor keeps today's keys: the app binds `toggleBlockComment` to Shift-Alt-A itself, without CodeMirror 6.11's macOS entry, in both editor keymaps, so macOS Shift-Ctrl-A keeps selecting to the line start and, on a list item, to the item's text start; a pin dispatches a real macOS keydown for both selections and a Linux Shift-Alt-A for the comment; no CHANGELOG line is owed, since nothing a person does changes.

## Owner's word 2026-10-21 on the macOS block-comment key

The first answer ("A: keep today's keys") was read back to the owner with the measured fact that macOS then has no block-comment chord at all, as it had none before this version (Shift-Option-A types a character), while Linux and Windows have Shift-Alt-A. The answer: "A: as today (recommended): no block-comment key on macOS; Shift-Ctrl-A keeps selecting; one line in the release report says so".
