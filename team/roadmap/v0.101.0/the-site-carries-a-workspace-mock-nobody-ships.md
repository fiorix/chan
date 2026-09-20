# The site carries a workspace mock nobody ships, and the graph tuner a fixture nobody uses

Status: raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog, where the fixture's keep, slim or drop question was never answered. The claims are a source reading against `main` at `fa0df75ad`.

## What was seen

The marketing site shows a live launcher and no workspace. Its build (`web/packages/marketing/scripts/build.mjs`) bundles `launcher-demo.ts`, which mounts `@chan/launcher/demo` (`web/packages/launcher/src/LauncherDemo.svelte`), on the home page and in the manual's devserver iframe. The workspace mock beside it is dormant: `workspace-demo.ts` and `WorkspaceDemoOverlay.svelte` are imported by nothing the build emits, and the package README says they are "retained as dormant source files for a future re-enable".

What that dormant path keeps alive in the workspace app: the `./demo` and `./demo-data` package exports, `src/WorkspaceDemo.svelte`, `index.demo.html`, and `src/demo/` (fourteen files, about 124K: a mock router, socket, store, search, graph, upload, download and report, with a test). The only importers of those exports are the two dormant marketing files and the aliases `build.mjs` declares for them. In shipped code the mock's footprint is a replaceable-transport seam in `src/api/transport.ts`, documented there as existing for "the marketing-site workspace demo", and `handleDemoDownload`, called twice from `src/state/store.svelte.ts`.

Separately, `src/graph-tuner/sampleGraph.json` is 389,714 bytes of captured graph data. Its one importer is `GraphTuner.svelte`, a development page reached through `graph-tuner.html` that no build script or Makefile target names; the tuner also has generated data in `fakeData.ts`.

## Desired contract

Owner ruling, 2026-09-20: wipe it. The fixture was never used and neither was the workspace code exported to the marketing package; there will be no workspace mock on the website, and the launcher embed will itself leave the site at some point. Keep what remains tidy, without much complexity.

The workspace mock is gone from both packages, the launcher embed keeps working exactly as it does today, and the fixture is deleted. Nothing is left behind "for a future re-enable".

## Boundaries

`web/packages/marketing/` (the two dormant sources, the `build.mjs` aliases, the README's description of them), `web/packages/workspace-app/` (`package.json` exports, `WorkspaceDemo.svelte`, `index.demo.html`, `src/demo/`, `src/graph-tuner/sampleGraph.json` and the tuner's use of it). The transport seam and `handleDemoDownload` go only if the mock was their sole user; tests that install a fake fetch through the same seam keep it. `LauncherDemo.svelte` and its test are out of scope, as is removing the launcher from the site. Marketing direction belongs to the chan-mkt repository; this item removes code the site does not serve and changes nothing a visitor sees.

## Acceptance

1. No file under `web/` imports `@chan/workspace-app/demo` or `demo-data`, and the workspace app exports neither.
2. The marketing build output is byte-identical before and after, apart from hashed chunk names, and the home page's launcher and the manual's devserver iframe still mount.
3. `sampleGraph.json` is deleted and the graph tuner page still loads on its generated data, or the tuner is removed with it and the item says which.
4. Every seam left in `transport.ts` names a remaining user; none is kept for the mock.
5. `make web-check` is green, including the unused-locals gate, and the embedded workspace bundle is no larger than before.
