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
            match has_shebang_prefix(&abs) {
                Ok(true) => {}
                Ok(false) => return Ok(None),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            }
            let Some(language) = LanguageType::from_shebang(&abs) else {
                return Ok(None);
            };
            language
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
        Some(TextRead::NonUtf8) => {
            // Tokei's slice parser does not decode non-UTF-8 input. Its
            // path decoder reopens and reads without a limit, so growth
            // during this fallback can exceed the initial bounded read.
            // Complexity needs UTF-8 and remains zero here.
            #[cfg(test)]
            record_content_read();
            match language.parse(abs, &cfg) {
                Ok(r) => (
                    r.stats.code as u64,
                    r.stats.comments as u64,
                    r.stats.blanks as u64,
                    0,
                ),
                Err((error, _)) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err((error, _)) => return Err(error.into()),
            }
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
    NonUtf8,
    Oversize,
}

/// Probe at most 256 bytes. Tokei is only asked to inspect a shebang when
/// the probe contains its complete first line, so other extensionless
/// files never enter the body reader.
fn has_shebang_prefix(abs: &Path) -> std::io::Result<bool> {
    let mut prefix = Vec::with_capacity(256);
    fs::File::open(abs)?.take(256).read_to_end(&mut prefix)?;
    let Some(end) = prefix.iter().position(|byte| *byte == b'\n') else {
        return Ok(false);
    };
    Ok(std::str::from_utf8(&prefix[..end]).is_ok_and(|line| line.trim_start().starts_with("#!")))
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
        Err(_) => TextRead::NonUtf8,
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
}
