//! The files macOS asks this desktop to open: Finder's Open With, a double
//! click once Chan is the default app for a file's type, and `open -a Chan
//! FILE`. They come as an open-file event (`RunEvent::Opened`) carrying
//! `file://` URLs, not as arguments, both to a running desktop and to one
//! macOS launches to open them, which can receive the event before the app's
//! setup has run. Each URL is read as a launch's file URI is
//! ([`launch_paths::from_urls`]) and opened as a launch's paths are: as
//! `cs open PATH` typed in a standalone window would open it.
//!
//! Finder offers Chan for Markdown files because the bundle declares them: a
//! document type chan edits without claiming to be its default
//! (`bundle.fileAssociations` in `tauri.macos.conf.json`, macOS's alone) and
//! the Markdown content type it names, imported (`Info.plist`, which tauri-cli
//! merges into the bundle's). The tests below pin both from those files.
//!
//! The boot opens what came before it reached its paths, right after the
//! launch's own and before the first-open rule and the boot window, which
//! then find the window the files opened in rather than open one beside it.
//! After the boot an event's paths open in a task, one task at a time and in
//! the order the events came, so two opens close together cannot each mint a
//! window of their own; a holder that panics hands the queue on.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, MutexGuard};

use chan_server::handoff::Response;
use tauri::Manager;

use crate::{launch_paths, serve, AppState};

/// The paths open-file events delivered that are still to open, and whether
/// an [`Opening`] holds the queue.
#[derive(Debug)]
pub(crate) struct OpenEvents {
    paths: VecDeque<String>,
    /// Held by the boot from the process's start, so the event that launched
    /// the desktop waits for it, then by one task at a time.
    held: bool,
}

impl OpenEvents {
    /// The queue a desktop starts with, held by its boot.
    pub(crate) fn awaiting_boot() -> Self {
        Self {
            paths: VecDeque::new(),
            held: true,
        }
    }

    /// Queue an event's paths. True when nothing holds the queue, so the
    /// caller starts the task that opens it, which then holds it.
    fn queue(&mut self, paths: Vec<String>) -> bool {
        self.paths.extend(paths);
        let start = !self.held && !self.paths.is_empty();
        if start {
            self.held = true;
        }
        start
    }

    /// The path to open next, for the queue's holder. One at a time, so a
    /// holder that panics loses the path it was opening and no other.
    fn next(&mut self) -> Option<String> {
        self.paths.pop_front()
    }

    /// The holder is done, or gone by a panic: true when paths wait, and the
    /// caller starts the task that opens them, which then holds the queue;
    /// with none waiting, the next event's paths start one.
    fn hand_on(&mut self) -> bool {
        self.held = !self.paths.is_empty();
        self.held
    }
}

fn lock(state: &AppState) -> MutexGuard<'_, OpenEvents> {
    state.open_events.lock().unwrap_or_else(|e| e.into_inner())
}

/// The hold on the queue: the boot's from its task's start, then one task's
/// at a time. Its holder opens the queue dry ([`Opening::open`]). Dropped at
/// the end of that or before it, by a panic too, it hands the queue to a new
/// task when paths wait and leaves it to the next event otherwise, so no
/// event waits for a holder that is gone. The queue changes hands only here:
/// an event that comes while the holder finishes joins the queue the drop
/// then reads.
pub(crate) struct Opening(Arc<AppState>);

impl Opening {
    /// The boot's hold, the one the queue starts with.
    pub(crate) fn boot(state: &Arc<AppState>) -> Self {
        Self(Arc::clone(state))
    }

    /// Open the queued paths one after the other, in the order the events
    /// delivered them, and what events add meanwhile, until none is left. A
    /// path that cannot be opened is logged and the rest still open.
    pub(crate) async fn open(self) {
        loop {
            let next = lock(&self.0).next();
            let Some(path) = next else {
                return;
            };
            match serve::open_path_in_standalone_window(Arc::clone(&self.0), &path).await {
                Response::PathOpened { message, .. } => {
                    tracing::info!(%message, "opened a file macOS asked this desktop to open")
                }
                other => {
                    tracing::warn!(%path, reply = ?other, "could not open a file macOS asked this desktop to open")
                }
            }
        }
    }
}

impl Drop for Opening {
    fn drop(&mut self) {
        if lock(&self.0).hand_on() {
            tauri::async_runtime::spawn(Opening(Arc::clone(&self.0)).open());
        }
    }
}

/// Answer an open-file event, which macOS alone delivers; its arm of the run
/// loop is built on macOS alone, so it makes this one call, and what the call
/// does is built and tested on every target.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn deliver(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    let state = app.state::<Arc<AppState>>();
    if let Some(task) = opened(&state, urls) {
        tauri::async_runtime::spawn(task);
    }
}

/// Queue an event's paths, and return the task that opens the queue when
/// nothing holds it, for the caller to spawn. Until the boot has opened its
/// launch's paths it holds the queue, so nothing is returned. A URL that
/// names nothing this desktop can open is logged and skipped.
fn opened(
    state: &Arc<AppState>,
    urls: Vec<tauri::Url>,
) -> Option<impl Future<Output = ()> + Send + 'static> {
    let event = launch_paths::from_urls(urls);
    for (url, why) in &event.skipped {
        tracing::warn!(%url, "skipping a file macOS asked this desktop to open: {why}");
    }
    let start = lock(state).queue(event.paths);
    start.then(|| Opening(Arc::clone(state)).open())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| path.to_string()).collect()
    }

    /// The event that launches the desktop can come before the boot reaches
    /// its paths: it waits, and so does every event until the boot hands the
    /// queue on, which starts a task for what came at its end. One task holds
    /// the queue at a time; an event that comes meanwhile joins it.
    #[test]
    fn events_wait_for_the_boot_and_then_one_task_opens_them() {
        let mut events = OpenEvents::awaiting_boot();
        assert!(
            !events.queue(paths(&["/a.md", "/b.md"])),
            "the boot opens them"
        );
        assert_eq!(events.next().as_deref(), Some("/a.md"));
        assert!(!events.queue(paths(&["/c.md"])), "the boot holds the queue");
        assert_eq!(events.next().as_deref(), Some("/b.md"));
        assert_eq!(events.next().as_deref(), Some("/c.md"));
        assert_eq!(events.next(), None, "the queue is dry");
        assert!(
            !events.queue(paths(&["/d.md"])),
            "the boot holds the queue until it hands it on"
        );
        assert!(events.hand_on(), "a task opens what came at the boot's end");
        assert!(
            !events.queue(paths(&["/e.md"])),
            "that task holds the queue"
        );
        assert_eq!(events.next().as_deref(), Some("/d.md"));
        assert_eq!(events.next().as_deref(), Some("/e.md"));
        assert_eq!(events.next(), None);
        assert!(!events.hand_on(), "nothing waits");
        assert!(!events.queue(Vec::new()), "nothing to open starts nothing");
        assert!(
            events.queue(paths(&["/f.md"])),
            "the next event starts a task"
        );
    }

    /// A holder gone before the queue is dry, a boot that never reached its
    /// paths or a task that panicked, hands what waits to a new task, the
    /// path it was opening aside, and with nothing waiting leaves the next
    /// event to start one.
    #[test]
    fn a_holder_gone_hands_the_queue_on() {
        let mut waiting = OpenEvents::awaiting_boot();
        assert!(!waiting.queue(paths(&["/a.md", "/b.md"])));
        assert_eq!(
            waiting.next().as_deref(),
            Some("/a.md"),
            "the holder's last"
        );
        assert!(waiting.hand_on(), "a task opens what waits");
        assert!(
            !waiting.queue(paths(&["/c.md"])),
            "that task holds the queue"
        );
        assert_eq!(waiting.next().as_deref(), Some("/b.md"));
        assert_eq!(waiting.next().as_deref(), Some("/c.md"));

        let mut empty = OpenEvents::awaiting_boot();
        assert!(!empty.hand_on(), "nothing waits");
        assert!(
            empty.queue(paths(&["/a.md"])),
            "the next event starts a task"
        );
    }

    #[cfg(unix)]
    fn file_url(path: &std::path::Path) -> tauri::Url {
        tauri::Url::from_file_path(path).unwrap()
    }

    /// A file macOS asks to open before the boot reaches its paths waits for
    /// the boot, which opens it in a standalone window; one asked for after
    /// the boot opens in that window through the task the event returns. A
    /// missing file opens created empty, as `cs open` creates it, which shows
    /// each path was opened and when. A URL of another scheme is skipped and
    /// starts nothing.
    #[cfg(unix)]
    #[test]
    fn files_asked_for_before_the_boot_open_with_it_and_later_ones_beside_them() {
        if !crate::embedded::in_own_chan_home(
            "open_events::tests::files_asked_for_before_the_boot_open_with_it_and_later_ones_beside_them",
        ) {
            return;
        }
        let desktop = crate::tests::handoff_row::Desktop::new();
        let files = tempfile::tempdir().unwrap();
        let notes = files.path().join("notes.md");
        std::fs::write(&notes, "# notes\n").unwrap();
        let early = files.path().join("early.md");
        let late = files.path().join("late.md");
        let standalone = || -> Vec<String> {
            desktop
                .embedded()
                .local_window_records()
                .into_iter()
                .filter(|row| matches!(row.kind, chan_server::WindowKind::Terminal))
                .map(|row| row.window_id)
                .collect()
        };

        let boot = Opening::boot(&desktop.state);
        assert!(
            opened(&desktop.state, vec![file_url(&notes), file_url(&early)]).is_none(),
            "the boot opens what comes before it reaches its paths"
        );
        assert!(
            opened(
                &desktop.state,
                vec![tauri::Url::parse("https://example.com/x.md").unwrap()]
            )
            .is_none(),
            "a URL of another scheme starts nothing"
        );
        assert!(!early.exists(), "nothing opens before the boot does");
        assert_eq!(standalone(), Vec::<String>::new());

        desktop.runtime.block_on(boot.open());
        assert!(early.exists(), "the boot opened the queued files");
        let windows = standalone();
        assert_eq!(windows.len(), 1, "{windows:?}");
        assert!(
            desktop
                .embedded()
                .host_for_tests()
                .is_routed_mint(&windows[0]),
            "the window seeds no terminal: its content is the files"
        );

        let task = opened(&desktop.state, vec![file_url(&late)])
            .expect("after the boot an event's files open in a task");
        assert!(!late.exists(), "the task has not run");
        desktop.runtime.block_on(task);
        assert!(late.exists(), "the task opened the file");
        assert_eq!(standalone(), windows, "into the window the boot opened");
        assert!(
            !lock(&desktop.state).held,
            "the queue is left to the next event"
        );
    }

    /// A boot that is gone before it reached its paths, as a panic in its
    /// restore leaves it, hands the files waiting for it to a task of their
    /// own when its guard drops, which opens them and leaves the queue to
    /// the next event.
    #[cfg(unix)]
    #[test]
    fn a_boot_gone_before_its_paths_hands_the_waiting_files_to_a_task() {
        if !crate::embedded::in_own_chan_home(
            "open_events::tests::a_boot_gone_before_its_paths_hands_the_waiting_files_to_a_task",
        ) {
            return;
        }
        let desktop = crate::tests::handoff_row::Desktop::new();
        let files = tempfile::tempdir().unwrap();
        let waiting = files.path().join("waiting.md");
        let boot = Opening::boot(&desktop.state);
        assert!(opened(&desktop.state, vec![file_url(&waiting)]).is_none());
        drop(boot);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !waiting.exists() || lock(&desktop.state).held {
            assert!(
                std::time::Instant::now() < deadline,
                "the task the guard handed the queue to opened nothing in 30 s"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            opened(
                &desktop.state,
                vec![file_url(&files.path().join("next.md"))]
            )
            .is_some(),
            "the next event starts a task of its own"
        );
    }

    /// A task that panics while it opens the queue, here on its first path,
    /// hands what waits to a new task when its hold drops in the unwind: the
    /// file after the one it was opening still opens, the queue is then left
    /// to the next event, and that event starts a task of its own.
    #[cfg(unix)]
    #[test]
    fn a_task_that_panics_hands_the_queue_on() {
        if !crate::embedded::in_own_chan_home(
            "open_events::tests::a_task_that_panics_hands_the_queue_on",
        ) {
            return;
        }
        let desktop = crate::tests::handoff_row::Desktop::new();
        let files = tempfile::tempdir().unwrap();
        let first = files.path().join("first.md");
        let second = files.path().join("second.md");
        desktop
            .runtime
            .block_on(Opening::boot(&desktop.state).open());
        assert!(!lock(&desktop.state).held, "the boot handed the queue on");

        // The task an event starts, as `opened` hands it out, panicking on
        // the first path it takes.
        let event = vec![
            first.to_str().unwrap().to_string(),
            second.to_str().unwrap().to_string(),
        ];
        assert!(lock(&desktop.state).queue(event));
        let hold = Opening(Arc::clone(&desktop.state));
        let task = desktop.runtime.spawn(async move {
            let path = lock(&hold.0).next();
            panic!("opening {path:?} panicked");
        });
        assert!(desktop.runtime.block_on(task).is_err(), "the task panicked");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !second.exists() || lock(&desktop.state).held {
            assert!(
                std::time::Instant::now() < deadline,
                "nothing opened the file after the panicked one in 30 s"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!first.exists(), "the panicked path is not opened again");
        assert!(
            opened(
                &desktop.state,
                vec![file_url(&files.path().join("next.md"))]
            )
            .is_some(),
            "the next event starts a task of its own"
        );
    }

    fn manifest_file(relative: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    fn config(relative: &str) -> serde_json::Value {
        serde_json::from_str(&manifest_file(relative))
            .unwrap_or_else(|e| panic!("parse {relative}: {e}"))
    }

    /// The type the document type names, which the bundle imports.
    const MARKDOWN_UTI: &str = "net.daringfireball.markdown";

    /// What Finder reads from the bundle, built here by the emitter the
    /// bundler calls (tauri-utils' `file_associations_plist`, at the version
    /// this crate locks; the tauri-cli that bundles may carry another) from
    /// the macOS config: one document type for `.md` and `.markdown`, by the
    /// Markdown type, which chan edits (role Editor) without claiming to be
    /// its default (rank Alternate), and no exported type, since chan does
    /// not define Markdown.
    #[test]
    fn the_macos_bundle_lists_chan_as_an_alternate_markdown_editor() {
        let macos = config("tauri.macos.conf.json");
        let associations: Vec<tauri::utils::config::FileAssociation> =
            serde_json::from_value(macos["bundle"]["fileAssociations"].clone())
                .expect("tauri.macos.conf.json declares bundle.fileAssociations");
        let plist = tauri::utils::config::file_associations_plist(&associations)
            .expect("the associations make Info.plist keys");
        let keys = plist.as_dictionary().expect("a dictionary of keys");
        assert_eq!(
            keys.keys().map(String::as_str).collect::<Vec<_>>(),
            ["CFBundleDocumentTypes"],
            "a document type and no exported type"
        );
        let types = keys
            .get("CFBundleDocumentTypes")
            .and_then(|value| value.as_array())
            .unwrap();
        assert_eq!(types.len(), 1, "{types:?}");
        let markdown = types[0].as_dictionary().unwrap();
        let text = |key: &str| markdown.get(key).and_then(|value| value.as_string());
        let list = |key: &str| -> Vec<&str> {
            markdown
                .get(key)
                .and_then(|value| value.as_array())
                .unwrap_or_else(|| panic!("{key} is a list"))
                .iter()
                .map(|value| value.as_string().unwrap())
                .collect()
        };
        assert_eq!(text("CFBundleTypeRole"), Some("Editor"));
        assert_eq!(text("LSHandlerRank"), Some("Alternate"));
        assert_eq!(list("LSItemContentTypes"), [MARKDOWN_UTI]);
        assert_eq!(list("CFBundleTypeExtensions"), ["md", "markdown"]);
    }

    /// The bundle imports the Markdown type its document type names, so a
    /// Mac where nothing declares it still maps `.md` and `.markdown` to it:
    /// a plain-text type, imported rather than exported, so a declaration by
    /// macOS or another app wins. tauri-cli merges `Info.plist` into the
    /// bundle's on macOS alone, so the file is pinned here whole, its
    /// comment and layout aside.
    #[test]
    fn the_macos_bundle_imports_the_markdown_type_it_names() {
        let source = manifest_file("Info.plist");
        let body = source
            .split_once("-->")
            .expect("the comment ends before the plist")
            .1;
        let compact: String = body.split_whitespace().collect();
        let expected = format!(
            "<plistversion=\"1.0\"><dict><key>UTImportedTypeDeclarations</key><array><dict>\
             <key>UTTypeIdentifier</key><string>{MARKDOWN_UTI}</string>\
             <key>UTTypeDescription</key><string>Markdowndocument</string>\
             <key>UTTypeConformsTo</key><array><string>public.plain-text</string></array>\
             <key>UTTypeTagSpecification</key><dict>\
             <key>public.filename-extension</key><array><string>md</string><string>markdown</string></array>\
             <key>public.mime-type</key><array><string>text/markdown</string></array>\
             </dict></dict></array></dict></plist>"
        );
        assert_eq!(compact, expected);
        assert!(
            !source.contains("UTExportedTypeDeclarations")
                && !source.contains("CFBundleDocumentTypes"),
            "the document type is the config's, and the type is imported"
        );
    }

    /// Only the macOS bundle declares the type. A declaration in the base
    /// config would reach the Windows installers too, which register a
    /// declared extension with chan, and Windows has no file surface to open
    /// it in.
    #[test]
    fn only_the_macos_bundle_declares_a_document_type() {
        for name in [
            "tauri.conf.json",
            "tauri.windows.conf.json",
            "tauri.ci.windows.conf.json",
            "tauri.ci.macos.conf.json",
        ] {
            assert!(
                config(name)["bundle"].get("fileAssociations").is_none(),
                "{name} declares bundle.fileAssociations"
            );
        }
    }

    fn production(source: &str) -> &str {
        let boundary = "\n#[cfg(test)]\nmod tests {";
        &source[..source.find(boundary).expect("the boundary is present")]
    }

    fn region<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        let from = source
            .find(start)
            .unwrap_or_else(|| panic!("{start:?} is present"));
        let to = from
            + source[from..]
                .find(end)
                .unwrap_or_else(|| panic!("{end:?} follows {start:?}"));
        &source[from..to]
    }

    /// The run loop's macOS arm makes the one call, built on every target.
    /// A source pin: it holds the call, not what macOS then delivers.
    #[test]
    fn the_open_file_event_goes_through_the_delivery_built_everywhere() {
        let main = production(include_str!("main.rs"));
        let run_loop = region(
            main,
            "app.run(move |_app, event| {",
            "\n/// Build and install the application menu.",
        );
        let arm = region(
            run_loop,
            "#[cfg(target_os = \"macos\")]\n            RunEvent::Opened { urls } =>",
            "\n            #[cfg(target_os = \"macos\")]\n            RunEvent::Reopen {",
        );
        assert!(
            arm.contains("open_events::deliver(_app, urls)"),
            "the open-file arm must hand its URLs to the delivery: {arm}"
        );
    }

    /// The boot's task holds the queue's guard from before its first await,
    /// so every way out of the task hands the queue on, and opens the queue
    /// right after the launch's own paths, before the first-open rule and
    /// the boot window. A source pin of the boot's order.
    #[test]
    fn the_boot_opens_the_queue_after_the_launch_paths_and_before_its_window() {
        let main = production(include_str!("main.rs"));
        let boot = region(
            main,
            "let queued = queue_boot_restore(&state_for_restore);",
            "spawn_launch_update_check(app.handle().clone());",
        );
        let at = |needle: &str| {
            boot.find(needle)
                .unwrap_or_else(|| panic!("the boot runs {needle}"))
        };
        let task = at("tauri::async_runtime::spawn(async move {");
        let guard = at("let boot_opens = open_events::Opening::boot(&state_for_restore);");
        let first_await = at(".await");
        assert!(
            task < guard && guard < first_await,
            "the boot's task must hold the queue's guard from before its first await"
        );
        let launch =
            at("launch_paths::open_at_boot(Arc::clone(&state_for_restore), &launch_paths).await;");
        let open = at("boot_opens.open().await;");
        let first_open = at("embedded.ensure_first_open_terminal()");
        let boot_window = at("ensure_boot_window(Arc::clone(&state_for_restore)).await");
        assert!(
            launch < open && open < first_open && first_open < boot_window,
            "the boot opens the queue after the launch's paths and before its window"
        );
    }
}
