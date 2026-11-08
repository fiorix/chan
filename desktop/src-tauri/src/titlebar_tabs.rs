//! A page's tab bar in the macOS title bar.
//!
//! A page that draws a tab bar across the top of its window asks for the
//! title bar's band with [`set_titlebar_tabs`]. On macOS the title bar turns
//! transparent, the window's content view runs under it (the full-size content
//! view), and the title text hides; the traffic lights stay where AppKit puts
//! them. The answer, a [`TitlebarChrome`], says in the page's own CSS px how
//! much room the traffic lights take, and the page asks again with
//! [`titlebar_chrome`] whenever its viewport resizes, which a fullscreen
//! transition and a zoom change both do. The desktop never turns the mode on
//! by itself, and a page load from another origin than the page that turned it
//! on turns it off, so a page that does not know this contract is never laid
//! out under the traffic lights. Off macOS both commands answer an inactive
//! chrome and change nothing.
//!
//! The switch is made with AppKit calls rather than Tauri's
//! `set_title_bar_style`. In tauri-runtime-wry that call's `Visible` arm
//! leaves the full-size content view on, so it cannot give the normal title bar
//! back, and every style mask change tao makes ends by making tao's own view
//! the first responder, a view that is no longer in the window once wry
//! installs the webview's parent as the content view. Here the style mask
//! changes and the page keeps the keyboard.
//!
//! While a window holds the mode, three other parts of the desktop read its
//! record: the hide-time geometry capture stores the height a normal title bar
//! would leave (`serve::capture_window_geometry`), the launcher panel sits below
//! the band (`launcher_panel::content_bounds`), and window destruction drops it
//! (`serve::on_destroyed`). While the window's Computers launcher shows, the
//! page hides its tab bar's contents and the title bar shows the window's title
//! again ([`launcher_visibility_changed`]).
//!
//! Whether a page asks is the user's choice, the `titlebar_tabs` field of the
//! desktop's own config, off by default. It covers every window the desktop
//! builds, whatever tenant the window shows, so a devserver's preferences play
//! no part. A page reads it with [`titlebar_tabs_preference`], Settings writes
//! it with [`set_titlebar_tabs_preference`], and every window hears the change
//! as [`PREFERENCE_EVENT`] and switches without a reload.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::config::ConfigStore;
use crate::AppState;

/// The event every window receives when the desktop's preference changes,
/// with a [`PreferencePayload`].
pub(crate) const PREFERENCE_EVENT: &str = "titlebar-tabs-preference";

/// The preference event's payload.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
struct PreferencePayload {
    on: bool,
}

/// The tallest band a page may ask for, in CSS px. A band holds one row of
/// tabs; the bound keeps a bad value from pushing the launcher panel off the
/// window.
#[cfg(any(target_os = "macos", test))]
const MAX_BAND_HEIGHT: f64 = 200.0;

/// The room the page keeps between the zoom button and its first control, in
/// points, about the spacing AppKit leaves between the traffic lights.
#[cfg(any(target_os = "macos", test))]
const CONTROLS_PADDING: f64 = 8.0;

/// What both commands answer: the window's title bar mode and the room the
/// page must leave for the window controls. Lengths are CSS px of the calling
/// page, converted from AppKit points through the page zoom. Field names are
/// the page-side contract.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TitlebarChrome {
    /// The title bar is transparent over the page for the calling window.
    pub(crate) active: bool,
    /// The width the bar keeps free at its left edge for the traffic lights;
    /// 0 when inactive or fullscreen.
    pub(crate) inset_left: f64,
    /// The width the bar keeps free at its right edge; 0 on macOS.
    pub(crate) inset_right: f64,
    /// The distance from the top of the page to the traffic lights' vertical
    /// centre; 0 when inactive or when they are hidden (fullscreen).
    pub(crate) controls_center_y: f64,
    /// The window is fullscreen.
    pub(crate) fullscreen: bool,
}

/// The windows whose title bar hosts their page's tab bar, by native label.
#[derive(Default)]
pub(crate) struct TitlebarWindows(Mutex<HashMap<String, Record>>);

/// One window in the mode. Only macOS records one; the type exists on every
/// platform so that its readers need no platform split.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Debug)]
struct Record {
    /// The origin of the page that turned the mode on.
    origin: url::Origin,
    /// The band the page draws its bar in, CSS px.
    band_height: f64,
    /// The height of this window's title bar in its normal style, points.
    title_bar_height: f64,
}

impl TitlebarWindows {
    /// The normal title bar height of a window in the mode, in points;
    /// `None` for every other window.
    pub(crate) fn title_bar_height(&self, label: &str) -> Option<f64> {
        let windows = self.0.lock().unwrap_or_else(|e| e.into_inner());
        windows.get(label).map(|record| record.title_bar_height)
    }

    /// Drop a destroyed window's record.
    pub(crate) fn forget(&self, label: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }
}

#[cfg(any(target_os = "macos", test))]
impl TitlebarWindows {
    /// Put `label` in the mode, or update the band of a window already in it.
    fn enable(&self, label: &str, record: Record) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(label.to_string(), record);
    }

    /// Take `label` out of the mode; `true` when it was in it.
    fn disable(&self, label: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label)
            .is_some()
    }

    fn is_active(&self, label: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(label)
    }

    /// The band of a window in the mode, CSS px.
    fn band_height(&self, label: &str) -> Option<f64> {
        let windows = self.0.lock().unwrap_or_else(|e| e.into_inner());
        windows.get(label).map(|record| record.band_height)
    }

    /// A page load starts in `label`: the window leaves the mode unless the
    /// page comes from the origin that turned it on. `true` when it left, so
    /// its title bar is due its normal look.
    fn drop_for_load(&self, label: &str, loading: &url::Origin) -> bool {
        let mut windows = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match windows.get(label) {
            Some(record) if !keeps_mode(&record.origin, loading) => {
                windows.remove(label);
                true
            }
            _ => false,
        }
    }
}

/// Whether a page loading from `loading` keeps the mode a page from `enabled`
/// turned on: only a page of the same scheme, host and port does. An opaque
/// origin, such as a bundled local page, matches nothing, itself included.
#[cfg(any(target_os = "macos", test))]
fn keeps_mode(enabled: &url::Origin, loading: &url::Origin) -> bool {
    enabled.is_tuple() && enabled == loading
}

/// The content height, in points, a window would have under its normal title
/// bar, from its current content height and, for a window in the mode, its
/// normal title bar height. In the mode the content runs under the title bar,
/// so it is taller by the title bar; in fullscreen the content fills the
/// screen under either title bar.
pub(crate) fn normal_inner_height(
    inner_height: f64,
    overlay_title_bar: Option<f64>,
    fullscreen: bool,
) -> f64 {
    match overlay_title_bar {
        Some(title_bar) if !fullscreen => (inner_height - title_bar).max(0.0),
        _ => inner_height,
    }
}

/// Check the band a page asks for, in CSS px.
#[cfg(any(target_os = "macos", test))]
fn checked_band_height(band_height: f64) -> Result<f64, String> {
    if band_height.is_finite() && (0.0..=MAX_BAND_HEIGHT).contains(&band_height) {
        Ok(band_height)
    } else {
        Err(format!(
            "bandHeight must be between 0 and {MAX_BAND_HEIGHT} CSS px, got {band_height}"
        ))
    }
}

/// A page zoom usable as a factor: the zoom, or 1 when it is unreadable.
#[cfg(any(target_os = "macos", test))]
fn usable_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() && zoom > 0.0 {
        zoom
    } else {
        1.0
    }
}

/// The band's height in points, the unit the launcher panel is laid out in.
#[cfg(any(target_os = "macos", test))]
fn band_points(band_height: f64, zoom: f64) -> f64 {
    band_height * usable_zoom(zoom)
}

/// Where AppKit has the traffic lights, in points from the window's top-left
/// corner.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct Controls {
    /// The zoom button's right edge.
    right: f64,
    /// The close button's vertical centre.
    center_y: f64,
}

/// The chrome a window answers, from its mode, AppKit's report and the page
/// zoom. A window without traffic lights leaves the page no room to keep.
#[cfg(any(target_os = "macos", test))]
fn chrome_for(
    active: bool,
    fullscreen: bool,
    controls: Option<Controls>,
    zoom: f64,
) -> TitlebarChrome {
    let zoom = usable_zoom(zoom);
    let (inset_left, controls_center_y) = match controls {
        Some(controls) if active && !fullscreen => (
            (controls.right + CONTROLS_PADDING) / zoom,
            controls.center_y / zoom,
        ),
        _ => (0.0, 0.0),
    };
    TitlebarChrome {
        active,
        inset_left,
        inset_right: 0.0,
        controls_center_y,
        fullscreen,
    }
}

/// Turn the calling window's title bar over to its page's tab bar
/// (`enabled`), or give it its normal look back. `bandHeight` is the bar's
/// height in CSS px; the launcher panel stays below it. Off macOS this answers
/// an inactive chrome and changes nothing.
#[tauri::command]
pub(crate) async fn set_titlebar_tabs(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
    band_height: f64,
) -> Result<TitlebarChrome, String> {
    #[cfg(target_os = "macos")]
    {
        let band_height = if enabled {
            checked_band_height(band_height)?
        } else {
            0.0
        };
        let origin = window
            .url()
            .map_err(|e| format!("reading the page of {}: {e}", window.label()))?
            .origin();
        crate::window_ops::on_main(&app, move || switch(&window, enabled, band_height, origin))
            .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, enabled, band_height);
        Ok(TitlebarChrome::default())
    }
}

/// The calling window's title bar mode and the room its page must leave for
/// the window controls, read fresh: the page asks after its viewport resizes.
/// Off macOS this answers an inactive chrome.
#[tauri::command]
pub(crate) async fn titlebar_chrome(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<TitlebarChrome, String> {
    #[cfg(target_os = "macos")]
    {
        crate::window_ops::on_main(&app, move || measure(&window)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window);
        Ok(TitlebarChrome::default())
    }
}

/// The stored preference.
fn read_preference(store: &Mutex<ConfigStore>) -> Result<bool, String> {
    let store = store.lock().unwrap_or_else(|e| e.into_inner());
    let cfg = store
        .get()
        .map_err(|e| format!("reading the desktop config: {e}"))?;
    Ok(cfg.titlebar_tabs)
}

/// Store the preference. An unchanged value writes nothing.
fn write_preference(store: &Mutex<ConfigStore>, on: bool) -> Result<(), String> {
    let mut store = store.lock().unwrap_or_else(|e| e.into_inner());
    let mut cfg = store
        .get()
        .map_err(|e| format!("reading the desktop config: {e}"))?;
    if cfg.titlebar_tabs == on {
        return Ok(());
    }
    cfg.titlebar_tabs = on;
    store
        .save(&cfg)
        .map_err(|e| format!("saving the desktop config: {e}"))
}

/// Tell every window the preference.
fn publish_preference<R: tauri::Runtime>(app: &AppHandle<R>, on: bool) {
    if let Err(e) = app.emit(PREFERENCE_EVENT, PreferencePayload { on }) {
        tracing::warn!(error = %e, "publishing the title bar tabs preference failed");
    }
}

/// Whether a window's page puts its tab bar in the title bar: the desktop's
/// own preference, which a page reads once at load.
#[tauri::command]
pub(crate) fn titlebar_tabs_preference(state: State<Arc<AppState>>) -> Result<bool, String> {
    read_preference(&state.store)
}

/// Store the Settings toggle and tell every window, which each switches its
/// title bar on hearing; answers the stored value.
#[tauri::command]
pub(crate) fn set_titlebar_tabs_preference(
    app: AppHandle,
    state: State<Arc<AppState>>,
    on: bool,
) -> Result<bool, String> {
    write_preference(&state.store, on)?;
    publish_preference(&app, on);
    Ok(on)
}

/// The window's Computers launcher was shown or hidden. The page hides its tab
/// bar's contents while the launcher covers it (it reads the launcher's
/// `data-launcher-shown` mark on its root), so a window in the mode shows its
/// title in the title bar for as long as the launcher does, in AppKit's own
/// place and look, and follows every retitle. Main thread.
pub(crate) fn launcher_visibility_changed<R: tauri::Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    {
        let Some(state) = window.try_state::<Arc<AppState>>() else {
            return;
        };
        if state.titlebar_windows.is_active(window.label()) {
            let shown = crate::launcher_panel::panel_is_visible(window.label());
            appkit::set_title_shown(window, shown);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// A page load starts in `window`: a page from another origin than the one
/// that turned the mode on gets the normal title bar back before it lays out.
/// A reload of the same origin keeps the mode, so the page's bar does not
/// flash away and back.
pub(crate) fn page_load_started(window: &WebviewWindow, url: &tauri::Url) {
    #[cfg(target_os = "macos")]
    {
        let Some(state) = window.try_state::<Arc<AppState>>() else {
            return;
        };
        if !state
            .titlebar_windows
            .drop_for_load(window.label(), &url.origin())
        {
            return;
        }
        tracing::debug!(
            window = window.label(),
            origin = %url.origin().ascii_serialization(),
            "a page from another origin is loading; the title bar returns to normal"
        );
        let host = window.clone();
        let _ = window.run_on_main_thread(move || {
            appkit::set_overlay(&host, false);
            crate::launcher_panel::sync_for_host(&host);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, url);
}

/// The page zoom of `window` changed: a launcher panel below the band follows
/// the band's new height in points.
pub(crate) fn zoom_changed(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let active = window
            .try_state::<Arc<AppState>>()
            .is_some_and(|state| state.titlebar_windows.is_active(window.label()));
        if active {
            let host = window.clone();
            let _ = window.run_on_main_thread(move || crate::launcher_panel::sync_for_host(&host));
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// The band the launcher panel leaves to `host`'s page, in points: the band
/// of a window whose title bar hosts its page's tab bar, 0 for every other
/// window. Main thread, where the page zoom reads live.
#[cfg(target_os = "macos")]
pub(crate) fn launcher_top_inset(host: &WebviewWindow) -> f64 {
    let band = host
        .try_state::<Arc<AppState>>()
        .and_then(|state| state.titlebar_windows.band_height(host.label()));
    match band {
        Some(band) => band_points(band, page_zoom(host)),
        None => 0.0,
    }
}

/// Switch the mode and answer the resulting chrome. Main thread.
#[cfg(target_os = "macos")]
fn switch(
    window: &WebviewWindow,
    enabled: bool,
    band_height: f64,
    origin: url::Origin,
) -> TitlebarChrome {
    if let Some(state) = window.try_state::<Arc<AppState>>() {
        let label = window.label();
        if enabled {
            // What the hide-time capture subtracts; the reading holds in
            // either style.
            let title_bar_height = appkit::normal_title_bar_height(window).unwrap_or(0.0);
            // Recorded before the switch, so the launcher's relayout below and
            // any resize the switch causes already read the band.
            state.titlebar_windows.enable(
                label,
                Record {
                    origin,
                    band_height,
                    title_bar_height,
                },
            );
            appkit::set_overlay(window, true);
            // A window entering the mode under its shown launcher keeps its
            // title until the launcher hides.
            if crate::launcher_panel::panel_is_visible(label) {
                appkit::set_title_shown(window, true);
            }
            crate::launcher_panel::sync_for_host(window);
        } else if state.titlebar_windows.disable(label) {
            appkit::set_overlay(window, false);
            crate::launcher_panel::sync_for_host(window);
        }
    }
    measure(window)
}

/// The chrome of `window` as it is now. Main thread.
#[cfg(target_os = "macos")]
fn measure(window: &WebviewWindow) -> TitlebarChrome {
    let active = window
        .try_state::<Arc<AppState>>()
        .is_some_and(|state| state.titlebar_windows.is_active(window.label()));
    let fullscreen = appkit::is_fullscreen(window);
    let controls = if active && !fullscreen {
        appkit::controls(window)
    } else {
        None
    };
    chrome_for(active, fullscreen, controls, page_zoom(window))
}

/// The page zoom of `window`. WebKit's own value is read on the main thread,
/// so a zoom from Tauri's wheel and key polyfill, which the desktop's zoom
/// tracking never sees, counts too; elsewhere the tracked zoom stands in.
#[cfg(target_os = "macos")]
fn page_zoom(window: &WebviewWindow) -> f64 {
    appkit::page_zoom(window).unwrap_or_else(|| {
        window
            .try_state::<Arc<AppState>>()
            .map(|state| crate::current_zoom(&state, window.label()))
            .unwrap_or(1.0)
    })
}

/// The AppKit side of the switch. Main thread only, like every AppKit call;
/// each function checks and does nothing elsewhere.
#[cfg(target_os = "macos")]
mod appkit {
    use objc2::encode::{Encode, Encoding};
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use tauri::WebviewWindow;

    use super::Controls;

    /// `NSWindowStyleMaskFullScreen`.
    const FULL_SCREEN: usize = 1 << 14;
    /// `NSWindowStyleMaskFullSizeContentView`.
    const FULL_SIZE_CONTENT_VIEW: usize = 1 << 15;
    /// `NSWindowTitleVisible`.
    const TITLE_VISIBLE: isize = 0;
    /// `NSWindowTitleHidden`.
    const TITLE_HIDDEN: isize = 1;
    /// `NSWindowCloseButton`.
    const CLOSE_BUTTON: usize = 0;
    /// `NSWindowZoomButton`.
    const ZOOM_BUTTON: usize = 2;

    // NSRect is CGRect on 64-bit macOS. The three structs are encoded as Core
    // Graphics declares them, so the message checks objc2 runs in debug builds
    // accept each call.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    // SAFETY: two CGFloats, `{CGPoint=dd}`.
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    // SAFETY: two CGFloats, `{CGSize=dd}`.
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    // SAFETY: a CGPoint then a CGSize, `{CGRect={CGPoint=dd}{CGSize=dd}}`.
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding =
            Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    /// Run `f` with the window's NSWindow, on the main thread only.
    fn with_ns_window<R: tauri::Runtime, T>(
        window: &WebviewWindow<R>,
        f: impl FnOnce(&AnyObject) -> Option<T>,
    ) -> Option<T> {
        objc2::MainThreadMarker::new()?;
        let ns_window = window.ns_window().ok()?;
        // SAFETY: on the main thread (checked above), and `ns_window` is the
        // live NSWindow Tauri owns for this window, borrowed for this call.
        let ns_window = unsafe { ns_window.cast::<AnyObject>().as_ref() }?;
        f(ns_window)
    }

    /// Whether the window's style carries the fullscreen bit, which AppKit
    /// sets for a window in fullscreen.
    pub(super) fn is_fullscreen(window: &WebviewWindow) -> bool {
        with_ns_window(window, |ns_window| {
            // SAFETY: `styleMask` is an NSUInteger property of NSWindow.
            let mask: usize = unsafe { msg_send![ns_window, styleMask] };
            Some(mask & FULL_SCREEN != 0)
        })
        .unwrap_or(false)
    }

    /// The height of the window's title bar in the normal titled style, in
    /// points, whatever style the window has now.
    pub(super) fn normal_title_bar_height(window: &WebviewWindow) -> Option<f64> {
        let class = AnyClass::get(c"NSWindow")?;
        with_ns_window(window, |ns_window| {
            // SAFETY: `frame` and `styleMask` are NSWindow properties of the
            // declared types, and `contentRectForFrameRect:styleMask:` is the
            // NSWindow class method taking an NSRect and an NSUInteger.
            unsafe {
                let frame: CGRect = msg_send![ns_window, frame];
                let mask: usize = msg_send![ns_window, styleMask];
                let normal = mask & !(FULL_SIZE_CONTENT_VIEW | FULL_SCREEN);
                let content: CGRect =
                    msg_send![class, contentRectForFrameRect: frame, styleMask: normal];
                Some(frame.size.height - content.size.height)
            }
        })
    }

    /// Where AppKit has the traffic lights; `None` for a window without them.
    pub(super) fn controls(window: &WebviewWindow) -> Option<Controls> {
        with_ns_window(window, |ns_window| {
            // SAFETY: `standardWindowButton:` takes an NSWindowButton and
            // returns a borrowed NSButton or nil; `bounds` and
            // `convertRect:toView:` are NSView methods, a nil view meaning
            // the window's own coordinates.
            unsafe {
                let frame: CGRect = msg_send![ns_window, frame];
                let close: *mut AnyObject =
                    msg_send![ns_window, standardWindowButton: CLOSE_BUTTON];
                let zoom: *mut AnyObject = msg_send![ns_window, standardWindowButton: ZOOM_BUTTON];
                let in_window = |button: &AnyObject| -> CGRect {
                    let bounds: CGRect = msg_send![button, bounds];
                    msg_send![button, convertRect: bounds, toView: None::<&AnyObject>]
                };
                let close = in_window(close.as_ref()?);
                let zoom = in_window(zoom.as_ref()?);
                Some(Controls {
                    right: zoom.origin.x + zoom.size.width,
                    // Window coordinates run up from the bottom edge; the
                    // content view starts at the window's top in the mode.
                    center_y: frame.size.height - (close.origin.y + close.size.height / 2.0),
                })
            }
        })
    }

    /// WebKit's page zoom of the window's webview, which wry sets for every
    /// zoom. `None` off the main thread, where the read would only be queued.
    pub(super) fn page_zoom(window: &WebviewWindow) -> Option<f64> {
        objc2::MainThreadMarker::new()?;
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .with_webview(move |webview| {
                // SAFETY: on macOS `inner` is the window's live WKWebView, and
                // `pageZoom` is a CGFloat property of WKWebView.
                let zoom = unsafe {
                    webview
                        .inner()
                        .cast::<AnyObject>()
                        .as_ref()
                        .map(|webview| -> f64 { msg_send![webview, pageZoom] })
                };
                let _ = tx.send(zoom);
            })
            .ok()?;
        // On the main thread Tauri runs the closure before returning.
        rx.try_recv().ok().flatten()
    }

    /// Show or hide the window's title, which AppKit draws centred in the
    /// title bar, over the page in the mode.
    pub(super) fn set_title_shown<R: tauri::Runtime>(window: &WebviewWindow<R>, shown: bool) {
        with_ns_window(window, |ns_window| {
            let visibility = if shown { TITLE_VISIBLE } else { TITLE_HIDDEN };
            // SAFETY: `setTitleVisibility:` is an NSWindow method taking an
            // NSWindowTitleVisibility, an NSInteger.
            let _: () = unsafe { msg_send![ns_window, setTitleVisibility: visibility] };
            Some(())
        });
    }

    /// Give the window's title bar to its page's tab bar (`on`), or its
    /// normal look back: the full-size content view, a transparent title bar
    /// with no title text, and no opaque layer under it; or none of them.
    pub(super) fn set_overlay(window: &WebviewWindow, on: bool) {
        let switched = with_ns_window(window, |ns_window| {
            // SAFETY: each selector is an NSWindow method taking and returning
            // the declared types; the first responder is retained across the
            // style change and handed back as an NSResponder.
            unsafe {
                // A style mask change can move the first responder off the
                // page, which would leave the terminal deaf to the keyboard.
                let responder: Option<Retained<AnyObject>> = msg_send![ns_window, firstResponder];
                let mask: usize = msg_send![ns_window, styleMask];
                let next = if on {
                    mask | FULL_SIZE_CONTENT_VIEW
                } else {
                    mask & !FULL_SIZE_CONTENT_VIEW
                };
                if next != mask {
                    let _: () = msg_send![ns_window, setStyleMask: next];
                }
                let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: Bool::new(on)];
                let visibility = if on { TITLE_HIDDEN } else { TITLE_VISIBLE };
                let _: () = msg_send![ns_window, setTitleVisibility: visibility];
                if let Some(responder) = responder {
                    let now: *mut AnyObject = msg_send![ns_window, firstResponder];
                    if !std::ptr::eq(now, Retained::as_ptr(&responder)) {
                        let _: Bool = msg_send![ns_window, makeFirstResponder: &*responder];
                    }
                }
            }
            Some(())
        });
        if switched.is_none() {
            return;
        }
        if on {
            crate::serve::clear_title_bar_backdrop(window);
        } else {
            crate::serve::keep_title_bar_opaque(window);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(url: &str) -> url::Origin {
        url::Url::parse(url).expect("test URL parses").origin()
    }

    fn record(page: &str, band_height: f64, title_bar_height: f64) -> Record {
        Record {
            origin: origin(page),
            band_height,
            title_bar_height,
        }
    }

    #[test]
    fn the_preference_defaults_off_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = Mutex::new(ConfigStore::at_path(path.clone()));
        assert!(
            !read_preference(&store).unwrap(),
            "off until the user turns it on"
        );
        write_preference(&store, false).unwrap();
        assert!(!path.exists(), "an unchanged value writes nothing");
        write_preference(&store, true).unwrap();
        assert!(read_preference(&store).unwrap());
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["titlebar_tabs"], true, "stored under its config key");
        write_preference(&store, false).unwrap();
        assert!(!read_preference(&store).unwrap());
    }

    #[test]
    fn a_config_without_the_preference_reads_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"launcher_theme":"dark"}"#).unwrap();
        let store = Mutex::new(ConfigStore::at_path(path));
        assert!(!read_preference(&store).unwrap());
    }

    #[test]
    fn the_preference_reaches_every_window_as_an_event() {
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        app.listen_any(PREFERENCE_EVENT, move |event| {
            sink.lock().unwrap().push(event.payload().to_string());
        });
        publish_preference(app.handle(), true);
        publish_preference(app.handle(), false);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![r#"{"on":true}"#.to_string(), r#"{"on":false}"#.to_string()],
            "the payload is the page's contract"
        );
    }

    /// The field names are the page's contract: `api/desktop.ts` reads these
    /// five keys and nothing else.
    #[test]
    fn the_chrome_serializes_the_contract_fields() {
        let chrome = TitlebarChrome {
            active: true,
            inset_left: 78.0,
            inset_right: 0.0,
            controls_center_y: 14.0,
            fullscreen: false,
        };
        let value = serde_json::to_value(chrome).expect("chrome serializes");
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("chrome is an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "active",
                "controlsCenterY",
                "fullscreen",
                "insetLeft",
                "insetRight"
            ]
        );
        assert_eq!(value["insetLeft"], 78.0);
        assert_eq!(value["controlsCenterY"], 14.0);
        let inactive = serde_json::to_value(TitlebarChrome::default()).expect("serializes");
        assert_eq!(
            inactive,
            serde_json::json!({
                "active": false,
                "insetLeft": 0.0,
                "insetRight": 0.0,
                "controlsCenterY": 0.0,
                "fullscreen": false,
            })
        );
    }

    #[test]
    fn the_chrome_converts_points_to_the_pages_css_px() {
        let controls = Some(Controls {
            right: 70.0,
            center_y: 15.0,
        });
        let at_100 = chrome_for(true, false, controls, 1.0);
        assert_eq!(
            at_100,
            TitlebarChrome {
                active: true,
                inset_left: 78.0,
                inset_right: 0.0,
                controls_center_y: 15.0,
                fullscreen: false,
            }
        );
        // A zoomed-in page has fewer, larger CSS px over the same points.
        let at_125 = chrome_for(true, false, controls, 1.25);
        assert_eq!(at_125.inset_left, 78.0 / 1.25);
        assert_eq!(at_125.controls_center_y, 12.0);
        let at_50 = chrome_for(true, false, controls, 0.5);
        assert_eq!(at_50.inset_left, 156.0);
        assert_eq!(at_50.controls_center_y, 30.0);
    }

    #[test]
    fn fullscreen_and_inactive_windows_keep_no_room() {
        let controls = Some(Controls {
            right: 70.0,
            center_y: 15.0,
        });
        assert_eq!(
            chrome_for(true, true, controls, 1.0),
            TitlebarChrome {
                active: true,
                fullscreen: true,
                ..TitlebarChrome::default()
            }
        );
        assert_eq!(
            chrome_for(false, false, controls, 1.0),
            TitlebarChrome::default()
        );
        assert_eq!(
            chrome_for(false, true, None, 1.0),
            TitlebarChrome {
                fullscreen: true,
                ..TitlebarChrome::default()
            }
        );
        // No traffic lights to avoid: active, nothing to keep.
        assert_eq!(
            chrome_for(true, false, None, 1.0),
            TitlebarChrome {
                active: true,
                ..TitlebarChrome::default()
            }
        );
    }

    #[test]
    fn an_unreadable_zoom_counts_as_100_percent() {
        let controls = Some(Controls {
            right: 70.0,
            center_y: 15.0,
        });
        for zoom in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(chrome_for(true, false, controls, zoom).inset_left, 78.0);
            assert_eq!(band_points(36.0, zoom), 36.0);
        }
    }

    #[test]
    fn the_launcher_band_is_the_pages_band_in_points() {
        assert_eq!(band_points(36.0, 1.0), 36.0);
        assert_eq!(band_points(36.0, 1.5), 54.0);
        assert_eq!(band_points(40.0, 0.5), 20.0);
    }

    #[test]
    fn the_band_height_is_bounded() {
        for ok in [0.0, 36.0, MAX_BAND_HEIGHT] {
            assert_eq!(checked_band_height(ok), Ok(ok));
        }
        for bad in [-1.0, MAX_BAND_HEIGHT + 1.0, f64::NAN, f64::INFINITY] {
            assert!(checked_band_height(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn only_a_page_of_the_same_origin_keeps_the_mode() {
        let enabled = origin("http://127.0.0.1:4090/api/w-1/index.html?t=x&w=w-1");
        for same in [
            "http://127.0.0.1:4090/api/w-1/index.html?t=y&w=w-1",
            "http://127.0.0.1:4090/other",
        ] {
            assert!(keeps_mode(&enabled, &origin(same)), "{same}");
        }
        for other in [
            "http://127.0.0.1:4091/api/w-1/index.html",
            "http://localhost:4090/api/w-1/index.html",
            "https://127.0.0.1:4090/api/w-1/index.html",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/",
            "tauri://localhost/connecting.html",
            "about:blank",
        ] {
            assert!(!keeps_mode(&enabled, &origin(other)), "{other}");
        }
        // An opaque origin never keeps a mode, not even its own.
        let local = origin("tauri://localhost/connecting.html");
        assert!(!keeps_mode(&local, &local.clone()));
    }

    #[test]
    fn a_window_leaves_the_mode_on_a_load_from_another_origin() {
        let windows = TitlebarWindows::default();
        let page = "http://127.0.0.1:4090/api/w-1/index.html";
        windows.enable("local::w-1", record(page, 36.0, 28.0));
        assert!(windows.is_active("local::w-1"));
        assert_eq!(windows.band_height("local::w-1"), Some(36.0));
        assert_eq!(windows.title_bar_height("local::w-1"), Some(28.0));

        // A reload of the same origin keeps it.
        assert!(!windows.drop_for_load("local::w-1", &origin(page)));
        assert!(windows.is_active("local::w-1"));

        // A load from elsewhere drops it once.
        let elsewhere = origin("http://127.0.0.1:5000/");
        assert!(windows.drop_for_load("local::w-1", &elsewhere));
        assert!(!windows.is_active("local::w-1"));
        assert!(!windows.drop_for_load("local::w-1", &elsewhere));
        assert_eq!(windows.title_bar_height("local::w-1"), None);

        // A window never in the mode has nothing to drop.
        assert!(!windows.drop_for_load("local::w-2", &elsewhere));
    }

    #[test]
    fn records_are_per_window_and_go_with_the_window() {
        let windows = TitlebarWindows::default();
        let page = "http://127.0.0.1:4090/";
        windows.enable("local::w-1", record(page, 36.0, 28.0));
        windows.enable("lib-0a1b::w-1", record(page, 40.0, 28.0));
        // A second enable updates the band.
        windows.enable("local::w-1", record(page, 44.0, 28.0));
        assert_eq!(windows.band_height("local::w-1"), Some(44.0));
        assert_eq!(windows.band_height("lib-0a1b::w-1"), Some(40.0));

        assert!(windows.disable("local::w-1"));
        assert!(
            !windows.disable("local::w-1"),
            "a second disable has nothing to undo"
        );
        assert!(windows.is_active("lib-0a1b::w-1"));

        windows.forget("lib-0a1b::w-1");
        assert!(!windows.is_active("lib-0a1b::w-1"));
        assert_eq!(windows.title_bar_height("lib-0a1b::w-1"), None);
    }

    #[test]
    fn the_stored_height_is_the_normal_title_bar_height() {
        // Not in the mode: the content height as it is.
        assert_eq!(normal_inner_height(772.0, None, false), 772.0);
        // In the mode the content runs under the 28 pt title bar.
        assert_eq!(normal_inner_height(800.0, Some(28.0), false), 772.0);
        // Fullscreen content fills the screen under either title bar.
        assert_eq!(normal_inner_height(1117.0, Some(28.0), true), 1117.0);
        assert_eq!(normal_inner_height(10.0, Some(28.0), false), 0.0);
    }

    /// The drift the capture correction prevents. A window in the mode reports
    /// its content under the title bar, and a rebuilt window starts with the
    /// normal title bar and restores the stored height as its content height,
    /// so storing the reported height grows the window by the title bar on
    /// every hide and rebuild. Modelled on AppKit: a normal window's frame is
    /// its content plus the title bar, and in the mode the content is the
    /// whole frame.
    #[test]
    fn hiding_and_rebuilding_a_window_in_the_mode_keeps_its_size() {
        const TITLE_BAR: f64 = 28.0;
        let cycle = |stored: f64, corrected: bool| -> f64 {
            // Rebuilt with a normal title bar, at the stored content height.
            let frame = stored + TITLE_BAR;
            // The page turns the mode on: the frame stays, the content grows.
            let reported = frame;
            if corrected {
                normal_inner_height(reported, Some(TITLE_BAR), false)
            } else {
                reported
            }
        };

        let mut stored = 772.0;
        for _ in 0..5 {
            stored = cycle(stored, true);
        }
        assert_eq!(stored, 772.0, "the window keeps its size across rebuilds");

        // Non-vacuity: without the correction the same cycles grow it.
        let mut drifting = 772.0;
        for _ in 0..5 {
            drifting = cycle(drifting, false);
        }
        assert_eq!(drifting, 772.0 + 5.0 * TITLE_BAR);
    }

    fn production(src: &'static str) -> &'static str {
        src.split_once("\n#[cfg(test)]\nmod tests {")
            .expect("the test module separates the production code")
            .0
    }

    fn function<'a>(src: &'a str, signature: &str) -> &'a str {
        let (_, rest) = src
            .split_once(signature)
            .unwrap_or_else(|| panic!("{signature} exists"));
        rest.split_once("\n}\n")
            .expect("the function ends at a column-0 brace")
            .0
    }

    /// The three readers of the record, pinned in the source because each
    /// needs a live native window to run.
    #[test]
    fn the_record_reaches_the_capture_the_launcher_and_destruction() {
        const SERVE_RS: &str = include_str!("serve.rs");
        const LAUNCHER_RS: &str = include_str!("launcher_panel.rs");
        let serve = production(SERVE_RS);

        let capture = function(serve, "\npub(crate) fn capture_window_geometry(");
        assert!(capture.contains("crate::titlebar_tabs::normal_inner_height("));
        assert!(capture.contains("titlebar_windows.title_bar_height(label)"));
        assert!(capture.contains("let ph = height.round() as u32;"));

        let destroyed = function(serve, "\nfn on_destroyed(");
        assert!(destroyed.contains("state.titlebar_windows.forget(label);"));

        let build = function(serve, "\nfn build_workspace_window_with_completion(");
        let hook = build
            .split_once(".on_page_load(")
            .expect("every window build registers a page-load hook")
            .1;
        assert!(hook.contains("PageLoadEvent::Started"));
        assert!(hook.contains("crate::titlebar_tabs::page_load_started("));

        let launcher = production(LAUNCHER_RS);
        let bounds = function(launcher, "\nfn content_bounds(");
        assert!(bounds.contains("crate::titlebar_tabs::launcher_top_inset(host)"));
        let park = function(launcher, "\nfn park(");
        assert!(park.contains("crate::titlebar_tabs::launcher_top_inset(host)"));
    }

    /// Every change of the launcher's visible set reaches the title bar, so a
    /// window in the mode shows its title exactly while its launcher shows.
    #[test]
    fn every_launcher_show_and_hide_reaches_the_title() {
        const LAUNCHER_RS: &str = include_str!("launcher_panel.rs");
        let launcher = production(LAUNCHER_RS);
        for (name, after) in [
            (
                "\nfn show_now(",
                "set(&VISIBLE).lock().unwrap().insert(label);",
            ),
            (
                "\nfn hide_now(",
                "set(&VISIBLE).lock().unwrap().remove(host);",
            ),
            (
                "\npub(crate) fn close_for_host<",
                "let was_visible = set(&VISIBLE).lock().unwrap().remove(host);",
            ),
        ] {
            let body = function(launcher, name);
            let (_, rest) = body
                .split_once(after)
                .unwrap_or_else(|| panic!("{name} changes the visible set"));
            assert!(
                rest.contains("crate::titlebar_tabs::launcher_visibility_changed("),
                "{name} tells the title bar after the visible set changes"
            );
        }
        assert_eq!(
            LAUNCHER_RS
                .matches("set(&VISIBLE).lock().unwrap().insert(")
                .count()
                + LAUNCHER_RS
                    .matches("set(&VISIBLE).lock().unwrap().remove(")
                    .count(),
            3,
            "no other path changes the visible set"
        );
    }

    /// The switch and every measurement run on the main thread, which AppKit
    /// requires and which makes the WebKit zoom read synchronous.
    #[test]
    fn both_commands_run_their_appkit_work_on_the_main_thread() {
        const SELF_RS: &str = include_str!("titlebar_tabs.rs");
        let module = production(SELF_RS);
        let set = function(module, "\npub(crate) async fn set_titlebar_tabs(");
        assert!(set.contains("crate::window_ops::on_main(&app, move ||"));
        assert!(set.contains("switch(&window, enabled, band_height, origin)"));
        let chrome = function(module, "\npub(crate) async fn titlebar_chrome(");
        assert!(chrome.contains("crate::window_ops::on_main(&app, move || measure(&window))"));
        let loaded = function(module, "\npub(crate) fn page_load_started(");
        assert!(loaded.contains("window.run_on_main_thread(move ||"));
    }
}
