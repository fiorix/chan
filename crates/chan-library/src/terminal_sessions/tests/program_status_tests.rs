use super::*;
use serde_json::{json, Value};

const SPEC: &str = include_str!("../../../tests/fixtures/program-status-spec.json");

struct Rig {
    registry: Registry,
    session: Arc<Session>,
    commands: Mutex<std::sync::mpsc::Receiver<PtyCommand>>,
}

impl Rig {
    fn new() -> Self {
        let registry = Registry::new(test_config(65536, 4, 0));
        let (session, commands) =
            test_agent_session(65536, &random_session_id(), None, None, None, &[]);
        register_session(&registry, &session);
        Self {
            registry,
            session,
            commands: Mutex::new(commands),
        }
    }

    fn feed(&self, bytes: &[u8]) {
        assert!(self.registry.inject_output(&self.session.id, bytes));
    }

    fn report(&self, body: &str) {
        self.feed(&sequence("7501", body, b"\x07"));
    }

    fn snapshot(&self) -> ProgramStatusSnapshot {
        self.session
            .output
            .lock()
            .unwrap()
            .status
            .published
            .borrow()
            .as_ref()
            .clone()
    }
}

fn sequence(identifier: &str, body: &str, end: &[u8]) -> Vec<u8> {
    let mut bytes = format!("\x1b]{identifier};{body}").into_bytes();
    bytes.extend_from_slice(end);
    bytes
}

fn record(fields: &Value, order: u64) -> ProgramStatusRecord {
    let mut value = json!({
        "source": "program", "id": null, "state": "idle", "kind": null,
        "progress": null, "app": null, "title": null, "msg": null,
        "seen": false, "update_order": order
    });
    for (key, field) in fields.as_object().unwrap() {
        value[key] = field.clone();
    }
    serde_json::from_value(value).unwrap()
}

#[derive(Clone)]
struct Case {
    name: String,
    identifier: String,
    body: String,
    expected: Option<Value>,
}

fn case(name: &str, body: impl Into<String>, expected: Option<Value>) -> Case {
    Case {
        name: name.into(),
        identifier: "7501".into(),
        body: body.into(),
        expected,
    }
}

fn spec_cases() -> Vec<Case> {
    let spec: Value = serde_json::from_str(SPEC).unwrap();
    spec["examples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            case(
                row["name"].as_str().unwrap(),
                row["body"].as_str().unwrap(),
                Some(row["expected"].clone()),
            )
        })
        .collect()
}

fn reference_cases() -> Vec<Case> {
    let source: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/program-status-reference.json"
    ))
    .unwrap();
    source["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| Case {
            name: format!("reference-{}", row["name"].as_str().unwrap()),
            identifier: row["identifier"].as_str().unwrap().into(),
            body: row["body"].as_str().unwrap().into(),
            expected: (!row["expected"].is_null()).then(|| row["expected"].clone()),
        })
        .collect()
}

fn boundary_cases() -> Vec<Case> {
    let mut cases = vec![
        case(
            "capital-known-keys",
            "STATE=done:state=working:APP=cargo",
            Some(json!({"state":"working"})),
        ),
        case(
            "trim-ascii",
            " \tstate \r= \nworking\x0b : app = cargo\x0c",
            Some(json!({"state":"working","app":"cargo"})),
        ),
        case(
            "skip-invalid-winning-value",
            "state=done:state=b@d:app=ok:app=b@d",
            Some(json!({"state":"done","app":"ok"})),
        ),
        case(
            "last-text-wins",
            "state=done:msg=a:msg=QQ==:title=/w==:title=Qg",
            Some(json!({"state":"done","msg":"A","title":"B"})),
        ),
        case(
            "last-id-wins",
            "state=done:id=first:id=second",
            Some(json!({"state":"done","id":"second"})),
        ),
        case(
            "last-kind-progress",
            "state=blocked:kind=auth:kind=question:progress=0:progress=100",
            Some(json!({"state":"blocked","kind":"question","progress":100})),
        ),
        case("unknown-wins", "state=working:state=future", None),
        case(
            "key-prepass-invalid-value",
            "state=working:abcdefghijklmnopq=@",
            None,
        ),
        case(
            "key-prepass-invalid-key",
            "state=working:ABCDEFGHIJKLMNO_PQ=@",
            None,
        ),
        case(
            "bad-key-no-equals",
            format!("state=working:{}", "x".repeat(17)),
            Some(json!({"state":"working"})),
        ),
        case(
            "non-alphabet-id-is-skipped",
            "state=working:id=b@d",
            Some(json!({"state":"working"})),
        ),
        case("invalid-earlier-id", "state=working:id=a//b:id=good", None),
        case(
            "clear-invalid-earlier-id",
            "state=clear:id=a//b:id=good",
            None,
        ),
        case("clear-invalid-text", "state=clear:msg=a", None),
        case(
            "clear-invalid-app-length",
            format!("state=clear:app={}", "a".repeat(33)),
            None,
        ),
        case(
            "app-empty",
            "state=working:app=",
            Some(json!({"state":"working"})),
        ),
        case(
            "app-valid-alphabet",
            "state=idle:app=A-z_0.9+",
            Some(json!({"state":"idle","app":"A-z_0.9+"})),
        ),
        case(
            "app-cap",
            format!("state=working:app={}", "a".repeat(32)),
            Some(json!({"state":"working","app":"a".repeat(32)})),
        ),
        case(
            "app-comma",
            "state=working:app=a,b",
            Some(json!({"state":"working"})),
        ),
        case(
            "app-equals",
            "state=working:app=a=b",
            Some(json!({"state":"working"})),
        ),
        case(
            "replaced-overlong-alphabet-invalid-app",
            format!("state=working:app={}@:app=ok", "a".repeat(33)),
            Some(json!({"state":"working","app":"ok"})),
        ),
        case(
            "blocked-progress",
            "state=blocked:kind=permission:progress=0",
            Some(json!({"state":"blocked","kind":"permission","progress":0})),
        ),
        case(
            "idle-progress-kind",
            "state=idle:kind=auth:progress=1",
            Some(json!({"state":"idle"})),
        ),
        case(
            "error-progress-kind",
            "state=error:kind=question:progress=1",
            Some(json!({"state":"error"})),
        ),
        case(
            "bidi-text-is-kept",
            "state=done:msg=4oCu4oCL",
            Some(json!({"state":"done","msg":"\u{202e}\u{200b}"})),
        ),
    ];
    let id128 = format!(
        "{}/{}/{}/{}",
        "a".repeat(32),
        "b".repeat(32),
        "c".repeat(32),
        "d".repeat(29)
    );
    cases.push(case(
        "id128",
        format!("state=done:id={id128}"),
        Some(json!({"state":"done","id":id128})),
    ));
    cases.push(case("id129", format!("state=done:id={id128}e"), None));
    for (name, value) in [
        ("empty", ""),
        ("empty-segment", "a//b"),
        ("comma", "a,b"),
        ("equals", "a=b"),
    ] {
        cases.push(case(
            &format!("invalid-id-{name}"),
            format!("state=working:id={value}"),
            None,
        ));
    }
    for field in ["title", "msg"] {
        for (name, encoded) in [
            ("base64", "a"),
            ("padding", "QQ="),
            ("utf8", "/w=="),
            ("c0", "AA=="),
            ("del", "fw=="),
            ("c1", "woA="),
        ] {
            cases.push(case(
                &format!("{field}-{name}"),
                format!("state=done:{field}={encoded}"),
                None,
            ));
            cases.push(case(
                &format!("{field}-{name}-replaced"),
                format!("state=done:{field}={encoded}:{field}=QQ=="),
                Some(json!({"state":"done",(field):"A"})),
            ));
        }
        let (cap, repeats) = if field == "title" {
            (256, 64)
        } else {
            (2732, 683)
        };
        let over = format!("{}A", "QUFB".repeat(repeats));
        assert_eq!(over.len(), cap + 1);
        cases.push(case(
            &format!("{field}-encoded-plus-one"),
            format!("state=done:{field}={over}"),
            None,
        ));
        cases.push(case(
            &format!("{field}-encoded-plus-one-replaced"),
            format!("state=done:{field}={over}:{field}=QQ=="),
            None,
        ));
        cases.push(case(
            &format!("clear-{field}-encoded-plus-one"),
            format!("state=clear:{field}={over}"),
            None,
        ));
    }
    cases.push(case(
        "title-decoded-193",
        format!("state=done:title={}QQ==", "QUFB".repeat(64)),
        None,
    ));
    cases.push(case(
        "msg-decoded-2049",
        format!("state=done:msg={}", "QUFB".repeat(683)),
        None,
    ));
    cases.push(case(
        "msg-decoded-over-replaced",
        format!("state=done:msg={}:msg=QQ==", "QUFB".repeat(683)),
        Some(json!({"state":"done","msg":"A"})),
    ));
    cases.push(case(
        "msg-encoded-2732-decoded-2048",
        format!("state=done:msg={}QUE=", "QUFB".repeat(682)),
        Some(json!({"state":"done","msg":"A".repeat(2048)})),
    ));
    cases
}

#[test]
fn status_reference_parser_inputs() {
    let rig = Rig::new();
    for case in reference_cases() {
        for end in [b"\x07".as_slice(), b"\x1b\\".as_slice()] {
            assert_case(&rig, &case, end, None, false);
        }
    }
}

#[test]
fn status_boundary_conformance_and_atomic_discards() {
    let rig = Rig::new();
    for case in boundary_cases() {
        for end in [b"\x07".as_slice(), b"\x1b\\".as_slice()] {
            assert_case(&rig, &case, end, None, false);
        }
    }
}

#[test]
fn status_all_tables_at_every_split_and_bytewise() {
    let rig = Rig::new();
    for case in spec_cases()
        .into_iter()
        .chain(reference_cases())
        .chain(boundary_cases())
    {
        for end in [b"\x07".as_slice(), b"\x1b\\".as_slice()] {
            assert_case(&rig, &case, end, None, true);
            let len = sequence(&case.identifier, &case.body, end).len();
            for split in 0..=len {
                assert_case(&rig, &case, end, Some(split), false);
            }
        }
    }
}

#[test]
fn status_framer_strings_cancellation_reset_and_recovery() {
    let rig = Rig::new();
    let mut cases: Vec<(String, Vec<u8>, Option<ProgramState>)> = Vec::new();
    for prefix in [b'P', b'X', b'^', b'_'] {
        cases.push((
            format!("string-{prefix}"),
            [
                [0x1b, prefix].as_slice(),
                b"7501;state=done\x077501;state=error\x1b\\",
            ]
            .concat(),
            Some(ProgramState::Idle),
        ));
        cases.push((
            format!("string-escape-{prefix}"),
            [
                [0x1b, prefix].as_slice(),
                b"ignored\x1b]7501;state=done\x07",
            ]
            .concat(),
            Some(ProgramState::Done),
        ));
    }
    for cancel in [0x18, 0x1a] {
        cases.push((
            format!("cancel-before-later-pair-{cancel}"),
            [
                b"\x1b]7501;state=error:ignored=x".as_slice(),
                &[cancel],
                b":state=done\x07",
            ]
            .concat(),
            Some(ProgramState::Idle),
        ));

        cases.push((
            format!("cancel-{cancel}"),
            [b"\x1b]7501;state=error".as_slice(), &[cancel], b"\x07"].concat(),
            Some(ProgramState::Idle),
        ));
        cases.push((
            format!("cancel-recover-{cancel}"),
            [
                b"\x1b]7501;state=error".as_slice(),
                &[cancel],
                b"\x1b]7501;state=done\x07",
            ]
            .concat(),
            Some(ProgramState::Done),
        ));
    }
    for (name, bytes, state) in [
        (
            "escape-final",
            b"\x1b]7501;state=done\x1b7".as_slice(),
            Some(ProgramState::Done),
        ),
        (
            "escape-start-osc",
            b"\x1b]7501;state=working\x1b]7501;state=done\x07",
            Some(ProgramState::Done),
        ),
        ("escape-ris", b"\x1b]7501;state=done\x1bc", None),
        ("csi-escape-ris", b"\x1b[12;\x1bc", None),
        ("string-escape-ris", b"\x1bPfoo\x1bc", None),
        ("intermediate-escape-ris", b"\x1b(\x1bc", None),
        ("intermediate-not-ris", b"\x1b(c", Some(ProgramState::Idle)),
        ("soft-reset", b"\x1b[!p", Some(ProgramState::Idle)),
        (
            "screens",
            b"\x1b[?1049h\x1b[?1049l",
            Some(ProgramState::Idle),
        ),
        (
            "other-osc",
            b"\x1b]2;7501;state=done\x07",
            Some(ProgramState::Idle),
        ),
        (
            "number-prefix",
            b"\x1b]75010;state=done\x07",
            Some(ProgramState::Idle),
        ),
        (
            "number-leading-zero",
            b"\x1b]07501;state=done\x07",
            Some(ProgramState::Idle),
        ),
        (
            "number-incomplete",
            b"\x1b]7501\x07",
            Some(ProgramState::Idle),
        ),
        ("query", b"\x1b]7501;?\x07", Some(ProgramState::Idle)),
        ("prompt-clears-idle", b"\x1b]133;A\x07", None),
    ] {
        cases.push((name.into(), bytes.to_vec(), state));
    }
    cases.push((
        "overflow-recover".into(),
        [
            b"\x1b]7501;state=error:".as_slice(),
            vec![b'x'; 4088].as_slice(),
            b"\x1b]7501;state=done\x07",
        ]
        .concat(),
        Some(ProgramState::Done),
    ));
    for (name, bytes, state) in cases {
        for split in 0..=bytes.len() {
            rig.feed(b"\x1bc");
            rig.report("state=idle");
            let before = rig.snapshot();
            rig.feed(&bytes[..split]);
            rig.feed(&bytes[split..]);
            let after = rig.snapshot();
            assert_eq!(
                after.records.first().map(|v| v.state),
                state,
                "{name} split={split}"
            );
            assert_eq!(after.records.len(), usize::from(state.is_some()), "{name}");
            if name == "escape-ris" {
                assert_eq!(
                    after.revision,
                    before.revision + 2,
                    "ESC applies the report before RIS"
                );
            }
            if state == Some(ProgramState::Idle) {
                assert_eq!(
                    before, after,
                    "ignored input mutates neither order nor revision: {name}"
                );
            }
        }
    }
}

#[test]
fn status_publication_never_regresses_after_a_delayed_writer() {
    let rig = Rig::new();
    let session_id = rig.session.id.clone();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    arm_attach_seam(&session_id, AttachSeam::OutputAfterRingLock, move || {
        entered_tx.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    std::thread::scope(|scope| {
        let first = scope.spawn(|| rig.report("state=working"));
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        rig.report("state=done");
        let newest = rig.snapshot();
        release_tx.send(()).unwrap();
        first.join().unwrap();
        assert_eq!(newest.records[0].state, ProgramState::Done);
        assert_eq!(newest.revision, 2);
        assert_eq!(
            rig.snapshot(),
            newest,
            "delayed first writer cannot publish stale state"
        );
    });
}

fn seed(rig: &Rig, expected: Option<&Value>) -> ProgramStatusSnapshot {
    rig.feed(b"\x1bc");
    rig.report("state=blocked:kind=auth:app=seed:progress=9:msg=U2VlZA==");
    rig.report("state=error:id=sentinel:title=S2VlcA==");
    if let Some(value) = expected.filter(|v| v["state"] == "clear") {
        if let Some(id) = value["id"].as_str() {
            rig.report(&format!("state=working:id={id}"));
            rig.report(&format!("state=idle:id={id}/nested"));
        }
    }
    let before = rig.snapshot();
    assert!(
        before.records.len() >= 2,
        "seed reports must reach the stored set"
    );
    assert_eq!(before.records[0].msg.as_deref(), Some("Seed"), "seed root");
    assert_eq!(
        before.records[1].title.as_deref(),
        Some("Keep"),
        "seed child"
    );
    before
}

fn expected_after(
    before: &ProgramStatusSnapshot,
    expected: Option<&Value>,
) -> ProgramStatusSnapshot {
    let Some(value) = expected else {
        return before.clone();
    };
    let mut after = before.clone();
    after.revision += 1;
    if value["state"] == "clear" {
        if value["id"].is_string() {
            after.records.truncate(2);
        } else {
            after.records.clear();
        }
    } else {
        let order = before.records.last().unwrap().update_order + 1;
        let new = record(value, order);
        after.records.retain(|row| row.id != new.id);
        after.records.push(new);
    }
    after
}

fn assert_case(rig: &Rig, case: &Case, end: &[u8], split: Option<usize>, bytewise: bool) {
    let before = seed(rig, case.expected.as_ref());
    let expected = expected_after(&before, case.expected.as_ref());
    let bytes = sequence(&case.identifier, &case.body, end);
    if bytewise {
        for byte in &bytes {
            rig.feed(std::slice::from_ref(byte));
        }
    } else if let Some(split) = split {
        rig.feed(&bytes[..split]);
        rig.feed(&bytes[split..]);
    } else {
        rig.feed(&bytes);
    }
    assert_eq!(
        rig.snapshot(),
        expected,
        "case={} end={end:?} split={split:?} bytewise={bytewise}",
        case.name
    );
}

#[test]
fn status_specification_examples() {
    let rig = Rig::new();
    for case in spec_cases() {
        for end in [b"\x07".as_slice(), b"\x1b\\".as_slice()] {
            assert_case(&rig, &case, end, None, false);
        }
    }
}

#[test]
fn status_replaces_whole_record_and_clears_segment_subtrees() {
    let rig = Rig::new();
    for body in [
        "state=working:app=root",
        "state=blocked:id=a:app=own:kind=question:progress=0:title=QQ==:msg=Qg==",
        "state=working:id=a/child",
        "state=idle:id=ab",
        "state=error:id=missing/child",
    ] {
        rig.report(body);
    }
    let before = rig.snapshot();
    assert_eq!(before.records.len(), 5);
    assert_eq!(before.records[2].app, None, "own app stays absent");
    rig.report("state=done:id=a");
    let mut after = before.clone();
    after.revision = 6;
    after.records.remove(1);
    after
        .records
        .push(record(&json!({"state":"done","id":"a"}), 6));
    assert_eq!(
        rig.snapshot(),
        after,
        "whole replacement drops every omitted key"
    );
    rig.report("state=clear:id=a");
    assert_eq!(
        rig.snapshot(),
        ProgramStatusSnapshot {
            revision: 7,
            records: vec![
                before.records[0].clone(),
                before.records[3].clone(),
                before.records[4].clone()
            ],
        },
        "a subtree excludes ab and keeps orphans"
    );
    let unchanged = rig.snapshot();
    rig.report("state=clear:id=absent");
    assert_eq!(rig.snapshot(), unchanged, "no-op clear preserves revision");
    rig.report("state=clear");
    assert_eq!(
        rig.snapshot(),
        ProgramStatusSnapshot {
            revision: 8,
            records: vec![]
        }
    );
    rig.report("state=clear");
    assert_eq!(rig.snapshot().revision, 8);
}

#[test]
fn status_cap_evicts_least_recently_updated() {
    let rig = Rig::new();
    for n in 0..64 {
        rig.report(&format!("state=working:id=job{n}"));
    }
    let before = rig.snapshot();
    assert_eq!(before.records.len(), 64);
    rig.report("state=working:id=job0");
    let updated = rig.snapshot();
    assert_eq!(updated.records.len(), 64, "replacement evicts nothing");
    assert_eq!(updated.records[0].id.as_deref(), Some("job1"));
    assert_eq!(updated.records.last().unwrap().update_order, 65);
    rig.report("state=done:id=new");
    let mut expected = updated;
    expected.revision = 66;
    expected.records.remove(0);
    expected
        .records
        .push(record(&json!({"state":"done","id":"new"}), 66));
    assert_eq!(
        rig.snapshot(),
        expected,
        "new record evicts oldest update, not oldest creation"
    );
}

#[test]
fn status_publication_is_retained_coalesced_and_independent_of_output_lag() {
    let rig = Rig::new();
    let mut rx = rig.session.clone().attach(None).program_status();
    assert_eq!(rx.borrow_and_update().revision, 0);
    rig.feed(b"\x1b]7501;state=working\x07\x1b]7501;state=done\x07");
    assert_eq!(
        rig.session.output.lock().unwrap().status.publications,
        1,
        "one publication per read"
    );
    assert!(rx.has_changed().unwrap());
    assert_eq!(
        rx.borrow_and_update().as_ref(),
        &ProgramStatusSnapshot {
            revision: 2,
            records: vec![record(&json!({"state":"done"}), 2)],
        }
    );
    rig.report("state=unknown");
    assert!(!rx.has_changed().unwrap(), "reject must not publish");
    drop(rx);
    rig.report("state=error");
    let mut output = rig.session.output_tx.subscribe();
    for _ in 0..BROADCAST_CAP + 2 {
        rig.feed(b"x");
    }
    assert!(matches!(
        output.try_recv(),
        Err(broadcast::error::TryRecvError::Lagged(_))
    ));
    let rx = rig.session.clone().attach(None).program_status();
    assert_eq!(
        rx.borrow().as_ref(),
        &ProgramStatusSnapshot {
            revision: 3,
            records: vec![record(&json!({"state":"error"}), 3)],
        }
    );
}

#[test]
fn status_shared_specification_limits() {
    use crate::terminal_sessions::program_status::*;
    let fixture: Value = serde_json::from_str(SPEC).unwrap();
    assert_eq!(
        fixture["limits"],
        json!({
            "sequence":MAX_SEQUENCE_BYTES, "body":MAX_BODY_BYTES, "key":MAX_KEY_BYTES,
            "msg_encoded":MAX_MSG_ENCODED_BYTES, "msg_decoded":MAX_MSG_BYTES,
            "title_encoded":MAX_TITLE_ENCODED_BYTES, "title_decoded":MAX_TITLE_BYTES,
            "app":MAX_APP_BYTES, "id":MAX_ID_BYTES, "id_segment":MAX_ID_SEGMENT_BYTES,
            "id_depth":MAX_ID_DEPTH, "records_minimum":RECORD_CAP,
        })
    );
}

#[test]
fn status_decoded_title_helper_cap() {
    use crate::terminal_sessions::program_status::{decode_text, ReportError};
    let at = "QUFB".repeat(64);
    assert_eq!(decode_text(at.as_bytes(), 192), Ok(Some("A".repeat(192))));
    let over = format!("{at}QQ==");
    assert_eq!(
        decode_text(over.as_bytes(), 192),
        Err(ReportError::TooLong),
        "decoded title cap independent of encoded ingress cap"
    );
}

#[test]
fn status_capture_bound_applies_to_reports_and_prompt_markers() {
    use crate::terminal_sessions::program_status::Framing;
    for identifier in ["7501", "133"] {
        let rig = Rig::new();
        rig.report("state=done");
        let before = rig.snapshot();
        rig.feed(format!("\x1b]{identifier};").as_bytes());
        rig.feed(&vec![b'x'; 4087]);
        match &rig.session.output.lock().unwrap().status.framing {
            Framing::OscBody { body, .. } => assert_eq!(body.len(), 4087),
            state => panic!("capture at the limit: {state:?}"),
        }
        rig.feed(b"x");
        assert_eq!(
            rig.session.output.lock().unwrap().status.framing,
            Framing::OscDiscard,
            "overflow drops capture immediately"
        );
        rig.feed(b"\x07");
        assert_eq!(rig.snapshot(), before);
        rig.report("state=error");
        assert_eq!(rig.snapshot().records[0].state, ProgramState::Error);
    }
}

#[test]
fn status_framing_serialization_continues_unfinished_sequences() {
    use crate::terminal_sessions::program_status::Framing;
    let cases: &[(&str, &[u8], &[u8], ProgramState)] = &[
        (
            "ground",
            b"",
            b"\x1b]7501;state=done\x07",
            ProgramState::Done,
        ),
        (
            "escape",
            b"\x1b",
            b"]7501;state=done\x07",
            ProgramState::Done,
        ),
        (
            "escape_intermediate",
            b"\x1b(",
            b"B\x1b]7501;state=done\x07",
            ProgramState::Done,
        ),
        (
            "csi",
            b"\x1b[31;",
            b"1m\x1b]7501;state=done\x07",
            ProgramState::Done,
        ),
        (
            "osc_identifier",
            b"\x1b]75",
            b"01;state=done\x07",
            ProgramState::Done,
        ),
        (
            "osc_body",
            b"\x1b]7501;state=work",
            b"ing\x07",
            ProgramState::Working,
        ),
        (
            "osc_discard",
            b"\x1b]75010;",
            b"state=error\x07\x1b]7501;state=done\x07",
            ProgramState::Done,
        ),
        (
            "string",
            b"\x1bPignored",
            b"\x1b]7501;state=done\x07",
            ProgramState::Done,
        ),
    ];
    for &(state, prefix, suffix, expected) in cases {
        let rig = Rig::new();
        rig.feed(prefix);
        let stored = {
            let output = rig.session.output.lock().unwrap();
            serde_json::to_value(&output.status.framing).unwrap()
        };
        assert_eq!(stored["state"], state);
        let restored: Framing = serde_json::from_value(stored).unwrap();
        rig.session.output.lock().unwrap().status.framing = restored;
        rig.feed(suffix);
        assert_eq!(
            rig.snapshot(),
            ProgramStatusSnapshot {
                revision: 1,
                records: vec![record(&json!({"state":expected}), 1)]
            },
            "{state}"
        );
    }
    let rig = Rig::new();
    rig.feed(b"\x1b]7501;state=done\x1b");
    assert_eq!(rig.snapshot().revision, 1);
    let stored = serde_json::to_value(&rig.session.output.lock().unwrap().status.framing).unwrap();
    assert_eq!(
        stored,
        json!({"state":"escape"}),
        "the report is already applied at ESC"
    );
    rig.session.output.lock().unwrap().status.framing = serde_json::from_value(stored).unwrap();
    rig.feed(b"c");
    assert_eq!(
        rig.snapshot(),
        ProgramStatusSnapshot {
            revision: 2,
            records: vec![]
        },
        "RIS runs after the terminated report without reapplying it"
    );
}

#[test]
fn status_snapshot_wire_nulls_and_tags() {
    let rig = Rig::new();
    rig.report("state=done");
    assert_eq!(
        serde_json::to_value(rig.snapshot()).unwrap(),
        json!({
            "revision":1,
            "records":[{
                "source":"program", "id":null, "state":"done", "kind":null,
                "progress":null, "app":null, "title":null, "msg":null,
                "seen":false, "update_order":1
            }]
        })
    );
}

#[test]
fn status_differential_visible_count_and_ring_bytes() {
    let corpus = [
        b"hello world\r\n".to_vec(),
        b"\x1b[31mcolour\x1b[0m\x1b]2;title\x07\x1bPpayload\x1b\\".to_vec(),
        b"\x1b]7501;state=working\x07\x1b]7501;state=done\x1b\\".to_vec(),
        [
            b"\x1b]7501;".as_slice(),
            vec![b'x'; 4200].as_slice(),
            b"\x07tail",
        ]
        .concat(),
        b"\x1b]7501;state=working\x18printed\x1b]7501;state=done\x1bc".to_vec(),
    ]
    .concat();
    for chunk_size in [1, 2, 3, 7, 4096, corpus.len()] {
        let rig = Rig::new();
        let mut old = VisibleScan::default();
        let mut count = 0;
        for chunk in corpus.chunks(chunk_size) {
            count += old.count(chunk);
            rig.feed(chunk);
            assert_eq!(
                rig.session.bytes_since_focus(),
                count,
                "chunk size {chunk_size}"
            );
        }
        assert!(count > 0, "positive visible control");
        assert_eq!(rig.session.scrollback(), corpus);
    }
}

#[test]
fn status_query_replies_once_per_query_without_a_client_or_with_one() {
    for attached in [false, true] {
        for end in [b"\x07".as_slice(), b"\x1b\\", b"\x1b7"] {
            let bytes = sequence("7501", "?", end);
            for split in 0..=bytes.len() {
                let rig = Rig::new();
                let _client = attached.then(|| rig.session.clone().attach(None));
                rig.feed(&bytes[..split]);
                rig.feed(&bytes[split..]);
                assert!(rig.commands.lock().unwrap().try_recv().is_ok(), "one query must enqueue one reply: attached={attached} end={end:?} split={split}");
                assert!(
                    rig.commands.lock().unwrap().try_recv().is_err(),
                    "no extra reply"
                );
                assert_eq!(rig.snapshot(), ProgramStatusSnapshot::default());
                assert_eq!(rig.session.scrollback(), bytes);
            }
        }
    }
}

#[test]
fn status_two_queries_enqueue_two_answers_before_client_input() {
    let rig = Rig::new();
    let mut client = rig.session.clone().attach(None);
    rig.feed(b"\x1b]7501;?\x07\x1b]7501;?\x1b\\\x1b[c");
    assert!(matches!(client.rx.try_recv(), Ok(SessionEvent::Output(_))));
    client.send_input(b"\x1b[?1;2c");
    assert!(
        matches!(
            rig.commands.lock().unwrap().try_recv(),
            Ok(PtyCommand::ProgramStatusReply(_))
        ),
        "first query reply"
    );
    assert!(
        matches!(
            rig.commands.lock().unwrap().try_recv(),
            Ok(PtyCommand::ProgramStatusReply(_))
        ),
        "second query reply precedes client input"
    );
    let third = rig.commands.lock().unwrap().try_recv();
    assert!(
        matches!(&third, Ok(PtyCommand::Input(bytes)) if bytes == b"\x1b[?1;2c"),
        "client answer follows exactly two query replies"
    );
    assert!(rig.commands.lock().unwrap().try_recv().is_err());
}

#[test]
fn status_query_enqueues_before_ring_push_and_broadcast() {
    let rig = Rig::new();
    let mut client = rig.session.clone().attach(None);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        &rig.session.id,
        AttachSeam::OutputBeforeRingPush,
        move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        },
    );
    let (reply, output) = std::thread::scope(|scope| {
        let reader = scope.spawn(|| rig.feed(b"\x1b]7501;?\x07\x1b[c"));
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let reply = rig.commands.lock().unwrap().try_recv();
        let output = client.rx.try_recv();
        release_tx.send(()).unwrap();
        reader.join().unwrap();
        (reply, output)
    });
    assert!(
        matches!(reply, Ok(PtyCommand::ProgramStatusReply(_))),
        "reply must be on the input channel before the read reaches the ring"
    );
    assert!(
        matches!(output, Err(broadcast::error::TryRecvError::Empty)),
        "nothing has reached the client at query admission"
    );
    assert!(matches!(client.rx.try_recv(), Ok(SessionEvent::Output(_))));
}

#[test]
fn status_focused_completion_arrives_seen_and_blur_never_unsees() {
    let rig = Rig::new();
    let client = rig.session.clone().attach(None);
    let epoch = client.set_focused(true).unwrap();
    for state in ["idle", "working", "blocked", "done", "error"] {
        rig.report(&format!("state={state}:id={state}"));
    }
    let snapshot = rig.snapshot();
    assert_eq!(
        snapshot.records.iter().map(|r| r.seen).collect::<Vec<_>>(),
        [false, false, false, true, true],
        "completions arriving under a true focus word are seen"
    );
    client.set_focused(false);
    assert_eq!(rig.snapshot(), snapshot, "blur cannot unsee records");
    assert!(!client.withdraw_focus(epoch));
    assert_eq!(rig.snapshot(), snapshot);
    rig.report("state=error:id=error");
    assert!(
        !rig.snapshot().records.last().unwrap().seen,
        "replacement under false starts unseen"
    );
    let next_epoch = client.set_focused(true).unwrap();
    let seen = rig.snapshot();
    assert!(client.withdraw_focus(next_epoch));
    assert_eq!(rig.snapshot(), seen, "withdrawal cannot unsee");
    rig.report("state=done:id=after-withdrawal");
    assert!(!rig.snapshot().records.last().unwrap().seen);
}

#[test]
fn status_focus_marks_all_completions_once_without_reordering() {
    let rig = Rig::new();
    let client = rig.session.clone().attach(None);
    for body in ["state=done:id=a", "state=working:id=b", "state=error:id=c"] {
        rig.report(body);
    }
    let before = rig.snapshot();
    let mut receiver = client.program_status();
    receiver.borrow_and_update();
    client.set_focused(false);
    assert_eq!(
        rig.snapshot(),
        before,
        "false word preserves unseen records"
    );
    client.set_focused(true);
    let mut expected = before;
    expected.revision += 1;
    expected.records[0].seen = true;
    expected.records[2].seen = true;
    assert_eq!(
        rig.snapshot(),
        expected,
        "seen-only change advances revision without reordering"
    );
    assert!(receiver.has_changed().unwrap());
    assert_eq!(receiver.borrow_and_update().as_ref(), &expected);
    client.set_focused(true);
    assert!(
        !receiver.has_changed().unwrap(),
        "already seen is not a status update"
    );
}

#[test]
fn status_prompt_drops_only_transient_program_records() {
    for body in ["A", "A;", "A;key=value", "B", "AA", "Aother", " A"] {
        for end in [b"\x07".as_slice(), b"\x1b\\"] {
            let rig = Rig::new();
            for state in ["idle", "working", "blocked", "done", "error"] {
                rig.report(&format!("state={state}:id={state}"));
            }
            let before = rig.snapshot();
            let mut expected = before.clone();
            if body == "A" || body.starts_with("A;") {
                expected.revision += 1;
                expected.records.drain(..3);
            }
            let bytes = sequence("133", body, end);
            for byte in &bytes {
                rig.feed(std::slice::from_ref(byte));
            }
            assert_eq!(
                rig.snapshot(),
                expected,
                "prompt cleanup for {body:?} {end:?}"
            );
            rig.feed(&bytes);
            assert_eq!(
                rig.snapshot(),
                expected,
                "a no-op prompt preserves revision"
            );
        }
    }
}

#[test]
fn status_soft_reset_screens_and_clock_preserve_all_records() {
    let rig = Rig::new();
    let _client = rig.session.clone().attach(None);
    for state in ["idle", "working", "blocked", "done", "error"] {
        rig.report(&format!("state={state}:id={state}"));
    }
    let before = rig.snapshot();
    for bytes in [
        b"\x1b[!p".as_slice(),
        b"\x1b[?1049h",
        b"\x1b[?1049l",
        b"\x1b[?47h",
        b"\x1b[?47l",
    ] {
        rig.feed(bytes);
        assert_eq!(rig.snapshot(), before, "non-clearing sequence {bytes:?}");
    }
    let start = now_unix_millis();
    for elapsed in [1_000, 60_000, 86_400_000, 31_536_000_000i64] {
        rig.registry.drain_writes_at(start + elapsed);
        assert_eq!(rig.registry.prune_idle_at((start + elapsed) / 1000), 0);
        assert_eq!(rig.snapshot(), before, "clock-only advance {elapsed}ms");
    }
}

#[test]
fn status_restart_replaces_records_and_partial_framing() {
    let rig = Rig::new();
    let client = rig.session.clone().attach(None);
    rig.report("state=working");
    rig.report("state=done:id=old");
    rig.feed(b"\x1b]7501;state=error:id=partial");
    assert_eq!(client.program_status().borrow().records.len(), 2);
    assert!(rig
        .registry
        .restart(&rig.session.id, RestartOverrides::default())
        .unwrap());
    let replacement = rig.registry.attach(&rig.session.id, None).unwrap();
    let value = replacement.program_status();
    assert_eq!(
        value.borrow().as_ref(),
        &ProgramStatusSnapshot::default(),
        "restart must expose an empty new incarnation"
    );
    assert!(rig.registry.inject_output(&rig.session.id, b"\x07"));
    assert_eq!(
        value.borrow().as_ref(),
        &ProgramStatusSnapshot::default(),
        "old partial report must not cross restart"
    );
    assert_eq!(
        client.program_status().borrow().records.len(),
        2,
        "old attached handle is distinct"
    );
    rig.registry.close_all(CloseReason::Shutdown);
}

fn take_status_reply(rig: &Rig) -> program_status_query::Reply {
    match rig.commands.lock().unwrap().try_recv() {
        Ok(PtyCommand::ProgramStatusReply(reply)) => reply,
        _ => panic!("expected a query reply on the session input channel"),
    }
}

#[test]
fn status_query_exact_bytes_and_terminators() {
    for attached in [false, true] {
        for (query, answer) in [
            (b"\x1b]7501;?\x07".as_slice(), b"\x1b]7501;?\x07".as_slice()),
            (b"\x1b]7501;?\x1b\\", b"\x1b]7501;?\x1b\\"),
            (b"\x1b]7501;?\x1b7", b"\x1b]7501;?\x1b\\"),
        ] {
            let rig = Rig::new();
            let _client = attached.then(|| rig.session.clone().attach(None));
            rig.report("state=error:msg=c2VjcmV0:id=secret");
            rig.feed(query);
            let mut written = Vec::new();
            let mut writer = program_status_query::ReplyWriter::default();
            rig.session
                .write_status_reply(take_status_reply(&rig), &mut writer, &mut written, |_| {
                    false
                })
                .unwrap();
            assert_eq!(written, answer, "fixed reply contains nothing from records");
            assert!(rig.commands.lock().unwrap().try_recv().is_err());
        }
    }
}

#[test]
fn status_query_rate_cap_uses_a_rolling_second() {
    let rig = Rig::new();
    let mut writer = program_status_query::ReplyWriter::default();
    let mut bytes = Vec::new();
    let start = std::time::Instant::now();
    for index in 0..9 {
        rig.feed(b"\x1b]7501;?\x07");
        writer
            .write(take_status_reply(&rig), &mut bytes, false, || {
                start + Duration::from_millis(index * 10)
            })
            .unwrap();
    }
    assert_eq!(
        bytes,
        b"\x1b]7501;?\x07".repeat(8),
        "ninth reply in a second is dropped"
    );
    for (millis, replies) in [(999, 8), (1000, 9), (1001, 9), (1010, 10)] {
        rig.feed(b"\x1b]7501;?\x07");
        writer
            .write(take_status_reply(&rig), &mut bytes, false, || {
                start + Duration::from_millis(millis)
            })
            .unwrap();
        assert_eq!(bytes.len(), 9 * replies, "rolling boundary at {millis}ms");
    }
}

#[test]
fn status_query_rate_counts_completion_after_a_blocked_write() {
    struct AdvancesClock<'a> {
        time: &'a std::cell::Cell<std::time::Instant>,
    }
    impl Write for AdvancesClock<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.time.set(self.time.get() + Duration::from_secs(10));
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let rig = Rig::new();
    let mut writer = program_status_query::ReplyWriter::default();
    let time = std::cell::Cell::new(std::time::Instant::now());
    rig.feed(b"\x1b]7501;?\x07");
    writer
        .write(
            take_status_reply(&rig),
            &mut AdvancesClock { time: &time },
            false,
            || time.get(),
        )
        .unwrap();
    let mut bytes = Vec::new();
    for _ in 0..8 {
        rig.feed(b"\x1b]7501;?\x07");
        writer
            .write(take_status_reply(&rig), &mut bytes, false, || time.get())
            .unwrap();
    }
    assert_eq!(
        bytes.len(),
        9 * 7,
        "completed blocked reply consumes this second's first slot"
    );
}

#[test]
fn status_query_pending_cap_includes_a_controller_held_reply() {
    let rig = Rig::new();
    rig.feed(b"\x1b]7501;?\x07");
    let held = take_status_reply(&rig);
    rig.feed(&b"\x1b]7501;?\x07".repeat(10_000));
    let queued: Vec<_> = rig.commands.lock().unwrap().try_iter().collect();
    assert_eq!(
        queued.len(),
        7,
        "one held plus queued replies cannot exceed eight"
    );
    rig.feed(b"\x1b]7501;?\x07");
    assert!(
        rig.commands.lock().unwrap().try_recv().is_err(),
        "full pending set drops queries"
    );
    drop(held);
    rig.feed(b"\x1b]7501;?\x07");
    drop(take_status_reply(&rig));
    drop(queued);
    rig.feed(&b"\x1b]7501;?\x07".repeat(9));
    assert_eq!(
        rig.commands.lock().unwrap().try_iter().count(),
        8,
        "dropping commands releases every slot"
    );
}

#[test]
fn status_query_suppression_and_write_failure_release_pending_slots() {
    struct Refuses;
    impl Write for Refuses {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("constructed writer failure"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            panic!("failed write cannot flush")
        }
    }
    let rig = Rig::new();
    let mut writer = program_status_query::ReplyWriter::default();
    let mut bytes = Vec::new();
    for _ in 0..16 {
        rig.feed(b"\x1b]7501;?\x07");
        writer
            .write(
                take_status_reply(&rig),
                &mut bytes,
                true,
                std::time::Instant::now,
            )
            .unwrap();
        rig.feed(b"\x1b]7501;?\x07");
        assert!(writer
            .write(
                take_status_reply(&rig),
                &mut Refuses,
                false,
                std::time::Instant::now
            )
            .is_err());
    }
    assert!(bytes.is_empty(), "echo suppression writes no bytes");
    rig.feed(b"\x1b]7501;?\x07");
    writer
        .write(
            take_status_reply(&rig),
            &mut bytes,
            false,
            std::time::Instant::now,
        )
        .unwrap();
    assert_eq!(
        bytes, b"\x1b]7501;?\x07",
        "suppression and failures do not consume the rate allowance"
    );
}

#[test]
fn status_focus_and_reports_follow_output_lock_admission() {
    for pause_report in [true, false] {
        let rig = Rig::new();
        let seam = if pause_report {
            AttachSeam::OutputBeforeRingLock
        } else {
            AttachSeam::FocusBeforeRingLock
        };
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        arm_attach_seam(&rig.session.id, seam, move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        std::thread::scope(|scope| {
            let paused = scope.spawn(|| {
                if pause_report {
                    rig.report("state=done")
                } else {
                    rig.session.set_focused(true);
                }
            });
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            if pause_report {
                rig.session.set_focused(true);
            } else {
                rig.report("state=done");
            }
            release_tx.send(()).unwrap();
            paused.join().unwrap();
        });
        let snapshot = rig.snapshot();
        assert!(
            snapshot.records[0].seen,
            "completion is seen in either admission order"
        );
        assert_eq!(
            snapshot.revision,
            if pause_report { 1 } else { 2 },
            "arrival seen versus later seen publication"
        );
        assert_eq!(snapshot.records[0].update_order, 1);
    }
}

#[cfg(target_os = "linux")]
fn raw_query_pty() -> (portable_pty::PtyPair, std::fs::File) {
    let pair = native_pty_system().openpty(test_size()).unwrap();
    let slave = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(pair.master.tty_name().unwrap())
        .unwrap();
    let mut termios = rustix::termios::tcgetattr(&slave).unwrap();
    termios.make_raw();
    rustix::termios::tcsetattr(&slave, rustix::termios::OptionalActions::Now, &termios).unwrap();
    (pair, slave)
}

#[cfg(target_os = "linux")]
fn readable(fd: &impl AsRawFd, wait: Duration) -> bool {
    let mut poll = [filedescriptor::pollfd {
        fd: fd.as_raw_fd(),
        events: filedescriptor::POLLIN,
        revents: 0,
    }];
    filedescriptor::poll(&mut poll, Some(wait)).unwrap() != 0
}

#[cfg(target_os = "linux")]
#[test]
fn status_query_checks_real_termios_at_write_after_admission() {
    use rustix::termios::{LocalModes, OptionalActions};
    struct CountedWriter<'a> {
        inner: &'a mut dyn Write,
        bytes: usize,
    }
    impl Write for CountedWriter<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let written = self.inner.write(bytes)?;
            self.bytes += written;
            Ok(written)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.inner.flush()
        }
    }
    for (echo, echoctl, change_after_read) in [
        (false, false, false),
        (true, true, false),
        (true, false, false),
        (true, false, true),
    ] {
        let rig = Rig::new();
        let (pair, mut slave) = raw_query_pty();
        let master_fd = clone_master_fd(pair.master.as_raw_fd().unwrap()).unwrap();
        let mut flags = rustix::termios::tcgetattr(&slave).unwrap();
        flags.local_modes.set(LocalModes::ECHO, echo);
        flags.local_modes.set(LocalModes::ECHOCTL, echoctl);
        if change_after_read {
            let slave = slave.try_clone().unwrap();
            arm_attach_seam(&rig.session.id, AttachSeam::QueryBeforeWrite, move || {
                rustix::termios::tcsetattr(&slave, OptionalActions::Now, &flags).unwrap();
            });
        } else {
            rustix::termios::tcsetattr(&slave, OptionalActions::Now, &flags).unwrap();
        }
        rig.feed(b"\x1b]7501;?\x07");
        let mut pty_writer = pair.master.take_writer().unwrap();
        let mut counted = CountedWriter {
            inner: pty_writer.as_mut(),
            bytes: 0,
        };
        rig.session
            .write_status_reply(
                take_status_reply(&rig),
                &mut program_status_query::ReplyWriter::default(),
                &mut counted,
                |_| {
                    let fresh = program_status_query::master_echoes_query(pair.master.as_ref());
                    assert_eq!(
                        fresh,
                        program_status_query::fd_echoes_query(&master_fd),
                        "fresh and imported masters read the same flags"
                    );
                    fresh
                },
            )
            .unwrap();
        if echo && !echoctl {
            assert_eq!(
                counted.bytes, 0,
                "echoing query must be suppressed at write time, changed={change_after_read}"
            );
            assert_eq!(
                rustix::io::ioctl_fionread(&slave).unwrap(),
                0,
                "no reply at slave"
            );
            assert_eq!(
                rustix::io::ioctl_fionread(&master_fd).unwrap(),
                0,
                "no further echoed output"
            );
            slave.write_all(b"positive-control").unwrap();
            assert!(
                readable(&master_fd, Duration::from_secs(5)),
                "readiness positive control"
            );
            assert!(
                rustix::io::ioctl_fionread(&master_fd).unwrap() > 0,
                "zero-byte reader positive control"
            );
        } else {
            assert_eq!(counted.bytes, 9);
            assert!(readable(&slave, Duration::from_secs(5)));
            let mut answer = [0; 9];
            slave.read_exact(&mut answer).unwrap();
            assert_eq!(&answer, b"\x1b]7501;?\x07");
        }
    }
    let file = tempfile::tempfile().unwrap();
    assert!(
        !program_status_query::fd_echoes_query(&file),
        "unreadable discipline leaves only the caps"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn status_query_fresh_controller_writes_both_terminators() {
    let registry = Registry::new(test_config(65536, 4, 60));
    let mut opts = opts_with_window("query-controller");
    opts.command = Some(r#"stty raw -echo; printf '\033]7501;?\007\033]7501;?\033\'; dd bs=1 count=19 2>/dev/null | od -An -tx1 -v | tr -d ' \n'; printf 'QUERY_<%s>' COMPLETE; read -r hold"#.into());
    let mut client = registry.create(opts).unwrap();
    let mut bytes = client.replay.concat();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        while !contains_subslice(&bytes, b"QUERY_<COMPLETE>") {
            match client.rx.recv().await.unwrap() {
                SessionEvent::Output(chunk) => bytes.extend_from_slice(&chunk),
                SessionEvent::Error(error) => panic!("controller failed: {error}"),
                _ => {}
            }
        }
    })
    .await;
    registry.close_all(CloseReason::Shutdown);
    assert!(result.is_ok(), "fresh controller must answer both queries");
    assert!(
        contains_subslice(
            &bytes,
            b"1b5d373530313b3f071b5d373530313b3f1b5cQUERY_<COMPLETE>"
        ),
        "slave receives exact BEL and ST replies: {bytes:?}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn status_query_restored_controller_wakes_without_a_tick() {
    let (pair, mut slave) = raw_query_pty();
    let master_fd = clone_master_fd(pair.master.as_raw_fd().unwrap()).unwrap();
    let id = random_session_id();
    let meta = FdStoreSessionMeta {
        tenant_prefix: "/w".into(),
        session_id: id.clone(),
        tab_name: None,
        tab_group: None,
        spawn_name: None,
        spawn_group: None,
        window_id: None,
        pane_id: None,
        side: None,
        tab_id: None,
        cwd: None,
        command: None,
        env: BTreeMap::new(),
        profile: None,
        mcp_env: false,
        child_pid: None,
        size: test_size().into(),
        seq: 0,
        generation: 1,
        alt_screen: false,
        private_modes: Vec::new(),
    };
    let registry = Registry::new(test_config(65536, 4, 60));
    let session = Session::from_imported(
        test_config(65536, 4, 60),
        FdStoreSessionImport {
            meta,
            child_identity: RecordedChildIdentity::default(),
            master_fd,
            ring_fd: None,
            replay: Vec::new(),
            sealed_manifest: true,
        },
        Arc::new(Mutex::new(None)),
        Arc::new(ReaderWake::new()),
        || 2,
    )
    .unwrap();
    register_session(&registry, &session);
    let mut client = session.clone().attach(None);
    slave
        .write_all(b"\x1b]7501;?\x07\x1b]7501;?\x1b7\x1b[c")
        .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut output = Vec::new();
            loop {
                if let SessionEvent::Output(chunk) = client.rx.recv().await.unwrap() {
                    output.extend_from_slice(&chunk);
                }
                if output.ends_with(b"\x1b[c") {
                    break;
                }
            }
        })
        .await
        .unwrap();
    });
    client.send_input(b"\x1b[?1;2c");
    let expected = b"\x1b]7501;?\x07\x1b]7501;?\x1b\\\x1b[?1;2c";
    let mut bytes = vec![0; expected.len()];
    let mut offset = 0;
    while offset < bytes.len() {
        assert!(
            readable(&slave, Duration::from_secs(5)),
            "restored controller must serve the reply command"
        );
        offset += slave.read(&mut bytes[offset..]).unwrap();
    }
    registry.close_all(CloseReason::Shutdown);
    assert_eq!(
        bytes, expected,
        "both replies precede the client's CSI c answer at the slave"
    );
    assert_eq!(
        rustix::io::ioctl_fionread(&slave).unwrap(),
        0,
        "nothing else is written"
    );
}
