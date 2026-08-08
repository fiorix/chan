# A devserver build is not identifiable at runtime

Status: REGISTERED 2026-08-08; the server-side sibling of the shipped desktop build identity, grounded by the same trap firing again during the v086-integration live test.

## What

Two `chan` binaries from different commits report the same version string between release bumps, and nothing a client can observe names the build that served a response. The 2026-08-08 extension incident spent its first diagnostic cycle unable to tell whether the devserver behind a tunnel was the operator's freshly built integration binary or a day-old process from before the fix under test; the answer had to be inferred from a response-header signature. The v0.85.0 round lost an acceptance cycle to the identical ambiguity on chan-desktop, and this round shipped `CHAN_DESKTOP_BUILD_ID` for it; the devserver has no equivalent.

The restart path makes this worse than a curiosity: a supervised devserver restart relaunches whatever binary the service entry names, not what the operator just built, so "I rebuilt and restarted" plus an unchanged version string is exactly the invisible-skew condition.

## Contract

- A chan build is identifiable at runtime as the specific build it is: `chan --version` and the health surface carry a build id alongside the release version.
- An operator diagnosing through a tunnel can read the serving build's id without shell access to the host.

## Acceptance

- Two builds from different commits are distinguishable via `chan --version` and via the health surface through a gateway-served tenant.
- The id survives the release build path (static musl, Nix) rather than only cargo dev builds.

## Rough size

Small; the desktop lane's `build.rs` shape is the template, plus one field on the health surface.
