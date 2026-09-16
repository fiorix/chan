// Per-file counting via `tokei`.
//
// Detects language by filename, extension or bounded shebang probe,
// counts code / comments / blanks, computes complexity, and reads metadata
// (bytes, mtime). Recognized files over the read cap retain metadata
// rows with zero line counts and complexity, without a content read.
// Unrecognized, non-regular or vanished files return `None`; other I/O
// errors are returned to the caller.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use encoding_rs_io::DecodeReaderBytesBuilder;
use tokei::{Config, LanguageType};

use crate::complexity;
use crate::error::ChanReportError;
use crate::summary::{FileBucket, FileStats};

/// Classify a tokei-recognized language into the
/// source-code-shaped bucket axis. Markdown is the only special
/// case (the graph colour scheme distinguishes notes from
/// source); everything else `tokei` recognizes falls under
/// `SourceCode { language: <tokei name> }`.
///
/// Binary / Media / Other don't appear here because chan-report
/// doesn't track those file kinds; the graph indexer composes
/// chan-report's bucket with `chan_workspace::classify()` (the
/// IO-contract axis) for those.
fn classify_bucket(language: LanguageType) -> FileBucket {
    match language {
        LanguageType::Markdown => FileBucket::Markdown,
        other => FileBucket::SourceCode {
            language: other.name().to_string(),
        },
    }
}

/// Content-counting limit. Larger files retain metadata-only rows so
/// reports keep their file/byte totals without large watcher-thread reads.
const READ_CAP: u64 = 16 * 1024 * 1024;

#[cfg(test)]
thread_local! {
    static CONTENT_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn record_content_read() {
    CONTENT_READS.set(CONTENT_READS.get() + 1);
}

const FILENAME_LANGUAGES: &[(&str, LanguageType)] = &[
    ("dockerfile", LanguageType::Dockerfile),
    ("makefile", LanguageType::Makefile),
    ("rakefile", LanguageType::Rakefile),
    ("sconstruct", LanguageType::Scons),
    ("sconscript", LanguageType::Scons),
];

// Interpreter names tokei 12.1.2 recognizes after `#!/usr/bin/env`, from the
// `env` field of its languages.json. Tokei exposes its `#!` paths through
// `LanguageType::shebangs` but has no accessor for these.
const ENV_LANGUAGES: &[(&str, LanguageType)] = &[
    ("bash", LanguageType::Bash),
    ("csh", LanguageType::CShell),
    ("crystal", LanguageType::Crystal),
    ("elvish", LanguageType::Elvish),
    ("fish", LanguageType::Fish),
    ("python", LanguageType::Python),
    ("python2", LanguageType::Python),
    ("python3", LanguageType::Python),
    ("ruby", LanguageType::Ruby),
    ("sh", LanguageType::Sh),
];

// Tokei's detector only reads shebangs for extensionless paths. Mirror
// those named-file rules so oversized files need no read; dotted names
// use tokei's filename and extension rules directly.
fn language_from_path(abs: &Path) -> Option<LanguageType> {
    if abs.extension().is_some() {
        return LanguageType::from_path(abs, &Config::default());
    }
    let name = abs.file_name()?.to_str()?.to_lowercase();
    for &(filename, language) in FILENAME_LANGUAGES {
        if name == filename {
            return Some(language);
        }
    }
    None
}

pub(crate) fn count_file_impl(
    root: &Path,
    rel: &str,
) -> Result<Option<FileStats>, ChanReportError> {
    let abs = root.join(rel);

    let meta = match fs::symlink_metadata(&abs) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ChanReportError::Io(e.to_string())),
    };
    count_file_after_stat(abs, rel, meta)
}

fn count_file_after_stat(
    abs: PathBuf,
    rel: &str,
    mut meta: fs::Metadata,
) -> Result<Option<FileStats>, ChanReportError> {
    if !meta.is_file() {
        // Symlinks, sockets, devices: not interesting.
        return Ok(None);
    }
    let cfg = Config::default();
    let path_language = language_from_path(&abs);
    let language = match path_language {
        Some(language) => language,
        None => {
            if meta.len() > READ_CAP || abs.extension().is_some() {
                return Ok(None);
            }
            match shebang_language(&abs) {
                Ok(Some(language)) => language,
                Ok(None) => return Ok(None),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            }
        }
    };

    let content = if meta.len() > READ_CAP {
        None
    } else {
        match read_text(&abs) {
            Ok((content, observed)) => {
                meta = observed;
                Some(content)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
    };
    if matches!(content, Some(TextRead::Oversize)) && path_language.is_none() {
        return Ok(None);
    }

    let (code, comments, blanks, complexity_score) = match content {
        Some(TextRead::Text(content)) => {
            let stats = language.parse_from_str(&content, &cfg);
            let cx = complexity::score(language.name(), &content);
            (
                stats.code as u64,
                stats.comments as u64,
                stats.blanks as u64,
                cx,
            )
        }
        Some(TextRead::NonUtf8(bytes)) => {
            // Tokei's slice parser does not decode non-UTF-8 input, so the
            // bounded bytes are decoded in memory the way tokei's path parser
            // decodes a file: BOM sniffing, no explicit encoding, invalid
            // sequences replaced, and raw passthrough without a BOM.
            // Complexity needs UTF-8 and remains zero here.
            let decoded = decode_like_tokei(&bytes)?;
            let stats = language.parse_from_slice(&decoded, &cfg);
            (
                stats.code as u64,
                stats.comments as u64,
                stats.blanks as u64,
                0,
            )
        }
        None | Some(TextRead::Oversize) => (0, 0, 0, 0),
    };

    let mtime = meta
        .modified()
        .ok()
        .map(|t| DateTime::<Utc>::from(t).to_rfc3339());

    Ok(Some(FileStats {
        path: rel.to_string(),
        language: language.name().to_string(),
        code,
        comments,
        blanks,
        complexity: complexity_score,
        bytes: meta.len(),
        mtime,
        bucket: Some(classify_bucket(language)),
    }))
}

enum TextRead {
    Text(String),
    NonUtf8(Vec<u8>),
    Oversize,
}

/// Transcode bytes to UTF-8 with the decoder options tokei's path parser
/// uses: `DecodeReaderBytesBuilder::new()` (BOM sniffing on, no explicit
/// encoding, no UTF-8 passthrough, BOM removed by the decoder). Without a
/// BOM the bytes pass through unchanged, so the output is not necessarily
/// valid UTF-8 and is counted by tokei's slice parser.
fn decode_like_tokei(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut decoded = Vec::with_capacity(bytes.len());
    DecodeReaderBytesBuilder::new()
        .build(bytes)
        .read_to_end(&mut decoded)?;
    Ok(decoded)
}

/// Probe at most 256 bytes and detect the language from the shebang
/// within them, so other extensionless files never enter the body reader.
fn shebang_language(abs: &Path) -> std::io::Result<Option<LanguageType>> {
    let mut probe = Vec::with_capacity(256);
    fs::File::open(abs)?.take(256).read_to_end(&mut probe)?;
    Ok(shebang_probe_language(&probe))
}

/// Tokei's shebang rules applied to a bounded probe. The probe must hold
/// the complete first line, valid UTF-8 and starting with `#!` after
/// leading whitespace; a longer or non-UTF-8 first line is not a shebang.
/// The line then matches the way tokei matches: its first
/// whitespace-separated word must equal one of a language's `#!` paths, or
/// be `#!/usr/bin/env` followed by a word equal to a known interpreter
/// name. Arguments after the match are ignored, and a space after `#!`, a
/// version suffix or an `env` option make the line match nothing.
fn shebang_probe_language(probe: &[u8]) -> Option<LanguageType> {
    let end = probe.iter().position(|byte| *byte == b'\n')?;
    let line = std::str::from_utf8(&probe[..end]).ok()?;
    if !line.trim_start().starts_with("#!") {
        return None;
    }
    let mut words = line.split_whitespace();
    let first = words.next()?;
    if first == "#!/usr/bin/env" {
        let interpreter = words.next()?;
        return ENV_LANGUAGES
            .iter()
            .find(|(name, _)| *name == interpreter)
            .map(|&(_, language)| language);
    }
    LanguageType::list()
        .iter()
        .copied()
        .find(|language| language.shebangs().contains(&first))
}

/// Read at most one byte beyond the cap to detect growth after stat.
/// Non-UTF-8 content is distinguished from oversize input and I/O errors.
fn read_text(abs: &Path) -> std::io::Result<(TextRead, fs::Metadata)> {
    #[cfg(test)]
    record_content_read();
    let file = fs::File::open(abs)?;
    let capacity = file.metadata()?.len().saturating_add(1).min(READ_CAP + 1) as usize;
    let mut buf = Vec::with_capacity(capacity);
    (&file).take(READ_CAP + 1).read_to_end(&mut buf)?;
    let meta = file.metadata()?;
    if buf.len() as u64 > READ_CAP || meta.len() > READ_CAP {
        return Ok((TextRead::Oversize, meta));
    }
    let content = match String::from_utf8(buf) {
        Ok(content) => TextRead::Text(content),
        Err(error) => TextRead::NonUtf8(error.into_bytes()),
    };
    Ok((content, meta))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_extensionless_non_shebang_file_does_not_read_the_body() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("LICENSE");
        fs::write(&abs, "license text\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&abs)
            .unwrap()
            .set_len(1024 * 1024)
            .unwrap();
        CONTENT_READS.set(0);
        assert!(count_file_impl(dir.path(), "LICENSE").unwrap().is_none());
        assert_eq!(
            CONTENT_READS.get(),
            0,
            "a prefix probe must not enter the body reader"
        );
    }

    #[test]
    fn a_shebang_without_a_newline_in_the_probe_is_not_counted() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("script"),
            format!("#!/usr/bin/env python {}\npass\n", " ".repeat(256)),
        )
        .unwrap();
        CONTENT_READS.set(0);
        assert!(count_file_impl(dir.path(), "script").unwrap().is_none());
        assert_eq!(CONTENT_READS.get(), 0);
    }

    #[test]
    fn a_file_unlinked_after_stat_is_removed_on_update() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("vanished.rs");
        fs::write(&abs, "fn a() {}\n").unwrap();
        let mut index = crate::Index::scan(&crate::ReportOptions::new(dir.path())).unwrap();
        let outcome = index.update_with("vanished.rs", |_, rel| {
            let meta = fs::symlink_metadata(&abs).unwrap();
            fs::remove_file(&abs).unwrap();
            let stats = count_file_after_stat(abs, rel, meta).expect("a file vanished before open");
            assert!(stats.is_none());
            Ok(stats)
        });
        assert_eq!(outcome.unwrap(), crate::UpdateOutcome::Removed);
        assert!(index.is_empty());
    }

    #[test]
    fn path_language_detection_matches_tokei() {
        let dir = tempfile::tempdir().unwrap();
        let names = FILENAME_LANGUAGES.iter().map(|(name, _)| *name).chain([
            "CMakeLists.txt",
            "meson.build",
            "meson_options.txt",
            "main.rs",
            "notes.txt",
            "source.PY",
            "unknown.extension",
            "unrecognized",
        ]);
        for name in names {
            let abs = dir.path().join(name);
            fs::write(&abs, "# fixture\n").unwrap();
            assert_eq!(
                language_from_path(&abs),
                LanguageType::from_path(&abs, &Config::default()),
                "path detector parity for {name}"
            );
        }
    }

    #[test]
    fn shebang_detection_matches_tokei() {
        // The interpreter names in tokei 12.1.2's languages.json `env`
        // fields, held apart from ENV_LANGUAGES so a missing table entry
        // fails here.
        const TOKEI_ENV_INTERPRETERS: &[&str] = &[
            "bash", "csh", "crystal", "elvish", "fish", "python", "python2", "python3", "ruby",
            "sh",
        ];
        let dir = tempfile::tempdir().unwrap();
        let mut cases: Vec<(Vec<u8>, Option<Option<LanguageType>>)> = Vec::new();
        for &language in LanguageType::list() {
            for shebang in language.shebangs() {
                cases.push((format!("{shebang}\n").into_bytes(), Some(Some(language))));
                cases.push((format!("{shebang} -x\n").into_bytes(), Some(Some(language))));
            }
        }
        for &(name, language) in ENV_LANGUAGES {
            cases.push((
                format!("#!/usr/bin/env {name}\n").into_bytes(),
                Some(Some(language)),
            ));
        }
        for name in TOKEI_ENV_INTERPRETERS {
            cases.push((format!("#!/usr/bin/env {name}\n").into_bytes(), None));
        }
        let edges: [(&[u8], Option<LanguageType>); 19] = [
            (b"  #!/bin/sh\n", Some(LanguageType::Sh)),
            (b"\t#!/usr/bin/env python\n", Some(LanguageType::Python)),
            (b"#!/bin/sh\r\n", Some(LanguageType::Sh)),
            (b"#!/usr/bin/env python\r\n", Some(LanguageType::Python)),
            (b"#!/usr/bin/env python -u\n", Some(LanguageType::Python)),
            (b"#!/usr/bin/env\tpython\n", Some(LanguageType::Python)),
            (b"#!/bin/bash -x\tscript\n", Some(LanguageType::Bash)),
            (b"#!/usr/bin/env\n", None),
            (b"#!/usr/bin/env unknown-interpreter\n", None),
            (b"#!/usr/bin/env -S python\n", None),
            (b"#!/usr/bin/env python3.12\n", None),
            (b"#!/usr/bin/python3\n", None),
            (b"#! /bin/sh\n", None),
            (b"#!\n", None),
            (b"#!/BIN/SH\n", None),
            (b"\xef\xbb\xbf#!/bin/sh\n", None),
            (b"\n#!/bin/sh\n", None),
            (b"#!/bin/sh \xff\n", None),
            (b"license text\n", None),
        ];
        for (line, expected) in edges {
            cases.push((line.to_vec(), Some(expected)));
        }
        for (i, (line, expected)) in cases.iter().enumerate() {
            let abs = dir.path().join(format!("probe-{i}"));
            fs::write(&abs, line).unwrap();
            let mut probe = Vec::new();
            fs::File::open(&abs)
                .unwrap()
                .take(256)
                .read_to_end(&mut probe)
                .unwrap();
            let detected = shebang_probe_language(&probe);
            let line = String::from_utf8_lossy(line);
            assert_eq!(
                detected,
                LanguageType::from_shebang(&abs),
                "shebang parity with tokei for {line:?}"
            );
            if let Some(expected) = expected {
                assert_eq!(detected, *expected, "shebang detection for {line:?}");
            }
        }
    }

    #[test]
    fn a_small_shebang_file_is_counted() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("script"),
            "#!/usr/bin/env python\nif True:\n    pass\n",
        )
        .unwrap();
        let stats = count_file_impl(dir.path(), "script")
            .unwrap()
            .expect("small script is recognized");
        assert_eq!(stats.language, LanguageType::Python.name());
        assert!(stats.code > 0);
        assert!(stats.complexity > 0);
    }

    #[test]
    fn a_small_non_utf8_file_uses_tokei_decoding() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = vec![0xff, 0xfe];
        for unit in "if True:\n    pass\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(dir.path().join("encoded.py"), &bytes).unwrap();
        let stats = count_file_impl(dir.path(), "encoded.py")
            .unwrap()
            .expect("UTF-16 source is counted");
        assert_eq!(stats.language, LanguageType::Python.name());
        assert_eq!(stats.code, 2);
        assert_eq!(stats.complexity, 0);
        assert_eq!(stats.bytes, bytes.len() as u64);
    }

    #[test]
    fn a_file_over_read_cap_is_tracked_without_reading_it() {
        let dir = tempfile::tempdir().unwrap();
        fs::File::create(dir.path().join("dump.txt"))
            .unwrap()
            .set_len(READ_CAP + 1)
            .unwrap();
        CONTENT_READS.set(0);
        let stats = count_file_impl(dir.path(), "dump.txt")
            .unwrap()
            .expect("oversized file stays tracked");
        assert_eq!(
            CONTENT_READS.get(),
            0,
            "oversized files must not enter a content-reading branch"
        );
        assert_eq!(stats.language, LanguageType::Text.name());
        assert_eq!(stats.bytes, READ_CAP + 1);
        assert_eq!(
            (stats.code, stats.comments, stats.blanks, stats.complexity),
            (0, 0, 0, 0)
        );
        assert!(stats.mtime.is_some());
        assert_eq!(stats.bucket, Some(classify_bucket(LanguageType::Text)));
    }

    #[test]
    fn a_file_that_grows_past_read_cap_after_stat_is_tracked_without_line_counts() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("growing.rs");
        fs::write(&abs, "fn main() { if true {} }\n").unwrap();
        let meta = fs::symlink_metadata(&abs).unwrap();
        let grown = fs::OpenOptions::new().write(true).open(&abs).unwrap();
        grown.set_len(READ_CAP + 8192).unwrap();
        let modified =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        grown
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let observed = grown.metadata().unwrap();
        drop(grown);
        CONTENT_READS.set(0);
        let stats = count_file_after_stat(abs, "growing.rs", meta)
            .unwrap()
            .expect("grown file stays tracked");
        assert_eq!(stats.bytes, observed.len());
        assert_eq!(
            stats.mtime,
            Some(DateTime::<Utc>::from(observed.modified().unwrap()).to_rfc3339())
        );
        assert_eq!(
            (stats.code, stats.comments, stats.blanks, stats.complexity),
            (0, 0, 0, 0)
        );
        assert_eq!(
            CONTENT_READS.get(),
            1,
            "growth may consume one bounded read, without a parser reread"
        );
    }

    #[test]
    fn an_oversized_shebang_only_file_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("script");
        fs::write(&abs, "#!/bin/sh\nif true; then echo yes; fi\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&abs)
            .unwrap()
            .set_len(READ_CAP + 1)
            .unwrap();
        CONTENT_READS.set(0);
        let stats = count_file_impl(dir.path(), "script").unwrap();
        assert_eq!(
            CONTENT_READS.get(),
            0,
            "language detection must not read an oversized shebang-only file"
        );
        assert!(
            stats.is_none(),
            "a shebang-only language cannot be inferred from metadata"
        );
    }

    #[test]
    fn oversized_named_files_keep_their_path_language() {
        let dir = tempfile::tempdir().unwrap();
        for (name, language) in [
            ("CMakeLists.txt", LanguageType::CMake),
            ("Dockerfile", LanguageType::Dockerfile),
            ("Makefile", LanguageType::Makefile),
            ("meson.build", LanguageType::Meson),
            ("meson_options.txt", LanguageType::Meson),
            ("Rakefile", LanguageType::Rakefile),
            ("SConstruct", LanguageType::Scons),
            ("SConscript", LanguageType::Scons),
        ] {
            fs::File::create(dir.path().join(name))
                .unwrap()
                .set_len(READ_CAP + 1)
                .unwrap();
            CONTENT_READS.set(0);
            let stats = count_file_impl(dir.path(), name)
                .unwrap()
                .expect("named source file stays tracked");
            assert_eq!(
                CONTENT_READS.get(),
                0,
                "{name} must use path-only detection"
            );
            assert_eq!(stats.language, language.name());
        }
    }

    #[test]
    fn non_utf8_counts_match_tokei_path_parsing() {
        let dir = tempfile::tempdir().unwrap();
        let text = "# leading comment\nif True:\n\n    pass  # trailing\n# caf\u{e9}\n";
        let mut utf16le = vec![0xff, 0xfe];
        let mut utf16be = vec![0xfe, 0xff];
        for unit in text.encode_utf16() {
            utf16le.extend_from_slice(&unit.to_le_bytes());
            utf16be.extend_from_slice(&unit.to_be_bytes());
        }
        let latin1: Vec<u8> = text
            .chars()
            .map(|c| u8::try_from(u32::from(c)).unwrap())
            .collect();
        let mut utf8_bom_invalid = vec![0xef, 0xbb, 0xbf];
        utf8_bom_invalid.extend_from_slice(&latin1);
        let fixtures = [
            ("utf16le-bom.py", utf16le),
            ("utf16be-bom.py", utf16be),
            ("latin1.py", latin1),
            ("utf8-bom-invalid.py", utf8_bom_invalid),
        ];
        for (name, bytes) in fixtures {
            assert!(
                std::str::from_utf8(&bytes).is_err(),
                "{name} must not be valid UTF-8"
            );
            let abs = dir.path().join(name);
            fs::write(&abs, &bytes).unwrap();
            let expected = LanguageType::Python
                .parse(abs.clone(), &Config::default())
                .unwrap()
                .stats;
            assert!(
                expected.comments > 0 && expected.code > 0,
                "{name} fixture must exercise comments and code"
            );
            let stats = count_file_impl(dir.path(), name)
                .unwrap()
                .expect("non-UTF-8 source is counted");
            assert_eq!(stats.language, LanguageType::Python.name());
            assert_eq!(
                (stats.code, stats.comments, stats.blanks),
                (
                    expected.code as u64,
                    expected.comments as u64,
                    expected.blanks as u64
                ),
                "{name} counts match tokei's path parser"
            );
            assert_eq!(stats.complexity, 0);
            assert_eq!(stats.bytes, bytes.len() as u64);
        }
    }

    #[test]
    fn a_small_non_utf8_file_is_read_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = vec![0xff, 0xfe];
        for unit in "# comment\nif True:\n    pass\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(dir.path().join("encoded.py"), &bytes).unwrap();
        CONTENT_READS.set(0);
        let stats = count_file_impl(dir.path(), "encoded.py")
            .unwrap()
            .expect("UTF-16 source is counted");
        assert_eq!(
            CONTENT_READS.get(),
            1,
            "non-UTF-8 content is decoded from the one bounded read"
        );
        assert_eq!((stats.code, stats.comments), (2, 1));
    }
}
