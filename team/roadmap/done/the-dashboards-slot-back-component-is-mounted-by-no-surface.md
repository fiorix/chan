# The dashboard's slot-back component is mounted by no surface

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the build: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of the icon-set change; closes in the round.

## What was seen

`web/packages/workspace-app/src/components/dashboard/DashboardSlotBack.svelte` is mounted by nothing but its own test: the pane's back-side switch stopped importing and mounting it when the pane tab flip was added (`0d59d01f0`), and Settings became the one configuration surface the same month (`4cee61b9b`). `WorkspaceSlotConfig.svelte` is imported only by that component and its own test. Three comments still describe the flip-back as live (`EmptyPaneCarousel.svelte` near its slot-back note, `WorkspaceInfoBody.svelte` in its head comment and at its configure action).

## Desired contract

The two components that no surface mounts are gone, and no comment describes the flip-back they served.

## What to do

Remove the two components and their tests, and rewrite or drop the three comments so they describe the surfaces as they are. A grep of the app for the two component names, red at the parent and green at the commit, is the pin.

## Boundaries

The two components, their two tests, the three commented files. Not changed: the dashboard's cards, the pane's back side, Settings.

## Acceptance

1. The grep pin red first; `make web-check` green at the commit.
2. The three comments read true against the code at the commit.

## Lead's rulings 2026-10-22

On the frontend seat's plan, 16:22Z: **Ruled, dated 2026-10-22,** on the row's Desired contract, which is that the two components are gone and no comment describes the flip-back they served, across the app and not only in the two named files:

- **A and B taken** as the comment rewrites you propose (`EmptyPaneCarousel.test.ts` 59, `GraphCanvas.svelte` 1910), comment only.
- **C (i) taken:** `HybridSurfaceConfigShell.svelte`'s `footerCenter` and `footerBorder` props, the footer's centre slot markup and the border toggle are removed in the same commit as the slot-back's residue (dead code, whose only caller goes); the pin's grep widens to `DashboardSlotBack|WorkspaceSlotConfig|footerCenter|footerBorder`, red at the parent and green at the commit, and the shell's existing test is the guard that its two kept callers (`HybridEditorConfig`, `HybridFileBrowserConfig`) still render. Not touched: the dashboard's cards, the pane's back side, Settings.
- **D taken as comment only,** after your read of the two mounts (`settings/workspace/ScreenLockControl.svelte`, `PlainScreensaverPreview.svelte`): `MatrixRainPreview.svelte` 12 to 18 names the preview by where it is mounted today and drops the About-slot config and the back-face sentences; a statement you cannot verify from those mounts is left out, not rewritten, and the hand-back says so. No row of its own.

On the seat's read of the two previews' mounts, 16:40Z: **Ruled, dated 2026-10-22:** E is taken as you propose, comment only, in dslotb's commit beside D: `PlainScreensaverPreview.svelte` lines 2 to 4 name the preview by its one mount (`ScreenLockControl`, line 292) and keep the interface sentence without the back-face reason you cannot verify; D's rewrite as you describe it (the mount named, the gating facts the code shows kept, the back face and the rotated-away parenthetical dropped). Your plan's D correction (the preview mounted by `ScreenLockControl` alone; `PlainScreensaverPreview` names it in a comment only) goes into the row's rulings section with E as a fifth point.

On the seat's finding that the shell's two callers are unmounted as well, 17:07Z (this replaces C):

- **Ruled, dated 2026-10-22:** **(a)** is taken. dslotb's one commit removes the whole family, `HybridSurfaceConfigShell.svelte`, `HybridEditorConfig.svelte`, `HybridFileBrowserConfig.svelte` and their three tests, beside the row's two components and their two tests; C's prop removal folds into the shell's removal. The reason: the family is the same class of dead code from the same cause as the row's two, nothing a person sees changes (none of it mounts), the removal touches neither the pane's back side nor the dashboard's cards nor Settings, and a row of its own would cost a review cycle for six files the row's reading already placed. The pin's grep widens to `DashboardSlotBack|WorkspaceSlotConfig|HybridSurfaceConfigShell|HybridEditorConfig|HybridFileBrowserConfig` over `web scripts`, red at the parent (the count stated) and rc 1 at the commit beside the positive control. The row's Boundaries widen by this ruling: write it into the row's "Lead's rulings 2026-10-22" section as the lead's words (the family named, the cause, the five-name pin, the untouched surfaces), with the D correction already there. **(b)** and **(c)** are not taken.
- **F and G:** taken as comment rewrites in the same commit, as A, B, D and E were. G as you propose. F: first verify against the code at `a08fcaa07` that a carousel mounted later in the page (another Dashboard tab, or one mounted again) does render its graph synchronously from the cache (read the cache's reader in `EmptyPaneCarousel.svelte` or wherever `indexingStatus`'s cache is consumed, and name the lines in the hand-back); if that holds, the rewrite as you propose; if it does not, drop the false sentence and leave the cache's purpose unstated rather than restated, as D's rule says.

## Built 2026-10-22

Removed, each mounted by no surface and imported only by its own test or by another removed file. All three Hybrid backs lost their mount in the pane A/B flip, the change that also dropped `DashboardSlotBack`.
- `components/dashboard/DashboardSlotBack.svelte` and its test, and `components/dashboard/WorkspaceSlotConfig.svelte` and its test. The directory goes with them.
- `components/HybridSurfaceConfigShell.svelte`, `HybridEditorConfig.svelte`, `HybridFileBrowserConfig.svelte` and their three tests.

What the removed files reached keeps its other callers:
- the slot labels and count (`DashboardTab`, `EmptyPaneCarousel`);
- `tab.autoRotate` (`tabs.svelte.ts`'s opts and session restore, read by `DashboardTab`);
- `api.config()` (`SettingsOverlay`, `store.svelte.ts`);
- `settings/commit`'s `SaveStatus` (six other users).

The recent-workspaces list `WorkspaceSlotConfig` showed had no reachable surface before this change and has none after; `/api/config` still serves it. No browser check reads any of the five. `Pane.surfaceTheme.test.ts` asserts that no `.hybrid-config` renders, which stays true.

The comments, rewritten to describe the surfaces as they are (lines at the commit):
- `EmptyPaneCarousel.svelte`:
  - the indexing cache's seed (110 to 116) and its write (124): "a carousel mounted later in the page (another Dashboard tab, or this one mounted again)", and "the next mount";
  - the Workspace slide's note (505 to 508), without the config clause.
- `WorkspaceInfoBody.svelte`:
  - the head comment (2 to 13), "the Dashboard's Workspace slide", without the recents clause;
  - the variant's "dashboard slide" (13);
  - the `variant` doc (51 to 52), "the Dashboard's Workspace slide, where the action row does not render".
- A, `EmptyPaneCarousel.test.ts` 56 to 60: "The cursor is the single source of truth for the shown slide".
- B, `GraphCanvas.svelte` 1910: "(a first load)".
- D, `screensaver/MatrixRainPreview.svelte` 12 to 21: the preview named by its one mount, `ScreenLockControl` in Settings (290). It keeps the gating the code shows: the IntersectionObserver, the document's visibility, the still under reduced motion, and the interval cleared in `onDestroy`. The back face and the rotated-away case go.
- E, `screensaver/PlainScreensaverPreview.svelte` 2 to 4: named by its one mount, `ScreenLockControl` (292), with the interface sentence and no back-face reason.
- F, `state/indexingStatus.svelte.ts` 3 to 7: the Hybrid flip sentence goes, since `Pane.svelte` keeps every dashboard of both sides mounted (`everyTab`, 200; the keep-alive at 2092). The cache's purpose stays as verified at the parent:
  - `EmptyPaneCarousel.svelte` 115 seeds `indexing` from `indexingCache.last`;
  - the spine derives from it (163 to 165), and the loading stub shows only while it is null;
  - `EmptyPaneCarousel.slides.test.ts` 82 to 88 pins "draws the cached indexing graph at once, before its first poll answers".
- G, `state/tabs.svelte.ts` 685: "The tab menu's on/off rows read them from here."
- C's prop removal folded into the shell's removal.

**The pin**, run in the frontend guest's private checkout (`evidence/Frontend109/dslotb/pin.sh`, `build/pin-1.log`): `git grep -n -E 'DashboardSlotBack|WorkspaceSlotConfig|HybridSurfaceConfigShell|HybridEditorConfig|HybridFileBrowserConfig' -- web scripts`.
- At the parent `a08fcaa07`: rc 0, 23 lines. The removed files' own uses, the shell's three importers and their tests, and the three comments the row names.
- At the commit: rc 1, no line.
- Positive control beside it: `git grep -l WorkspaceInfoBody -- web scripts`, 7 files at both.

**What remains of the wider search** at the commit (`flip-back|slot picker|About-slot|Hybrid back|config back|footerCenter|footerBorder` over `web/packages/workspace-app/src`):
- the pane's own side flip: `FileEditorTab` 278, `Source` 172, `Wysiwyg` 487, and `Pane.svelte`'s `--pane-side-flip-back` (1477, 2294);
- Team Work's config writes, in `TeamDialog.load.test.ts`.

The earlier pane-flip mentions in the plan (`FileEditorTab` 209, the pane's back-face CSS and its source-text test) are the same live flip.

The gate at the code commit `7c35ceeb6` in the frontend guest from a clean fetch (`evidence/Frontend109/drsvrf/gate.sh`, `build/gate-1.log`): `VITEST_MAX_WORKERS=1 make web-check` rc 0 (17:11:55Z to 17:31:06Z; the workspace app 7619 tests in 590 files, web-shared 218, the launcher 624, profile 20), the web lock unchanged and the checkout clean after; svelte-check 0 errors in the dev tree before the commit, the nine touched test files 86 of 86 (`build/dev-1.log`). The guest across the pin and the gate (`build/seq-1.cgroup-before.txt`, `-after.txt`): no cap reclaim and 24 more throttled periods.

Acceptance: (1) the pin is red at the parent and green at the commit; `make web-check` is green at the commit; (2) every comment named above reads true against the code at the commit. The evidence is under the bus's `evidence/Frontend109/dslotb/`:
- `plan.md`;
- `edit.py` with `scripts.sha256`;
- `build/` (the rebase record, the pin, the dev run and the gate).
