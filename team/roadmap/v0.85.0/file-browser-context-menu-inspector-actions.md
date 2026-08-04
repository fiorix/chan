# File browser context menu and inspector actions

Status: REGISTERED for v0.85.0; implementation correction in progress.

- The file browser's right-click context menu offers a narrower set of actions than the inspector does for the same file, so a video reached by right-click has no view or download entry; the menu should carry the inspector's per-type actions, which means deciding whether the two surfaces share one action source or keep separate lists that drift.
