# The Windows cross-check omits resource and build-user limits

Status: accepted for v0.104.0 by the owner on 2026-10-08, answering "Repair the driver" to the lead's Windows cross-check driver survey. This is tooling work before candidate freeze; no compiling attempt is recorded as passed or run by this acceptance.

## What was seen

The required `make windows-cross-check` selects the existing team pool and imported Ubuntu rootfs through `SDME` and `WINDOWS_CROSS_ROOTFS`, but `scripts/windows-cross-check.sh` supplies no CPU or memory limit, runs rustup and cargo as root without an explicit job cap, has no in-guest time bound, and puts cargo output on a host bind outside the guest's disk quota. The boot timeout does not bound the compilation. The driver also suppresses cleanup failures. A pool that supports `--disk` alone cannot satisfy the round's execution contract. Hygiene104 read the driver at `a8ed1687d0fd77e20dc1b08d31f6d0f0e03f8f1b`; its blob is `ee6637eb376805da01758239a94b3616c9314850`.

## Desired contract

The target performs the existing Windows GNU CLI and selected test compilations in a disposable guest with explicit CPU, memory and disk limits. Package installation remains root-only setup; rustup and cargo run as a non-root build user with an explicit home, tool paths and job/thread caps. One timeout inside the guest bounds setup and compilation. Source and build output used by the compiler remain private to the guest and under its disk cap; the host receives only the intended status and evidence. The complete command's true status is preserved: a cargo failure, timeout, transport failure, missing or malformed status, or failed cleanup cannot produce success.

## Boundaries

The repair belongs to `scripts/windows-cross-check.sh`, with a small failure-path test if needed to exercise its command and status contract. Keep the existing Makefile target and the existing Windows compilation selections and warning policy. Reuse `packaging/sdme-build-policy.sh` and the tracked-source snapshot helper. No product behavior change, new pool or imported rootfs, payload-rewriting wrapper, host compilation, or broad cleanup. Remove only the exact guest and snapshot owned by an invocation, and preserve diagnostics when removal fails. Lead104 owns this item's roadmap and landing record; Hygiene104 owns the driver repair; Review104 independently reviews it.

## Acceptance

1. Constructed-input checks exercise the sdme invocation, resource limits, root-only setup and non-root build split, in-guest bound, and guest-private build output, including the real driver's failure paths before a compiling attempt.
2. Cargo failure, guest timeout, transport failure, absent or malformed status, and cleanup failure remain non-green with retained diagnostics. The cleanup scope cannot select another guest, the shared pool or an imported rootfs.
3. The source snapshot used for the candidate attempt is tied to one clean committed integration SHA. Any generated compiler source stays inside the capped guest; no build writes into the host checkout or snapshot bind.
4. Shell and workflow lints pass at the committed repair in the owning guest, followed by independent review. The complete candidate gate runs after this repair lands.
5. Run the unchanged `make windows-cross-check` once at the frozen candidate on the existing team pool with a fresh explicit reservation. Record the exact command, full log, source identity, actual exit status and resource evidence. A refused or failed compiling attempt stays distinct from a pass; native Windows execution remains unobserved here.

## Implementation choices, 2026-10-08T18:06:22Z

CPU, memory, job and time limits are the driver's own defaults with environment overrides: `WINDOWS_CROSS_CPUS=2`, `WINDOWS_CROSS_MEMORY=6G`, `WINDOWS_CROSS_JOBS=2` and `WINDOWS_CROSS_TIMEOUT=7200` seconds. The build's explicit cargo, test-thread and Rayon caps use the job value. `SDME_BUILD_DISK` remains the existing disk setting; `packaging/sdme-build-policy.sh` is unchanged. Invalid limit values refuse before a build. The actual candidate command records all limit overrides and matches its reservation.

`WINDOWS_CROSS_TARGET_DIR` remains the host directory for status and evidence, and holds no build output. Source, generated schemas and cargo output stay in the capped guest; each invocation is a cold build, with the disk cap and in-guest bound sized for that cost. The driver creates or verifies its non-root build user, home and required writable paths before any compilation; an unusable rootfs refuses with a reason.

The failure-path test is committed beside the driver and run by its exact command in the owning guest and at independent review. It is not added to pre-push in this version. Shell-check includes scripts/check-sdme-storage.py; the new test must pass that existing contract, with no change to its allowlist by default. The implementation pathspec also includes only the prerequisite sentences for this target in `.agents/skills/gate/SKILL.md` and `.agents/skills/release/SKILL.md`: sdme, an imported Ubuntu rootfs, and a pool that applies the CPU, memory and disk limits. These documentation changes land with the driver.

The Arch, COPR, Nix and desktop build drivers are outside this item. Review104's search found no explicit CPU/memory flags in sibling drivers, but their execution contracts and any wider repair were not investigated here. No sibling driver or shared resource policy is changed by this authorization.
