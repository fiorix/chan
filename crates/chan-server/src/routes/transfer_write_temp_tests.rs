use super::*;
use std::sync::mpsc::{channel, Sender};
use std::thread::JoinHandle;

type Save = JoinHandle<chan_workspace::Result<chan_workspace::FileStat>>;

fn held_save(root: &Path, rel: &str) -> (Sender<()>, Save, PathBuf) {
    let mini = chan_workspace::MiniWorkspace::open(root, root, 1 << 20).unwrap();
    let rel = rel.to_string();
    let parent = root.join(&rel).parent().unwrap().to_path_buf();
    let (ready_tx, ready_rx) = channel();
    let (finish_tx, finish_rx) = channel();
    let save = std::thread::spawn(move || {
        mini.write_atomic_stream(&rel, chan_workspace::AtomicWriteKind::Bytes, |sink| {
            sink.write_chunk(b"published")?;
            let temporary = std::fs::read_dir(parent)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    chan_workspace::fs_ops::is_atomic_write_temp_name(
                        &path.file_name().unwrap().to_string_lossy(),
                    )
                })
                .expect("the atomic writer has a real temporary");
            ready_tx.send(temporary).unwrap();
            finish_rx
                .recv()
                .map_err(|_| chan_workspace::ChanError::Cancelled)?;
            Ok(())
        })
    });
    (finish_tx, save, ready_rx.recv().unwrap())
}

fn archive_files(bytes: &[u8]) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    tar::Archive::new(bytes)
        .entries()
        .unwrap()
        .map(|entry| {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().into_owned();
            let mut body = Vec::new();
            entry.read_to_end(&mut body).unwrap();
            (path, body)
        })
        .collect()
}

#[tokio::test]
async fn terminal_directory_download_omits_atomic_write_temporaries() {
    let root = tempfile::tempdir().unwrap();
    let tree = root.path().join("tree");
    for name in [".git", ".chan", ".hg", "nested"] {
        std::fs::create_dir_all(tree.join(name)).unwrap();
        std::fs::write(tree.join(name).join("user.bin"), b"user").unwrap();
    }
    for name in [".CHAN-WRITE-user", ".chan-writer", ".hidden"] {
        std::fs::write(tree.join(name), b"user").unwrap();
    }
    std::fs::write(tree.join("nested/save.bin"), b"old").unwrap();
    let archive_name = download_filename(&tree.to_string_lossy());
    let expected_size = verify_readable_fs(&tree).unwrap();
    let (finish, save, temporary) = held_save(root.path(), "tree/nested/save.bin");
    // A leftover stage uses the exact namespace emitted by the writer.
    let stage = tree.join(temporary.file_name().unwrap());
    std::fs::create_dir(&stage).unwrap();
    std::fs::write(stage.join("partial.bin"), b"partial").unwrap();

    let bulk = crate::state::test_support::make_test_bulk_transfer_tenant();
    let response = stream_planned_download_tracked(&bulk, None, None, tree.clone(), u64::MAX).await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the directory stream completes");
    let files = archive_files(&bytes);
    assert!(
        files.keys().all(|path| !path.components().any(|part| {
            chan_workspace::fs_ops::is_atomic_write_temp_name(&part.as_os_str().to_string_lossy())
        })),
        "reserved write temporaries must not enter the archive: {files:?}"
    );
    for name in [
        ".git/user.bin",
        ".chan/user.bin",
        ".hg/user.bin",
        "nested/user.bin",
        ".CHAN-WRITE-user",
        ".chan-writer",
        ".hidden",
    ] {
        assert_eq!(
            files.get(&Path::new(&archive_name).join(name)),
            Some(&b"user".to_vec())
        );
    }
    assert_eq!(
        verify_readable_fs(&tree).unwrap(),
        expected_size,
        "the preflight must exclude the same reserved entries as the archive"
    );
    assert_eq!(bytes.len() as u64, expected_size);
    finish.send(()).unwrap();
    save.join().unwrap().unwrap();
}

struct CommitOnWrite {
    bytes: Vec<u8>,
    save: Option<(Sender<()>, Save)>,
}

impl Write for CommitOnWrite {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if let Some((finish, save)) = self.save.take() {
            finish.send(()).unwrap();
            save.join().unwrap().unwrap();
        }
        self.bytes.write(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn terminal_directory_archive_survives_an_atomic_write_temporary_rename() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("save.bin"), b"old").unwrap();
    let (finish, save, temporary) = held_save(root.path(), "save.bin");
    let mut output = CommitOnWrite {
        bytes: Vec::new(),
        save: Some((finish, save)),
    };
    let mut builder = tar::Builder::new(&mut output);
    builder.follow_symlinks(false);
    // The root header is written after its children are enumerated. Committing
    // here removes a name the unfiltered walk has already queued.
    append_terminal_directory(&mut builder, Path::new("tree"), root.path())
        .expect("a save renaming its temporary must not abort the directory archive");
    builder.finish().unwrap();
    drop(builder);
    assert!(
        output.save.is_none(),
        "the save committed during the archive"
    );
    assert!(!temporary.exists(), "the real writer renamed its temporary");
    let files = archive_files(&output.bytes);
    assert_eq!(
        files.get(Path::new("tree/save.bin")),
        Some(&b"published".to_vec())
    );
    assert_eq!(files.len(), 2, "only the directory and its published file");
}

#[cfg(unix)]
#[test]
fn terminal_directory_archive_keeps_fifo_and_symlink_entries() {
    let root = tempfile::tempdir().unwrap();
    let fifo = root.path().join("pipe");
    // The POSIX utility also works on Apple, where rustix excludes mkfifoat.
    let created = std::process::Command::new("mkfifo")
        .args(["-m", "600"])
        .arg(&fifo)
        .output()
        .expect("run mkfifo for the archive fixture");
    assert!(
        created.status.success(),
        "create archive FIFO: {}",
        String::from_utf8_lossy(&created.stderr)
    );
    let _open = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&fifo)
        .unwrap();
    std::os::unix::fs::symlink("missing", root.path().join("link")).unwrap();
    let mut builder = tar::Builder::new(Vec::new());
    builder.follow_symlinks(false);
    let name = download_filename(&root.path().to_string_lossy());
    append_terminal_directory(&mut builder, Path::new(&name), root.path())
        .expect("special entries retain archive-relative names");
    let bytes = builder.into_inner().unwrap();
    assert_eq!(verify_readable_fs(root.path()).unwrap(), bytes.len() as u64);
    let mut archive = tar::Archive::new(bytes.as_slice());
    let mut seen = Vec::new();
    for entry in archive.entries().unwrap() {
        let entry = entry.unwrap();
        let path = entry.path().unwrap().into_owned();
        if path.ends_with("pipe") {
            assert_eq!(path, Path::new(&name).join("pipe"));
            assert!(entry.header().entry_type().is_fifo());
            seen.push("pipe");
        } else if path.ends_with("link") {
            assert!(entry.header().entry_type().is_symlink());
            assert_eq!(entry.link_name().unwrap().unwrap(), Path::new("missing"));
            seen.push("link");
        }
    }
    seen.sort();
    assert_eq!(seen, ["link", "pipe"]);
}
