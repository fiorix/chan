//! Linux AppImage GUI-stack preference.
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

#[cfg(target_os = "linux")]
mod linux {
    use crate::cs_install;
    use std::ffi::OsString;
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    /// Policy knob: `auto` (default), `system` (force; any reason we cannot
    /// prefer the host stack is fatal rather than a silent fallback), or
    /// `bundled` (keep today's bundle-first behavior).
    const POLICY_ENV: &str = "CHAN_LINUX_SYSTEM_GUI";

    /// Loop guard, set across the re-exec so the child does not re-exec again.
    const APPLIED_ENV: &str = "CHAN_LINUX_SYSTEM_GUI_APPLIED";

    /// dma-buf policy knob: `auto` (default, disable only for the NVIDIA
    /// proprietary driver), `on` (never disable), `off` (always disable).
    const DMABUF_ENV: &str = "CHAN_LINUX_DMABUF";

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
        // The re-exec'd child inherits APPLIED=1 and must not loop.
        if std::env::var_os(APPLIED_ENV).is_some() {
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

        // Prepend the host lib dir so the loader resolves libgtk /
        // libwebkit2gtk / libEGL / libgbm to the host copies, falling back to
        // the bundle for anything the host lacks.
        let mut ld_path = system_dir;
        if let Some(existing) = std::env::var_os("LD_LIBRARY_PATH") {
            if !existing.is_empty() {
                ld_path.push(":");
                ld_path.push(existing);
            }
        }

        let argv: Vec<OsString> = std::env::args_os().skip(1).collect();
        // execv replaces the image on success and returns only on failure.
        let err = Command::new(&exe)
            .args(&argv)
            .env("LD_LIBRARY_PATH", &ld_path)
            .env(APPLIED_ENV, "1")
            .exec();
        // Re-exec failed. Under `system` that is fatal; under `auto` fall
        // through to a normal bundle-first launch rather than aborting.
        if force {
            eprintln!("chan: {POLICY_ENV}=system re-exec failed: {err}");
            std::process::exit(1);
        }
        eprintln!("chan: system-GUI-stack re-exec failed ({err}); continuing on bundled stack");
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
    /// This layer was belt-and-braces from the start: the EGL_BAD_PARAMETER
    /// abort that motivated this module is an AMD-on-newer-Mesa fault, and the
    /// host-stack re-exec above is its actual fix. A user who needs the old
    /// behavior sets the variable themselves; the value is never clobbered.
    ///
    /// `CHAN_LINUX_DMABUF` overrides the detection: `on` keeps the
    /// accelerated path whatever the driver (the knob for an NVIDIA user who
    /// wants to try WebGL), `off` restores the old unconditional disable, and
    /// anything else is `auto`.
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
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
            return;
        }
        if dma_buf_disabled(&std::env::var(DMABUF_ENV).unwrap_or_default(), || {
            nvidia_proprietary_driver(Path::new("/"))
        }) {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
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

    fn ldconfig_cache() -> Option<String> {
        let out = Command::new("ldconfig").arg("-p").output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
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
        use super::{dma_buf_disabled, nvidia_proprietary_driver, NVIDIA_DRIVER_MARKERS};
        use std::fs;

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
        fn an_absent_or_unknown_policy_defers_to_the_driver() {
            for policy in ["", "auto", "yes", "1"] {
                assert!(dma_buf_disabled(policy, || true), "{policy:?} on nvidia");
                assert!(!dma_buf_disabled(policy, || false), "{policy:?} elsewhere");
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
