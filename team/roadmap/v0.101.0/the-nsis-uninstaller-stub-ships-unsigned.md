# The NSIS uninstaller stub ships unsigned

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the release report's Windows signing leftovers; unchanged from v0.99.0. A source reading against `main` at `6237c2677`.

## Owner ruling

Accepted on 2026-09-24 as the lead recommended: scheduled at the version's first release candidate, rc0, rather than as a lane now, because only a release dry run can validate it. Sign the stub after a PE rename or in a post-build step; if it cannot be signed, record the limitation in `.agents/desktop.md` and close the item with that reason. The ruling named the first candidate rc1; on 2026-09-27 the owner ruled that a version's first release candidate is rc0.

## What was seen

tauri's NSIS bundler passes its `nst*.tmp` uninstaller stub through the sign command, CodeSignTool refuses it as "Unsupported file format", and `sign.ps1` logs the skip (`desktop/src-tauri/scripts/windows/sign.ps1:88-91`). The stub is written into the installer unsigned.

## What to do

Find whether tauri or NSIS can sign the stub after it is renamed to a PE extension, or sign it in a post-build step; otherwise record the limitation in `.agents/desktop.md`. Validate on a release dry run.

## What shipped

Staged on the integration branch and not on `main`: four commits, accepted on 2026-10-01 on the lead's reading of the script and the verify step alone, since nothing of it runs on the development machine, which has no Windows and no `pwsh`, and `actionlint` does not lint a `.ps1`. `sign.ps1` copies an input that is a PE under a name CodeSignTool refuses beside itself under a `.exe` name, signs the copy, reads the signature back and copies the signed bytes over the original, and a non-PE keeps its skip line (`desktop/src-tauri/scripts/windows/sign.ps1:75`); the stub reaches it through the bundler's uninstaller hook. Both release workflows' Windows verify steps install the just-built installer silently, check the installed `uninstall.exe`'s signature, uninstall silently with `_?=<install dir>` so that the step waits for the uninstall, where an uninstaller run with `/S` alone relaunches a copy of itself and exits at once, which one fix round corrected, then check both binaries gone and remove the leftover (`.github/workflows/release.yml:1193-1220`; `release-desktop.yml:410-436`); one sentence in `.agents/desktop.md` says so. `make workflow-check` was green at the tip.

The proof is the owner's rc0 dry run, as the ruling above has it: it decides whether CodeSignTool signs the renamed stub and whether makensis embeds the signed bytes; the bundler then is `tauri-cli@2`, unpinned in both workflows; each build takes one more eSigner signature. No changelog entry until the dry run shows the stub signed, and what the owner reads in that run for both outcomes is the acceptance.
