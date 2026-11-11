//! The files macOS asks this desktop to open: Finder's Open With, a double
//! click once Chan is the default app for a file's type, and `open -a Chan
//! FILE`. They come as an open-file event (`RunEvent::Opened`) carrying
//! `file://` URLs, not as arguments, both to a running desktop and to one
//! macOS launches to open them, which can receive the event before the app's
//! setup has run. Each URL is read as a launch's file URI is
//! ([`launch_paths::from_urls`]) and opened as a launch's paths are: as
//! `cs open PATH` typed in a standalone window would open it.
//!
//! The boot opens what came before it reached its paths, right after the
//! launch's own and before the first-open rule and the boot window, which
//! then find the window the files opened in rather than open one beside it.
//! After the boot an event's paths open in a task, one task at a time and in
//! the order the events came, so two opens close together cannot each mint a
//! window of their own.

use std::future::Future;
use std::sync::{Arc, MutexGuard};

use chan_server::handoff::Response;
use tauri::Manager;

use crate::{launch_paths, serve, AppState};

/// The paths open-file events delivered that are still to open, and what
/// opens them.
#[derive(Debug)]
pub(crate) struct OpenEvents {
    paths: Vec<String>,
    opener: Opener,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Opener {
    /// The boot, from the process's start until it has opened its launch's
    /// paths: the event that launched the desktop waits for it.
    Boot,
    /// A task an event started, until the queue runs dry.
    Task,
    /// Nothing: the next event's paths start a task.
    Idle,
}

impl OpenEvents {
    /// The queue a desktop starts with, held by its boot.
    pub(crate) fn awaiting_boot() -> Self {
        Self {
            paths: Vec::new(),
            opener: Opener::Boot,
        }
    }

    /// Queue an event's paths. True when nothing is opening the queue, so
    /// the caller starts the task that does.
    fn queue(&mut self, paths: Vec<String>) -> bool {
        self.paths.extend(paths);
        let start = self.opener == Opener::Idle && !self.paths.is_empty();
        if start {
            self.opener = Opener::Task;
        }
        start
    }

    /// The paths to open next, for the boot or the task opening the queue.
    /// None left ends its turn: the next event's paths start a task.
    fn next(&mut self) -> Vec<String> {
        let paths = std::mem::take(&mut self.paths);
        if paths.is_empty() {
            self.opener = Opener::Idle;
        }
        paths
    }

    /// The boot is gone without having opened the queue: true when paths
    /// wait, and the caller starts the task that opens them.
    fn boot_gone(&mut self) -> bool {
        if self.opener != Opener::Boot {
            return false;
        }
        if self.paths.is_empty() {
            self.opener = Opener::Idle;
            return false;
        }
        self.opener = Opener::Task;
        true
    }
}

fn lock(state: &AppState) -> MutexGuard<'_, OpenEvents> {
    state.open_events.lock().unwrap_or_else(|e| e.into_inner())
}

/// Held by the boot's task from its start. [`BootOpens::open`] opens what
/// the events queued before the boot reached its paths; a boot that ends
/// without getting there, by a panic too, hands the queue to a task on drop,
/// so no event waits for a boot that is gone.
pub(crate) struct BootOpens(Arc<AppState>);

impl BootOpens {
    pub(crate) fn held(state: &Arc<AppState>) -> Self {
        Self(Arc::clone(state))
    }

    /// Open the queue, and what events add to it meanwhile, until it is dry;
    /// later events then open their own.
    pub(crate) async fn open(self) {
        open_queued(Arc::clone(&self.0)).await;
    }
}

impl Drop for BootOpens {
    fn drop(&mut self) {
        if lock(&self.0).boot_gone() {
            tauri::async_runtime::spawn(open_queued(Arc::clone(&self.0)));
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
/// nothing opens it yet, for the caller to spawn. Until the boot has opened
/// its launch's paths it opens the queue itself, so nothing is returned. A
/// URL that names nothing this desktop can open is logged and skipped.
fn opened(
    state: &Arc<AppState>,
    urls: Vec<tauri::Url>,
) -> Option<impl Future<Output = ()> + Send + 'static> {
    let event = launch_paths::from_urls(urls);
    for (url, why) in &event.skipped {
        tracing::warn!(%url, "skipping a file macOS asked this desktop to open: {why}");
    }
    let start = lock(state).queue(event.paths);
    start.then(|| open_queued(Arc::clone(state)))
}

/// Open the queued paths one after the other, in the order the events
/// delivered them, until none is left. A path that cannot be opened is
/// logged and the rest still open.
async fn open_queued(state: Arc<AppState>) {
    loop {
        let paths = lock(&state).next();
        if paths.is_empty() {
            return;
        }
        for path in paths {
            match serve::open_path_in_standalone_window(Arc::clone(&state), &path).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| path.to_string()).collect()
    }

    /// The event that launches the desktop can come before the boot reaches
    /// its paths: it waits, and so does every event until the boot has opened
    /// the queue dry. The next event starts a task; one that comes while the
    /// task opens joins its queue.
    #[test]
    fn events_wait_for_the_boot_and_then_one_task_opens_them() {
        let mut events = OpenEvents::awaiting_boot();
        assert!(!events.queue(paths(&["/a.md"])), "the boot opens it");
        assert!(!events.queue(paths(&["/b.md"])), "the boot opens it");
        assert_eq!(events.next(), paths(&["/a.md", "/b.md"]));
        assert!(
            !events.queue(paths(&["/c.md"])),
            "the boot is still opening"
        );
        assert_eq!(events.next(), paths(&["/c.md"]));
        assert_eq!(events.next(), Vec::<String>::new(), "the boot is done");

        assert!(!events.queue(Vec::new()), "nothing to open starts nothing");
        assert!(events.queue(paths(&["/d.md"])), "a task starts");
        assert!(!events.queue(paths(&["/e.md"])), "the task opens it next");
        assert_eq!(events.next(), paths(&["/d.md", "/e.md"]));
        assert_eq!(events.next(), Vec::<String>::new(), "the task is done");
        assert!(events.queue(paths(&["/f.md"])), "the next event starts one");
    }

    /// A boot that ends before it opened the queue hands what waits to a
    /// task, and with nothing waiting leaves the next event to start one; a
    /// boot that opened the queue leaves the task an event started alone.
    #[test]
    fn a_boot_gone_without_opening_hands_the_queue_on() {
        let mut waiting = OpenEvents::awaiting_boot();
        assert!(!waiting.queue(paths(&["/a.md"])));
        assert!(waiting.boot_gone(), "a task opens what waits");
        assert!(!waiting.queue(paths(&["/b.md"])), "that task opens it next");
        assert_eq!(waiting.next(), paths(&["/a.md", "/b.md"]));

        let mut empty = OpenEvents::awaiting_boot();
        assert!(!empty.boot_gone(), "nothing waits");
        assert!(
            empty.queue(paths(&["/a.md"])),
            "the next event starts a task"
        );

        let mut opened = OpenEvents::awaiting_boot();
        assert_eq!(opened.next(), Vec::<String>::new());
        assert!(opened.queue(paths(&["/a.md"])));
        assert!(!opened.boot_gone(), "the event's task opens the queue");
        assert!(!opened.queue(paths(&["/b.md"])));
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

        let boot = BootOpens::held(&desktop.state);
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
        assert_eq!(lock(&desktop.state).opener, Opener::Idle);
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
        let boot = BootOpens::held(&desktop.state);
        assert!(opened(&desktop.state, vec![file_url(&waiting)]).is_none());
        drop(boot);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !(waiting.exists() && lock(&desktop.state).opener == Opener::Idle) {
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
        let guard = at("let boot_opens = open_events::BootOpens::held(&state_for_restore);");
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
