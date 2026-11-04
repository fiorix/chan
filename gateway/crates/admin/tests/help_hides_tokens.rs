//! The admin CLI's help never renders the bearer tokens it reads from the
//! environment.
//!
//! The token arguments are global, so every help screen lists them. Each case
//! runs the built binary with a cleared environment holding sentinel values,
//! so no test mutates this process's environment. Failure messages name the
//! variable and the invocation, never a sentinel.

use std::process::Command;

const TOKENS: [(&str, &str); 3] = [
    ("CHAN_ADMIN_PROFILE_TOKEN", "sentinel-profile-bearer-5d1c"),
    ("CHAN_ADMIN_IDENTITY_TOKEN", "sentinel-identity-bearer-8a4e"),
    ("CHAN_ADMIN_OPERATOR_TOKEN", "sentinel-operator-bearer-2f7b"),
];

const URL: (&str, &str) = (
    "CHAN_ADMIN_PROFILE_URL",
    "http://sentinel-profile-url.invalid:7001",
);

const INVOCATIONS: [&[&str]; 6] = [
    &["--help"],
    &["-h"],
    &["flag", "--help"],
    &["flag", "grant", "--help"],
    &["user", "create", "--help"],
    &["help", "fleet"],
];

#[test]
fn help_names_token_variables_without_their_values() {
    let mut failures = Vec::new();
    for args in INVOCATIONS {
        let invocation = args.join(" ");
        let output = Command::new(env!("CARGO_BIN_EXE_chan-gateway-admin"))
            .args(args)
            .env_clear()
            .envs(TOKENS)
            .env(URL.0, URL.1)
            .output()
            .expect("run chan-gateway-admin");
        if !output.status.success() {
            failures.push(format!("`{invocation}` exited with {}", output.status));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Help wraps at the terminal width, which can split an entry at its
        // space.
        let help = stdout.split_whitespace().collect::<Vec<_>>().join(" ");
        for (name, value) in TOKENS {
            if stdout.contains(value) || stderr.contains(value) {
                failures.push(format!("`{invocation}` printed the value of {name}"));
            }
            let entry = format!("[env: {name}]");
            let count = help.matches(&entry).count();
            if count != 1 {
                failures.push(format!(
                    "`{invocation}` showed {entry} {count} times, want 1"
                ));
            }
        }
        if !help.contains(&format!("[env: {}={}]", URL.0, URL.1)) {
            failures.push(format!("`{invocation}` dropped the value of {}", URL.0));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
