use super::*;
use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Event, EventKind};
use std::sync::{mpsc, Mutex, RwLock};

#[derive(Default)]
struct Events(Mutex<Vec<WatchEvent>>);

impl WatchCallback for Events {
    fn on_event(&self, event: WatchEvent) {
        self.0.lock().unwrap().push(event);
    }
}

struct Trace {
    root: tempfile::TempDir,
    roots: Vec<WatchRoot>,
    policy: ScopePolicySource,
    registered: RegisteredDirs,
    commands: RegistrationTx,
    received_commands: mpsc::Receiver<WatchCommand>,
    state: DispatchState,
    events: Events,
}

impl Trace {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let generation = serde_json::from_str("9").unwrap();
        let policy = Arc::new(RwLock::new(Arc::new(
            IndexScopePolicy::new(
                root.path().to_path_buf(),
                generation,
                crate::WalkFilter::new(["node_modules"]),
            )
            .unwrap(),
        )));
        let (commands, received_commands) = mpsc::channel();
        Self {
            roots: vec![WatchRoot::workspace(root.path())],
            root,
            policy,
            registered: Arc::new(RwLock::new(HashSet::new())),
            commands,
            received_commands,
            state: DispatchState::new(),
            events: Events::default(),
        }
    }

    fn event(&mut self, kind: EventKind, paths: &[&str], cookie: Option<u32>) {
        let mut event = Event::new(kind);
        event.paths = paths
            .iter()
            .map(|path| self.root.path().join(path))
            .collect();
        if let Some(cookie) = cookie {
            event.attrs.set_tracker(cookie as usize);
        }
        dispatch(
            &self.roots,
            &self.policy,
            &self.registered,
            event,
            &self.events,
            &self.commands,
            &mut self.state,
        );
    }

    fn rename(&mut self, mode: RenameMode, paths: &[&str], cookie: u32) {
        self.event(
            EventKind::Modify(ModifyKind::Name(mode)),
            paths,
            Some(cookie),
        );
    }

    fn file(&self, kind: WatchKind, path: &str) -> WatchEvent {
        WatchEvent::file(kind, path, self.policy.read().unwrap().generation())
    }

    fn arrival(&self, path: &str, cookie: u32) -> WatchEvent {
        WatchEvent::rename(
            None,
            Some(path.into()),
            false,
            Some(cookie),
            self.policy.read().unwrap().generation(),
        )
    }

    fn assert_events(&self, expected: &[WatchEvent]) {
        assert_eq!(*self.events.0.lock().unwrap(), expected);
    }
}

#[test]
fn linux_save_sequences_emit_one_normalized_event() {
    for both in [false, true] {
        for (source, kind) in [
            ("notes/.chan-write-a-0001", WatchKind::Modified),
            ("notes/.chan-write-new-a-0001", WatchKind::Created),
        ] {
            let mut trace = Trace::new();
            trace.rename(RenameMode::From, &[source], 21);
            trace.rename(RenameMode::To, &["notes/target.md"], 21);
            if both {
                trace.rename(RenameMode::Both, &[source, "notes/target.md"], 21);
            }
            trace.assert_events(&[trace.file(kind, "notes/target.md")]);
        }
    }
}

#[test]
fn interleaved_writers_keep_their_own_publication_kind() {
    for (first_source, first_kind) in [
        ("a/.chan-write-one", WatchKind::Modified),
        ("a/.chan-write-new-one", WatchKind::Created),
    ] {
        let mut trace = Trace::new();
        trace.rename(RenameMode::From, &[first_source], 51);
        trace.rename(RenameMode::From, &["b/.chan-write-two"], 52);
        trace.rename(RenameMode::To, &["a/first.md"], 51);
        trace.rename(RenameMode::To, &["b/second.md"], 52);
        trace.rename(RenameMode::Both, &["b/.chan-write-two", "b/second.md"], 52);
        trace.assert_events(&[
            trace.file(first_kind, "a/first.md"),
            trace.file(WatchKind::Modified, "b/second.md"),
        ]);
    }
}

#[test]
fn lost_to_is_bounded_by_sixteen_pending_cookies() {
    for count in [16, 17] {
        let mut trace = Trace::new();
        for cookie in 1..=count {
            trace.rename(RenameMode::From, &[".chan-write-new-pending"], cookie);
        }
        trace.rename(RenameMode::To, &["oldest.md"], 1);
        trace.rename(RenameMode::To, &["newest.md"], count);
        trace.assert_events(&[
            if count == 16 {
                trace.file(WatchKind::Created, "oldest.md")
            } else {
                trace.arrival("oldest.md", 1)
            },
            trace.file(WatchKind::Created, "newest.md"),
        ]);
    }
}

#[test]
fn consumed_cookie_cannot_normalize_a_later_arrival() {
    let mut trace = Trace::new();
    trace.rename(RenameMode::From, &[".chan-write-temp"], 10);
    trace.rename(RenameMode::To, &["saved.md"], 10);
    trace.rename(RenameMode::To, &["arrived.md"], 10);
    trace.assert_events(&[
        trace.file(WatchKind::Modified, "saved.md"),
        trace.arrival("arrived.md", 10),
    ]);
}

#[test]
fn foreign_and_missing_cookies_keep_arrivals() {
    let mut trace = Trace::new();
    trace.rename(RenameMode::To, &["lost-from.md"], 11);
    trace.rename(RenameMode::From, &[".chan-write-new-temp"], 12);
    trace.rename(RenameMode::To, &["foreign.md"], 13);
    trace.rename(RenameMode::To, &["created.md"], 12);
    trace.assert_events(&[
        trace.arrival("lost-from.md", 11),
        trace.arrival("foreign.md", 13),
        trace.file(WatchKind::Created, "created.md"),
    ]);
}

#[test]
fn filtered_nonreserved_source_does_not_normalize_an_arrival() {
    let mut trace = Trace::new();
    trace.rename(RenameMode::From, &[".git/x"], 14);
    trace.rename(RenameMode::To, &["x"], 14);
    trace.assert_events(&[trace.arrival("x", 14)]);
}

#[test]
fn excluded_destination_consumes_the_cookie_without_an_event() {
    let mut trace = Trace::new();
    trace.rename(RenameMode::From, &[".chan-write-temp"], 15);
    trace.rename(RenameMode::To, &["node_modules/excluded.md"], 15);
    trace.rename(
        RenameMode::Both,
        &[".chan-write-temp", "node_modules/excluded.md"],
        15,
    );
    trace.assert_events(&[]);
    trace.rename(RenameMode::To, &["arrived.md"], 15);
    trace.assert_events(&[trace.arrival("arrived.md", 15)]);
}

#[test]
fn reserved_source_onto_a_directory_keeps_registration_and_catch_up() {
    let mut trace = Trace::new();
    let arrived = trace.root.path().join("arrived");
    std::fs::create_dir(&arrived).unwrap();
    trace.registered.write().unwrap().insert(arrived.clone());
    trace.rename(RenameMode::From, &[".chan-write-stage"], 16);
    trace.rename(RenameMode::To, &["arrived"], 16);
    trace.assert_events(&[WatchEvent::dir(
        WatchKind::Created,
        "arrived",
        trace.policy.read().unwrap().generation(),
    )]);
    assert!(trace.registered.read().unwrap().contains(&arrived));
    let WatchCommand::Register(registration) = trace.received_commands.try_recv().unwrap() else {
        panic!("directory arrival must queue registration and catch-up");
    };
    assert_eq!(registration.abs, arrived);
    assert_eq!(registration.rel, "arrived");
    assert_eq!(registration.plan, DirPlan::WatchAndDescend);
    assert_eq!(
        registration.generation,
        trace.policy.read().unwrap().generation()
    );
}

#[test]
fn ordinary_renames_keep_their_paths_and_cookies_beside_a_save() {
    let mut trace = Trace::new();
    trace.rename(RenameMode::From, &[".chan-write-temp"], 17);
    trace.rename(RenameMode::From, &["before.md"], 18);
    trace.rename(RenameMode::To, &["after.md"], 18);
    trace.rename(RenameMode::Both, &["before.md", "after.md"], 18);
    trace.rename(RenameMode::To, &["saved.md"], 17);
    let generation = trace.policy.read().unwrap().generation();
    trace.assert_events(&[
        WatchEvent::rename(Some("before.md".into()), None, false, Some(18), generation),
        trace.arrival("after.md", 18),
        WatchEvent::rename(
            Some("before.md".into()),
            Some("after.md".into()),
            false,
            Some(18),
            generation,
        ),
        trace.file(WatchKind::Modified, "saved.md"),
    ]);
}

#[test]
fn untracked_windows_and_fsevents_shapes_keep_backend_mapping() {
    for mode in [RenameMode::To, RenameMode::Any] {
        let mut trace = Trace::new();
        let source_mode = if mode == RenameMode::To {
            RenameMode::From
        } else {
            RenameMode::Any
        };
        trace.event(
            EventKind::Modify(ModifyKind::Name(source_mode)),
            &[".chan-write-new-temp"],
            None,
        );
        trace.event(
            EventKind::Modify(ModifyKind::Name(mode)),
            &["target.md"],
            None,
        );
        let (from, to) = if mode == RenameMode::To {
            (None, Some("target.md".into()))
        } else {
            (Some("target.md".into()), None)
        };
        trace.assert_events(&[WatchEvent::rename(
            from,
            to,
            false,
            None,
            trace.policy.read().unwrap().generation(),
        )]);
    }
}

#[test]
fn reserved_orphans_and_stages_never_dispatch_or_register() {
    let mut trace = Trace::new();
    std::fs::create_dir(trace.root.path().join(".chan-write-stage")).unwrap();
    for path in [".chan-write-orphan", ".chan-write-stage/payload"] {
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Modify(ModifyKind::Any),
            EventKind::Remove(RemoveKind::File),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        ] {
            trace.event(kind, &[path], Some(20));
        }
    }
    trace.event(
        EventKind::Create(CreateKind::Folder),
        &[".chan-write-stage"],
        None,
    );
    trace.assert_events(&[]);
    assert!(matches!(
        trace.received_commands.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    for path in ["#123", "e7eec6ab-54ca-43fb-9f86-8120361e624a"] {
        trace.event(EventKind::Create(CreateKind::File), &[path], None);
    }
    trace.assert_events(&[
        trace.file(WatchKind::Created, "#123"),
        trace.file(WatchKind::Created, "e7eec6ab-54ca-43fb-9f86-8120361e624a"),
    ]);
}

#[test]
fn normalized_destination_keeps_its_root_prefix_and_sampled_generation() {
    let mut trace = Trace::new();
    trace.roots[0].prefix = Some("mounted".into());
    trace.rename(RenameMode::From, &[".chan-write-temp"], 22);
    let generation = serde_json::from_str("10").unwrap();
    *trace.policy.write().unwrap() = Arc::new(
        IndexScopePolicy::new(
            trace.root.path().to_path_buf(),
            generation,
            crate::WalkFilter::new(["node_modules"]),
        )
        .unwrap(),
    );
    trace.rename(RenameMode::To, &["target.md"], 22);
    trace.assert_events(&[trace.file(WatchKind::Modified, "mounted/target.md")]);
}
