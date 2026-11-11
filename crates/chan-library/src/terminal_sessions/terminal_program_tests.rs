use super::*;

const SHELL: Foreground = Foreground::Group(10);
const JOB: Foreground = Foreground::Group(20);

struct FakeSource {
    foreground: Foreground,
    name: Option<&'static str>,
    probes: usize,
    names: usize,
}

impl FakeSource {
    fn shell() -> Self {
        Self {
            foreground: SHELL,
            name: Some("bash"),
            probes: 0,
            names: 0,
        }
    }

    fn probe(&mut self) -> Foreground {
        self.probes += 1;
        self.foreground
    }

    fn feed(&mut self, program: &mut TerminalProgram, bytes: &[u8]) {
        program.feed(bytes, || self.probe());
    }

    fn sample(&mut self, program: &mut TerminalProgram) {
        if let Some(request) = program.observe(|| self.probe()) {
            self.names += 1;
            assert!(program.apply_name(request, self.foreground, self.name));
        }
    }
}

fn assert_reading(program: &TerminalProgram, title: Option<&str>, command: Option<&str>) {
    assert_eq!(
        program.reading(),
        &ProgramReading {
            title: title.map(str::to_owned),
            command: command.map(str::to_owned),
        }
    );
}

#[test]
fn state_group_expiry_and_no_resurrection() {
    let mut program = TerminalProgram::default();
    let mut source = FakeSource::shell();
    source.sample(&mut program);
    assert_reading(&program, None, Some("bash"));
    source.feed(&mut program, b"\x1b]2;prompt\x07");
    assert_reading(&program, Some("prompt"), Some("bash"));
    source.foreground = JOB;
    source.name = Some("vim");
    source.sample(&mut program);
    assert_reading(&program, None, Some("vim"));
    source.feed(&mut program, b"\x1b]0;editing\x07");
    assert_reading(&program, Some("editing"), Some("vim"));
    source.foreground = SHELL;
    source.name = Some("bash");
    source.sample(&mut program);
    assert_reading(&program, None, Some("bash"));
    source.foreground = JOB;
    source.name = Some("vim");
    source.sample(&mut program);
    assert_reading(&program, None, Some("vim"));
}

#[test]
fn state_new_group_title_clears_previous_command() {
    let mut program = TerminalProgram::default();
    let mut source = FakeSource::shell();
    source.sample(&mut program);
    source.feed(&mut program, b"\x1b]2;prompt\x07");
    source.foreground = JOB;
    source.feed(&mut program, b"\x1b]2;job\x07");
    assert_reading(&program, Some("job"), None);
    assert_eq!(program.title_owner, Some(JOB));
    source.name = Some("vim");
    source.sample(&mut program);
    assert_reading(&program, Some("job"), Some("vim"));
}

#[test]
fn state_known_same_group_exec_expires_title_and_partial_candidate() {
    let mut program = TerminalProgram::default();
    let mut source = FakeSource::shell();
    source.sample(&mut program);
    source.feed(&mut program, b"\x1b]2;prompt\x07\x1b]2;partial");
    source.name = Some("vim");
    source.sample(&mut program);
    assert_reading(&program, None, Some("vim"));
    source.feed(&mut program, b" tail\x07");
    assert_reading(&program, None, Some("vim"));
    source.feed(&mut program, b"\x1b]2;new\x07");
    assert_reading(&program, Some("new"), Some("vim"));
}

#[test]
fn state_first_successful_name_preserves_fresh_prompt_title() {
    let mut program = TerminalProgram::default();
    let mut source = FakeSource::shell();
    source.feed(&mut program, b"\x1b]2;prompt\x07");
    assert_reading(&program, Some("prompt"), None);
    source.sample(&mut program);
    assert_reading(&program, Some("prompt"), Some("bash"));
    source.sample(&mut program);
    assert_reading(&program, Some("prompt"), Some("bash"));
}

#[test]
fn state_failed_group_read_clears_and_refuses_unattributable_titles() {
    let mut program = TerminalProgram::default();
    let mut source = FakeSource::shell();
    source.sample(&mut program);
    source.feed(&mut program, b"\x1b]2;prompt\x07");
    source.foreground = Foreground::Unavailable;
    source.sample(&mut program);
    assert_reading(&program, None, None);
    source.feed(&mut program, b"\x1b]2;unprovable\x07");
    assert_reading(&program, None, None);
    source.foreground = SHELL;
    source.sample(&mut program);
    assert_reading(&program, None, Some("bash"));
}

#[test]
fn state_failed_name_read_keeps_only_the_provable_title() {
    let mut program = TerminalProgram::default();
    let mut source = FakeSource::shell();
    source.sample(&mut program);
    source.feed(&mut program, b"\x1b]2;prompt\x07");
    source.name = None;
    source.sample(&mut program);
    assert_reading(&program, Some("prompt"), None);
    source.feed(&mut program, b"\x1b]2;fresh\x07");
    source.name = Some("bash");
    source.sample(&mut program);
    assert_reading(&program, Some("fresh"), Some("bash"));
    source.foreground = JOB;
    source.name = None;
    source.sample(&mut program);
    assert_reading(&program, None, None);
}

#[test]
fn state_partial_candidates_do_not_cross_observed_owners() {
    for terminator in ["\x07", "\x1b\\"] {
        let bytes = format!("\x1b]2;split{terminator}").into_bytes();
        for split in 1..bytes.len() {
            for explicit_sample in [false, true] {
                let mut program = TerminalProgram::default();
                let mut source = FakeSource::shell();
                source.feed(&mut program, &bytes[..split]);
                source.foreground = JOB;
                if explicit_sample {
                    program.observe(|| source.probe());
                }
                source.feed(&mut program, &bytes[split..]);
                assert_reading(&program, None, None);
                source.feed(&mut program, b"\x1b]2;new\x07");
                assert_reading(&program, Some("new"), None);
            }
        }
    }
}

#[test]
fn state_partial_candidates_survive_reads_with_the_same_owner() {
    let bytes = "\x1b]2;h\u{e9}llo\x1b\\".as_bytes();
    for split in 0..=bytes.len() {
        let mut program = TerminalProgram::default();
        let mut source = FakeSource::shell();
        source.feed(&mut program, &bytes[..split]);
        source.feed(&mut program, &bytes[split..]);
        assert_reading(&program, Some("h\u{e9}llo"), None);
    }
}

#[test]
fn state_stale_name_result_cannot_erase_new_or_duplicate_title() {
    let mut program = TerminalProgram::default();
    let mut source = FakeSource::shell();
    source.sample(&mut program);
    for _ in 0..2 {
        let request = program.observe(|| source.probe()).unwrap();
        assert_eq!(request.group(), 10);
        source.feed(&mut program, b"\x1b]2;fresh\x07");
        assert!(!program.apply_name(request, SHELL, Some("vim")));
        assert_reading(&program, Some("fresh"), Some("bash"));
    }
}

#[test]
fn state_stale_name_result_rejected_after_group_cycle_clear_and_new_sample() {
    let mut program = TerminalProgram::default();
    let old = program.observe(|| SHELL).unwrap();
    program.observe(|| JOB);
    let newer = program.observe(|| SHELL).unwrap();
    assert!(!program.apply_name(old, SHELL, Some("old")));
    assert!(program.apply_name(newer, SHELL, Some("bash")));
    assert!(!program.apply_name(newer, SHELL, Some("old")));
    let pending = program.observe(|| SHELL).unwrap();
    program.clear();
    program.observe(|| SHELL);
    assert!(!program.apply_name(pending, SHELL, Some("old")));
    assert_reading(&program, None, None);
}

#[test]
fn state_name_result_rechecks_foreground() {
    let mut program = TerminalProgram::default();
    program.feed(b"\x1b]2;prompt\x07", || SHELL);
    let request = program.observe(|| SHELL).unwrap();
    assert!(!program.apply_name(request, JOB, Some("bash")));
    assert_reading(&program, None, None);
    let request = program.observe(|| JOB).unwrap();
    assert!(!program.apply_name(request, Foreground::Unavailable, Some("vim")));
    assert_reading(&program, None, None);
}

#[test]
fn state_empty_and_ris_clear_only_title_and_exit_clears_everything() {
    let mut program = TerminalProgram::default();
    let mut source = FakeSource::shell();
    source.sample(&mut program);
    for clear in [b"\x1b]2;\x07".as_slice(), b"\x1bc"] {
        source.feed(&mut program, b"\x1b]2;prompt\x07");
        let request = program.observe(|| SHELL).unwrap();
        source.feed(&mut program, clear);
        assert_reading(&program, None, Some("bash"));
        assert_eq!(program.title_owner, None);
        assert!(!program.apply_name(request, SHELL, Some("stale")));
    }
    source.feed(&mut program, b"\x1b]2;prompt\x07\x1b]2;partial");
    program.clear();
    assert_reading(&program, None, None);
    source.feed(&mut program, b" tail\x07");
    assert_reading(&program, None, None);
}

#[test]
fn state_title_only_has_no_command_and_clears_explicitly() {
    let mut program = TerminalProgram::default();
    assert!(program.observe(|| Foreground::TitleOnly).is_none());
    program.feed(b"\x1b]2;windows\x07", || Foreground::TitleOnly);
    assert_reading(&program, Some("windows"), None);
    assert_eq!(program.title_owner, Some(Foreground::TitleOnly));
    program.feed(b"\x1bc", || Foreground::TitleOnly);
    assert_reading(&program, None, None);
    program.feed(b"\x1b]2;windows\x07", || Foreground::TitleOnly);
    program.clear();
    assert_reading(&program, None, None);
}

#[test]
fn state_title_flood_observes_at_most_once_per_read_and_never_reads_names() {
    let mut program = TerminalProgram::default();
    let mut source = FakeSource::shell();
    let mut bytes = b"\x1b]2;repeated\x07".repeat(1000);
    bytes.extend_from_slice(b"\x1b]2;last\x07");
    for chunk in 1..=10 {
        source.feed(&mut program, &bytes);
        assert_eq!(source.probes, chunk);
        assert_eq!(source.names, 0);
        assert_reading(&program, Some("last"), None);
        source.feed(&mut program, b"ordinary output");
        assert_eq!(source.probes, chunk);
    }
}

#[test]
fn state_command_uses_same_display_normalization() {
    let mut program = TerminalProgram::default();
    let request = program.observe(|| SHELL).unwrap();
    assert!(program.apply_name(request, SHELL, Some(" \x00ba\nsh\x7f \n")));
    assert_reading(&program, None, Some("bash"));
    let request = program.observe(|| SHELL).unwrap();
    assert!(program.apply_name(request, SHELL, Some(&"x".repeat(MAX_DISPLAY_CHARS + 1))));
    assert_reading(&program, None, Some(&"x".repeat(MAX_DISPLAY_CHARS)));
    let request = program.observe(|| SHELL).unwrap();
    assert!(program.apply_name(request, SHELL, Some(" \n\t")));
    assert_reading(&program, None, None);
}

#[test]
fn state_attribution_uses_only_the_admission_observation() {
    let mut program = TerminalProgram::default();
    // Bytes have no writer id; an unobserved job-to-shell transition is not inferred.
    program.feed(b"\x1b]2;already-buffered\x07", || SHELL);
    assert_eq!(program.title_owner, Some(SHELL));
    assert_reading(&program, Some("already-buffered"), None);
}

fn title(value: &str) -> Option<Update> {
    Some(Update::Title(Some(value.to_owned())))
}

#[test]
fn scanner_title_table_at_every_split() {
    for identifier in [0, 2] {
        for terminator in ["\x07", "\x1b\\"] {
            let bytes = format!("plain\x1b]{identifier};  h\u{e9}\u{1f680}llo  {terminator}tail")
                .into_bytes();
            let unchanged = bytes.clone();
            for split in 0..=bytes.len() {
                let mut scanner = Scanner::default();
                let first = scanner.feed(&bytes[..split]);
                let last = scanner.feed(&bytes[split..]);
                assert_eq!(
                    last.or(first),
                    title("h\u{e9}\u{1f680}llo"),
                    "id={identifier}, terminator={terminator:?}, split={split}"
                );
                assert_eq!(bytes, unchanged);
            }
            let mut scanner = Scanner::default();
            let mut last = None;
            for byte in &bytes {
                last = scanner.feed(std::slice::from_ref(byte)).or(last);
            }
            assert_eq!(last, title("h\u{e9}\u{1f680}llo"));
        }
    }
}

#[test]
fn scanner_bel_terminates() {
    assert_eq!(Scanner::default().feed(b"\x1b]2;build\x07"), title("build"));
}

#[test]
fn scanner_st_requires_both_bytes_across_reads() {
    let mut scanner = Scanner::default();
    assert_eq!(scanner.feed(b"\x1b]2;build\x1b"), None);
    assert_eq!(scanner.feed(b"\\"), title("build"));
}

#[test]
fn scanner_successive_empty_duplicate_and_reset() {
    let mut scanner = Scanner::default();
    assert_eq!(
        scanner.feed(b"\x1b]0;first\x07\x1b]2;last\x07"),
        title("last")
    );
    assert_eq!(scanner.feed(b"\x1b]2;last\x07"), title("last"));
    assert_eq!(
        scanner.feed(b"\x1b]2; \t\x00\x7f \x07"),
        Some(Update::Title(None))
    );
    assert_eq!(scanner.feed(b"\x1b]2;last\x07\x1bc"), Some(Update::Reset));
    assert_eq!(scanner.feed(b"\x1bc\x1b]2;next\x07"), title("next"));
}

#[test]
fn scanner_normalizes_controls_invalid_utf8_and_scalar_limit() {
    let mut scanner = Scanner::default();
    assert_eq!(
        scanner.feed(b"\x1b]2;\x00 a\t\nb\x7f\xc2\x85\xff \x07"),
        title("ab\u{fffd}")
    );
    let value = "\u{1f680}".repeat(MAX_DISPLAY_CHARS + 1);
    assert_eq!(
        scanner.feed(format!("\x1b]2;{value}\x07").as_bytes()),
        title(&"\u{1f680}".repeat(MAX_DISPLAY_CHARS))
    );
}

#[test]
fn scanner_cancelled_and_malformed_candidates_recover() {
    for bytes in [
        b"\x1b]2;bad\x18ignored\x07".as_slice(),
        b"\x1b]2;bad\x1aignored\x07",
        b"\x1b]2;bad\x1bXignored\x1b\\",
        b"\x1b]2;bad\x1b[31mignored\x07",
        b"\x1b]2bad\x07",
        b"\x1b];bad\x07",
        b"\x1b]02;bad\x07",
        b"\x1b]20;bad\x07",
        b"\x1b]2\x1b\\",
        b"\x1b(]2;bad\x07",
        b"\x1b[2;bad\x07",
    ] {
        for split in 0..=bytes.len() {
            let mut scanner = Scanner::default();
            assert_eq!(scanner.feed(&bytes[..split]), None, "{bytes:?} at {split}");
            assert_eq!(scanner.feed(&bytes[split..]), None, "{bytes:?} at {split}");
            assert_eq!(scanner.feed(b"\x1b]2;good\x07"), title("good"));
        }
    }
    let mut scanner = Scanner::default();
    assert_eq!(scanner.feed(b"\x1b]2;bad\x1b]0;good\x07"), title("good"));
    assert_eq!(scanner.feed(b"\x1b]2;bad\x1bc"), Some(Update::Reset));
}

#[test]
fn scanner_oversized_payload_is_discarded_through_terminator() {
    let mut scanner = Scanner::default();
    assert_eq!(scanner.feed(b"\x1b]2;"), None);
    assert_eq!(scanner.feed(&vec![b'x'; MAX_PAYLOAD_BYTES]), None);
    assert_eq!(scanner.body.len(), MAX_PAYLOAD_BYTES);
    assert_eq!(scanner.feed(b"x"), None);
    assert!(
        scanner.body.is_empty(),
        "oversized payload must be discarded"
    );
    assert_eq!(scanner.feed(b"\x1b]2;embedded"), None);
    assert_eq!(scanner.feed(b"\x1b"), None);
    assert_eq!(scanner.feed(b"\\"), None);
    assert_eq!(scanner.feed(b"\x1b]2;recovered\x07"), title("recovered"));
    let exact = format!("\x1b]0;{}\x07", "z".repeat(MAX_PAYLOAD_BYTES));
    assert_eq!(
        scanner.feed(exact.as_bytes()),
        title(&"z".repeat(MAX_DISPLAY_CHARS))
    );
    let large = format!(
        "\x1b]0;{}\x07\x1b]2;ok\x07",
        "x".repeat(MAX_PAYLOAD_BYTES + 1)
    );
    assert_eq!(scanner.feed(large.as_bytes()), title("ok"));
}

#[test]
fn scanner_skips_other_strings_without_buffering_or_nested_titles() {
    for opener in [
        "\x1b]52;",
        "\x1b]133;",
        "\x1b]7501;",
        "\x1bP",
        "\x1b_",
        "\x1b^",
        "\x1bX",
    ] {
        let bytes = format!("{opener}prefix\x1b]2;hidden\x1bc\x1b\\").into_bytes();
        for split in 0..=bytes.len() {
            let mut scanner = Scanner::default();
            assert_eq!(scanner.feed(&bytes[..split]), None);
            assert!(scanner.body.is_empty());
            assert_eq!(scanner.feed(&bytes[split..]), None);
            assert!(scanner.body.is_empty());
            assert_eq!(scanner.feed(b"\x1b]2;visible\x07"), title("visible"));
        }
    }
    for opener in [b'P', b'_', b'^', b'X'] {
        let mut bytes = vec![0x1b, opener];
        bytes.extend_from_slice(b"\x07\x1b]2;hidden\x07\x1b\\");
        assert_eq!(Scanner::default().feed(&bytes), None);
    }
    for abort in [0x18, 0x1a] {
        let mut scanner = Scanner::default();
        scanner.feed(b"\x1b]52;ignored");
        scanner.feed(&[abort]);
        assert_eq!(scanner.feed(b"\x1b]0;visible\x07"), title("visible"));
    }
    assert_eq!(Scanner::default().feed(b"\x9d2;not-an-osc\x07"), None);
}
