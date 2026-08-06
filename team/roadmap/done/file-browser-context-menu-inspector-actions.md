# File browser context menu and inspector actions

> Status: shipped in [v0.85.0](../../release/release-v0.85.0.md).

Status: IMPLEMENTED for v0.85.0; automated evidence complete.

- The file browser's right-click context menu offers a narrower set of actions than the inspector does for the same file, so a video reached by right-click has no view or download entry; the menu should carry the inspector's per-type actions, which means deciding whether the two surfaces share one action source or keep separate lists that drift.

## Implemented contract

The two surfaces share one action source. A classifier decides which actions apply to a path from its kind and the caller's capabilities, and both the inspector and the file tree render what it returns, so the two cannot drift apart by construction rather than by discipline.

- Applicability is capability-driven. A caller passes what it can do, such as whether uploads are allowed, and the classifier emits only the rows those capabilities permit. The inspector and the tree pass different capability sets for the same path and therefore legitimately show different rows, without either holding its own action list.
- Ordinary-file replacement is retained. It was the behavior most at risk from unifying the two lists and it is pinned directly.
- Media routing discriminates image, video, audio, and PDF inside one shared branch and routes all four to the media viewer.

## Implementation evidence

- Parity between the inspector and the tree is asserted directly, per file kind, rather than inferred from the two rendering the same component.
- The classifier's capability-omission behavior is covered independently of either surface, so a regression in applicability fails without needing a mounted component.
- Eighteen test files source-pin the two rewritten components. All eighteen were run together: sixteen passed unmodified, and two asserted syntax the rewrite legitimately dissolved and were re-pointed at the current shape. Both re-pointed assertions were verified to fail against the pre-change source, so neither passes by accident.

## Boundary worth recording

The original work shipped with two of those eighteen suites already stale, because the candidate branch never ran them. Blob-identity across candidate branches tells you a test was not updated; it does not tell you the test still passes. Only running it does.
