//! Linux AppImage GUI-stack preference, and the GPU probe the GTK desktops
//! (Linux and FreeBSD) share.
//!
//! WHY: the Linux AppImage bundles its own GUI stack (libgtk-3,
//! libwebkit2gtk-4.1) plus the GL/EGL/gbm libraries linuxdeploy-plugin-gtk
//! drags in, built on Ubuntu in release.yml. On a rolling distro whose Mesa
//! is newer than the bundle (e.g. CachyOS on an AMD radeonsi iGPU), the
//! bundled libgtk cannot create an EGL display against the host Mesa and the
//! webview aborts at creation time with `EGL_BAD_PARAMETER`. The host's GTK
//! and Mesa are always built against each other, so preferring the host GUI
//! stack (and keeping the bundle as fallback for anything the host lacks) is
//! the durable fix across distros.
//!
//! WHY a re-exec: by the time `main()` runs, libgtk/libEGL are already
//! resolved and loaded (they are DT_NEEDED of the binary, loaded at process
//! start in the bundle-first order AppRun set). Rewriting `LD_LIBRARY_PATH`
//! from inside `main()` cannot move them. A fresh process started via `execv`
//! after rewriting the loader path honors the new order, and the
//! `EGL_BAD_PARAMETER` failure happens later (at webview creation), so a
//! top-of-`main()` re-exec runs before the failing path. The GTK module env
//! AppRun exported (GTK_PATH, GDK_PIXBUF_MODULE_FILE, GIO_MODULE_DIR, ...) is
//! inherited across the exec for free, so the shim only has to rewrite the
//! library search path.

/// Prefer the host GUI stack on a Linux AppImage launch, re-exec'ing once.
/// No-op off Linux (macOS and Windows have no AppImage / bundle-first loader
/// order to correct -- the body compiles to nothing there), off an AppImage, or
/// once already applied. The `linux` module below is `#[cfg(target_os =
/// "linux")]`, so nothing in it is compiled for the Windows target.
pub fn prefer_system_gui_stack() {
    #[cfg(target_os = "linux")]
    linux::prefer_system_gui_stack();
}

/// Whether the desktop WebKit process has a decided renderer path.
///
/// The Linux AppImage bootstrap returns its dma-buf result. Other Linux
/// packages return `None` because that bootstrap does not run, which leaves
/// the SPA on its fail-safe DOM renderer. A FreeBSD build is never an
/// AppImage, so it answers as those packages do. macOS and Windows return
/// WebGL.
pub fn webgl_renderer_available() -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        linux::webgl_renderer_available()
    }
    #[cfg(target_os = "freebsd")]
    {
        None
    }
    #[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
    {
        Some(true)
    }
}

/// Whether this desktop can open a GPU render node for the welcome.
/// The answer is cached for the final process after any AppImage re-exec.
pub fn gpu_available() -> bool {
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    {
        dri::gpu_available()
    }
    #[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
    {
        // Supported macOS desktops have Metal; Windows answers true and relies
        // on the welcome's runtime probe; reading its adapter needs a DXGI
        // dependency the desktop does not carry.
        true
    }
}

/// The DRM render-node probe. Linux and FreeBSD (drm-kmod) both publish
/// `/dev/dri/renderD*` character devices.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
mod dri {
    use std::ffi::{CString, OsStr};
    use std::fs::{self, DirEntry};
    use std::os::raw::{c_char, c_int};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::FileTypeExt;
    use std::path::Path;
    use std::sync::OnceLock;

    unsafe extern "C" {
        fn access(path: *const c_char, mode: c_int) -> c_int;
    }

    const R_OK: c_int = 4;
    const W_OK: c_int = 2;
    static GPU_AVAILABLE: OnceLock<bool> = OnceLock::new();

    pub fn gpu_available() -> bool {
        *GPU_AVAILABLE.get_or_init(|| {
            gpu_available_in(Path::new("/dev/dri"), |entry| {
                let character = entry.file_type().is_ok_and(|kind| kind.is_char_device());
                let openable = CString::new(entry.path().as_os_str().as_bytes())
                    .ok()
                    .is_some_and(|path| unsafe { access(path.as_ptr(), R_OK | W_OK) == 0 });
                (character, openable)
            })
        })
    }

    fn render_node_available(name: &OsStr, character: bool, openable: bool) -> bool {
        let Some(suffix) = name.as_bytes().strip_prefix(b"renderD") else {
            return false;
        };
        !suffix.is_empty() && suffix.iter().all(u8::is_ascii_digit) && character && openable
    }

    fn gpu_available_in(directory: &Path, entry_info: impl Fn(&DirEntry) -> (bool, bool)) -> bool {
        let Ok(entries) = fs::read_dir(directory) else {
            return false;
        };
        entries.filter_map(Result::ok).any(|entry| {
            let (character, openable) = entry_info(&entry);
            render_node_available(&entry.file_name(), character, openable)
        })
    }

    #[cfg(test)]
    mod tests {
        use super::{gpu_available_in, render_node_available};
        use std::ffi::OsStr;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        #[test]
        fn only_an_openable_character_render_node_counts_as_a_gpu() {
            for (name, character, openable, expected) in [
                ("renderD128", true, true, true),
                ("renderD", true, true, false),
                ("renderDx", true, true, false),
                ("card0", true, true, false),
                ("renderD128", false, true, false),
                ("renderD128", true, false, false),
            ] {
                assert_eq!(
                    render_node_available(OsStr::new(name), character, openable),
                    expected,
                    "{name} character={character} openable={openable}"
                );
            }
        }

        #[test]
        fn gpu_scan_reads_the_injected_directory_on_every_linux_launch() {
            let directory = tempfile::tempdir().expect("tempdir");
            assert!(!gpu_available_in(directory.path(), |_| (true, true)));
            fs::write(directory.path().join("card0"), "").expect("card marker");
            assert!(!gpu_available_in(directory.path(), |_| (true, true)));
            fs::write(directory.path().join("renderD128"), "").expect("render marker");
            assert!(gpu_available_in(directory.path(), |_| (true, true)));
            assert!(!gpu_available_in(directory.path(), |_| (false, true)));
            assert!(!gpu_available_in(directory.path(), |_| (true, false)));
            assert!(!gpu_available_in(&directory.path().join("missing"), |_| (
                true, true
            )));
        }

        #[test]
        fn an_unreadable_render_directory_reports_no_gpu() {
            let directory = tempfile::tempdir().expect("tempdir");
            fs::write(directory.path().join("renderD128"), "").expect("render marker");
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o000))
                .expect("make directory unreadable");
            assert!(
                fs::read_dir(directory.path()).is_err(),
                "test needs an unprivileged user"
            );
            assert!(!gpu_available_in(directory.path(), |_| (true, true)));
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
                .expect("restore directory permissions");
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use crate::cs_install;
    use std::ffi::{OsStr, OsString};
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    /// Policy knob: `auto` (default), `system` (force; any reason we cannot
    /// prefer the host stack is fatal rather than a silent fallback), or
    /// `bundled` (keep today's bundle-first behavior).
    const POLICY_ENV: &str = "CHAN_LINUX_SYSTEM_GUI";

    /// Loop guard, set across the re-exec so the re-exec'd process does not
    /// re-exec again, and consumed there ([`reexec_done`]).
    const APPLIED_ENV: &str = "CHAN_LINUX_SYSTEM_GUI_APPLIED";

    /// dma-buf policy knob: `auto` (default, disable only for the NVIDIA
    /// proprietary driver), `on` (never disable), `off` (always disable).
    const DMABUF_ENV: &str = "CHAN_LINUX_DMABUF";

    const WEBKIT_DISABLE_DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    // The sonames chan-desktop links. BOTH must be present on the host before
    // we shadow the bundle: a partial shadow (host libgtk against a bundled
    // libwebkit, or the reverse) is worse than either stack on its own.
    const GTK_SONAME: &str = "libgtk-3.so.0";
    const WEBKIT_SONAME: &str = "libwebkit2gtk-4.1.so.0";

    pub fn prefer_system_gui_stack() {
        // Bundle-first loader order only exists inside an AppImage.
        if cs_install::appimage_path().is_none() {
            return;
        }

        // A desktop an older release started holds that release's mount
        // block after its own in PATH, a directory under /tmp that goes when
        // that process exits and that every child of this one would search.
        // Dropped here, single-threaded, where the marker is consumed too.
        let path = chan_server::without_foreign_apprun_blocks("PATH", std::env::vars_os(), None);
        if let Some(path) = path {
            std::env::set_var("PATH", path);
        }

        // Independent, cheap layer: keep WebKit off the dma-buf renderer path
        // that aborts with EGL_BAD_PARAMETER on the affected GPUs. WebKit reads
        // this lazily at webview init (no re-exec needed) and it is inherited
        // across the re-exec below when one happens. Never clobber a user value.
        set_webkit_env_defaults();

        match std::env::var(POLICY_ENV).unwrap_or_default().trim() {
            "bundled" => {}
            "system" => apply(true),
            _ => apply(false), // auto (default)
        }
    }

    /// Prefer the host stack, re-exec'ing once. `force` reflects
    /// `CHAN_LINUX_SYSTEM_GUI=system`.
    fn apply(force: bool) {
        if reexec_done() {
            return;
        }

        let Some(cache) = ldconfig_cache() else {
            return bail(force, "`ldconfig -p` is unavailable");
        };

        // Presence gate: both sonames must resolve in the host linker cache.
        // We prepend the dir reported for libwebkit2gtk (the heavier of the
        // two); on every supported distro libgtk lives in the same dir.
        let (Some(_gtk), Some(system_dir)) =
            (lib_dir(&cache, GTK_SONAME), lib_dir(&cache, WEBKIT_SONAME))
        else {
            return bail(
                force,
                "host is missing libgtk-3 and/or libwebkit2gtk-4.1 in the ldconfig cache",
            );
        };

        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => return bail(force, &format!("current_exe() failed: {e}")),
        };

        let ld_path = reexec_ld_path(system_dir, std::env::vars_os());

        let argv: Vec<OsString> = std::env::args_os().skip(1).collect();
        // execv replaces the image on success and returns only on failure.
        let err = reexec_command(&exe, &argv, &ld_path).exec();
        // Re-exec failed. Under `system` that is fatal; under `auto` fall
        // through to a normal bundle-first launch rather than aborting.
        if force {
            eprintln!("chan: {POLICY_ENV}=system re-exec failed: {err}");
            std::process::exit(1);
        }
        eprintln!("chan: system-GUI-stack re-exec failed ({err}); continuing on bundled stack");
    }

    /// The loader path the re-exec hands its new image: the host lib dir
    /// first, so the loader resolves libgtk / libwebkit2gtk / libEGL / libgbm
    /// to the host copies, then this process's `LD_LIBRARY_PATH` falling back
    /// to the bundle for anything the host lacks, without the block of any
    /// mount but this one's, which an older release that started this process
    /// handed down, its re-exec directory ahead of its block included
    /// ([`chan_server::without_foreign_apprun_blocks`]).
    fn reexec_ld_path(
        system_dir: OsString,
        vars: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> OsString {
        let vars: Vec<(OsString, OsString)> = vars.into_iter().collect();
        let existing = chan_server::without_foreign_apprun_blocks(
            "LD_LIBRARY_PATH",
            vars.iter().cloned(),
            Some(system_dir.as_os_str()),
        )
        .or_else(|| {
            vars.into_iter()
                .find(|(key, _)| key == "LD_LIBRARY_PATH")
                .map(|(_, value)| value)
        });
        let mut ld_path = system_dir;
        if let Some(existing) = existing.filter(|existing| !existing.is_empty()) {
            ld_path.push(":");
            ld_path.push(existing);
        }
        ld_path
    }

    /// Whether this process is the re-exec [`reexec_command`] started: the
    /// marker is set. Reading it also removes it, since it describes this
    /// process alone: a New Window sibling, a desktop a `chan-term` starts
    /// and a `chan-term -e` typed in one of this desktop's shells are
    /// AppImage launches of their own, which AppRun starts bundle-first
    /// again, so each must make its own re-exec, and an inherited marker
    /// would skip it. The environment changes while the process is still
    /// single-threaded: `main` gets here before the tracing setup and before
    /// any thread starts, where it also sets the WebKit default and then
    /// drops `$ARGV0`.
    fn reexec_done() -> bool {
        if std::env::var_os(APPLIED_ENV).is_none() {
            return false;
        }
        std::env::remove_var(APPLIED_ENV);
        true
    }

    /// The re-exec of this process with `ld_path` as its loader path,
    /// marked so the new image knows it has had its re-exec.
    fn reexec_command(exe: &Path, args: &[OsString], ld_path: &OsStr) -> Command {
        let mut command = Command::new(exe);
        command
            .args(args)
            .env("LD_LIBRARY_PATH", ld_path)
            .env(APPLIED_ENV, "1");
        command
    }

    fn bail(force: bool, why: &str) {
        if force {
            eprintln!("chan: {POLICY_ENV}=system but {why}");
            std::process::exit(1);
        }
        // auto: leave bundle-first behavior intact so minimal/older hosts
        // (and hosts without the host GUI stack) still launch.
    }

    /// Files the NVIDIA proprietary driver creates once its kernel module is
    /// loaded. Nouveau creates neither, and the open-source NVIDIA kernel
    /// modules create them while carrying the same userspace GL driver, which
    /// is the half the dma-buf fault lives in, so matching them is correct.
    const NVIDIA_DRIVER_MARKERS: [&str; 2] =
        ["proc/driver/nvidia/version", "sys/module/nvidia/version"];

    fn nvidia_proprietary_driver(root: &Path) -> bool {
        NVIDIA_DRIVER_MARKERS
            .iter()
            .any(|marker| root.join(marker).exists())
    }

    /// Turn the dma-buf renderer off only where it is known to break.
    ///
    /// dma-buf is how WebKit hands GPU buffers to the compositor, and turning
    /// it off drops the webview onto the legacy WPE/X11 path for everything,
    /// not just the failing case. Measured cost on an AMD host: the WebGL
    /// layer paints nothing at all, on two independent capture paths, so
    /// xterm.js's WebGL renderer is unavailable and the terminal grid is stuck
    /// on the DOM renderer that bands rules and blocks. WebGL context creation
    /// still succeeds, which is why nothing above the pixels notices.
    ///
    /// The fault it works around is the NVIDIA proprietary driver's ("Failed
    /// to create GBM buffer", Error 71). Upstream declined to detect that case
    /// itself (WebKit bug 262607, WONTFIX), so the check lives here, and
    /// Tauri's own Linux graphics guidance is explicit that an unconditional
    /// override "disables a faster path for everyone, including users on
    /// working setups".
    ///
    /// This layer covers a separate fault from the AMD-on-newer-Mesa
    /// EGL_BAD_PARAMETER abort handled by the host-stack re-exec above. A
    /// `WEBKIT_DISABLE_DMABUF_RENDERER` the user already set is never
    /// clobbered.
    ///
    /// `CHAN_LINUX_DMABUF` overrides the detection: `on` keeps the
    /// accelerated path whatever the driver (the knob for an NVIDIA user who
    /// wants to try WebGL), `off` disables dma-buf unconditionally, and anything
    /// else is `auto`.
    ///
    /// A knob is needed because WebKit reads its own variable by PRESENCE,
    /// not value: measured, `WEBKIT_DISABLE_DMABUF_RENDERER=0` disables
    /// dma-buf exactly as `=1` does, so "set it yourself" can only ever turn
    /// the accelerated path OFF. The only way to ask for it back is for chan
    /// not to set the variable at all, which is a decision only chan can make.
    ///
    /// WEBKIT_DISABLE_COMPOSITING_MODE is left alone on purpose; forcing it
    /// off degrades rendering on healthy hosts.
    fn set_webkit_env_defaults() {
        if std::env::var_os(WEBKIT_DISABLE_DMABUF_ENV).is_some() {
            return;
        }
        if dma_buf_disabled(&std::env::var(DMABUF_ENV).unwrap_or_default(), || {
            nvidia_proprietary_driver(Path::new("/"))
        }) {
            std::env::set_var(WEBKIT_DISABLE_DMABUF_ENV, "1");
        }
    }

    /// Expose the AppImage bootstrap's result without probing the driver again.
    /// A non-AppImage has no result because [`set_webkit_env_defaults`] never
    /// runs there, so it emits no renderer signal and the SPA stays on DOM.
    pub fn webgl_renderer_available() -> Option<bool> {
        renderer_signal(
            cs_install::appimage_path().is_some(),
            std::env::var_os(WEBKIT_DISABLE_DMABUF_ENV).is_some(),
        )
    }

    fn renderer_signal(decision_ran: bool, dma_buf_disabled: bool) -> Option<bool> {
        decision_ran.then_some(!dma_buf_disabled)
    }

    /// Whether to disable dma-buf, given the policy value and a driver probe
    /// the caller supplies. The probe is lazy so `on` and `off` never touch
    /// the filesystem.
    fn dma_buf_disabled(policy: &str, nvidia: impl FnOnce() -> bool) -> bool {
        match policy.trim() {
            "on" => false,
            "off" => true,
            _ => nvidia(),
        }
    }

    /// Where `ldconfig` is looked for, in order: by name through `PATH`, then
    /// the two places distributions install it, since a desktop session's
    /// `PATH` often leaves out the `sbin` directories and the re-exec would
    /// otherwise be skipped without a word.
    const LDCONFIG: [&str; 3] = ["ldconfig", "/sbin/ldconfig", "/usr/sbin/ldconfig"];

    fn ldconfig_cache() -> Option<String> {
        ldconfig_cache_with(|program| Command::new(program).arg("-p").output())
    }

    /// `ldconfig -p`'s listing through the first of [`LDCONFIG`] that
    /// resolves; `run` runs one of them. A candidate that does not resolve is
    /// skipped, and one that runs and fails ends the search.
    fn ldconfig_cache_with(
        mut run: impl FnMut(&str) -> std::io::Result<std::process::Output>,
    ) -> Option<String> {
        for program in LDCONFIG {
            match run(program) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return None,
                Ok(out) => {
                    return out
                        .status
                        .success()
                        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
                }
            }
        }
        None
    }

    // `ldconfig -p` entries look like:
    //   \tlibwebkit2gtk-4.1.so.0 (libc6,x86-64) => /usr/lib/libwebkit2gtk-4.1.so.0
    // Return the directory of the first entry whose soname (the first token)
    // matches, so the dir is right on Arch (/usr/lib), Fedora (/usr/lib64) and
    // Debian/Ubuntu multiarch (/usr/lib/x86_64-linux-gnu), x86_64 and arm64.
    fn lib_dir(cache: &str, soname: &str) -> Option<OsString> {
        for line in cache.lines() {
            let line = line.trim();
            if line.split_whitespace().next() != Some(soname) {
                continue;
            }
            let path = line.rsplit("=>").next()?.trim();
            if path.is_empty() {
                continue;
            }
            return Path::new(path).parent().map(|d| d.as_os_str().to_owned());
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::{
            dma_buf_disabled, ldconfig_cache_with, nvidia_proprietary_driver, reexec_command,
            reexec_done, reexec_ld_path, renderer_signal, APPLIED_ENV, NVIDIA_DRIVER_MARKERS,
        };
        use std::ffi::{OsStr, OsString};
        use std::fs;
        use std::path::Path;
        use std::process::{Command, ExitStatus, Output};

        fn root_with(marker: Option<&str>) -> tempfile::TempDir {
            let dir = tempfile::tempdir().expect("tempdir");
            if let Some(marker) = marker {
                let path = dir.path().join(marker);
                fs::create_dir_all(path.parent().expect("marker parent")).expect("mkdir");
                fs::write(&path, "driver\n").expect("write marker");
            }
            dir
        }

        #[test]
        fn a_host_without_the_nvidia_driver_keeps_dma_buf() {
            // The whole point of the gate: an AMD or Intel host keeps the
            // accelerated path, and with it a usable WebGL layer.
            let root = root_with(None);
            assert!(!nvidia_proprietary_driver(root.path()));
        }

        #[test]
        fn either_driver_marker_is_enough() {
            // The two markers are alternatives, not a pair: which one exists
            // depends on how the module was built and loaded.
            for marker in NVIDIA_DRIVER_MARKERS {
                let root = root_with(Some(marker));
                assert!(
                    nvidia_proprietary_driver(root.path()),
                    "{marker} should select the workaround"
                );
            }
        }

        #[test]
        fn the_policy_knob_overrides_the_driver_in_both_directions() {
            // `on` is the hatch this exists for: WebKit reads its own
            // variable by presence, so a user cannot ask for the accelerated
            // path by setting it, only by chan declining to.
            assert!(!dma_buf_disabled("on", || true));
            assert!(dma_buf_disabled("off", || false));
            assert!(dma_buf_disabled(" off ", || false));
        }

        #[test]
        fn the_driver_decision_selects_the_matching_terminal_renderer() {
            let nvidia = root_with(Some(NVIDIA_DRIVER_MARKERS[0]));
            let nvidia_auto = dma_buf_disabled("auto", || nvidia_proprietary_driver(nvidia.path()));
            assert_eq!(renderer_signal(true, nvidia_auto), Some(false));

            let nvidia_forced_on =
                dma_buf_disabled("on", || nvidia_proprietary_driver(nvidia.path()));
            assert_eq!(renderer_signal(true, nvidia_forced_on), Some(true));

            let non_nvidia = root_with(None);
            let non_nvidia_auto =
                dma_buf_disabled("auto", || nvidia_proprietary_driver(non_nvidia.path()));
            assert_eq!(renderer_signal(true, non_nvidia_auto), Some(true));
        }

        #[test]
        fn a_non_appimage_has_no_renderer_signal() {
            assert_eq!(renderer_signal(false, false), None);
            assert_eq!(renderer_signal(false, true), None);
        }

        #[test]
        fn an_absent_or_unknown_policy_defers_to_the_driver() {
            for policy in ["", "auto", "yes", "1"] {
                assert!(dma_buf_disabled(policy, || true), "{policy:?} on nvidia");
                assert!(!dma_buf_disabled(policy, || false), "{policy:?} elsewhere");
            }
        }

        /// The re-exec'd process reads the marker and removes it, so no child
        /// it starts inherits it and each AppImage child makes its own
        /// re-exec; a process without the marker has had none. It mutates
        /// the environment, so it runs in a test process of its own.
        #[test]
        fn the_reexec_marker_is_consumed_where_it_is_read() {
            if !crate::embedded::in_own_chan_home(
                "linux_gui_stack::linux::tests::the_reexec_marker_is_consumed_where_it_is_read",
            ) {
                return;
            }
            std::env::remove_var(APPLIED_ENV);
            assert!(!reexec_done(), "without the marker there was no re-exec");
            std::env::set_var(APPLIED_ENV, "1");
            assert!(reexec_done(), "the re-exec'd process finds the marker");
            assert_eq!(std::env::var_os(APPLIED_ENV), None, "and drops it");
            assert!(!reexec_done(), "it is read once");
            let child = Command::new("/bin/sh")
                .args(["-c", "printf %s \"${CHAN_LINUX_SYSTEM_GUI_APPLIED-unset}\""])
                .output()
                .expect("run a child shell");
            assert_eq!(child.stdout, b"unset", "a child inherits no marker");
        }

        /// The re-exec's loader path puts the host directory first, then this
        /// process's value without an older parent's chained block; a value
        /// with nothing foreign follows as it is, and none gives the host
        /// directory alone.
        #[test]
        fn the_reexec_loader_path_drops_an_older_parents_block() {
            let mount = "/tmp/.mount_ChanNEW";
            let block = |dir: &str| {
                [
                    "usr/lib/",
                    "usr/lib/i386-linux-gnu/",
                    "usr/lib/x86_64-linux-gnu/",
                    "usr/lib32/",
                    "usr/lib64/",
                    "lib/",
                    "lib/i386-linux-gnu/",
                    "lib/x86_64-linux-gnu/",
                    "lib32/",
                    "lib64/",
                ]
                .map(|entry| format!("{dir}/{entry}"))
                .join(":")
            };
            let host = "/usr/lib/x86_64-linux-gnu";
            let vars = |ld: String| -> Vec<(OsString, OsString)> {
                vec![
                    ("APPDIR".into(), mount.into()),
                    ("LD_LIBRARY_PATH".into(), ld.into()),
                ]
            };
            let handed = format!(
                "{}:{host}:{}:/opt/a/lib",
                block(mount),
                block("/tmp/.mount_ChanOLD")
            );
            assert_eq!(
                reexec_ld_path(host.into(), vars(handed)),
                OsString::from(format!("{host}:{}:/opt/a/lib", block(mount)))
            );
            let own = format!("{}:/opt/a/lib", block(mount));
            assert_eq!(
                reexec_ld_path(host.into(), vars(own.clone())),
                OsString::from(format!("{host}:{own}"))
            );
            assert_eq!(
                reexec_ld_path(host.into(), Vec::new()),
                OsString::from(host)
            );
        }

        /// `prefer_system_gui_stack` drops an older parent's block from this
        /// process's own `PATH` before anything else it does, while
        /// single-threaded. A source pin: the value is
        /// `without_foreign_apprun_blocks`', tested in chan-library.
        #[test]
        fn the_boot_drops_an_older_parents_block_from_path() {
            const SELF: &str = include_str!("linux_gui_stack.rs");
            let boot = SELF
                .split_once("    pub fn prefer_system_gui_stack() {")
                .expect("the boot")
                .1;
            let boot = boot
                .split_once("\n    fn apply(force: bool) {")
                .expect("apply follows the boot")
                .0;
            let cleaned = boot
                .find("chan_server::without_foreign_apprun_blocks(\"PATH\", std::env::vars_os(), None)")
                .expect("the boot cleans PATH");
            let set = boot
                .find("std::env::set_var(\"PATH\", path);")
                .expect("and sets it");
            let webkit = boot
                .find("set_webkit_env_defaults();")
                .expect("the WebKit default");
            assert!(cleaned < set && set < webkit);
        }

        /// A process without the marker re-execs itself with its own
        /// arguments, the host-first loader path, and the marker set.
        #[test]
        fn the_reexec_carries_the_marker_and_the_loader_path() {
            let args = [OsString::from("--dir=/w x"), OsString::from("notes.md")];
            let ld_path = OsStr::new("/usr/lib:/tmp/.mount_chan/usr/lib");
            let command = reexec_command(Path::new("/opt/chan/chan-desktop"), &args, ld_path);
            assert_eq!(command.get_program(), "/opt/chan/chan-desktop");
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                ["--dir=/w x", "notes.md"]
            );
            let env = |key: &str| {
                command
                    .get_envs()
                    .find(|(name, _)| *name == key)
                    .and_then(|(_, value)| value.map(OsStr::to_os_string))
            };
            assert_eq!(env(APPLIED_ENV), Some(OsString::from("1")));
            assert_eq!(env("LD_LIBRARY_PATH"), Some(ld_path.to_os_string()));
        }

        fn ran(code: i32, stdout: &str) -> std::io::Result<Output> {
            use std::os::unix::process::ExitStatusExt;
            Ok(Output {
                status: ExitStatus::from_raw(code << 8),
                stdout: stdout.as_bytes().to_vec(),
                stderr: Vec::new(),
            })
        }

        fn missing() -> std::io::Result<Output> {
            Err(std::io::ErrorKind::NotFound.into())
        }

        /// `ldconfig` is run by name first, then from `/sbin` and `/usr/sbin`
        /// when the name does not resolve, so a `PATH` without the `sbin`
        /// directories still reaches the listing; the lookup is driven here
        /// by a fake runner, whatever the host's `PATH` holds.
        #[test]
        fn ldconfig_is_found_by_name_then_in_sbin_then_in_usr_sbin() {
            for (found, tried) in [
                ("ldconfig", &["ldconfig"][..]),
                ("/sbin/ldconfig", &["ldconfig", "/sbin/ldconfig"]),
                (
                    "/usr/sbin/ldconfig",
                    &["ldconfig", "/sbin/ldconfig", "/usr/sbin/ldconfig"],
                ),
            ] {
                let mut asked = Vec::new();
                let listing = ldconfig_cache_with(|program| {
                    asked.push(program.to_string());
                    if program == found {
                        ran(0, "listing")
                    } else {
                        missing()
                    }
                });
                assert_eq!(listing.as_deref(), Some("listing"), "{found}");
                assert_eq!(asked, tried, "{found}");
            }
            assert_eq!(ldconfig_cache_with(|_| missing()), None, "none resolves");
        }

        /// An `ldconfig` that resolves and fails, or cannot be run, ends the
        /// search: only one that does not resolve is passed over.
        #[test]
        fn an_ldconfig_that_runs_and_fails_ends_the_search() {
            for answer in [
                ran(1, "partial"),
                Err(std::io::ErrorKind::PermissionDenied.into()),
            ] {
                let mut answer = Some(answer);
                let mut asked = 0;
                let listing = ldconfig_cache_with(|_| {
                    asked += 1;
                    answer.take().unwrap_or_else(|| ran(0, "listing"))
                });
                assert_eq!(listing, None);
                assert_eq!(asked, 1);
            }
        }

        #[test]
        fn a_nouveau_style_tree_is_not_matched() {
            // Nouveau creates neither marker, and it is not the driver the
            // dma-buf workaround exists for.
            let root = root_with(Some("sys/module/nouveau/version"));
            assert!(!nvidia_proprietary_driver(root.path()));
        }
    }
}
