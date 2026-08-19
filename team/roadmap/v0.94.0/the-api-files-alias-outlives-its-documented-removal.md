# The /api/files alias outlives its documented removal

Status: REGISTERED for v0.94.0. Implemented in-round on the integration branch.

## Problem

v0.93.0 unified file content and transfers under `/api/fs` and kept `/api/files` as a compatibility alias, with the removal deadline documented in four places: `design.md` ("is removed in v0.94.0"), `.agents/gateway.md` (the transfer-policy aliases, same wording), and two route-block comments in `crates/chan-server/src/lib.rs`. The public CHANGELOG states the same contract. None of the v0.94.0 feature branches implements the removal, so shipping v0.94.0 with the alias intact would falsify all four statements and the published deprecation.

## Direction

Remove the alias in the same release the contract names, with no replacement and no second deprecation cycle. The alias arms come out of both chan-server tenant route tables, the desktop native-transfer endpoint classifier, and the gateway transfer-policy classifier; the alias-exercising tests either move to `/api/fs` or flip into refusal pins asserting the alias no longer routes or classifies. The two design-doc sentences change to state the present: `/api/fs` is the only content and transfer namespace. Consumers were already migrated in v0.93.0 (243 references across 73 files); this item deletes only the server-side acceptance.

## Acceptance

- No route, classifier, or policy arm anywhere in the tree matches `/api/files`; a whole-tree grep finds it only in history (CHANGELOG, `team/`) and in refusal tests.
- A refusal pin asserts `/api/files` requests are not served by the tenant routers (404 like any unknown path) and receive no special gateway transfer policy.
- `design.md` and `.agents/gateway.md` describe `/api/fs` as the only namespace, present tense, with no removal narrative.
- The full gate is green on the integration branch with the removal in place.
