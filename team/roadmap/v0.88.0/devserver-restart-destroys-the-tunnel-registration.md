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
- Not yet done: exercised against a live supervised tunnel unit on a real host rather than in test. Worth doing before the GA close, because the failure this closes is a data-loss path and the recovery is manual.

## Rig built 2026-08-10, and what building it already proved

The open acceptance line needs a supervised tunnel unit that is **not** the one hosting the round. There is no such unit available on this host, and that is structural rather than incidental: `DEVSERVER_SYSTEMD_UNIT` is the hardcoded constant `"chan-devserver.service"` (`crates/chan/src/lib.rs:4058`) with no override, so a user session has exactly one supervised chan devserver, and on the development host that one is the round's own — a systemd `--user` unit whose `ExecStart` carries `--tunnel-url` and whose `Environment=` lines hold both `CHAN_TUNNEL_TOKEN` and `CHAN_TUNNEL_URL`. Manufacturing a second unit beside a name it would collide with is not an option, so the exercise runs in a container provisioned by `packaging/sdme/chan-devserver-provision.sh`, which gives a real systemd user unit under real linger with a real gateway dial.

Standing that rig up was itself the first end-to-end exercise of the two files this item touches, and it is better evidence for them than a test would have been:

- The `chan-devserver` rootfs had never been built. `sudo sdme fs build chan-devserver chan-devserver.sdme` builds clean, and the `COPY` lands `chan-devserver-provision` at `/usr/local/bin` mode `0755` as the template intends.
- The container boots to `systemctl is-system-running` = `running`, so the `dbus-user-session` dependency the template installs for `systemctl --user` is doing its job.
- Five refusal paths were exercised and every one fails closed **before any network activity**: no token non-interactively, a malformed token, a `chan_pat_` prefix with the wrong body length, an invalid Unix user name, and `--user root`. Each dies with its own named message and exit 1.

What that does **not** establish is the open acceptance line. None of it dials a gateway, and the restart-from-a-token-free-shell case — the branch that destroys the registration — is untouched by it. That line stays open.

One constraint the rig has to respect, recorded because it is easy to miss: the provisioner installs the **released** `chan` from `chan.app/install.sh`, and this fix is not in a release. A rig left to provision itself would exercise the pre-fix binary and prove the opposite of what it was set up to prove. The rig must run a build carrying `fee66884`, copied in — which is a property of the exercise, not a change the provisioner needs.

## Rough size

Done. Recorded for the release report and for the invariant it establishes: a command that can rewrite the only copy of a credential must resolve that credential before it decides it cannot.
