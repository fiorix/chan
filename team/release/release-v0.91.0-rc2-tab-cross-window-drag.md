# RC report: 0.91.0-rc2 / tab-cross-window-drag

## Scope

A tab dragged between two windows of one workspace arrives as itself. Pre-existing on `main`, found by another agent while bringing up the HybridWindow prototype on the desktop, reported against `main` and confirmed present in `0.91.0-rc1` unchanged.

1. **Every tab kind crosses as itself.** `crossWindowPayload` is exhaustive over the `Tab` union, ending in a `never` binding. Graph, file browser and dashboard tabs carry a `SerTab` snapshot from the session serializer; the target rebuilds them through the same `restore*FromSer` functions a window reload runs.
2. **A move is not a destroy, on either side.** A moved file tab flushes its buffer first, and a moved draft is released rather than discarded or promoted.
3. **Acceptance is claimed only after the rebuild succeeds.** Both drop handlers adopt first and call `preventDefault` last.
4. **Regression coverage**: a browser check that drives two real windows, and a scenario pack for what no harness can reach.

## The defect

`crossWindowPayload` listed file, terminal and extension, then ended in:

```ts
return { kind: "terminal", title: t.title };
```

A dragged graph, file browser or dashboard tab therefore announced itself to the other window as a terminal. The target read a terminal with no `terminalSessionId`, took the fresh-terminal branch, and returned success; the accepted drop set `dropEffect = "move"`, and the source's `dragend` closed the original. A graph went in and a terminal came out.

Every layer behaved correctly on the data it was given. Only the label was wrong. That is why nothing caught it: no unit test covered the payload, and no browser check drove two windows.

The `Tab` union has exactly six members, so the affected set was graph, browser and dashboard. The reason a seventh kind would have inherited the bug is structural: the catch-all was a `return`, not a `switch`, so a new kind opted into the mislabel by doing nothing.

## Findings beyond the report

The incoming report described the payload defect and a containment fix on the prototype's own branch. Four things it did not cover:

1. **The fix was not in this repo.** Neither `feat/hybrid-window` nor commit `18c0181d` exists in `chan`; that work lives only in the prototype checkout. `main` and `0.91.0-rc1` both carried the fully destructive version.
2. **Dragging a draft could delete it.** Drafts are file tabs (`isDraftTab`), and the source-side close ran the ordinary draft flow. An empty or pristine-seed draft was passed to `api.discardDraft` with no prompt at all -- deleting the file the target window had just opened. A draft with content raised the promote/discard modal *after* the drop landed: promote moved it out from under the target's path, and cancel left the same draft open in both windows. This is worse than the reported bug: it destroys a file rather than a view.
3. **Both drop handlers accepted before they knew.** `preventDefault` was called before `acceptCrossWindowTab`, and `preventDefault` is the entire signal that makes the source release. Any failed rebuild destroyed the tab.
4. **The extension branch always claimed success**, though `openExtensionInPane` rejects a malformed id and returns null. Latent rather than live, but the same tab-loss shape.

The report also stated the loss was unrecoverable. It is not: `closeTabAsync` calls `rememberClosedTab` before the splice and `cloneTab` deep-copies, so the tab lands on the recently-closed stack with its state intact and "Reopen closed tab" restores it in the source window. Still a defect -- silent, and it strands a junk terminal in the target -- but the data was never gone.

## Design decision

The three view-state kinds cross through the **session serializer** rather than a bespoke drag payload. A moved tab is rebuilt by exactly the code a reload runs, so its fidelity is whatever a reload already guarantees, and a newly persisted field has to be taught to one mapping instead of two that drift apart. The coupling is deliberate and is recorded in the scenario pack, because it cuts both ways: anything that narrows what a reload preserves silently narrows what a move preserves.

## Validation

- `Pane.test.ts` and `tabs.test.ts`: 282 tests green, including the payload kind for graph/browser/dashboard, the graph round trip through snapshot and adopt, the fresh-id rule, the refusal of an unrebuildable snapshot, the draft release, the dirty-file flush, and the save-failure case that keeps the tab.
- `make web-check` green (typecheck, lint, every package suite).
- Full `make pre-push` green on the candidate.
- **The new browser check was proven to fail before it was trusted.** With the fix: `PASS`. With the catch-all restored: `FAIL: dashboard: crossed the window boundary as "terminal"`. Restored to green afterwards, and validated in full-suite position as the harness README requires.

## Coverage added

- `scripts/e2e/browser-smoke/checks/124-tab-cross-window-drag.mjs`: two real windows of one workspace, the app's real `dragstart` and drop handlers, the real `DataTransfer` payload carried between them. Asserts the kind that arrives, that exactly one tab arrives, that no stray terminal appears, and that the source releases. Covers dashboard and file browser; both are reachable from a command, so it needs no fixture.
- `scripts/e2e/scenarios/tab-drag-and-drop.md`: TD-01 through TD-08.

## Known risks

- **TD-08 is manual on all three desktop platforms, and that is a real gap.** No browser automation protocol can drag between two top-level windows -- even the Chrome check replays the payload rather than performing the pointer gesture -- and the desktop shells expose no automation endpoint at all. This matters on this surface specifically: WKWebView mangles a MIME type containing `:` or `|`, which is why the drag scope is hex-encoded through `dragScopeMimeToken`; without that encoding every drop is rejected on macOS, and no Chrome check can see it. A green web suite is evidence about Chrome.
- **The check simulates the transport, not the gesture.** It drives both real handlers and carries the real payload, so the wire contract is covered end to end; pointer-level behaviour (drag images, autoscroll, the no-drop cursor) is not.
- **Browser and dashboard field fidelity is not compared end to end.** The graph round trip is pinned field by field; the other two are covered at the payload level and by the shared reload path, not by a full field comparison.
- Multi-selection (`BrowserTab.selectedPaths`) is not restored by the reload path, so a moved file browser does not carry it either. Pre-existing, and inherited deliberately by routing through the session serializer.

## Changelog-worthy user impact

- Dragging a graph, file browser or dashboard tab to another window now moves that tab, with its view state, instead of replacing it with an empty terminal.
- Dragging a draft to another window no longer risks discarding or relocating it.
