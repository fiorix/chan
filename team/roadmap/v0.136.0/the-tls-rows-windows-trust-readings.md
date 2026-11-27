# The TLS rows' Windows trust readings

Status: moved to v0.133.0 by the owner on 2026-11-19 ("move them and cut"); its VM kit for the self-update row sealed at r9 and not run; the model download's Windows trust reading waited for the owner's word on its model cache on the VM, which he gave on 2026-11-27 (the last section). Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version"). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27, not built in v0.135.0. Both rows' Windows lines were read on the Windows test VM on 2026-11-27 (the last section): read.

Record before the move: carried from v0.131.0 on 2026-11-16 under the owner's release-first ruling ("if things get more complicated we move to next version"); not started.

Record: [the self-update's trust row](../done/the-clis-self-update-trusts-only-reqwests-bundled-roots.md) merged in v0.131.0 on its tests and its Linux guest reading; [the model download's trust row](../done/the-model-download-trusts-only-bundled-roots.md) moved to v0.132.0 unmerged, with its Linux guest reading accepted. Their Windows test VM readings were one job (J187b): four release builds sharing one target (about 37000 s outer) and nine trust arms (about 29200 s outer), which did not fit the VM session left before the release. The kit is staged on the VM (`C:\v0131-tlswin-r5`, kit `tls-windows-r5`, manifest `aab84ef4`) and on the bus (`dev/v0131-team/evidence/Web131/`, the J187b request and its seals).

## Desired contract

Each row's Windows acceptance line, read on the Windows test VM from the Windows CLI zip of the release under test, with a throwaway CA in the machine's Root store and a TLS-inspecting proxy whose leaves that CA signs: the self-update and the model download trust the CA through the platform's verifier and are refused once it is removed; the store restored after.

## Acceptance

1. Both rows' Windows lines read, with the base trusting only the bundled roots, the tip trusting the system CA, and the tip refused without it, for each client.
2. The macOS lines stay postponed unless the owner asks for them.

## Decided, 2026-11-27: the model folder may be written

The question open since the kit's first review, put to the owner on 2026-11-27: may the job write inside the `chan` account's installed Chan folder on the VM (create its `models` folder, fill and delete the model's folder there, and hold then delete one lock file). He answered "6. yes", and of the VM as a whole the same day: "you can do anything with that windows vm - it's for our development and testing". By the preparation's reading the kit needs a new revision that takes the release's zips in place of builds on the VM, reviewed before the reading, and this reading runs before the Windows claim's, whose uninstall would remove the folder it uses.

## Read on the Windows VM, 2026-11-27

Read on the Windows 11 test VM with the round's kit (r10), the released Windows zips installed for each arm, a throwaway CA added to and removed from the machine's Root store, and a proxy that presents a certificate signed by it. Each arm's refusal or pass is the product's own line, with the proxy's TLS alert beside it.

- Self-update: v0.130.0 with the CA in the store refuses with `invalid peer certificate: UnknownIssuer` and an unknown-CA alert (it trusts only the bundled roots); v0.135.0 with the CA in the store passes; v0.135.0 without the CA refuses with `UnknownIssuer` through the platform verifier on Windows.
- Model download, by the CLI and by Settings: v0.131.0 with the CA in the store refuses with `UnknownIssuer` on both paths; v0.135.0 with the CA in the store downloads `BAAI/bge-small-en-v1.5` at its pinned commit, each file at its pinned hash, on both paths; v0.135.0 without the CA refuses with `UnknownIssuer` (Settings shows "certificate verification failed").
- The model cache was left as found: no repository, no lock, and an empty models folder after the reading; the installed packages were not changed.

So acceptance 1 holds for both rows on Windows: the base trusts only its bundled roots, the tip trusts the system store, and the tip refuses without the CA. The macOS lines stay postponed (acceptance 2).

