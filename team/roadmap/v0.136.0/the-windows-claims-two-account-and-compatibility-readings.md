# The Windows claim's two-account and compatibility readings

Status: moved to v0.133.0 by the owner on 2026-11-19 ("move them and cut"); its VM kit sealed at r4 and not run: its pre-read (job J39p) found both VM test accounts holding earlier installs, which the readings would delete, and the job waited for the owner's word on those two folders, which he gave on 2026-11-27 (the last section). Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version"). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27, not built in v0.135.0.

Record before the move: carried from v0.131.0 on 2026-11-16 under the owner's release-first ruling ("if things get more complicated we move to next version"); not started.

Record: [the Windows claim row](../done/the-windows-claim-is-a-name-another-account-can-hold.md) merged in v0.131.0 on its native tests (acceptance 1) and documents (acceptance 4). Its acceptances 2 and 3, the installed-build readings, did not run: the test kit's matrix and uninstall reading stopped on two defects of the kit itself (job J234, `dev/v0131-team/evidence/Ops131/J234/`).

## What is there now

The kit (sealed as `native89`, with a corrected copy `input-r10c` on the Windows test VM) drives a second local account (`ch.an`) and the installed package through interactive scheduled tasks. Found when it ran: the installer was passed `"/S"` through the kit's quoting helper, which NSIS does not read as its silent switch (fixed in `input-r10c` by a bare-`/S` launcher); then the kit's artifact records the desktop executable's hash before Tauri's bundler writes the bundle type into it (`__TAURI_BUNDLE_TYPE_VAR_UNK` becomes `..._NSS`, three bytes), so every install fails its hash check. The VM's client default execution policy (Restricted) also blocks the kit's interactive tasks, which run without `-ExecutionPolicy Bypass`.

## Desired contract

The claim row's acceptances 2 and 3, read on the Windows test VM with the installed build of the release under test: a second local account holds each shape of the claim's name and this account's launches still behave as one desktop; a v0.130.0 desktop beside a launch of this build, and the reverse, each end in one desktop; the uninstall removes the profile's claim files and leaves a junction's target untouched.

## Acceptance

1. The kit records the installed executable's hash from the package it installs, passes the silent switch bare, and runs its interactive tasks under an explicit execution policy; each fix shown by a control.
2. The matrix and the uninstall reading run to their verdicts, with their raw records kept.

## Decided, 2026-11-27: the two installs may go

The question open since the pre-read of 2026-11-18, put to the owner on 2026-11-27: may the readings delete `C:\Users\chan\AppData\Local\chan\` and `C:\Users\ch.an\AppData\Local\chan\` whole, install, uninstall and re-register Chan for those accounts, and delete what is needed on the VM's disk for space. He answered: "5. of course, you can do anything with that windows vm - it's for our development and testing". Nothing on the Windows test VM waits for his word any more. By the preparation's reading the newest kit pins paths that no longer exist and builds its two packages on the VM, so a respelled kit, reviewed, comes before the reading.
