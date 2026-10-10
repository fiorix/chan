use super::*;
use serde_json::Value;

const SPEC: &str = include_str!("../../../chan-library/tests/fixtures/program-status-spec.json");

#[derive(Default)]
struct Writer {
    bytes: Vec<u8>,
    writes: usize,
    flushes: usize,
    short: bool,
    fail_write: bool,
    fail_flush: bool,
}

impl Write for Writer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.writes += 1;
        if self.fail_write {
            return Err(io::Error::other("write refused"));
        }
        let n = bytes.len() - usize::from(self.short);
        self.bytes.extend_from_slice(&bytes[..n]);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flushes += 1;
        if self.fail_flush {
            Err(io::Error::other("flush refused"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn specification_examples_emit_exact_bytes_in_one_flushed_write() {
    let spec: Value = serde_json::from_str(SPEC).unwrap();
    for example in spec["examples"].as_array().unwrap() {
        let row = &example["expected"];
        let progress = row["progress"].as_u64().map(|n| n.to_string());
        let fields = Fields {
            state: row["state"].as_str().unwrap(),
            kind: row["kind"].as_str(),
            progress: progress.as_deref(),
            app: row["app"].as_str(),
            id: row["id"].as_str(),
            title: row["title"].as_str(),
            msg: row["msg"].as_str(),
        };
        let body = build_report(&fields).unwrap();
        assert_eq!(
            body,
            example["body"].as_str().unwrap(),
            "{} body",
            example["name"]
        );
        let mut writer = Writer::default();
        write_sequence(&mut writer, &sequence(&body).unwrap()).unwrap();
        let expected = format!("\x1b]7501;{}\x1b\\", example["body"].as_str().unwrap());
        assert_eq!(
            writer.bytes,
            expected.as_bytes(),
            "{} sequence",
            example["name"]
        );
        assert_eq!(writer.writes, 1, "one write");
        assert_eq!(writer.flushes, 1, "flush completes emission");
    }
}

fn limit(key: &str) -> usize {
    serde_json::from_str::<Value>(SPEC).unwrap()["limits"][key]
        .as_u64()
        .unwrap() as usize
}

#[test]
fn emitter_limits_match_shared_specification() {
    for (key, actual) in [
        ("body", MAX_BODY),
        ("app", MAX_APP),
        ("id", MAX_ID),
        ("id_segment", MAX_SEGMENT),
        ("id_depth", MAX_DEPTH),
        ("title_decoded", MAX_TITLE),
        ("title_encoded", MAX_TITLE_ENCODED),
        ("msg_decoded", MAX_MSG),
        ("msg_encoded", MAX_MSG_ENCODED),
    ] {
        assert_eq!(actual, limit(key), "shared specification limit {key}");
    }
}

#[test]
fn shared_limits_accept_boundaries_and_refuse_without_output() {
    for field in ["app", "title", "msg", "id_segment", "id", "id_depth"] {
        let bound = match field {
            "title" => limit("title_decoded"),
            "msg" => limit("msg_decoded"),
            _ => limit(field),
        };
        for over in [false, true] {
            let n = bound + usize::from(over);
            let value = match field {
                "id" => format!(
                    "{}/{}/{}/{}",
                    "a".repeat(32),
                    "b".repeat(32),
                    "c".repeat(32),
                    "d".repeat(n - 99)
                ),
                "id_depth" => vec!["a"; n].join("/"),
                _ => "x".repeat(n),
            };
            let mut fields = Fields {
                state: "working",
                ..Fields::default()
            };
            match field {
                "app" => fields.app = Some(&value),
                "title" => fields.title = Some(&value),
                "msg" => fields.msg = Some(&value),
                _ => fields.id = Some(&value),
            }
            let mut writer = Writer::default();
            let result = build_report(&fields).and_then(|body| {
                write_sequence(&mut writer, &sequence(&body)?)?;
                Ok(())
            });
            if over {
                let error = result.expect_err(field).to_string();
                assert!(error.contains(&bound.to_string()), "{field}: {error}");
                assert!(writer.bytes.is_empty(), "{field} wrote on refusal");
                assert_eq!(
                    writer.writes, 0,
                    "{field} selected output before validation"
                );
            } else {
                result.unwrap();
                assert!(!writer.bytes.is_empty(), "{field} boundary emitted nothing");
            }
        }
    }
}

#[test]
fn body_bound_uses_the_shared_sequence_and_body_limits() {
    let body = "x".repeat(limit("body"));
    assert_eq!(sequence(&body).unwrap().len(), limit("sequence"));
    let error = sequence(&(body + "x")).unwrap_err().to_string();
    assert!(error.contains(&limit("body").to_string()), "{error}");
    let progress = "0".repeat(limit("body") - "state=working:progress=".len());
    assert_eq!(
        build_report(&Fields {
            state: "working",
            progress: Some(&progress),
            ..Fields::default()
        })
        .unwrap()
        .len(),
        limit("body")
    );
    let progress = progress + "0";
    let error = build_report(&Fields {
        state: "working",
        progress: Some(&progress),
        ..Fields::default()
    })
    .unwrap_err()
    .to_string();
    assert!(error.contains("4087"), "{error}");
}

#[test]
fn encoded_text_limits_are_independently_enforced() {
    for (field, decoded, encoded) in [
        ("title", limit("title_decoded"), limit("title_encoded")),
        ("msg", limit("msg_decoded"), limit("msg_encoded")),
    ] {
        let text = "x".repeat(decoded);
        assert!(encode_text(Some(&text), field, usize::MAX, encoded).is_ok());
        let text = "x".repeat(decoded + 3);
        let error = encode_text(Some(&text), field, usize::MAX, encoded)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!("{encoded}-byte encoded")),
            "{error}"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_routes_select_console_redirect_or_refusal() {
    assert!(matches!(
        select_route(Some("console handle"), None).unwrap(),
        Route::Terminal("console handle")
    ));
    assert!(
        matches!(
            select_route(Some("console handle"), Some("s1".into())).unwrap(),
            Route::Terminal("console handle")
        ),
        "console wins over a control identity"
    );
    assert!(
        matches!(select_route::<()>(None, Some("s1".into())).unwrap(), Route::Control(id) if id == "s1"),
        "redirected stdout uses the session's control route"
    );
    assert!(
        select_route::<()>(None, None).is_err(),
        "no console and no session refuses"
    );
    assert!(
        select_route::<()>(None, Some(String::new())).is_err(),
        "empty session id refuses"
    );
}

#[test]
fn invalid_fields_refuse_without_reflecting_untrusted_text() {
    for field in ["state", "kind", "progress", "app", "id", "title", "msg"] {
        let bad = "SENSITIVE\u{1b}:state=done";
        let mut fields = Fields {
            state: "blocked",
            ..Fields::default()
        };
        match field {
            "state" => fields.state = bad,
            "kind" => fields.kind = Some(bad),
            "progress" => fields.progress = Some(bad),
            "app" => fields.app = Some(bad),
            "id" => fields.id = Some(bad),
            "title" => fields.title = Some(bad),
            "msg" => fields.msg = Some(bad),
            _ => unreachable!(),
        }
        let error = build_report(&fields).unwrap_err().to_string();
        assert!(error.contains(field), "{field}: {error}");
        assert!(
            !error.contains("SENSITIVE"),
            "reflected report text: {error}"
        );
    }
    for id in ["", "/a", "a/", "a//b", "a,b", "a=b"] {
        assert!(
            build_report(&Fields {
                state: "clear",
                id: Some(id),
                ..Fields::default()
            })
            .is_err(),
            "id grammar: {id:?}"
        );
    }
    for value in ["-1", "101", "1.5", "", "9999999999999999999999"] {
        assert!(
            build_report(&Fields {
                state: "working",
                progress: Some(value),
                ..Fields::default()
            })
            .is_err(),
            "progress grammar"
        );
    }
    for text in ["a\n", "\u{7f}", "\u{80}", "\u{9f}"] {
        assert!(
            build_report(&Fields {
                state: "clear",
                title: Some(text),
                ..Fields::default()
            })
            .is_err(),
            "title controls"
        );
        assert!(
            build_report(&Fields {
                state: "clear",
                msg: Some(text),
                ..Fields::default()
            })
            .is_err(),
            "msg controls"
        );
    }
}

#[test]
fn failed_short_and_unflushed_writes_are_errors_without_retry() {
    for mode in ["failed", "short", "unflushed"] {
        let mut writer = Writer {
            fail_write: mode == "failed",
            short: mode == "short",
            fail_flush: mode == "unflushed",
            ..Writer::default()
        };
        assert!(
            write_sequence(&mut writer, b"\x1b]7501;state=done\x1b\\").is_err(),
            "{mode} write succeeded"
        );
        assert_eq!(writer.writes, 1, "{mode} write retried");
        assert_eq!(writer.flushes, usize::from(mode == "unflushed"));
    }
}
