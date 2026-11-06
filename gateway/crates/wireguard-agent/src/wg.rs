//! The three `wg` invocations the agent makes, against one interface:
//! `show IFACE dump`, `set IFACE peer KEY allowed-ips A,B` and
//! `set IFACE peer KEY remove`. Nothing else is ever passed to `wg`: not
//! the interface's private key, listen port or fwmark, and no other
//! interface name.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::{Command, Output};

use anyhow::{bail, Context};

/// The peer operations the reconciler needs; a trait so the rule is tested
/// against a recording fake.
pub trait Wg {
    /// The public keys of the interface's peers.
    fn peer_keys(&self) -> anyhow::Result<BTreeSet<String>>;
    /// Create `key` or replace its allowed IPs with exactly `allowed_ips`.
    fn set_allowed_ips(&self, key: &str, allowed_ips: &[String]) -> anyhow::Result<()>;
    /// Remove the peer `key`.
    fn remove_peer(&self, key: &str) -> anyhow::Result<()>;
}

/// `wg` from wireguard-tools, run with the interface name as its only
/// device argument.
#[derive(Debug, Clone)]
pub struct WgCommand {
    bin: PathBuf,
    interface: String,
}

impl WgCommand {
    pub fn new(bin: PathBuf, interface: String) -> Self {
        Self { bin, interface }
    }

    fn run(&self, args: &[&str]) -> anyhow::Result<Output> {
        let output = Command::new(&self.bin)
            .args(args)
            .output()
            .with_context(|| format!("running {}", self.bin.display()))?;
        if !output.status.success() {
            // stderr only: stdout of `show dump` carries the private key.
            bail!(
                "{} {} exited with {}: {}",
                self.bin.display(),
                args[..args.len().min(4)].join(" "),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(output)
    }
}

impl Wg for WgCommand {
    fn peer_keys(&self) -> anyhow::Result<BTreeSet<String>> {
        let output = self.run(&["show", &self.interface, "dump"])?;
        let dump = String::from_utf8(output.stdout)
            .context("wg show dump printed output that is not UTF-8")?;
        Ok(parse_dump_keys(&dump))
    }

    fn set_allowed_ips(&self, key: &str, allowed_ips: &[String]) -> anyhow::Result<()> {
        let ips = allowed_ips.join(",");
        self.run(&["set", &self.interface, "peer", key, "allowed-ips", &ips])
            .map(drop)
    }

    fn remove_peer(&self, key: &str) -> anyhow::Result<()> {
        self.run(&["set", &self.interface, "peer", key, "remove"])
            .map(drop)
    }
}

/// The peer public keys of `wg show IFACE dump`. The first line is the
/// interface itself (private key, public key, listen port, fwmark) and is
/// skipped without being kept; every further line is one peer whose first
/// tab-separated field is its public key.
pub fn parse_dump_keys(dump: &str) -> BTreeSet<String> {
    dump.lines()
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let key = fields.next()?;
            // A peer line has eight fields; anything shorter is not one.
            (fields.count() >= 7 && !key.is_empty()).then(|| key.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peers::tests::key;

    #[test]
    fn the_dump_yields_peer_keys_and_never_the_interface_line() {
        let dump = format!(
            "{private}\t{public}\t51820\toff\n\
             {a}\t(none)\t(none)\t10.7.0.2/32\t0\t0\t0\toff\n\
             {b}\t(none)\t203.0.113.9:4500\t10.7.0.3/32,fd00:7::3/128\t1730000000\t10\t20\t25\n",
            private = key(9),
            public = key(8),
            a = key(1),
            b = key(2),
        );
        let keys = parse_dump_keys(&dump);
        assert_eq!(keys, BTreeSet::from([key(1), key(2)]));
        assert!(!keys.contains(&key(9)));
        assert!(parse_dump_keys("").is_empty());
        assert!(parse_dump_keys(&format!("{}\t{}\t51820\toff\n", key(9), key(8))).is_empty());
    }
}
