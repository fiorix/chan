# The build container runs the gate as root, so a fault that needs a user who is not root shows in no gate

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by the lead from main CI's run 36321021487 on `4139f8656`, whose `make ci-linux` failed where the integration gate had passed on the same sha; reproduced on the host as a user who is not root, with a stand-in for cargo (`dev/v0101-team/evidence/int/ci-36321021487/README.md` and `dev/v0101-team/journals/journal-Lead.md`, its entry of 13:56Z, in the development tree). The documented recipe read at `b1ef073ae`.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to accept it for this version, with no shape of the fix named.

## What was seen

The documented way to run the CI gate locally is inside an sdme container, and everything in it runs as root: the recipe puts the tree under `/root/chan`, sets `HOME=/root`, installs the toolchain there and runs `make ci-linux` through `sdme exec` (`docs/contributing/linux-and-macos.md:44-74`). The round's lane gates and integration gates ran in such a container the same way (the lead's journal, 13:56Z). CI's `linux` job runs `make ci-linux` on `ubuntu-latest` (`.github/workflows/ci.yml:33-35`, `:79`), where the user is not root.

For root a file's or a directory's mode stops nothing, so a test or a gate step that works only because permissions do not apply passes every gate and fails first on the runner. That is what happened on `4139f8656`: two tests left directories at mode 0555 with files in them, the symlinked step's cleanup could not remove them on the runner, and `make ci-linux` went red there while the integration gate on the same sha was green. That case is fixed: the step restores the owner's permissions before it removes its directory, and the tests put their modes back ([the-linux-gate-runs-tests-under-a-canonical-tmpdir](the-linux-gate-runs-tests-under-a-canonical-tmpdir.md)), which the lane and the lead proved on the host as a user who is not root with a stand-in for cargo. The blind spot stays: no gate runs any step as a user who is not root, so the next fault of this kind also shows first on a runner.

## Desired contract

A gate step that touches files, and a test whose outcome depends on permissions, are proved as a user who is not root before they land, in the gate or by a stated rule the gate skill carries.

## What to do

Decide the shape. The container recipe could create a user who is not root and run the gate, or at least the Rust suites and the steps that make and remove files, as that user, with a home and a target of its own; a gate step could run the suites under a user who is not root inside the root container; or the gate skill could state the rule the fix followed, a step that touches files is proved on the host as a user who is not root with a stand-in for cargo, and leave the container as it is. The first two cost a second warm target or a change of ownership of the one there is; the third keeps the gate as fast as it is and relies on a checklist. Red first: at `4139f8656` the gate as it runs today is green where the runner was red, and a gate of the new shape goes red there on the symlinked step's cleanup, as the runner did.

## Boundaries

`docs/contributing/linux-and-macos.md` (the container recipe), `.agents/skills/gate/SKILL.md`, and the `Makefile`'s gate targets if a step is added. CI's jobs are unchanged: they already run as a user who is not root.

## Acceptance

1. The gate as documented runs the Rust suites and the steps that make and remove files as a user who is not root, or the gate skill states the rule and how to follow it.
2. Under either of the first two shapes, the gate goes red at `4139f8656` on the symlinked step's cleanup, as the runner did.
