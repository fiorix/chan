# `chan devserver --restart` destroys the tunnel registration it cannot read

Status: REGISTERED 2026-08-10, after the fact. The work was done unplanned, off the roadmap, and is registered here so v0.88.0 carries it as accepted scope rather than as an unattributed line in the release report. IMPLEMENTED in `fee66884`.

## What

A supervised devserver's systemd unit is the only store for its tunnel PAT. Nothing else on the box holds a copy, so the unit is both the runtime configuration and the backup. `chan devserver --restart` could not read it, and rewrote it anyway.

The endpoint requirement fired at the top of the command, ahead of the code that recovers the endpoint from the installed unit. Two branches followed, both wrong:

- **A shell holding `CHAN_TUNNEL_TOKEN` was refused outright.** That is every terminal the devserver spawns, since they inherit the token from the unit, so the failure was reachable from the most ordinary place to run the command. The refusal covered `--status` as much as `--restart`, which made an inspection command fail for the same reason a mutation did.
- **A shell without the token resolved no tunnel at all**, rewrote the unit as a plain local devserver, and destroyed the only copy of the PAT in the same write. There is no second copy to restore from; re-registering the tunnel is the only way back.

The second branch is the one that matters. A restart is a routine operation a user reaches for when something is already wrong, and it silently converted a tunnelled service into a local one while appearing to succeed.

## Contract

- The endpoint resolves where it is used, not as a precondition at the top of the command, so a path that can recover it from the installed unit gets the chance to.
- A backend that persists no unit still refuses a token with no endpoint. The foreground and `--service=chan` backends have nothing to read back, so the original requirement is correct there and stays.
- The supervised path reads `--tunnel-url` or `CHAN_TUNNEL_URL` back out of the installed unit, and resolves the PAT the same way, with an explicit token still winning so a rotated one installs.
- A token with no endpoint from either source fails loudly rather than silently converting the service to a local devserver.
- Dropping the tunnel is deliberate: `--no-tunnel` is the way back to a local devserver, and it lets a shell that inherited a token start a local one.
- A tunnel unit carries its endpoint as `CHAN_TUNNEL_URL` alongside the PAT, so the terminals the devserver spawns resolve the same gateway the service dials.

## Acceptance

- `--restart` and `--status` run from a devserver-spawned terminal, which is the shell that inherits the token. Met.
- A restart from a shell with no token preserves the tunnel registration rather than rewriting the unit as local. Met.
- A token with no resolvable endpoint produces a named failure, not a silent downgrade. Met.
- A provisioned unit still matches the renderer byte for byte: the unit classifier accepts `CHAN_TUNNEL_URL` and the sdme provisioner (`packaging/sdme/chan-devserver-provision.sh`) writes the same line. Met.
- Exercised against a live supervised tunnel unit rather than in test: **local half done 2026-08-10, remote half done the same day against a real gateway, with one clause unverified.** See [Exercised live, 2026-08-10](#exercised-live-2026-08-10) and [The remote half, 2026-08-10](#the-remote-half-2026-08-10). A real registration survives a restart from a token-free shell, proven against a live gateway. The trailing clause "and the published host serves again" is **not** verified, for a structural reason recorded there rather than for lack of trying.

## Rig built 2026-08-10, and what building it already proved

The open acceptance line needs a supervised tunnel unit that is **not** the one hosting the round. There is no such unit available on this host, and that is structural rather than incidental: `DEVSERVER_SYSTEMD_UNIT` is the hardcoded constant `"chan-devserver.service"` (`crates/chan/src/lib.rs`, `const DEVSERVER_SYSTEMD_UNIT`) with no override, so a user session has exactly one supervised chan devserver, and on the development host that one is the round's own: a systemd `--user` unit whose `ExecStart` carries `--tunnel-url` and whose `Environment=` lines hold both `CHAN_TUNNEL_TOKEN` and `CHAN_TUNNEL_URL`. Manufacturing a second unit beside a name it would collide with is not an option, so the exercise runs in a container provisioned by `packaging/sdme/chan-devserver-provision.sh`, which gives a real systemd user unit under real linger with a real gateway dial.

> **"with a real gateway dial" did not survive the exercise, and the correction matters.** This sentence was written expecting a real endpoint and PAT. Neither arrived, and [Exercised live](#exercised-live-2026-08-10) instead points the unit at a **dead loopback port**, deliberately: the failure under test is a unit-file rewrite, so no gateway is involved in it. The rig is real in every other respect: real systemd `--user`, real linger, real unit, real restart. Left standing and corrected rather than edited away, because "a real gateway dial" is exactly the kind of clause a reader would carry forward as established when the item goes on to establish the opposite.

Standing that rig up was itself the first end-to-end exercise of the two files this item touches, and it is better evidence for them than a test would have been:

- The `chan-devserver` rootfs had never been built. `sudo sdme fs build chan-devserver chan-devserver.sdme` builds clean, and the `COPY` lands `chan-devserver-provision` at `/usr/local/bin` mode `0755` as the template intends.
- The container boots to `systemctl is-system-running` = `running`, so the `dbus-user-session` dependency the template installs for `systemctl --user` is doing its job.
- Five refusal paths were exercised and every one fails closed **before any network activity**: no token non-interactively, a malformed token, a `chan_pat_` prefix with the wrong body length, an invalid Unix user name, and `--user root`. Each dies with its own named message and exit 1.

What that does **not** establish is the open acceptance line. None of it dials a gateway, and the restart-from-a-token-free-shell case, the branch that destroys the registration, is untouched by it. That line stays open.

> **"That line stays open" expired later the same day.** It describes what standing the rig up proved on its own, which is still accurate, but the line it refers to was subsequently closed: [Exercised live](#exercised-live-2026-08-10) ran the token-free restart locally, and [The remote half](#the-remote-half-2026-08-10) ran it against a real gateway. Left standing with this pointer rather than rewritten, since what the rig-build alone proved is a separate claim from what the round finished with.

One constraint the rig has to respect, recorded because it is easy to miss: the provisioner installs the **released** `chan` from `chan.app/install.sh`, and this fix is not in a release. A rig left to provision itself would exercise the pre-fix binary and prove the opposite of what it was set up to prove. The rig must run a build carrying `fee66884`, copied in, which is a property of the exercise, not a change the provisioner needs.

## Exercised live, 2026-08-10

Against a **real** supervised unit: systemd `--user`, lingering, written by `packaging/sdme/chan-devserver-provision.sh`, running a build that carries this fix. In an sdme container, not on the development host, because `DEVSERVER_SYSTEMD_UNIT` is the hardcoded constant `"chan-devserver.service"` (`crates/chan/src/lib.rs`, `const DEVSERVER_SYSTEMD_UNIT`): a user session has exactly one supervised chan devserver, and on the development host that one holds every developer's terminal.

**Why a dead endpoint is the right rig, not a compromise.** What this defect destroys is a line in `~/.config/systemd/user/chan-devserver.service`. Whether a tunnel ever connected has no bearing on whether that line survives the rewrite, so the branch that loses the data is entirely local and testing it against a dead loopback endpoint tests the thing that actually breaks. Values were never read: the assertion compares the presence of `Environment=` variable **names** and a `sha256` of the whole unit.

### The A/B, one variable

Same unit, same token-free shell, only the binary differs. The token-free shell is the branch that mattered, because it is the one that rewrote the unit as a plain local devserver.

- **pre-fix binary** (v0.87.0, lacks this commit): unit before `env=[CHAN_TUNNEL_TOKEN]`, unit after **`env=[]`**, ExecStart after `devserver --bind=127.0.0.1 --port=8787`.
- **with this fix**: unit before `env=[CHAN_TUNNEL_TOKEN]`, unit after `env=[CHAN_TUNNEL_TOKEN CHAN_TUNNEL_URL]`, ExecStart after `devserver --tunnel-url=...`.

The pre-fix row is the data loss, reproduced live: the only copy of the PAT is gone, the service is now a local devserver, and the command **reported success**: `wrote ...`, `restarted ...`, no error and no warning. That is the silent conversion the item describes, observed rather than argued.

The fixed row not only preserves the token, it rewrites the pre-fix unit into the **canonical current shape**, and the resulting file hashes identically to what the provisioner writes from scratch. That is the byte-for-byte renderer/provisioner agreement, demonstrated from the opposite direction to the test that already covers it.

### The other arms

- `--status` from a **token-inheriting** shell: the case that was refused outright, making an inspection command fail for a mutation's reason. Runs, reports the unit and its command line, unit hash unchanged.
- `--restart` from a **token-inheriting** shell: unit hash unchanged, both variables intact.
- `--restart` from a **token-free** shell against a provisioner-written unit: unit hash unchanged, both variables intact.
- `--no-tunnel` from a token-inheriting shell: the deliberate way back to a local devserver still works, and is the only path here that drops the tunnel.
- A token with **no endpoint resolvable from either source**: `Error: chan devserver: tunnel mode requires --tunnel-url or CHAN_TUNNEL_URL`. A named failure, and the unit is not converted.

### The classifier change is load-bearing, found by a probe that failed to fire

The first attempt at the red arm did **not** reproduce the destruction. The pre-fix binary refused: *"refusing to overwrite foreign or administrator-edited systemd unit"*.

The reason is that the unit had been written by the **current** provisioner, which carries `CHAN_TUNNEL_URL`, a line added by this same commit. The pre-fix classifier has never seen that line, so it reads the unit as administrator-edited and declines to touch it. The red arm only fires against a unit in the **pre-fix shape**, token only, endpoint solely in the `ExecStart` flag.

That is worth recording for two reasons. It is independent evidence that the classifier half of this fix is doing work rather than being cosmetic. And a probe that fails to fire is not automatically a passing system: had it been accepted as one, this would have been written up as "the pre-fix binary is harmless here", which is the opposite of true.

### Not proven, stated flatly

**The remote half is untested.** Nothing here shows that a real registration survives a restart, that the tunnel re-registers with a live gateway, or that the published host serves again afterwards. That needs a real endpoint and a real PAT, and it remains open. The local result does not soften it.

### One observation for operators

Both the pre-fix silent downgrade and the deliberate `--no-tunnel` downgrade land the service on the default `127.0.0.1:8787`. A box where several chan instances share a network namespace can therefore acquire a second listener on the most collision-prone port as a side effect of a restart, which is a nuisance rather than a defect, and is worth knowing before it is diagnosed as a port problem.

## Rough size

Done. Recorded for the release report and for the invariant it establishes: a command that can rewrite the only copy of a credential must resolve that credential before it decides it cannot.

## The remote half, 2026-08-10

Run against a **real gateway** with a PAT issued for this exercise, on the rig container. The credential was delivered out of band, read into a process environment by way of stdin so it never reached a command line or a file, and deleted once the tunnel stood without it. It survives only where it is supposed to: inside the unit, mode 600.

### What was proven

The tunnel registered, and the round's own defect branch was then run against it:

- `chan devserver --restart` from a **token-free shell**, the branch that used to rewrite the unit as a plain local devserver.
- Unit sha256 **identical** before and after, `ef762ab5...`, with `CHAN_TUNNEL_TOKEN` and `CHAN_TUNNEL_URL` both intact.
- The tunnel **re-registered after the restart**: two `tunnel connected` lines in the unit journal, the second following the restart.

So a real registration survives a restart. That is the clause the item was waiting on, and it is now measured rather than reasoned.

### What was not proven, and why it is not a matter of effort

The acceptance line ends "and the published host serves again". **That clause is unverified.** The rig cannot learn its own published hostname: the gateway returns the tenant host as `{owner}--{disc}.{proxy}.usr.{domain}`, and `chan-tunnel-proto`'s `HelloAckOk` documents that the devserver client **ignores** that value, each tenant self-prefixing at its keyed pathspec instead. The `disc` component is never surfaced to the client, so there is no hostname to fetch from inside the rig, and guessing one is not evidence.

Verifying it needs the hostname supplied from outside the devserver, which is a gateway-side fact. Recorded as unverified rather than folded into the proven half.

### The registration name deviates, deliberately

The rig registered under workspace **`devserver-v088rig`**, not `devserver`.

`DEVSERVER_TUNNEL_NAME` is a bare `const` in `crates/chan-server/src/devserver.rs` with no flag, env or config override, so every supervised devserver registers under the same workspace name. The rig therefore dialled **the same gateway and the same registry as a live production tunnel**, and the only thing separating the two registrations was that name, changed in a rig-only build that was never committed.

That separation is a property of the registry rather than a hope: the key is `(user, workspace)` as a nested map, eviction is same-key only, and on cap overflow the newcomer is rejected rather than an incumbent evicted. A future reader repeating this needs to know that it was the key structure that protected the incumbent, not the use of a separate gateway, because there was no separate gateway.

Two things this turned up that are not in this item's scope and register forward:

- **chan's built-in default gateway does not resolve.** `usr.chan.app` returns `No address associated with hostname`. Anyone relying on the default on a fresh install gets a dial failure, which is how this exercise first failed.
- **Nothing pins reject-not-evict.** No test asserts that registering a new workspace at the per-user cap fails the newcomer rather than evicting an incumbent. The property that protects a live registration from a new one is unpinned.
