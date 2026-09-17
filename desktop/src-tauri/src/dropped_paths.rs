//! OS file paths for a just-completed drag-drop, read natively.
//!
//! The DOM File API never exposes OS paths (WebKit sanitizes
//! `text/uri-list` for cross-app file drags), and enabling wry's
//! native drag-drop handler would swallow ALL DOM drag events on
//! macOS -- wry only forwards a drag to WebKit when the installed
//! handler returns `false`, and tauri-runtime-wry's handler returns
//! `true` unconditionally -- killing the editor/file-browser drop
//! zones and in-page tab-move DnD. So the native handler stays
//! disabled (see `build_workspace_window`) and the SPA's terminal
//! drop zone fetches the dropped paths through this command instead:
//! when the DOM `drop` event fires, the macOS drag pasteboard
//! (`NSPasteboard` name `.drag`) still holds the dragged file URLs.
//!
//! Contract (frozen with the web half, task-Chan-ChanDesktop-1):
//! raw absolute paths, pasteboard order, no shell escaping (the SPA
//! escapes); `[]` when the drag carried no file items and
//! unconditionally off macOS (no equivalent persistent drag
//! pasteboard elsewhere; the SPA treats `[]` as a silent no-op).
//! Only meaningful when invoked from inside a `drop` handler: the
//! drag pasteboard is system-wide and persists until the NEXT drag
//! starts. That persistence is also why the ACL scopes this command
//! to locally-served `local::*` windows (capabilities/local-drop.json): a
//! gateway-served SPA could otherwise poll it and harvest paths the user drags
//! around in unrelated applications.

/// Read the file paths currently on the macOS drag pasteboard.
/// NSPasteboard is AppKit state, so the read runs on the main thread
/// via `run_on_main_thread`; the command awaits the result over a
/// oneshot channel.
#[tauri::command]
pub async fn read_dropped_paths(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(drag_pasteboard_paths());
    })
    .map_err(|e| format!("scheduling drag-pasteboard read: {e}"))?;
    rx.await
        .map_err(|e| format!("drag-pasteboard read was dropped: {e}"))
}

/// The `NSFilenamesPboardType` property list on the `.drag`
/// pasteboard, as plain strings. Mirrors wry's own `collect_paths`
/// read of the same pasteboard so this parses exactly what the
/// native drag layer would have reported. Empty when the most recent
/// drag carried no files.
//
// `NSFilenamesPboardType` is deprecated (AppKit points at
// `NSPasteboardTypeFileURL`), but wry 0.55.1 still reads exactly this
// type in its drag handler, and parity with that read is the point:
// one shared parse, no file-URL percent-decoding divergence. Migrate
// together with wry if/when wry moves off it.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn drag_pasteboard_paths() -> Vec<String> {
    use objc2_app_kit::{NSFilenamesPboardType, NSPasteboard, NSPasteboardNameDrag};
    use objc2_foundation::{NSArray, NSString};

    // The pasteboard-name and pasteboard-type statics live in AppKit's
    // extern block; reading them is the only unsafe here.
    let (name, file_type) = unsafe { (NSPasteboardNameDrag, NSFilenamesPboardType) };
    let pb = NSPasteboard::pasteboardWithName(name);
    let types = NSArray::from_slice(&[file_type]);
    if pb.availableTypeFromArray(&types).is_none() {
        return Vec::new();
    }
    let Some(plist) = pb.propertyListForType(file_type) else {
        return Vec::new();
    };
    let Ok(paths) = plist.downcast::<NSArray>() else {
        return Vec::new();
    };
    paths
        .iter()
        .filter_map(|p| p.downcast::<NSString>().ok().map(|s| s.to_string()))
        .collect()
}

/// Linux/Windows have no persistent system drag pasteboard to read
/// after the drop; the terminal path-print is macOS-only for now and
/// the SPA treats `[]` as a no-op.
#[cfg(not(target_os = "macos"))]
fn drag_pasteboard_paths() -> Vec<String> {
    Vec::new()
}
