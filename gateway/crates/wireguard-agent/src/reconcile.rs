//! The reconcile rule: make the interface's peers match the desired set,
//! touching only the peers this agent added.
//!
//! For each pass the interface's peer keys are read with `wg show IFACE
//! dump` and compared with the desired set and the managed set:
//!
//! - a managed key no longer desired is removed from the interface (when
//!   still there) and forgotten;
//! - a desired key on neither the interface nor the managed set is recorded
//!   as managed and then added with its allowed IPs;
//! - a managed key whose desired allowed IPs differ from the recorded ones
//!   is set to the desired list, then recorded;
//! - a managed key the operator removed from the interface is added again
//!   while it is desired;
//! - a desired key already on the interface but not managed is an
//!   operator's peer: it is logged once as a conflict and left alone.
//!
//! The managed set is written before an add and after a remove, so a
//! failed `wg` call or a crash between the call and the write never leaves
//! a peer this agent added outside the set (where it could never be
//! removed); at worst the set names a key the interface lacks, which the
//! next pass adds again or forgets. The copy in memory changes only once
//! the file holds the change: a failed write leaves both as they were, so
//! no `wg set` runs for a key the file does not hold, and the next pass
//! tries the change again.

use std::collections::BTreeSet;

use crate::peers::PeerSet;
use crate::state::StateFile;
use crate::wg::Wg;

/// What one pass changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub forgotten: usize,
    /// Operator peers logged as a conflict in this pass: each is logged in
    /// the first pass that meets it, and again only after it went away.
    pub conflicts_logged: usize,
}

impl Changes {
    pub fn any(&self) -> bool {
        *self != Self::default()
    }
}

pub struct Reconciler<W> {
    wg: W,
    interface: String,
    state: StateFile,
    managed: PeerSet,
    /// Operator peers already logged as a conflict, so each is logged once
    /// while it lasts.
    conflicts: BTreeSet<String>,
}

impl<W: Wg> Reconciler<W> {
    /// Open the managed set; a corrupt state file is an error.
    pub fn open(wg: W, interface: &str, state: StateFile) -> anyhow::Result<Self> {
        let managed = state.load()?;
        Ok(Self {
            wg,
            interface: interface.to_string(),
            state,
            managed,
            conflicts: BTreeSet::new(),
        })
    }

    pub fn managed(&self) -> &PeerSet {
        &self.managed
    }

    /// One pass toward `desired`. `stop` is checked before each change, so a
    /// shutdown ends the pass after the `wg` call in flight; every change is
    /// recorded before the next one starts.
    pub fn reconcile(
        &mut self,
        desired: &PeerSet,
        stop: &dyn Fn() -> bool,
    ) -> anyhow::Result<Changes> {
        let present = self.wg.peer_keys()?;
        let mut changes = Changes::default();

        let gone: Vec<String> = self
            .managed
            .keys()
            .filter(|key| !desired.contains_key(*key))
            .cloned()
            .collect();
        for key in gone {
            if stop() {
                return Ok(changes);
            }
            if present.contains(&key) {
                self.wg.remove_peer(&key)?;
                tracing::info!(interface = %self.interface, key = %key, "removed peer");
                changes.removed += 1;
            } else {
                tracing::info!(interface = %self.interface, key = %key, "forgot a peer the interface no longer has");
                changes.forgotten += 1;
            }
            self.change_managed(|managed| {
                managed.remove(&key);
            })?;
        }

        for (key, ips) in desired {
            if stop() {
                return Ok(changes);
            }
            let on_interface = present.contains(key);
            match self.managed.get(key) {
                None if on_interface => {
                    if self.conflicts.insert(key.clone()) {
                        changes.conflicts_logged += 1;
                        tracing::warn!(
                            interface = %self.interface,
                            key = %key,
                            "the interface already has this desired peer and the agent did not add it; leaving the operator's peer alone"
                        );
                    }
                }
                None => {
                    self.change_managed(|managed| {
                        managed.insert(key.clone(), ips.clone());
                    })?;
                    self.wg.set_allowed_ips(key, ips)?;
                    tracing::info!(interface = %self.interface, key = %key, allowed_ips = %ips.join(","), "added peer");
                    changes.added += 1;
                }
                Some(recorded) if !on_interface => {
                    let changed = recorded != ips;
                    self.wg.set_allowed_ips(key, ips)?;
                    if changed {
                        self.change_managed(|managed| {
                            managed.insert(key.clone(), ips.clone());
                        })?;
                    }
                    tracing::info!(interface = %self.interface, key = %key, allowed_ips = %ips.join(","), "added back a peer removed from the interface");
                    changes.added += 1;
                }
                Some(recorded) if recorded != ips => {
                    self.wg.set_allowed_ips(key, ips)?;
                    self.change_managed(|managed| {
                        managed.insert(key.clone(), ips.clone());
                    })?;
                    tracing::info!(interface = %self.interface, key = %key, allowed_ips = %ips.join(","), "updated peer's allowed IPs");
                    changes.updated += 1;
                }
                Some(_) => {}
            }
        }

        self.conflicts.retain(|key| {
            desired.contains_key(key) && present.contains(key) && !self.managed.contains_key(key)
        });
        Ok(changes)
    }

    /// Apply `edit` to a copy of the managed set, write the copy, and only
    /// then make it the set in memory: a failed write leaves memory equal to
    /// the file, so the caller's next `wg` call does not run and the next
    /// pass makes the change again.
    fn change_managed(&mut self, edit: impl FnOnce(&mut PeerSet)) -> anyhow::Result<()> {
        let mut next = self.managed.clone();
        edit(&mut next);
        self.state.store(&next)?;
        self.managed = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use super::*;
    use crate::peers::tests::key;
    use crate::state::tests::TempDir;
    use crate::wg::WgCommand;

    /// Tests that exec a freshly written script run one at a time: a script
    /// another thread is writing when this one forks can fail its exec with
    /// "Text file busy".
    static FAKE_WG: Mutex<()> = Mutex::new(());

    /// A stand-in `wg`: appends its argv to `argv.log`, answers
    /// `show IFACE dump` from `dump`, and fails every `set` while `fail`
    /// exists.
    struct FakeWg {
        dir: TempDir,
    }

    impl FakeWg {
        fn new() -> Self {
            let dir = TempDir::new("fake-wg");
            let script = format!(
                "#!/bin/sh\n\
                 printf '%s\\n' \"$*\" >> '{dir}/argv.log'\n\
                 if [ \"$1\" = set ] && [ -e '{dir}/fail' ]; then echo 'set refused' >&2; exit 1; fi\n\
                 if [ \"$1\" = show ] && [ \"$3\" = dump ]; then cat '{dir}/dump'; exit $?; fi\n\
                 exit 0\n",
                dir = dir.0.display()
            );
            let path = dir.0.join("wg");
            fs::write(&path, script).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            let fake = Self { dir };
            fake.set_dump(&[]);
            fake
        }

        fn bin(&self) -> PathBuf {
            self.dir.0.join("wg")
        }

        /// The interface line, then one line per `(key, allowed ips)`.
        fn set_dump(&self, peers: &[(String, &str)]) {
            let mut dump = format!("{}\t{}\t51820\toff\n", key(200), key(201));
            for (k, ips) in peers {
                dump.push_str(&format!("{k}\t(none)\t(none)\t{ips}\t0\t0\t0\toff\n"));
            }
            fs::write(self.dir.0.join("dump"), dump).unwrap();
        }

        fn failing(&self, fail: bool) {
            let path = self.dir.0.join("fail");
            if fail {
                fs::write(path, "").unwrap();
            } else {
                let _ = fs::remove_file(path);
            }
        }

        /// The argv lines since the last call.
        fn take_argv(&self) -> Vec<String> {
            let path = self.dir.0.join("argv.log");
            let lines = fs::read_to_string(&path).unwrap_or_default();
            let _ = fs::remove_file(&path);
            lines.lines().map(str::to_string).collect()
        }
    }

    fn reconciler(fake: &FakeWg, state_dir: &Path) -> Reconciler<WgCommand> {
        Reconciler::open(
            WgCommand::new(fake.bin(), "wg0".into()),
            "wg0",
            StateFile::new(state_dir, "wg0"),
        )
        .unwrap()
    }

    fn set(peers: &[(String, &[&str])]) -> PeerSet {
        peers
            .iter()
            .map(|(k, ips)| (k.clone(), ips.iter().map(|s| s.to_string()).collect()))
            .collect()
    }

    const NEVER: &dyn Fn() -> bool = &|| false;

    /// Every argv the agent passed is one of its three shapes, on wg0.
    fn assert_only_allowed_argv(argv: &[String]) {
        for line in argv {
            let words: Vec<&str> = line.split(' ').collect();
            let ok = matches!(words.as_slice(), ["show", "wg0", "dump"])
                || matches!(words.as_slice(), ["set", "wg0", "peer", _, "remove"])
                || matches!(
                    words.as_slice(),
                    ["set", "wg0", "peer", _, "allowed-ips", _]
                );
            assert!(ok, "unexpected wg argv: {line}");
        }
    }

    #[test]
    fn the_reconcile_rule_touches_only_managed_peers() {
        let _serial = FAKE_WG.lock().unwrap_or_else(|e| e.into_inner());
        let fake = FakeWg::new();
        let state = TempDir::new("reconcile-rule");
        let mut rec = reconciler(&fake, &state.0);
        let operator = key(50);
        let mut all_argv = Vec::new();

        // An absent desired key is added with its allowed IPs; a desired
        // key the operator already has is left alone and logged once.
        fake.set_dump(&[(operator.clone(), "10.9.0.1/32")]);
        let desired = set(&[
            (key(1), &["10.7.0.2/32"]),
            (key(2), &["10.7.0.3/32", "fd00:7::3/128"]),
            (operator.clone(), &["10.7.0.9/32"]),
        ]);
        let changes = rec.reconcile(&desired, NEVER).unwrap();
        assert_eq!((changes.added, changes.conflicts_logged), (2, 1));
        let argv = fake.take_argv();
        assert_eq!(
            argv,
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} allowed-ips 10.7.0.2/32", key(1)),
                format!(
                    "set wg0 peer {} allowed-ips 10.7.0.3/32,fd00:7::3/128",
                    key(2)
                ),
            ]
        );
        all_argv.extend(argv);
        assert_eq!(
            rec.managed().keys().cloned().collect::<Vec<_>>(),
            [key(1), key(2)]
        );

        // The interface now holds both; the conflict is not logged again.
        fake.set_dump(&[
            (operator.clone(), "10.9.0.1/32"),
            (key(1), "10.7.0.2/32"),
            (key(2), "10.7.0.3/32,fd00:7::3/128"),
        ]);
        let changes = rec.reconcile(&desired, NEVER).unwrap();
        assert!(!changes.any(), "{changes:?}");
        all_argv.extend(fake.take_argv());

        // A managed key whose allowed IPs changed is set again; a managed
        // key no longer desired is removed; the operator's key, now no
        // longer desired either, is not removed.
        let desired = set(&[(key(2), &["10.7.0.4/32"])]);
        let changes = rec.reconcile(&desired, NEVER).unwrap();
        assert_eq!((changes.updated, changes.removed), (1, 1));
        let argv = fake.take_argv();
        assert_eq!(
            argv,
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} remove", key(1)),
                format!("set wg0 peer {} allowed-ips 10.7.0.4/32", key(2)),
            ]
        );
        all_argv.extend(argv);
        assert_eq!(rec.managed(), &set(&[(key(2), &["10.7.0.4/32"])]));

        // A managed key the operator removed is added back while desired.
        fake.set_dump(&[(operator.clone(), "10.9.0.1/32")]);
        let changes = rec.reconcile(&desired, NEVER).unwrap();
        assert_eq!(changes.added, 1);
        let argv = fake.take_argv();
        assert_eq!(
            argv,
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} allowed-ips 10.7.0.4/32", key(2)),
            ]
        );
        all_argv.extend(argv);

        // Desired set empty: the managed key goes, the operator's stays.
        fake.set_dump(&[(operator.clone(), "10.9.0.1/32"), (key(2), "10.7.0.4/32")]);
        rec.reconcile(&PeerSet::new(), NEVER).unwrap();
        let argv = fake.take_argv();
        assert_eq!(
            argv,
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} remove", key(2))
            ]
        );
        all_argv.extend(argv);
        assert!(rec.managed().is_empty());

        assert_only_allowed_argv(&all_argv);
        assert!(!all_argv
            .iter()
            .any(|l| l.contains(&operator) && l.starts_with("set")));
        assert!(!all_argv.iter().any(|l| l.contains("private-key")
            || l.contains("listen-port")
            || l.contains("fwmark")));
    }

    #[test]
    fn an_unchanged_desired_set_and_dump_only_reads() {
        let _serial = FAKE_WG.lock().unwrap_or_else(|e| e.into_inner());
        let fake = FakeWg::new();
        let state = TempDir::new("reconcile-idempotent");
        let mut rec = reconciler(&fake, &state.0);
        let desired = set(&[(key(1), &["10.7.0.2/32"]), (key(2), &["10.7.0.3/32"])]);
        rec.reconcile(&desired, NEVER).unwrap();
        fake.take_argv();
        fake.set_dump(&[(key(1), "10.7.0.2/32"), (key(2), "10.7.0.3/32")]);
        let written = fs::metadata(state.0.join("peers.json"))
            .unwrap()
            .modified()
            .unwrap();

        for _ in 0..2 {
            let changes = rec.reconcile(&desired, NEVER).unwrap();
            assert!(!changes.any(), "{changes:?}");
            assert_eq!(fake.take_argv(), ["show wg0 dump"]);
        }
        assert_eq!(
            fs::metadata(state.0.join("peers.json"))
                .unwrap()
                .modified()
                .unwrap(),
            written,
            "an idle pass does not rewrite the state file"
        );
    }

    #[test]
    fn a_restart_keeps_what_the_agent_added_and_a_failed_add_is_retried() {
        let _serial = FAKE_WG.lock().unwrap_or_else(|e| e.into_inner());
        let fake = FakeWg::new();
        let state = TempDir::new("reconcile-restart");
        let desired = set(&[(key(1), &["10.7.0.2/32"])]);

        // The add's `wg set` fails after the key was recorded.
        let mut rec = reconciler(&fake, &state.0);
        fake.failing(true);
        let error = format!("{:#}", rec.reconcile(&desired, NEVER).unwrap_err());
        assert!(error.contains("set refused"), "{error}");
        fake.failing(false);
        fake.take_argv();
        drop(rec);

        // A restarted agent still manages the key, finds it missing and
        // adds it.
        let mut rec = reconciler(&fake, &state.0);
        assert_eq!(rec.managed(), &desired);
        rec.reconcile(&desired, NEVER).unwrap();
        assert_eq!(
            fake.take_argv(),
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} allowed-ips 10.7.0.2/32", key(1)),
            ]
        );

        // Once desired no more, the restarted agent removes it.
        fake.set_dump(&[(key(1), "10.7.0.2/32"), (key(60), "10.9.0.2/32")]);
        drop(rec);
        let mut rec = reconciler(&fake, &state.0);
        rec.reconcile(&PeerSet::new(), NEVER).unwrap();
        assert_eq!(
            fake.take_argv(),
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} remove", key(1))
            ]
        );
        assert!(StateFile::new(&state.0, "wg0").load().unwrap().is_empty());
    }

    #[test]
    fn a_managed_peer_already_gone_is_only_forgotten() {
        let _serial = FAKE_WG.lock().unwrap_or_else(|e| e.into_inner());
        let fake = FakeWg::new();
        let state = TempDir::new("reconcile-forget");
        let mut rec = reconciler(&fake, &state.0);
        rec.reconcile(&set(&[(key(1), &["10.7.0.2/32"])]), NEVER)
            .unwrap();
        fake.take_argv();
        // The operator removed the peer, then the gateway stopped listing
        // it: nothing is left to remove.
        fake.set_dump(&[]);
        let changes = rec.reconcile(&PeerSet::new(), NEVER).unwrap();
        assert_eq!((changes.removed, changes.forgotten), (0, 1));
        assert_eq!(fake.take_argv(), ["show wg0 dump"]);
        assert!(StateFile::new(&state.0, "wg0").load().unwrap().is_empty());
    }

    /// Make every state write fail, or work again: a directory where the
    /// write's sibling file goes refuses the open, for root as well.
    fn state_writes_fail(state_dir: &Path, fail: bool) {
        let sibling = state_dir.join(format!(".{}.tmp", crate::state::STATE_FILE));
        if fail {
            fs::create_dir(sibling).unwrap();
        } else {
            fs::remove_dir(sibling).unwrap();
        }
    }

    #[test]
    fn an_add_whose_record_fails_is_recorded_before_the_retried_set() {
        let _serial = FAKE_WG.lock().unwrap_or_else(|e| e.into_inner());
        let fake = FakeWg::new();
        let state = TempDir::new("reconcile-add-record-fails");
        let mut rec = reconciler(&fake, &state.0);
        let desired = set(&[(key(1), &["10.7.0.2/32"])]);

        // The add's record cannot be written: the pass stops before `wg set`.
        state_writes_fail(&state.0, true);
        let error = format!("{:#}", rec.reconcile(&desired, NEVER).unwrap_err());
        assert!(error.contains(".peers.json.tmp"), "{error}");
        assert_eq!(
            fake.take_argv(),
            ["show wg0 dump"],
            "no set in the failed pass"
        );

        // The next pass writes the record, then sets the peer.
        state_writes_fail(&state.0, false);
        let changes = rec.reconcile(&desired, NEVER).unwrap();
        assert_eq!(changes.added, 1);
        assert_eq!(
            fake.take_argv(),
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} allowed-ips 10.7.0.2/32", key(1)),
            ]
        );
        assert_eq!(
            StateFile::new(&state.0, "wg0").load().unwrap(),
            desired,
            "the file holds the key once its set ran"
        );

        // So a restarted agent removes the peer once it is revoked.
        fake.set_dump(&[(key(1), "10.7.0.2/32")]);
        drop(rec);
        let mut rec = reconciler(&fake, &state.0);
        rec.reconcile(&PeerSet::new(), NEVER).unwrap();
        assert_eq!(
            fake.take_argv(),
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} remove", key(1))
            ]
        );
    }

    #[test]
    fn an_update_whose_record_fails_is_set_and_recorded_again() {
        let _serial = FAKE_WG.lock().unwrap_or_else(|e| e.into_inner());
        let fake = FakeWg::new();
        let state = TempDir::new("reconcile-update-record-fails");
        let mut rec = reconciler(&fake, &state.0);
        rec.reconcile(&set(&[(key(1), &["10.7.0.2/32"])]), NEVER)
            .unwrap();
        fake.set_dump(&[(key(1), "10.7.0.2/32")]);
        fake.take_argv();
        let moved = set(&[(key(1), &["10.7.0.5/32"])]);

        // The set runs, then its record cannot be written.
        state_writes_fail(&state.0, true);
        rec.reconcile(&moved, NEVER).unwrap_err();
        fake.take_argv();

        // The next pass still sees the change, sets it again and records it.
        state_writes_fail(&state.0, false);
        let changes = rec.reconcile(&moved, NEVER).unwrap();
        assert_eq!(changes.updated, 1, "the update is tried again");
        assert_eq!(
            fake.take_argv(),
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} allowed-ips 10.7.0.5/32", key(1)),
            ]
        );
        assert_eq!(StateFile::new(&state.0, "wg0").load().unwrap(), moved);
    }

    #[test]
    fn a_stop_ends_the_pass_between_changes() {
        let _serial = FAKE_WG.lock().unwrap_or_else(|e| e.into_inner());
        let fake = FakeWg::new();
        let state = TempDir::new("reconcile-stop");
        let mut rec = reconciler(&fake, &state.0);
        let desired = set(&[(key(1), &["10.7.0.2/32"]), (key(2), &["10.7.0.3/32"])]);
        let calls = std::cell::Cell::new(0);
        let stop_after_one = || {
            calls.set(calls.get() + 1);
            calls.get() > 1
        };
        let changes = rec.reconcile(&desired, &stop_after_one).unwrap();
        assert_eq!(changes.added, 1);
        assert_eq!(
            fake.take_argv(),
            [
                "show wg0 dump".to_string(),
                format!("set wg0 peer {} allowed-ips 10.7.0.2/32", key(1)),
            ]
        );
        assert_eq!(StateFile::new(&state.0, "wg0").load().unwrap().len(), 1);
    }
}
