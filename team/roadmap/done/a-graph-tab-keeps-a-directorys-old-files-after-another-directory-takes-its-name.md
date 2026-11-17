# A graph tab keeps a directory's old files after another directory takes its name

Status: shipped in [v0.131.0](../../release/release-v0.131.0.md): a change that names a directory whose children a graph tab holds reads that directory's level again as well as its parent's, so after one directory takes another's name the tab draws the files on disk there before any reload, and the whole-fetch bound is unchanged (`v0131/graphrename` at `873952bf9` and `4ad9db179`, merged as `64de5f467` and `4369cba51`). Read by workspace-app tests with four mutations and by check 228 in a guest's Chrome, red at the base and green in five runs at the tip. Not observed: chan-desktop's engines and macOS.

Record before the release: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: found on 2026-11-13 by the confirm read of the second independent review of v0.129.0's graph fixes, in a vitest probe drawing from the spine alone, and older than that work (`dev/v0129/reviews/review-graphfix-2.md`, "Confirm read of round 4", follow-up 1; probe D in `dev/v0129/evidence/graphfix/review-2/probe-vitest-4/run.log`). Left open in the shipped [graph row](../done/the-graph-tab-draws-a-different-graph-for-each-way-it-is-opened.md) ("Open") and in `dev/v0129/row-notes.md`, "Graph work: follow-ups from the second review". At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`, in `web/packages/workspace-app/src/components/GraphPanel.svelte` unless named:

- A change in the workspace patches the tab's spine. `spineDirsTouched` (1439-1453) takes the parent directory of each path the change names, when the spine holds that parent's children or the tree draws them; `patchSpine` (1537-1580) reads each such level again, and `applySpineLevel` (1600-1646) lays it over what the spine held.
- A named path that is itself a directory the spine holds is not read. After `mv releases/v2 releases/v3 && mv releases/v1 releases/v2`, with `releases` and `releases/v2` opened, only `releases` is read; `releases/v2` is a directory before and after, so `applySpineLevel` keeps what the spine held below it. The tab draws `releases/v2/old.md`, which is now `releases/v3/old.md`, and not `releases/v2/new.md`, which came from `v1`, until `Reload graph` or a whole fetch. Shown by the probe while the tab draws from its spine alone. By reading, the shared graph laid over it does not remove the stale file: `withSpine` (`web/packages/workspace-app/src/graph/sharedGraph.ts:86-99`) adds every spine node the shared graph does not hold; not run.

## Desired contract

1. A change that names a directory the spine holds reads that directory's level again too, so its children are what is on disk after the change: in the sequence above `releases/v2` shows `new.md` and not `old.md`, with or without the shared graph laid over.
2. A patch stays bounded as now: one that would read as many directories as a whole fetch is a whole fetch.

## Boundaries

- `spineDirsTouched` and the patch path in `GraphPanel.svelte`.
- Not here, two lower items from the same read: a symlink swapped between the route's scope check and its walk would be listed (the escape guard has the same window); the symlink check matches a link by its target's directory, so a change there reads again every held directory with a link into it (performance only).

## Acceptance

1. Workspace app tests over the graph panel with the fs-graph stub (`web/packages/workspace-app/src/__tests__/graphPanel.ts`), the sequence above: drawing from the spine alone, and with a shared graph laid over that holds `releases/v2/new.md` and `releases/v3/old.md`; in both `releases/v2/new.md` is drawn and `releases/v2/old.md` is not. Red on the code without the change.
2. A browser check in a guest that runs the sequence in a real workspace with the tab's directories opened and reads the drawn nodes after the change, before any reload.

## Built, 2026-11-14

A change naming a directory whose children the spine holds now reads that level again as well as its parent. The same rule refreshes a previously opened directory while it is closed, without reading a directory whose children were never held. The existing whole-fetch bound is unchanged. The manual's graph page and the workspace app's design document describe the refresh.

The five mounted regressions in `GraphPanel.rename.test.ts` cover the replacement with the spine alone and a current shared graph, an unopened directory, a held directory closed across the rename, and the exact whole-fetch threshold. The first run at the base failed both stale-child cases and the threshold case; the restored implementation passes all 184 graph-panel and shared-graph tests. Four mutations fail: omitting the named level, reading every named path, reading only opened directories, and allowing an equal-cost patch. Full command outputs and restoration hashes are under `dev/v0131-team/evidence/Web131/graphrename/` (`unit-base-red.log`, `graph-tests-green.log`, and `mutation-*.log`).

Browser check 228 performs the real directory renames in a workspace and reads the selected directory's painted canvas labels without reloading. It holds the actual descendant-file and index-apply notifications until after the assertion, since their child-file paths could repair a stale directory-only patch. Directory rename messages and HTTP responses pass unchanged; the page receives the real completed shared graph after index recovery. Initial and final index-readiness barriers and fixture tag edges prove that both fixture files were indexed at their expected paths. The check records requests, original watcher frames, graph responses, and before/after screenshots.

In the guest, the final check at `ab2615014` with only `GraphPanel.svelte` restored to the base fails at the intended canvas assertion: the server and page graphs exclude the old path, but the selected `v2` still draws `new` and stale `old.md`; only `releases` was reread (J26). With the tip panel restored and rebuilt, five separate runs pass, with zero skips: `v2` draws `new` and neither old label, both `releases` and `releases/v2` are reread, no root fetch occurs, the page's time origin stays unchanged, and the real child/apply notifications remain held through the assertion (J28). The builder read every before/after screenshot and audited the raw records. Evidence is under `dev/v0131-team/evidence/Ops131/J26/` and `J28/`; the five-run comparison is `dev/v0131-team/evidence/Web131/graphrename/final-browser-audit.json`. Earlier runs stopped at harness preconditions and are not counted as regression evidence.

The committed frontend and marketing gates passed at `187ccc006` with a clean tree before and after (J14); subsequent commits change only check 228 and this closing record. The existing graph checks 98, 110, 111, 112, 163, 174, 218 and 224 passed together, eight checks and zero skips, on the same production source (J16). JavaScript syntax and diff checks passed on the final check commit (J26). The evidence covers headless Chrome in the Linux guest; no desktop or macOS run was required by this row. Fable review and the integration gate remain the lead's acceptance steps.
