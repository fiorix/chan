# The TLS rows' Windows trust readings

Status: moved to v0.133.0 by the owner on 2026-11-19 ("move them and cut"); its VM kit for the self-update row sealed at r9 and not run; the model download's Windows trust reading waited for the owner's word on its model cache on the VM, which he gave on 2026-11-27 (the last section). Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version"). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27, not built in v0.135.0.

Record before the move: carried from v0.131.0 on 2026-11-16 under the owner's release-first ruling ("if things get more complicated we move to next version"); not started.

Record: [the self-update's trust row](../done/the-clis-self-update-trusts-only-reqwests-bundled-roots.md) merged in v0.131.0 on its tests and its Linux guest reading; [the model download's trust row](../done/the-model-download-trusts-only-bundled-roots.md) moved to v0.132.0 unmerged, with its Linux guest reading accepted. Their Windows test VM readings were one job (J187b): four release builds sharing one target (about 37000 s outer) and nine trust arms (about 29200 s outer), which did not fit the VM session left before the release. The kit is staged on the VM (`C:\v0131-tlswin-r5`, kit `tls-windows-r5`, manifest `aab84ef4`) and on the bus (`dev/v0131-team/evidence/Web131/`, the J187b request and its seals).

## Desired contract

Each row's Windows acceptance line, read on the Windows test VM from the Windows CLI zip of the release under test, with a throwaway CA in the machine's Root store and a TLS-inspecting proxy whose leaves that CA signs: the self-update and the model download trust the CA through the platform's verifier and are refused once it is removed; the store restored after.

## Acceptance

1. Both rows' Windows lines read, with the base trusting only the bundled roots, the tip trusting the system CA, and the tip refused without it, for each client.
2. The macOS lines stay postponed unless the owner asks for them.

## Decided, 2026-11-27: the model folder may be written

The question open since the kit's first review, put to the owner on 2026-11-27: may the job write inside the `chan` account's installed Chan folder on the VM (create its `models` folder, fill and delete the model's folder there, and hold then delete one lock file). He answered "6. yes", and of the VM as a whole the same day: "you can do anything with that windows vm - it's for our development and testing". By the preparation's reading the kit needs a new revision that takes the release's zips in place of builds on the VM, reviewed before the reading, and this reading runs before the Windows claim's, whose uninstall would remove the folder it uses.
