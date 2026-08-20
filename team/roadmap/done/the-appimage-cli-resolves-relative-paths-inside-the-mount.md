# The AppImage CLI resolves relative paths inside the mount

Status: fixed on main, verified against the released 0.94.0 AppImage's own `AppRun.wrapped`; release assignment (v0.94.1 or v0.95.0) is the owner's pending call, so no release report records it yet.

## Problem

Every `chan` / `cs` invocation through the Linux AppImage starts in the wrong directory. The bundler's inner `AppRun` (tauri-bundler downloads AppImageKit's legacy `AppRun.c` binary, release tag `apprun-old`; linuxdeploy's GTK plugin wraps it as `AppRun.wrapped`) chdirs into the mounted `<AppDir>/usr` before exec'ing `usr/bin/chan-desktop`, and exports no `OWD`, so the caller's working directory is unrecoverable inside the process. `chan serve .` therefore opens and registers a workspace at `/tmp/.mount_*/usr` (a phantom that dies with the mount and litters the registry), and `cs upload .` absolutizes to `/tmp/.mount_*/usr/.`, escapes the workspace root, and dies at the desktop's native-transfer validator with "native upload target must be a workspace-relative path". `$(pwd)` forms work because the user's shell expands them before the AppImage runs. macOS and deb/rpm installs never run this `AppRun`, so only the AppImage is affected.

The trace also exposed a second, platform-independent defect on the same wire: `chan-shell`'s `absolutize` is a lexical join, so `cs upload .` carries a literal trailing `.` component, and the standalone transfer leg (`upload_path_standalone` / `download_path_standalone`) forwarded it verbatim into the same validator refusal. Any standalone-terminal window on any platform hit this, AppImage or not.

## Direction

Fix at the two layers that own the facts. The AppImage wrapper shims (`cs_install::wrapper_script`) export `$CHAN_CALLER_PWD`, and `cs_install::restore_caller_cwd` chdirs back at desktop boot, before any argv0 dispatch, consuming the variable so desktop-spawned terminals never inherit a stale value; the restore is gated on `$APPIMAGE` and refuses relative records. Existing shims rewrite themselves on the next desktop launch (content-stale wrappers are re-written). The standalone transfer legs canonicalize the requested path (verbatim-prefix stripped) before signalling the window, so no `.` / `..` component ever reaches the native validator; the workspace leg already canonicalized. A hand-run AppImage without a shim still starts in the mount; the contributing doc says so and names the workaround.

## Acceptance

- Against the real 0.94.0 `AppRun.wrapped`: a new-template shim `chan serve .` registers the caller's directory; the old-template shim reproduces the mount-rooted workspace (the failure stays visible to the instrument); an absolute-path serve is unchanged.
- `standalone_transfers_normalize_a_lexical_dot_component` pins that a `<dir>/.` upload and download signal the window with the canonical path, and `caller_cwd_restores_only_absolute_records_inside_an_appimage` pins the restore gate.
- The full gate is green.
