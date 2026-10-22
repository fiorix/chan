use cap_std::fs::{Dir, File, OpenOptions};
use std::ffi::OsStr;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) const PREFIX: &str = ".chan-write-";
const CREATE_MARKER: &str = "new-";
const COLLISION_ATTEMPTS: usize = 128;
static NEXT_NAME: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
pub(crate) enum AtomicWriteDestination {
    Create,
    Replace,
}

#[cfg(target_os = "linux")]
impl AtomicWriteDestination {
    pub(crate) fn from_temp_name(name: &str) -> Option<Self> {
        let suffix = name.strip_prefix(PREFIX)?;
        Some(if suffix.starts_with(CREATE_MARKER) {
            Self::Create
        } else {
            Self::Replace
        })
    }
}

fn temp_name(destination: AtomicWriteDestination, sequence: u64) -> String {
    let marker = match destination {
        AtomicWriteDestination::Create => CREATE_MARKER,
        AtomicWriteDestination::Replace => "",
    };
    format!("{PREFIX}{marker}{:x}-{sequence:016x}", std::process::id())
}

fn create_named<T>(
    destination: AtomicWriteDestination,
    counter: &AtomicU64,
    mut create: impl FnMut(&str) -> io::Result<T>,
) -> io::Result<(T, String)> {
    for _ in 0..COLLISION_ATTEMPTS {
        let name = temp_name(destination, counter.fetch_add(1, Ordering::Relaxed));
        match create(&name) {
            Ok(value) => return Ok((value, name)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "atomic write temporary names occupied",
    ))
}

pub(crate) struct AtomicWriteTemp<'d> {
    parent: &'d Dir,
    name: Option<String>,
    file: Option<File>,
}

impl<'d> AtomicWriteTemp<'d> {
    pub(crate) fn new(parent: &'d Dir, destination: AtomicWriteDestination) -> io::Result<Self> {
        Self::with_counter(parent, destination, &NEXT_NAME)
    }

    fn with_counter(
        parent: &'d Dir,
        destination: AtomicWriteDestination,
        counter: &AtomicU64,
    ) -> io::Result<Self> {
        let (file, name) = create_named(destination, counter, |name| {
            parent.open_with(
                name,
                OpenOptions::new().read(true).write(true).create_new(true),
            )
        })?;
        Ok(Self {
            parent,
            name: Some(name),
            file: Some(file),
        })
    }

    pub(super) fn as_file(&self) -> &File {
        self.file
            .as_ref()
            .expect("unpublished temporary has an open file")
    }

    pub(super) fn as_file_mut(&mut self) -> &mut File {
        self.file
            .as_mut()
            .expect("unpublished temporary has an open file")
    }

    pub(super) fn replace(mut self, leaf: &OsStr) -> io::Result<()> {
        // Closing before the rename keeps close notifications on the reserved name.
        drop(self.file.take());
        self.parent.rename(
            self.name.as_ref().expect("temporary owns its name"),
            self.parent,
            leaf,
        )?;
        self.name = None;
        Ok(())
    }

    pub(crate) fn close(mut self) -> io::Result<()> {
        drop(self.file.take());
        self.parent
            .remove_file(self.name.as_ref().expect("temporary owns its name"))?;
        self.name = None;
        Ok(())
    }
}

impl Drop for AtomicWriteTemp<'_> {
    fn drop(&mut self) {
        drop(self.file.take());
        if let Some(name) = self.name.take() {
            if let Err(error) = self.parent.remove_file(&name) {
                tracing::warn!(?name, ?error, "atomic write temporary cleanup failed");
            }
        }
    }
}

pub(super) struct AtomicWriteStage {
    dir: Option<Dir>,
}

impl AtomicWriteStage {
    pub(super) fn new(parent: &Dir) -> io::Result<Self> {
        let ((), name) = create_named(AtomicWriteDestination::Replace, &NEXT_NAME, |name| {
            parent.create_dir(name)
        })?;
        match parent.open_dir(&name) {
            Ok(dir) => Ok(Self { dir: Some(dir) }),
            Err(error) => {
                if let Err(cleanup) = parent.remove_dir(&name) {
                    tracing::warn!(?name, ?cleanup, "atomic write stage cleanup failed");
                }
                Err(error)
            }
        }
    }

    pub(super) fn dir(&self) -> &Dir {
        self.dir
            .as_ref()
            .expect("atomic write stage is open until cleanup")
    }

    pub(super) fn close(mut self) -> io::Result<()> {
        self.dir
            .take()
            .expect("atomic write stage is open until cleanup")
            .remove_open_dir_all()
    }
}

impl Drop for AtomicWriteStage {
    fn drop(&mut self) {
        if let Some(dir) = self.dir.take() {
            if let Err(error) = dir.remove_open_dir_all() {
                tracing::warn!(?error, "atomic write stage cleanup failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_ops::{
        self, AtomicWriteKind, IndexScopeDecision, IndexScopeExclusion, IndexScopePolicy,
        WalkFilter,
    };
    use crate::{ChanError, WorkspaceGeneration};
    use std::path::Path;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, Dir) {
        let root = TempDir::new().unwrap();
        let dir = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        (root, dir)
    }

    #[test]
    fn reserved_namespace_keeps_ordinary_user_names() {
        for name in [
            ".chan-write-",
            ".chan-write-new-123",
            ".chan-write-leftover",
        ] {
            assert!(fs_ops::is_atomic_write_temp_name(name), "reserved {name}");
        }
        for name in [
            "#123",
            "e7eec6ab-54ca-43fb-9f86-8120361e624a",
            ".chan-note",
            ".CHAN-WRITE-x",
            "notes.md",
        ] {
            assert!(!fs_ops::is_atomic_write_temp_name(name), "ordinary {name}");
        }
    }

    #[test]
    fn reserved_orphans_and_stage_subtrees_are_hard_excluded_despite_negation() {
        let (root, dir) = fixture();
        dir.write(".gitignore", "!.chan-write-*/\n!.chan-write-*\n!*.md\n")
            .unwrap();
        dir.create_dir(".chan-write-stage").unwrap();
        dir.write(".chan-write-stage/keep.md", b"staged").unwrap();
        dir.write(".chan-write-orphan", b"keep on disk").unwrap();
        for name in ["#123", "e7eec6ab-54ca-43fb-9f86-8120361e624a", "note.md"] {
            dir.write(name, b"ordinary").unwrap();
        }
        let policy = IndexScopePolicy::new(
            root.path().to_path_buf(),
            WorkspaceGeneration::INITIAL,
            WalkFilter::new([] as [&str; 0]),
        )
        .unwrap();
        for (name, is_dir) in [
            (".chan-write-orphan", false),
            (".chan-write-stage", true),
            (".chan-write-stage/keep.md", false),
            ("nested/.chan-write-stage/keep.md", false),
        ] {
            assert_eq!(
                policy.decision(name, is_dir),
                IndexScopeDecision::Exclude(IndexScopeExclusion::Hard),
                "{name}"
            );
        }
        let paths: Vec<_> = fs_ops::walk_workspace_scoped(root.path(), &policy)
            .map(|entry| fs_ops::rel_path_text(entry.path().strip_prefix(root.path()).unwrap()))
            .collect();
        assert!(
            !paths.iter().any(|path| path.contains(".chan-write-")),
            "{paths:?}"
        );
        for name in ["#123", "e7eec6ab-54ca-43fb-9f86-8120361e624a", "note.md"] {
            assert!(
                paths.iter().any(|path| path == name),
                "ordinary {name}: {paths:?}"
            );
        }
        assert_eq!(dir.read(".chan-write-orphan").unwrap(), b"keep on disk");
    }

    #[test]
    fn temporary_collisions_keep_existing_files() {
        let (_root, dir) = fixture();
        let counter = AtomicU64::new(0);
        let occupied = temp_name(AtomicWriteDestination::Replace, 0);
        dir.write(&occupied, b"foreign").unwrap();
        let temporary =
            AtomicWriteTemp::with_counter(&dir, AtomicWriteDestination::Replace, &counter).unwrap();
        assert_ne!(temporary.name.as_ref().unwrap(), &occupied);
        drop(temporary);
        assert_eq!(dir.read(&occupied).unwrap(), b"foreign");
        assert_eq!(dir.entries().unwrap().count(), 1);
    }

    #[test]
    #[cfg(unix)]
    fn temporary_collisions_keep_existing_symlinks_and_their_targets() {
        let (root, dir) = fixture();
        let counter = AtomicU64::new(0);
        let occupied = temp_name(AtomicWriteDestination::Replace, 0);
        dir.write("foreign.md", b"foreign").unwrap();
        std::os::unix::fs::symlink("foreign.md", root.path().join(&occupied)).unwrap();
        let temporary =
            AtomicWriteTemp::with_counter(&dir, AtomicWriteDestination::Replace, &counter).unwrap();
        assert_ne!(temporary.name.as_ref().unwrap(), &occupied);
        drop(temporary);
        assert_eq!(dir.read_link(&occupied).unwrap(), Path::new("foreign.md"));
        assert_eq!(dir.read("foreign.md").unwrap(), b"foreign");
        assert_eq!(dir.entries().unwrap().count(), 2);
    }

    #[test]
    fn collision_exhaustion_leaves_every_foreign_entry() {
        let (_root, dir) = fixture();
        let counter = AtomicU64::new(0);
        for sequence in 0..128 {
            dir.write(
                temp_name(AtomicWriteDestination::Replace, sequence),
                sequence.to_string(),
            )
            .unwrap();
        }
        let result = AtomicWriteTemp::with_counter(&dir, AtomicWriteDestination::Replace, &counter);
        assert!(matches!(result, Err(ref error) if error.kind() == io::ErrorKind::AlreadyExists));
        assert_eq!(counter.load(Ordering::Relaxed), 128);
        for sequence in 0..128 {
            assert_eq!(
                dir.read(temp_name(AtomicWriteDestination::Replace, sequence))
                    .unwrap(),
                sequence.to_string().as_bytes()
            );
        }
        assert_eq!(dir.entries().unwrap().count(), 128);
    }

    #[test]
    fn stream_failures_remove_the_temporary_and_preserve_the_target() {
        for failure in ["feed", "limit", "utf8", "utf8-tail"] {
            let (_root, dir) = fixture();
            dir.write("note.md", b"before").unwrap();
            let result = fs_ops::atomic_write_stream_in(
                &dir,
                Path::new("note.md"),
                AtomicWriteDestination::Replace,
                AtomicWriteKind::Text,
                8,
                true,
                |sink| {
                    sink.write_chunk(b"part")?;
                    match failure {
                        "feed" => Err(ChanError::Cancelled),
                        "limit" => sink.write_chunk(b"123456789"),
                        "utf8" => sink.write_chunk(&[0xff]),
                        "utf8-tail" => sink.write_chunk(&[0xc2]),
                        _ => unreachable!(),
                    }
                },
            );
            assert!(result.is_err(), "{failure}");
            assert_eq!(dir.read("note.md").unwrap(), b"before", "{failure}");
            assert_eq!(
                dir.entries().unwrap().count(),
                1,
                "no residue after {failure}"
            );
        }
    }

    #[test]
    fn failed_publication_cleans_only_the_owned_temporary() {
        let (_root, dir) = fixture();
        dir.create_dir("occupied").unwrap();
        dir.write("occupied/keep.md", b"keep").unwrap();
        assert!(fs_ops::atomic_write_stream_in(
            &dir,
            Path::new("occupied"),
            AtomicWriteDestination::Replace,
            AtomicWriteKind::Bytes,
            8,
            false,
            |sink| sink.write_chunk(b"bytes")
        )
        .is_err());
        assert_eq!(dir.read("occupied/keep.md").unwrap(), b"keep");
        assert_eq!(dir.entries().unwrap().count(), 1);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn sync_failure_reclaims_the_owned_name_without_publication() {
        let (_root, dir) = fixture();
        dir.write("note.md", b"before").unwrap();
        let result = (|| -> io::Result<()> {
            let mut temporary = AtomicWriteTemp::new(&dir, AtomicWriteDestination::Replace)?;
            // This descriptor rejects fsync without changing the owned directory entry.
            temporary.file = Some(File::from_std(std::fs::File::open("/dev/null")?));
            temporary.as_file().sync_all()?;
            temporary.replace(OsStr::new("note.md"))
        })();
        assert!(
            matches!(result, Err(ref error) if error.kind() == io::ErrorKind::InvalidInput),
            "{result:?}"
        );
        assert_eq!(dir.read("note.md").unwrap(), b"before");
        assert_eq!(dir.entries().unwrap().count(), 1);
    }

    #[test]
    #[cfg(unix)]
    fn exclusive_publication_keeps_an_existing_symlink() {
        let (root, dir) = fixture();
        dir.write("foreign.md", b"foreign").unwrap();
        std::os::unix::fs::symlink("foreign.md", root.path().join("target.md")).unwrap();
        assert!(matches!(
            fs_ops::atomic_create_in(&dir, Path::new("target.md"), b"new", 8, true),
            Err(ChanError::PathAlreadyExists(_))
        ));
        assert_eq!(dir.read_link("target.md").unwrap(), Path::new("foreign.md"));
        assert_eq!(dir.read("foreign.md").unwrap(), b"foreign");
        assert_eq!(dir.entries().unwrap().count(), 2);
    }

    #[test]
    fn stream_names_mark_only_creations() {
        for destination in [
            AtomicWriteDestination::Create,
            AtomicWriteDestination::Replace,
        ] {
            let (_root, dir) = fixture();
            fs_ops::atomic_write_stream_in(
                &dir,
                Path::new("note.md"),
                destination,
                AtomicWriteKind::Text,
                8,
                true,
                |sink| {
                    let names: Vec<_> = dir
                        .entries()
                        .unwrap()
                        .map(|entry| entry.unwrap().file_name())
                        .collect();
                    assert_eq!(names.len(), 1);
                    let name = names[0].to_str().unwrap();
                    assert!(
                        name.starts_with(".chan-write-"),
                        "reserved stream name: {name}"
                    );
                    assert_eq!(
                        name.starts_with(".chan-write-new-"),
                        matches!(destination, AtomicWriteDestination::Create)
                    );
                    sink.write_chunk(b"text")
                },
            )
            .unwrap();
            assert_eq!(dir.read("note.md").unwrap(), b"text");
            assert_eq!(dir.entries().unwrap().count(), 1);
        }
    }

    #[test]
    fn stage_names_are_reserved_and_cleanup_removes_the_whole_owned_stage() {
        let (_root, dir) = fixture();
        let stage = AtomicWriteStage::new(&dir).unwrap();
        let names: Vec<_> = dir
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1);
        assert!(fs_ops::is_atomic_write_temp_name(
            names[0].to_str().unwrap()
        ));
        stage.dir().write("payload", b"bytes").unwrap();
        drop(stage);
        assert_eq!(dir.entries().unwrap().count(), 0);
    }

    #[test]
    #[cfg(unix)]
    fn streamed_replacement_preserves_mode() {
        use cap_std::fs::PermissionsExt;
        let (_root, dir) = fixture();
        dir.write("note.md", b"before").unwrap();
        dir.set_permissions("note.md", cap_std::fs::Permissions::from_mode(0o640))
            .unwrap();
        fs_ops::atomic_write_stream_in(
            &dir,
            Path::new("note.md"),
            AtomicWriteDestination::Replace,
            AtomicWriteKind::Text,
            8,
            true,
            |sink| sink.write_chunk(b"after"),
        )
        .unwrap();
        assert_eq!(
            dir.metadata("note.md").unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(dir.read("note.md").unwrap(), b"after");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn streamed_replacement_preserves_xattrs() {
        let (root, dir) = fixture();
        dir.write("note.md", b"before").unwrap();
        xattr::set(root.path().join("note.md"), "user.chan-save", b"attribute")
            .expect("test filesystem must support user xattrs");
        fs_ops::atomic_write_stream_in(
            &dir,
            Path::new("note.md"),
            AtomicWriteDestination::Replace,
            AtomicWriteKind::Text,
            8,
            true,
            |sink| sink.write_chunk(b"after"),
        )
        .unwrap();
        assert_eq!(
            xattr::get(root.path().join("note.md"), "user.chan-save").unwrap(),
            Some(b"attribute".to_vec())
        );
    }

    #[test]
    fn sidecar_stream_uses_reserved_names_and_retains_its_failure_contract() {
        let (root, dir) = fixture();
        let store =
            crate::sidecar_store::SidecarStore::open(root.path().to_path_buf(), 64).unwrap();
        store
            .write_atomic_stream("record.json", AtomicWriteKind::Bytes, |sink| {
                let names: Vec<_> = dir
                    .entries()
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name())
                    .collect();
                assert_eq!(names.len(), 1);
                assert!(names[0].to_str().unwrap().starts_with(".chan-write-new-"));
                sink.write_chunk(b"{}")
            })
            .unwrap();
        let result = store.write_atomic_stream("record.json", AtomicWriteKind::Bytes, |sink| {
            let names: Vec<_> = dir
                .entries()
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            let temporary: Vec<_> = names.iter().filter(|name| *name != "record.json").collect();
            assert_eq!(temporary.len(), 1);
            let name = temporary[0].to_str().unwrap();
            assert!(name.starts_with(".chan-write-"));
            assert!(!name.starts_with(".chan-write-new-"));
            sink.write_chunk(b"partial")?;
            Err(ChanError::Cancelled)
        });
        assert!(matches!(result, Err(ChanError::Cancelled)));
        assert_eq!(dir.read("record.json").unwrap(), b"{}");
        assert_eq!(dir.entries().unwrap().count(), 1);
    }
}
