//! `chan workspace index status` for a workspace whose index config names a
//! model chan dropped: the default stands in, and the status says why.
#![cfg(feature = "embeddings")]

use std::path::Path;
use std::process::{Command, Output, Stdio};

// The library compiles its test harness for its own tests alone, so the
// file of it that scrubs a child's environment is mounted here by path.
#[path = "../src/test_env/child_env.rs"]
mod child_env;

fn chan(chan_home: &Path, home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_chan"))
        .args(args)
        .env_clear()
        .envs(child_env::scrubbed_process_env())
        .env("CHAN_HOME", chan_home)
        .env("HOME", home)
        .env("CHAN_NO_DESKTOP_HANDOFF", "1")
        .env("CHAN_NO_DEVSERVER_HANDOFF", "1")
        .stdin(Stdio::null())
        .output()
        .expect("run chan")
}

#[test]
fn status_names_the_default_and_why_it_replaced_a_dropped_model() {
    let chan_home = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let root_arg = root.path().to_str().expect("utf-8 root");
    let added = chan(
        chan_home.path(),
        home.path(),
        &["workspace", "add", root_arg],
    );
    assert!(
        added.status.success(),
        "fixture: registering the workspace failed: {}",
        String::from_utf8_lossy(&added.stderr)
    );
    // The workspace's metadata lives under CHAN_HOME/workspaces/<key>; its
    // index config, written lazily, names the dropped model.
    let workspaces: Vec<_> = std::fs::read_dir(chan_home.path().join("workspaces"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert_eq!(
        workspaces.len(),
        1,
        "fixture: one workspace: {workspaces:?}"
    );
    let index = workspaces[0].join("index");
    std::fs::create_dir_all(&index).unwrap();
    std::fs::write(
        index.join("config.toml"),
        format!(
            "schema_version = {}\nmodel = \"BAAI/bge-m3\"\n",
            chan_workspace::index::config::SCHEMA_VERSION
        ),
    )
    .unwrap();

    let status = chan(
        chan_home.path(),
        home.path(),
        &["workspace", "index", "status", "--path", root_arg],
    );
    let stdout = String::from_utf8_lossy(&status.stdout);
    assert!(
        status.status.success(),
        "status failed: {}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert!(
        stdout.contains("model:            BAAI/bge-small-en-v1.5\n"),
        "{stdout}"
    );
    assert!(
        stdout.contains(
            "model note:       BAAI/bge-m3 is no longer offered: its Hub repository \
             publishes no model.safetensors."
        ),
        "{stdout}"
    );

    let json = chan(
        chan_home.path(),
        home.path(),
        &["workspace", "index", "status", "--json", "--path", root_arg],
    );
    let body: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(body["model_name"], "BAAI/bge-small-en-v1.5");
    assert!(body["model_note"]
        .as_str()
        .unwrap()
        .starts_with("BAAI/bge-m3 is no longer offered"));
}
