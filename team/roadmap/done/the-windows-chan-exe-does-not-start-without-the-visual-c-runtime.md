# The Windows chan.exe does not start without the Visual C++ runtime

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: found on 2026-11-04 in the round's clean Windows 11 guest, while the command launcher focus fix was read in WebView2: `chan.exe` from the published v0.123.0 installer and from a dry-run installer of the integration branch exited `0xC0000135` (STATUS_DLL_NOT_FOUND) before `main`. A shipped bug, not this release's. The owner ordered the fix into v0.124.0 on 2026-11-05 (work order `dev/windows-cli-static-vcruntime.md`); one of the owner's Codex agents built it on `fix/windows-cli-static-vcruntime` off `038d82f42`, merged into `v0124/int` as `d2dd2c556`, and the lead re-pinned the Nix `cargoHash` for its lock edge (`a949adbe1`).

## What was there

`chan.exe`, shipped standalone as `chan-x86_64-pc-windows-msvc.zip` and carried by the NSIS installer behind the `chan` and `cs` shims in `%LOCALAPPDATA%\chan\bin`, imported `VCRUNTIME140.dll` beside the in-box Universal C runtime forwarders (`api-ms-win-crt-*`): `llvm-objdump -p` on the v0.123.0 zip's `chan.exe` lists it. Windows does not ship that library; the Visual C++ Redistributable does, so on a Windows without it the CLI and both shims fail before they start. `chan-desktop.exe` was unaffected, because `tauri-build` links the VC runtime statically through `static_vcruntime`. GitHub's Windows runners have the redistributable installed, so no CI smoke saw it. Nothing in the repository chose a VC runtime link mode, and the release jobs' `RUSTFLAGS: -D warnings` would override a target `rustflags` entry in `.cargo/config.toml`.

## Desired contract

1. Every `chan.exe` chan ships for Windows MSVC runs on a Windows 10 or 11 with no Visual C++ Redistributable installed.
2. The release fails when a shipped `chan.exe` imports a `VCRUNTIME*` or `MSVCP*` library.
3. The Universal C runtime stays dynamic, since it is part of Windows 10 and later; `chan-desktop.exe`'s linking and the Linux, macOS and FreeBSD builds are unchanged.

## Boundaries

`crates/chan/build.rs` calls `static_vcruntime::metabuild()` from a build dependency of `crates/chan`, an edge to the crate `tauri-build` already locked: the helper reads `CARGO_CFG_TARGET_ENV`, so a non-MSVC target gets no linker arguments, and `rustc-link-arg` reaches only the package's own binaries, not dependents such as chan-desktop. This was chosen over `-C target-feature=+crt-static` in the Windows jobs' `RUSTFLAGS`, which would also link the Universal C runtime statically, change every crate's fingerprint in those jobs, and miss a developer's or `cargo install`'s build. `scripts/check-windows-crt.sh` reads a built `chan.exe`'s import table with rustup's `llvm-objdump` and refuses `VCRUNTIME*` and `MSVCP*`, run right after signing in `release.yml` and `release-desktop.yml`; `scripts/test-windows-crt.sh`, in `make shell-check`, exercises its accepted imports and its refusals. The Nix `cargoHash` and the recorded lock digest moved with the lock edge; `npmDeps.hash` did not.

## Acceptance

1. The detector refuses the published v0.123.0 `chan.exe` and accepts a fixed one; `make shell-check` and `make workflow-check` green.
2. A dry run's Windows job prints only `kernel32` and `api-ms-win-crt-*` imports for `chan.exe` and passes the check.
3. On a clean Windows 11 with no redistributable, the installed `chan.exe` answers `--version` and `--help` and the `chan` and `cs` shims run, while the v0.123.0 `chan.exe` exits `0xC0000135` in the same boot as the red control.
4. `make nix-hash-check` green, and `ci.yml`'s Nix job green against the re-pinned `cargoHash`.

## Built

`edebd4d10`, fix(windows): link the CLI VC runtime statically, and `a949adbe1`, ci(nix): re-pin the cargoHash for the static VC runtime edge, harvested on the Linux host as the ordinary user from a snapshot of the tracked tree.

Verification: the commit records the detector red on the v0.123.0 CLI and its accepted and refused cases in shell-check. Desktop Package Dry Run 41943248647 at `a949adbe1` was green, and its Windows job's check printed `kernel32` and `api-ms-win-crt-*` imports only and "no VCRUNTIME or MSVCP DLL imports"; CI 41943251977 at the same commit was green in every job, the Nix job included. In the clean Windows 11 guest, checked before and after to hold no redistributable, the installer from that dry run (build `git-a949adbe19ad`) ran `chan.exe --version`, `chan.exe --help` and the `chan` and `cs` shims with exit 0, and the v0.123.0 zip's `chan.exe` exited `0xC0000135` in the same boot; the executables extracted from the installer on the host import no `VCRUNTIME` or `MSVCP` library.

Open: Windows 10 was not read. The standalone zip comes from `release.yml`, whose check first runs in the GA commit's dry run; the guest ran the installer's copy. Which earlier releases shipped the dependency was not read.
