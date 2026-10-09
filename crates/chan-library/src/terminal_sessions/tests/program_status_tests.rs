use super::*;
use serde_json::{json, Value};

const SPEC: &str = include_str!("../../../tests/fixtures/program-status-spec.json");

struct Rig {
    registry: Registry,
    session: Arc<Session>,
}

impl Rig {
    fn new() -> Self {
        let registry = Registry::new(test_config(65536, 4, 0));
        let session = test_agent_session(65536, &random_session_id(), None, None, None, &[]).0;
        register_session(&registry, &session);
        Self { registry, session }
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
        (
            "prompt-reserved",
            b"\x1b]133;A\x07",
            Some(ProgramState::Idle),
        ),
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
