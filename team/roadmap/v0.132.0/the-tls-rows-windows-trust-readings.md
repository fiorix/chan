# The TLS rows' Windows trust readings

Status: carried from v0.131.0 on 2026-11-16 under the owner's release-first ruling ("if things get more complicated we move to next version"); not started.

Record: [the self-update's trust row](../done/the-clis-self-update-trusts-only-reqwests-bundled-roots.md) merged in v0.131.0 on its tests and its Linux guest reading; [the model download's trust row](the-model-download-trusts-only-bundled-roots.md) moved to v0.132.0 unmerged, with its Linux guest reading accepted. Their Windows test VM readings were one job (J187b): four release builds sharing one target (about 37000 s outer) and nine trust arms (about 29200 s outer), which did not fit the VM session left before the release. The kit is staged on the VM (`C:\v0131-tlswin-r5`, kit `tls-windows-r5`, manifest `aab84ef4`) and on the bus (`dev/v0131-team/evidence/Web131/`, the J187b request and its seals).

## Desired contract

Each row's Windows acceptance line, read on the Windows test VM from the Windows CLI zip of the release under test, with a throwaway CA in the machine's Root store and a TLS-inspecting proxy whose leaves that CA signs: the self-update and the model download trust the CA through the platform's verifier and are refused once it is removed; the store restored after.

## Acceptance

1. Both rows' Windows lines read, with the base trusting only the bundled roots, the tip trusting the system CA, and the tip refused without it, for each client.
2. The macOS lines stay postponed unless the owner asks for them.
