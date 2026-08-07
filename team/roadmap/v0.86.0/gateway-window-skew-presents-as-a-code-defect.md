# A gateway window's SPA and its native ACL come from two independently versioned builds

Status: REGISTERED for v0.86.0, grounded 2026-08-06 by a live incident during the v0.85.0 delivery round.

## What

On a gateway-served window the SPA is served by the remote devserver over the tunnel, while the Tauri ACL that gates its invokes comes from the locally installed chan-desktop. Those are two separately built artifacts with no lockstep available, and either side can be newer.

A local window cannot skew. chan-desktop embeds `web/dist` via rust-embed at build time, so the bundle it serves and the ACL that gates it are the same artifact by construction. The exposure exists only where the page is remote and the native shell is local, which is exactly the gateway surface.

When a remote SPA invokes a command the installed app's ACL does not carry, Tauri rejects it before any handler runs. A release build answers `Command <name> not allowed by ACL` (`tauri/src/webview/mod.rs`, the non-`debug_assertions` arm). That message names the command, so it reads as a capability-wiring defect in the code under test rather than as a stale binary.

The desktop side cannot see it either. The refusal happens inside the authority before any application code executes, so nothing on the desktop logs which command was refused or for which origin.

## Why the operator cannot see it

This is the part that turns an inconvenience into a lost cycle: nothing observable distinguishes the two builds.

- **The version string is identical.** During a delivery round the branch still carries the previous release's version pins, because those bump at release cut. At `6e4537e4` both `Cargo.toml` and `desktop/src-tauri/tauri.conf.json` read `0.84.1`, the same string the last release reports. A bundle installed from that release and a bundle freshly built from the branch are indistinguishable by version. This is not specific to one round; it holds for every pre-release branch build.
- **The launch path prefers the old bundle.** Opening the app from the Dock or `/Applications` runs the previously installed bundle, not the one just built. A correct and complete build step therefore does not imply the new binary is the one being exercised.

So an operator following a correct procedure can build both ends, launch, and test the previous binary, with no signal anywhere that they have done so.

## Verified current state (2026-08-06)

An acceptance failure was reported against a gateway-served window: creating a library window from the command deck raised `Command create_library_window not allowed by ACL`. It was investigated as a capability defect, and the capability wiring was found correct at every layer: the permission set membership, the minted capability's shape and resolution, the origin canonicalization and matching including a tenant path, and the window-label matching at the real `{library_id}::{window_id}` shape.

The permission ancestry explains why it presented as a wiring defect rather than as an old app. Against the v0.84.1 base:

- `allow-gateway-csrf-token` is present in the base.
- The base's `workspace-window` set is the current set minus exactly `allow-create-library-window` and `allow-focus-library-window`.
- Every other permission in the minted gateway vocabulary is present in the base.

An older bundle therefore refuses exactly one action and serves every other native affordance in that window normally. A total capability failure would have been obvious; a one-command failure looks like a bug in that one command.

The owner then reran with every trap closed: both ends fetched to `6e4537e4` and rebuilt, all running instances quit, the fresh bundle launched explicitly, keychain entry deleted and re-established. Library window creation from the gateway-served window worked. The finding was version skew, and the round's capability wiring was correct throughout.

Cost: one acceptance cycle and roughly an hour of investigation, spent on a correct implementation.

## Re-verified 2026-08-07

Neither half exists yet. The only runtime version surface is the About window, which renders `app.package_info().version` (`main.rs:6629`, `about.js:20-23`), exactly the insufficient signal described above; there is no git hash or build id anywhere in `desktop/src-tauri/`, no `cargo:rustc-env` emission in `build.rs`, and no vocabulary or capability query in the invoke-handler list (`main.rs:5566-5627`). Post-release the two version pins both read `0.85.0`, confirming the indistinguishability premise for the next pre-release branch.

Implementation facts: the SPA-side refusal interpretation that shipped in v0.85.0 lives in `web/packages/workspace-app/src/api/libraryWindows.ts:47-61` (`isAclRefusal`) and is private to that module, so advertisement-aware suppression of other commands means lifting it out. The runtime ACL minting is `desktop/src-tauri/src/runtime_capability.rs`, whose module doc forbids scoped permissions and deny entries in a minted grant. Any advertisement command needs its own entry in `desktop/src-tauri/capabilities/` and a place in the minted gateway vocabulary, which is the bootstrap constraint the contract already names.

## Contract

- A chan-desktop build is identifiable at runtime as the specific build it is, not only as the release it descends from. An operator can tell which binary is running before drawing a conclusion from its behaviour.
- A desktop advertises the command vocabulary it grants to a remotely-served page, so the page can determine what is available rather than discovering it through a thrown refusal. The SPA-side interpretation of a refusal ships in v0.85.0; the desktop-side advertisement is the open half.

  **The two are complements, not stages, and the ordering does not run the way it first reads.** An advertisement is itself a command and needs its own ACL entry, so an app old enough to lack `create_library_window` is also old enough to lack the query that would have reported it missing. Asking would be refused exactly as the original call was, leaving the page where it started. Extending an already-granted command's response instead of adding a new one softens that, since an absent field is at least distinguishable from a refusal, but it still cannot enumerate what an older app grants. So for every build predating the advertisement, interpreting the refusal is not a stopgap awaiting an upgrade, it is the only mechanism there will ever be. Advertisement earns its place by letting the page suppress affordances for builds at or after the version that introduces it, which is a different and narrower claim than making the degradation meaningful.
- A native refusal that reaches a user distinguishes "this app does not have that command" from "this app refused that command here". The first is a version statement and the second is an authority statement, and they call for different actions.

## Acceptance

- Two builds of chan-desktop from different commits are distinguishable at runtime without consulting the filesystem, and the identifier appears somewhere a person testing an acceptance item will see it.
- A gateway-served page can query what the host grants, and a command absent from the host's vocabulary produces a message that says so, rather than one naming the command as refused.
- The acceptance procedure for any gateway-surface item states that both ends must be built from the same commit and that the launch must be of the freshly built bundle, because neither is implied by the version string.
- Reproduce the failure deliberately once, by running a bundle predating a command against a devserver serving the SPA that calls it, and confirm the message identifies a version difference as the likely cause. A diagnosis that cannot be shown working on the case that produced it is not accepted.

  State which of the two mechanisms that reproduction exercises, because it cannot be both. A bundle predating the command also predates the advertisement, so what it exercises is the refusal-interpreting path that shipped in v0.85.0, never the query. Testing the advertisement needs a bundle that has the query and lacks some later command, which is a second reproduction and not the same one.

  The message under test asserts the version cause conditionally rather than flatly, and that hedge is deliberate: a release build collapses every rejection shape into one string, so at the moment of reporting the page cannot separate "this app never had the command" from "this app grants it but not for this window". An acceptance that demands the message state the version cause as fact is demanding something the build cannot support.

## Rough size

Medium. The runtime build identity is small. The vocabulary advertisement is the real work: it needs a decision about what the host exposes and how a remotely-served page asks for it, and that surface has to stay honest about the difference between an ungranted origin and an unknown command.
