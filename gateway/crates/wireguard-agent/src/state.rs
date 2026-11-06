//! The managed set: the peers this agent added to the interface, with the
//! allowed IPs it gave them, kept in `peers.json` under the state
//! directory. It is what lets the agent remove its own peers and never an
//! operator's: a key outside it is never removed or changed.
//!
//! An absent file manages nothing, so a first run adopts no peer. A file
//! that does not parse, holds an invalid peer, or was written for another
//! interface refuses startup instead: treating it as empty would forget
//! peers the agent must remove, and treating it as anything else would
//! adopt peers it never added.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::peers::{canonical_peer, PeerSet};

pub const STATE_FILE: &str = "peers.json";
const FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OnDisk {
    version: u32,
    interface: String,
    peers: PeerSet,
}

#[derive(Debug)]
pub struct StateFile {
    path: PathBuf,
    interface: String,
}

impl StateFile {
    pub fn new(state_dir: &Path, interface: &str) -> Self {
        Self {
            path: state_dir.join(STATE_FILE),
            interface: interface.to_string(),
        }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read the managed set; an absent file is an empty one.
    pub fn load(&self) -> anyhow::Result<PeerSet> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(PeerSet::new()),
            Err(error) => {
                return Err(error).with_context(|| format!("reading {}", self.path.display()))
            }
        };
        let corrupt = || {
            format!(
                "{} is not a managed-peer file this agent wrote; refusing to start rather \
                 than guess which peers it added (move it aside only after checking the \
                 interface's peers by hand)",
                self.path.display()
            )
        };
        let on_disk: OnDisk = serde_json::from_slice(&bytes).with_context(corrupt)?;
        if on_disk.version != FORMAT_VERSION {
            bail!("{}: unknown format version {}", corrupt(), on_disk.version);
        }
        if on_disk.interface != self.interface {
            bail!(
                "{} records peers added to interface {:?}, not {:?}; remove them from that \
                 interface and the file before pointing the agent at another one",
                self.path.display(),
                on_disk.interface,
                self.interface
            );
        }
        for (key, ips) in &on_disk.peers {
            let canonical = canonical_peer(key, ips)
                .map_err(|e| anyhow::anyhow!(e))
                .with_context(corrupt)?;
            if &canonical != ips {
                bail!("{}: peer {key} is not in canonical form", corrupt());
            }
        }
        Ok(on_disk.peers)
    }

    /// Replace the file with `peers`: written to a sibling, flushed, renamed
    /// over the old one and the directory flushed, so a crash leaves either
    /// the old set or the new one.
    pub fn store(&self, peers: &PeerSet) -> anyhow::Result<()> {
        let dir = self
            .path
            .parent()
            .context("the state file has no parent directory")?;
        let tmp = dir.join(format!(".{STATE_FILE}.tmp"));
        let body = serde_json::to_vec_pretty(&OnDisk {
            version: FORMAT_VERSION,
            interface: self.interface.clone(),
            peers: peers.clone(),
        })?;
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .with_context(|| format!("writing {}", tmp.display()))?;
        file.write_all(&body)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .with_context(|| format!("writing {}", tmp.display()))?;
        drop(file);
        fs::rename(&tmp, &self.path)
            .with_context(|| format!("replacing {}", self.path.display()))?;
        File::open(dir)
            .and_then(|d| d.sync_all())
            .with_context(|| format!("flushing {}", dir.display()))?;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::peers::tests::key;

    /// A private directory under the test's TMPDIR, removed on drop.
    pub(crate) struct TempDir(pub PathBuf);

    impl TempDir {
        pub(crate) fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!(
                "wireguard-agent-{tag}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn managed() -> PeerSet {
        PeerSet::from([
            (key(1), vec!["10.7.0.2/32".to_string()]),
            (key(2), vec!["10.7.0.3/32".into(), "fd00:7::3/128".into()]),
        ])
    }

    #[test]
    fn the_managed_set_survives_a_restart() {
        let dir = TempDir::new("state-roundtrip");
        let state = StateFile::new(&dir.0, "wg0");
        state.store(&managed()).unwrap();
        // A new handle is what a restarted agent opens.
        assert_eq!(StateFile::new(&dir.0, "wg0").load().unwrap(), managed());
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(state.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(!dir.0.join(format!(".{STATE_FILE}.tmp")).exists());
    }

    #[test]
    fn an_absent_file_manages_nothing() {
        let dir = TempDir::new("state-absent");
        assert!(StateFile::new(&dir.0, "wg0").load().unwrap().is_empty());
    }

    #[test]
    fn a_corrupt_or_foreign_file_refuses_startup() {
        let dir = TempDir::new("state-corrupt");
        let state = StateFile::new(&dir.0, "wg0");
        for body in [
            "not json".to_string(),
            "{}".to_string(),
            r#"{"version":2,"interface":"wg0","peers":{}}"#.to_string(),
            format!(
                r#"{{"version":1,"interface":"wg0","peers":{{"{}":["10.7.0.2"]}}}}"#,
                key(1)
            ),
            r#"{"version":1,"interface":"wg0","peers":{"short":["10.7.0.2/32"]}}"#.to_string(),
            format!(
                r#"{{"version":1,"interface":"wg0","peers":{{}},"extra":true,"k":"{}"}}"#,
                key(1)
            ),
        ] {
            fs::write(state.path(), &body).unwrap();
            let error = format!("{:#}", state.load().expect_err(&body));
            assert!(error.contains("refusing to start"), "{body}: {error}");
        }
        StateFile::new(&dir.0, "wg1").store(&managed()).unwrap();
        let error = format!("{:#}", state.load().expect_err("another interface"));
        assert!(
            error.contains("records peers added to interface \"wg1\""),
            "{error}"
        );
    }
}
