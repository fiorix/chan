# The NSIS uninstaller stub ships unsigned

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the release report's Windows signing leftovers; unchanged from v0.99.0. A source reading against `main` at `6237c2677`.

## What was seen

tauri's NSIS bundler passes its `nst*.tmp` uninstaller stub through the sign command, CodeSignTool refuses it as "Unsupported file format", and `sign.ps1` logs the skip (`desktop/src-tauri/scripts/windows/sign.ps1:88-91`). The stub is written into the installer unsigned.

## What to do

Find whether tauri or NSIS can sign the stub after it is renamed to a PE extension, or sign it in a post-build step; otherwise record the limitation in `.agents/desktop.md`. Validate on a release dry run.
