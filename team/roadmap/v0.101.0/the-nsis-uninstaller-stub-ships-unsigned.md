# The NSIS uninstaller stub ships unsigned

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's Windows signing leftovers; unchanged from v0.99.0. A source reading against `main` at `6237c2677`.

## Owner ruling

Accepted on 2026-09-24 as the lead recommended: scheduled at rc1 rather than as a lane now, because only a release dry run can validate it. Sign the stub after a PE rename or in a post-build step; if it cannot be signed, record the limitation in `.agents/desktop.md` and close the item with that reason.

## What was seen

tauri's NSIS bundler passes its `nst*.tmp` uninstaller stub through the sign command, CodeSignTool refuses it as "Unsupported file format", and `sign.ps1` logs the skip (`desktop/src-tauri/scripts/windows/sign.ps1:88-91`). The stub is written into the installer unsigned.

## What to do

Find whether tauri or NSIS can sign the stub after it is renamed to a PE extension, or sign it in a post-build step; otherwise record the limitation in `.agents/desktop.md`. Validate on a release dry run.
