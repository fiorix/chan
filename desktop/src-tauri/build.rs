fn main() {
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        stage_check_sidecar();
    }
    emit_build_id();
    tauri_build::build()
}

/// Stamp the binary with the commit it was built from. The version string
/// cannot identify a build on its own: the version pins bump only at release
/// cut, so a pre-release branch build and the previous release's bundle carry
/// the same version. Best effort: a build outside a git checkout stamps
/// "unknown".
fn emit_build_id() {
    let id = match (
        git(&["rev-parse", "--short=12", "HEAD"]),
        git(&["status", "--porcelain"]),
    ) {
        (Some(hash), Some(status)) if !status.is_empty() => format!("{hash}-dirty"),
        (Some(hash), _) => hash,
        _ => "unknown".to_string(),
    };
    println!("cargo:rustc-env=CHAN_DESKTOP_BUILD_ID={id}");
    // Restamp when the checkout's head moves. `--absolute-git-dir` resolves
    // through a worktree's `.git` file to the real git directory.
    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={git_dir}/HEAD");
        println!("cargo:rerun-if-changed={git_dir}/index");
    }
}

fn git(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn stage_check_sidecar() {
    let Some(manifest_dir) = std::env::var_os("CARGO_MANIFEST_DIR") else {
        return;
    };
    let Some(target) = std::env::var_os("TARGET") else {
        return;
    };

    let sidecars_dir = std::path::Path::new(&manifest_dir).join("binaries");
    let sidecar = sidecars_dir.join(format!("chan-{}", target.to_string_lossy()));
    println!("cargo:rerun-if-changed={}", sidecar.display());

    if sidecar.exists() {
        return;
    }

    std::fs::create_dir_all(&sidecars_dir).expect("creating Tauri sidecar dir");
    std::fs::write(&sidecar, b"").expect("creating check-only Tauri sidecar placeholder");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o755))
            .expect("marking check-only Tauri sidecar placeholder executable");
    }
}
