//! Files dropped on a window from another application, read for its page.
//!
//! WebKitGTK hands a page a file dragged in from another application as a drop
//! whose types list `text/uri-list`, with no `Files`, and keeps the URIs from
//! the page (`getData` answers empty, as it does for any drag carrying files,
//! so a page learns no path); the page has no file access either. So the
//! desktop reads the drop for the page: each window webview's own GTK drag
//! signals record the paths of the latest drop from another application, the
//! page lists that drop's files by their base names (`dropped_files`) and reads
//! the ones it takes by their place in the list (`read_dropped_file`), each
//! once, within [`READ_WINDOW`] of the drop. A page therefore reads nothing the
//! user did not drop on it, which is what a browser's drop hands a page too,
//! and no path reaches the page.
//!
//! The signal handlers only observe: each returns without stopping the
//! emission, so WebKit's own drag handling, and with it the page's DOM drag and
//! drop, runs as before, and wry's native drag handler stays off (see
//! `build_workspace_window_with_completion`). A drag from another chan window
//! has a source widget in this process and is not recorded: the page drags it
//! itself.
//!
//! The bytes go back raw. A file over [`MAX_READ_BYTES`], the editor's upload
//! cap, is refused before it is read. macOS and Windows hand the page `Files`
//! for such a drop, so nothing is recorded there: the list is empty and every
//! read is refused.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::WebviewWindow;

/// How long after a drop its files can be read. The page asks from its drop
/// handler, so this only bounds how long a record outlives the drop.
const READ_WINDOW: Duration = Duration::from_secs(30);

/// The largest dropped file a page can read: the editor's upload cap, which a
/// larger file would fail anyway.
const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

/// One window's drag state.
#[derive(Debug, Default)]
struct DropRecord {
    /// The paths the drag over the window offers, from its `text/uri-list`.
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    offered: Vec<PathBuf>,
    /// A drop that came before its drag's URIs did: the URIs complete it.
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    awaiting_uris: bool,
    /// The latest drop's paths, each `None` once read, and when it came.
    dropped: Option<(Instant, Vec<Option<PathBuf>>)>,
}

// Only the GTK drag signals record a drop (see `observe`).
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
impl DropRecord {
    /// A drag moves over the window, so no drop is pending.
    fn motion(&mut self) {
        self.awaiting_uris = false;
    }

    /// The drag over the window offers `paths`.
    fn offer(&mut self, paths: Vec<PathBuf>, now: Instant) {
        if self.awaiting_uris {
            self.awaiting_uris = false;
            self.dropped = Some((now, paths.into_iter().map(Some).collect()));
        } else {
            self.offered = paths;
        }
    }

    /// The drag left the window without a drop; GTK reports a drop's leave
    /// before the drop itself, so this runs after the drop has taken its paths.
    fn left(&mut self) {
        self.offered.clear();
    }

    /// The drag dropped on the window. Its paths replace an earlier drop's.
    fn drop_here(&mut self, now: Instant) {
        if self.offered.is_empty() {
            self.dropped = None;
            self.awaiting_uris = true;
        } else {
            let paths = std::mem::take(&mut self.offered);
            self.dropped = Some((now, paths.into_iter().map(Some).collect()));
        }
    }
}

impl DropRecord {
    /// The latest drop's paths, in the order the drag offered them, while the
    /// read window lasts; an expired drop is cleared.
    fn current(&mut self, now: Instant) -> Option<&mut Vec<Option<PathBuf>>> {
        if let Some((at, _)) = &self.dropped {
            if now.duration_since(*at) > READ_WINDOW {
                self.dropped = None;
            }
        }
        self.dropped.as_mut().map(|(_, paths)| paths)
    }

    /// The base names of the latest drop's files, in order; empty without a
    /// drop or once the read window has passed.
    fn names(&mut self, now: Instant) -> Vec<String> {
        self.current(now)
            .map(|paths| {
                paths
                    .iter()
                    .map(|path| {
                        path.as_deref()
                            .map(crate::upload::shown_name)
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Take the latest drop's file at `index`, refusing a place the drop does
    /// not have, a file already read, and every file once the read window has
    /// passed.
    fn take(&mut self, index: usize, now: Instant) -> Result<PathBuf, String> {
        self.current(now)
            .and_then(|paths| paths.get_mut(index))
            .and_then(Option::take)
            .ok_or_else(|| NOT_DROPPED.into())
    }
}

const NOT_DROPPED: &str = "no such file was just dropped on this window";

fn records() -> &'static Mutex<HashMap<String, DropRecord>> {
    static RECORDS: OnceLock<Mutex<HashMap<String, DropRecord>>> = OnceLock::new();
    RECORDS.get_or_init(Default::default)
}

fn with_record<T>(label: &str, f: impl FnOnce(&mut DropRecord) -> T) -> T {
    let mut records = records()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(records.entry(label.to_string()).or_default())
}

/// The local path a `file:` URI names, percent-decoded. Any other scheme, and
/// a file URI naming another host, is refused.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
fn path_from_file_uri(uri: &str) -> Result<PathBuf, String> {
    let url = url::Url::parse(uri.trim()).map_err(|_| "not a file URI".to_string())?;
    if url.scheme() != "file" {
        return Err("not a file URI".into());
    }
    url.to_file_path()
        .map_err(|()| "the file URI names no local path".into())
}

/// Record the drags that reach `window`'s webview from another application.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
pub fn observe(window: &WebviewWindow) {
    let label = window.label().to_string();
    let attached = window.with_webview(move |webview| {
        use gtk::prelude::*;
        let view = webview.inner();
        let from_another_app = |ctx: &gtk::gdk::DragContext| ctx.drag_get_source_widget().is_none();
        {
            let label = label.clone();
            view.connect_drag_motion(move |_, _, _, _, _| {
                with_record(&label, DropRecord::motion);
                false
            });
        }
        {
            let label = label.clone();
            view.connect_drag_data_received(move |_, ctx, _, _, data, _, _| {
                if !from_another_app(ctx) {
                    return;
                }
                let paths: Vec<PathBuf> = data
                    .uris()
                    .iter()
                    .filter_map(|uri| path_from_file_uri(uri).ok())
                    .collect();
                if !paths.is_empty() {
                    with_record(&label, |record| record.offer(paths, Instant::now()));
                }
            });
        }
        {
            let label = label.clone();
            view.connect_drag_leave(move |_, _, _| {
                let label = label.clone();
                gtk::glib::idle_add_local_once(move || with_record(&label, DropRecord::left));
            });
        }
        view.connect_drag_drop(move |_, ctx, _, _, _| {
            if from_another_app(ctx) {
                with_record(&label, |record| record.drop_here(Instant::now()));
            }
            false
        });
    });
    if let Err(error) = attached {
        tracing::warn!(window = %window.label(), %error, "dropped files will not reach this window's page");
    }
}

/// Nothing records drops here: the webview hands the page `Files`.
#[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
pub fn observe(_window: &WebviewWindow) {}

/// Drop a destroyed window's record.
pub fn forget(label: &str) {
    records()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(label);
}

/// The base names of the files the user just dropped on the asking window
/// from another application, in the order the drag offered them; empty when
/// nothing was dropped there in the last [`READ_WINDOW`].
#[tauri::command]
pub async fn dropped_files(window: WebviewWindow) -> Vec<String> {
    with_record(window.label(), |record| record.names(Instant::now()))
}

/// Read the file at `index` of the asking window's latest drop, once.
#[tauri::command]
pub async fn read_dropped_file(
    window: WebviewWindow,
    index: usize,
) -> Result<tauri::ipc::Response, String> {
    let path = with_record(window.label(), |record| record.take(index, Instant::now()))?;
    let bytes = tauri::async_runtime::spawn_blocking(move || read_regular_file(&path))
        .await
        .map_err(|error| format!("reading the dropped file: {error}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Read `path` when it is a regular file no larger than [`MAX_READ_BYTES`]. A
/// symbolic link is refused as the native picker refuses one, and the opened
/// file must be the one that was checked.
fn read_regular_file(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let name = crate::upload::shown_name(path);
    let checked =
        std::fs::symlink_metadata(path).map_err(|error| format!("stat {name}: {error}"))?;
    if checked.file_type().is_symlink() || !checked.is_file() {
        return Err(format!("only a regular file can be read: {name}"));
    }
    if checked.len() > MAX_READ_BYTES {
        return Err(format!("{name} exceeds the 50 MiB limit"));
    }
    let file = std::fs::File::open(path).map_err(|error| format!("opening {name}: {error}"))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("stat {name}: {error}"))?;
    if !same_file(&checked, &opened) {
        return Err(format!("{name} changed while it was opened"));
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(MAX_READ_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("reading {name}: {error}"))?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(format!("{name} exceeds the 50 MiB limit"));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn same_file(checked: &std::fs::Metadata, opened: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    opened.is_file() && checked.dev() == opened.dev() && checked.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_file(_checked: &std::fs::Metadata, opened: &std::fs::Metadata) -> bool {
    opened.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn a_drop_lists_its_files_and_hands_each_over_once() {
        let now = Instant::now();
        let mut record = DropRecord::default();
        record.motion();
        record.offer(paths(&["/tmp/a.png", "/home/me/b c.jpg"]), now);
        // GTK reports a drop's leave before the drop, and the leave's idle
        // clear runs after it, once the drop has taken its paths.
        record.drop_here(now);
        record.left();
        assert_eq!(record.names(now), ["a.png", "b c.jpg"]);
        assert_eq!(record.take(1, now), Ok(PathBuf::from("/home/me/b c.jpg")));
        assert_eq!(record.take(0, now), Ok(PathBuf::from("/tmp/a.png")));
        assert_eq!(
            record.take(0, now),
            Err(NOT_DROPPED.into()),
            "a dropped file reads once"
        );
        assert_eq!(
            record.take(2, now),
            Err(NOT_DROPPED.into()),
            "no third file was dropped"
        );
        assert_eq!(record.names(now), ["", ""], "read files keep their places");
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn a_drag_that_left_without_dropping_hands_nothing_to_a_later_drop() {
        let now = Instant::now();
        let mut record = DropRecord::default();
        record.motion();
        record.offer(paths(&["/tmp/a.png"]), now);
        record.left();
        // A later drag of something else (text from another application)
        // drops without offering a file.
        record.motion();
        record.drop_here(now);
        assert!(record.names(now).is_empty());
        assert_eq!(record.take(0, now), Err(NOT_DROPPED.into()));
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn nothing_lists_or_reads_without_a_drop_or_after_the_read_window() {
        let now = Instant::now();
        let mut record = DropRecord::default();
        record.offer(paths(&["/tmp/a.png"]), now);
        assert!(
            record.names(now).is_empty(),
            "a drag still hovering has not dropped"
        );
        assert_eq!(record.take(0, now), Err(NOT_DROPPED.into()));
        record.drop_here(now);
        let late = now + READ_WINDOW + Duration::from_millis(1);
        assert!(record.names(late).is_empty());
        assert_eq!(record.take(0, late), Err(NOT_DROPPED.into()));
        assert!(record.dropped.is_none(), "an expired drop is cleared");
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn a_later_drop_replaces_the_earlier_one() {
        let now = Instant::now();
        let mut record = DropRecord::default();
        record.offer(paths(&["/tmp/a.png", "/tmp/b.png"]), now);
        record.drop_here(now);
        record.motion();
        record.offer(paths(&["/tmp/c.png"]), now);
        record.drop_here(now);
        assert_eq!(record.names(now), ["c.png"]);
        assert_eq!(record.take(0, now), Ok(PathBuf::from("/tmp/c.png")));
        assert_eq!(record.take(1, now), Err(NOT_DROPPED.into()));
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn a_drop_before_its_uris_is_completed_by_them_and_only_by_them() {
        let now = Instant::now();
        let mut record = DropRecord::default();
        record.drop_here(now);
        record.offer(paths(&["/tmp/a.png"]), now);
        assert_eq!(record.take(0, now), Ok(PathBuf::from("/tmp/a.png")));

        // A drop whose drag offered no file (text from another application)
        // leaves the next drag's offer an offer, not a drop.
        let mut record = DropRecord::default();
        record.drop_here(now);
        record.motion();
        record.offer(paths(&["/tmp/b.png"]), now);
        assert_eq!(record.take(0, now), Err(NOT_DROPPED.into()));
    }

    #[test]
    fn windows_keep_their_own_drops() {
        let now = Instant::now();
        let (one, two) = ("dropped-files-test-one", "dropped-files-test-two");
        // Seeded without the GTK drag methods, so this runs on every platform.
        with_record(one, |record| {
            record.dropped = Some((now, paths(&["/tmp/a.png"]).into_iter().map(Some).collect()));
        });
        assert!(with_record(two, |record| record.names(now)).is_empty());
        assert_eq!(
            with_record(two, |record| record.take(0, now)),
            Err(NOT_DROPPED.into())
        );
        forget(one);
        assert_eq!(
            with_record(one, |record| record.take(0, now)),
            Err(NOT_DROPPED.into()),
            "a destroyed window's drop is gone"
        );
        forget(two);
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn file_uris_decode_to_local_paths_and_nothing_else_does() {
        assert_eq!(
            path_from_file_uri("file:///tmp/a%20b.png"),
            Ok(PathBuf::from("/tmp/a b.png"))
        );
        assert_eq!(
            path_from_file_uri("file://localhost/tmp/a.png"),
            Ok(PathBuf::from("/tmp/a.png"))
        );
        assert_eq!(
            path_from_file_uri("file:///tmp/caf%C3%A9.png\r"),
            Ok(PathBuf::from("/tmp/café.png"))
        );
        for refused in [
            "https://example.com/a.png",
            "file://other-host/tmp/a.png",
            "/tmp/a.png",
            "",
        ] {
            assert!(
                path_from_file_uri(refused).is_err(),
                "{refused:?} must be refused"
            );
        }
    }

    #[test]
    fn only_a_regular_file_within_the_cap_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.png");
        std::fs::write(&file, b"png").unwrap();
        assert_eq!(read_regular_file(&file), Ok(b"png".to_vec()));

        assert!(
            read_regular_file(dir.path()).is_err(),
            "a directory is refused"
        );
        assert!(read_regular_file(&dir.path().join("gone.png")).is_err());

        let big = dir.path().join("big.png");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_READ_BYTES + 1)
            .unwrap();
        assert!(read_regular_file(&big)
            .unwrap_err()
            .contains("exceeds the 50 MiB limit"));

        #[cfg(unix)]
        {
            let link = dir.path().join("link.png");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(read_regular_file(&link)
                .unwrap_err()
                .contains("only a regular file"));
        }
    }
}
