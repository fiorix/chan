# Two WireGuard e2e suites reach past their isolation

Status: raised at the v0.124.0 close, part 1 from the Windows desktop suite's review and parts 2 and 3 from the third review of the endpoint resolution change; not started.

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
