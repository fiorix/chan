# No CI job runs the gateway packaging and roles suites

Status: raised on 2026-11-07 from the v0.125.0 release's gateway role-policy work; accepted by the owner for v0.126.0 at the v0.125.0 cut; moved to v0.127.0 by the owner on 2026-11-08; built on `ci/gateway-packaging-and-roles-suites` (`1ac2c320d`) and merged into the integration branch as `0a92d114e`. Acceptance 2 met on the build host; acceptance 1 is shown locally only and its workflow run is parked with the owner; acceptance 3 is met: the first Gateway CI run at a pushed integration tip (run 42580034365 at `72c1d57c6`, 2026-11-09) is green, with the manifest, packaging isolation and database roles steps in its gateway packaging job, beside `make workflow-check` green at that tip. A reading of the merged code before the GA ([its item](a-second-reading-of-the-releases-merged-code-finds-small-defects.md)) found that the roles suite passed with a grant removed, so acceptance 1's third red could not have been shown for most grants; the suite is exact since `51bcffda5` (merged as `a80424db8`), shown red locally for a narrowed, a dropped and an added grant, and green in Gateway CI run 42837473815 at `a80424db8` on PostgreSQL 16. The workflow-run reds of acceptance 1 stay parked with the owner.

## What is there now

`.github/workflows/gateway-ci.yml` runs two jobs: the gateway gate (the version pin check as its static packaging step, the SPA build and type check, fmt, clippy, doc and the workspace tests) and the container builds. Three checks that guard the packaging contract run on a developer's machine alone: `packaging/kube/test-manifests.py` (the Kubernetes manifests against the packaged scripts), `make gateway-packaging-isolation-test` (the real postinsts in every install order of the account-plane packages, the WireGuard agent's at every position, and the sdme provisioner refusals; Linux-only, about half a minute) and `packaging/gateway/scripts/test-database-roles.sh` (the prepare and reconcile scripts against an isolated database, read back as the packaged roles). Because nothing ran them in CI, the ConfigMap's embedded copy of the reconcile script drifted from the packaged one after migration 17 and stayed so until the role-lock row synchronized it by hand. The roles suite needs a PostgreSQL server, a database named `chan_gateway_role_test`, `DATABASE_URL`, `MIGRATIONS_DIR` and the explicit `CHAN_GATEWAY_DATABASE_TEST_ALLOW_DESTRUCTIVE=yes`; locally it runs in the sdme PostgreSQL guest of `packaging/gateway/scripts/dev/sdme/chan-psql.sdme`, and the owner wants no PostgreSQL installed on the machine that runs the tests.

## Desired contract

1. `gateway-ci.yml` runs the manifest test and the packaging isolation test on every run, as steps that fail the job.
2. `gateway-ci.yml` runs the roles suite against PostgreSQL as a GitHub Actions service container, with the test database created in the job and the destructive flag set there; the step fails the job on any FAIL line.
3. The local route for the roles suite is the sdme PostgreSQL guest and nothing else: a make target provisions the guest, runs the suite inside it and tears it down, and the gateway README says PostgreSQL is not installed on the host for this.
4. A drift of the ConfigMap's embedded script from the packaged one reds CI.

## Boundaries

- The workflow, the make targets and the gateway README's testing section; no change to the suites' assertions, the manifests or the reconcile script except what the CI run finds.
- The roles suite's own refusals (the expected database name, the destructive flag) stay; CI satisfies them, it does not remove them.

## Acceptance

1. A workflow run on a branch with the ConfigMap's embedded script deliberately desynchronized reds on the manifest test; the same branch with a postinst order broken reds on the isolation test; the same branch with a role grant removed from the reconcile script reds on the roles suite; each red read in the run's log, each green at the tip.
2. The roles suite green locally through the sdme route, with no PostgreSQL server package on the host (the host's package list read beside the run).
3. `make workflow-check` green at the tip; the gateway CI run at the tip green with the three new steps in its log.
