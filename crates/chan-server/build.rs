// build.rs
//
// rust-embed bakes `web/dist/` into the binary at compile time, but
// Cargo doesn't track changes inside the embedded directory. Without
// this script, `npm run build` followed by `cargo build --release`
// produces a binary with the OLD bundle because Cargo decides
// nothing has changed and skips compilation.
//
// We emit `cargo:rerun-if-changed=PATH` for every file under
// web/dist so Cargo re-links chan-server whenever the frontend
// bundle is rebuilt.
//
// We also `create_dir_all` web/dist on first build because rust-
// embed errors if the directory doesn't exist. A fresh clone has no
// dist (it's gitignored as a build artifact); the empty dir lets
// the macro succeed and the binary just serves nothing useful
// until the user runs `cd web && npm install && npm run build`.

use std::{env, path::Path};

fn main() {
    let dist = Path::new("../../web/dist");
    create_required_dir(dist);
    println!("cargo:rerun-if-changed={}", dist.display());
    walk(dist);

    // The launcher bundle (web-launcher/dist) is baked by `LauncherAssets`
    // exactly as `WebAssets` bakes web/dist; mirror the handling. It's a
    // gitignored build artifact, so a fresh clone / isolated gate worktree
    // has none -- create the empty dir so the rust-embed macro succeeds (it
    // errors on a missing folder), and track it so a rebuilt launcher
    // relinks. The binary serves the launcher only once
    // `cd web-launcher && npm install && npm run build` has run.
    let launcher_dist = Path::new("../../web-launcher/dist");
    create_required_dir(launcher_dist);
    println!("cargo:rerun-if-changed={}", launcher_dist.display());
    walk(launcher_dist);

    // Makefile creates and rewrites this after every frontend build. A missing
    // stamp is valid before the first frontend build; Cargo keeps watching the
    // path without a build script writing a placeholder into the source tree.
    let web_build_stamp = Path::new("../../web/.chan-build-stamp");
    println!("cargo:rerun-if-changed={}", web_build_stamp.display());

    // The launcher's build stamp mirrors web/.chan-build-stamp. Makefile
    // creates and rewrites it after every launcher build.
    let launcher_build_stamp = Path::new("../../web-launcher/.chan-build-stamp");
    println!("cargo:rerun-if-changed={}", launcher_build_stamp.display());

    // Embedded model bundle. Only consumed when the `embed-model`
    // cargo feature is on: the `include_bytes!` in
    // `src/embed_seed.rs` is `#![cfg(feature = "embed-model")]`, so
    // default builds drop the file entirely and the runtime path
    // goes through `chan_workspace::index::embeddings::resolve_model`
    // plus the on-demand download flow instead. Real bundle is
    // written by `cargo run -p fetch-models` (a.k.a. `make
    // models`); empty stub is enough for a `--features
    // embed-model` build without a prior `make models` to compile
    // (the seeder treats an empty bundle as "no embedded model").
    // rerun-if-changed pins the build to the bundle's mtime so a
    // subsequent `make models` re-links. It is emitted only when the
    // bundle (or the stub) exists: Cargo treats a rerun-if-changed path
    // that does not exist as stale on every invocation, so a default
    // build on a tree without the gitignored bundle recompiled
    // chan-server, and every crate above it, on each cargo call in the
    // same target dir even when nothing had changed.
    let model_bundle = Path::new("resources/models.tar.zst");
    if env::var_os("CARGO_FEATURE_EMBED_MODEL").is_some() && !model_bundle.exists() {
        if let Some(parent) = model_bundle.parent() {
            create_required_dir(parent);
        }
        std::fs::write(model_bundle, []).unwrap_or_else(|error| {
            panic!(
                "could not create required model bundle stub {}: {error}",
                model_bundle.display()
            )
        });
    }
    if model_bundle.exists() {
        println!("cargo:rerun-if-changed={}", model_bundle.display());
    }
}

fn create_required_dir(path: &Path) {
    std::fs::create_dir_all(path).unwrap_or_else(|error| {
        panic!(
            "could not create required build input directory {}: {error}",
            path.display()
        )
    });
}

fn walk(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        println!("cargo:rerun-if-changed={}", p.display());
        if p.is_dir() {
            walk(&p);
        }
    }
}
