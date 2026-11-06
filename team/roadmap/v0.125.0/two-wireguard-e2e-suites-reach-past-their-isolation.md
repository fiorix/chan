# Two WireGuard e2e suites reach past their isolation

Status: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); the Linux desktop and Windows kernel suites read green at the isolation tip in the release's guests.

## What is there now

1. **`scripts/e2e/wireguard-windows.sh` sends the client's private key inside its encoded PowerShell command.** `write_client_file` writes each client file on the Windows client by embedding the whole file, `PrivateKey` line included, base64 encoded in a PowerShell script, and `client_ps` passes that script to `powershell -EncodedCommand` on the ssh command line. The key is then on the Windows process's argv and in any script block PowerShell's logging records, and the suite also keeps an owner-only copy of each client file in its host work directory. `scripts/e2e/desktop-wireguard-windows.sh` already does it the other way: the file's text travels on the ssh channel's stdin (`client_ps_data`), the key is never on a command line on either end or in a logged block, and the host keeps only redacted copies.
2. **`scripts/e2e/desktop-wireguard.sh` inherits the caller's display and session bus.** It unsets the `CHAN_*` variables, `WAYLAND_DISPLAY` and `WAYLAND_SOCKET`, sets `GDK_BACKEND=x11` and refuses the caller's own runtime directory, but leaves `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` as the caller had them, and starts the desktop under `xvfb-run` without a session bus of its own. chan-desktop has no D-Bus code of its own; this is hardening against what its toolkit reaches.
3. **The same suite's runtime-directory guard runs after it has made the directory.** The script creates its work directory, then `mkdir -p` and `chmod 700` the `XDG_RUNTIME_DIR` it hands the desktop, and only then checks that directory is not the caller's own, so a guard that fires has already created or changed the mode of the directory it protects. A refused run also leaves its work directory behind, since it exits before the cleanup trap is set.

## Desired contract

1. `wireguard-windows.sh` writes the client files the way `desktop-wireguard-windows.sh` does: the text on stdin, no key on any command line or in any PowerShell script block, only redacted copies on the host.
2. `desktop-wireguard.sh` unsets `DISPLAY` beside the Wayland variables before it starts Xvfb, and runs the desktop under `dbus-run-session`, so neither the caller's X display nor its session bus reaches the desktop or its children.
3. `desktop-wireguard.sh` checks the runtime directory it is about to use (resolved with `realpath -m`, since it does not exist yet) before it creates or changes anything, and sets its cleanup trap before the first thing it makes.

## Acceptance

1. A whole `wireguard-windows.sh` run green, after which the client's PowerShell operational log holds no block with a `PrivateKey` line and the host work directory holds no private key.
2. A `desktop-wireguard.sh` run green from a shell with `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` set, with the desktop's `/proc/<pid>/environ` carrying the Xvfb display and a bus address of its own.
3. A refused `desktop-wireguard.sh` run, constructed so its runtime directory resolves to the caller's own, exits 2 having created, changed and left behind nothing.

## Built

Four commits: `48749b605` (Windows client files travel on SSH stdin and leave only redacted host copies), `b5950c317` (the desktop uses an Xvfb display and a private D-Bus session), `921dd5368` (the runtime path is checked before directory changes and refusal removes the work directory), and `docs(e2e): describe WireGuard DNS and unresolved startup` (the suite reference names the DNS arm, all kernel options and the unresolved startup verdict).

Verification: the constructed client-file, environment, runtime-guard and README checks fail at the base and pass at the tip. The Windows suite passes all six arms at the tip; its host work directory holds only redacted client files, and no PowerShell 4104 block carries the encoded client file while the probe's `platform=` and `Get-FileHash` blocks remain visible. The Linux desktop suite passes its connected and unresolved-endpoint runs; chan-desktop and its WebKit processes use the Xvfb display and a private D-Bus session, with neither caller Wayland variable. The constructed refusal exits 2, removes its work directory, leaves the caller's runtime directory unchanged and starts no process.
