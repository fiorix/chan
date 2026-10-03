//! Exercise both binary entrypoints with no terminal or server environment.
#![cfg(unix)]

use std::os::unix::process::CommandExt;
use std::process::Command;

// The library compiles its test harness for its own tests alone, so the
// file of it that scrubs a child's environment is mounted here by path.
#[path = "../src/test_env/child_env.rs"]
mod child_env;

#[test]
fn manual_entrypoints_match_without_server() {
    for flags in [
        "",
        "--list",
        "--topic serve",
        "--topic open --part 1",
        "--full",
    ] {
        let run = |name| {
            let output = Command::new(env!("CARGO_BIN_EXE_chan"))
                .arg0(name)
                .arg("dump-skill")
                .args(flags.split_whitespace())
                .env_clear()
                .envs(child_env::scrubbed_process_env())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{name} {flags}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(!output.stdout.is_empty());
            if flags != "--full" {
                assert!(output.stdout.len() <= 8192);
            }
            output.stdout
        };
        assert_eq!(run("chan"), run("cs"), "{flags}");
    }
}
