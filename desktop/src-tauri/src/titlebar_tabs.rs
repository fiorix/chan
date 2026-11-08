//! A page's tab bar in the window's title bar, on macOS and Windows.
//!
//! A page that draws a tab bar across the top of its window asks for the
//! title bar's band with [`set_titlebar_tabs`]. The answer, a
//! [`TitlebarChrome`], says in the page's own CSS px how much room the window
//! controls take and whether the page draws them itself, and the page asks
//! again with [`titlebar_chrome`] whenever its viewport resizes, which a
//! fullscreen transition, a maximize, a restore and a zoom change all do. The
//! desktop never turns the mode on by itself, and a page load from another
//! origin than the page that turned it on turns it off, so a page that does
//! not know this contract is never laid out under the window controls. On the
//! GTK desktops both commands answer an inactive chrome and change nothing.
//!
//! On macOS the title bar turns transparent, the window's content view runs
//! under it (the full-size content view), and the title text hides; the
//! traffic lights stay where AppKit puts them. The switch is made with AppKit
//! calls rather than Tauri's `set_title_bar_style`. In tauri-runtime-wry that
//! call's `Visible` arm leaves the full-size content view on, so it cannot give
//! the normal title bar back, and every style mask change tao makes ends by
//! making tao's own view the first responder, a view that is no longer in the
//! window once wry installs the webview's parent as the content view. Here the
//! style mask changes and the page keeps the keyboard.
//!
//! On Windows the window turns frameless and the page draws minimize, maximize
//! or restore, and close at the right end of its bar, three buttons of
//! Windows 11's caption button width, and acts through
//! [`titlebar_window_control`]. tao keeps the caption, sizing, minimize and
//! maximize styles of a window without decorations and changes only the
//! client area it answers `WM_NCCALCSIZE` with (tao 0.37
//! `platform_impl/windows/window_state.rs`, `to_window_styles`, and
//! `event_loop.rs`, `WM_NCCALCSIZE`), so snapping, the minimize and maximize
//! animations and Alt+F4 work as before. With the undecorated shadow the
//! client area keeps the resize frame at the left, right and bottom edges and
//! one DIP at the top on Windows 11 (`util.rs`, `calculate_insets_for_dpi`),
//! where DWM goes on drawing the shadow, the border and the rounded corners;
//! tauri-runtime-wry lays a child window answering `HTTOP` along the top edge,
//! which the webview covers (`undecorated_resizing.rs`). A maximized frameless
//! window's client area is its monitor's work area, so it leaves the taskbar
//! in view. The style change keeps the frame where it is (`apply_diff` sets
//! `SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED`), so the content grows into
//! the band the title bar held and gives it back when the mode ends. The
//! page's maximize button does not open the Windows 11 Snap Layouts flyout,
//! which only a native hit test answering `HTMAXBUTTON` over it brings up.
//!
//! While a window holds the mode, three other parts of the desktop read its
//! record: the hide-time geometry capture stores the height a normal title bar
//! would leave (`serve::capture_window_geometry`, [`title_bar_overlap`]), the
//! launcher panel sits below the band and, on Windows, leaves the window
//! without its menubar (`launcher_panel::content_bounds`,
//! `launcher_panel::sync_launcher_menu`), and window destruction drops it
//! (`serve::on_destroyed`). While the window's Computers launcher shows, the
//! page hides its tab bar's contents and, on macOS, the title bar shows the
//! window's title again ([`launcher_visibility_changed`]).
//!
//! Whether a page asks is the user's choice, the `titlebar_tabs` field of the
//! desktop's own config, off by default. It covers every window the desktop
//! builds, whatever tenant the window shows, so a devserver's preferences play
//! no part. A page reads it with [`titlebar_tabs_preference`], Settings writes
//! it with [`set_titlebar_tabs_preference`], and every window hears the change
//! as [`PREFERENCE_EVENT`] and switches without a reload.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

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
#[cfg(any(target_os = "macos", windows, test))]
const MAX_BAND_HEIGHT: f64 = 200.0;

/// The room the page keeps between the zoom button and its first control, in
/// points, about the spacing AppKit leaves between the traffic lights.
#[cfg(any(target_os = "macos", test))]
const CONTROLS_PADDING: f64 = 8.0;

/// The width of each window control a page draws, in DIP, the width of the
/// caption buttons Windows 11 draws.
#[cfg(any(windows, test))]
const CAPTION_BUTTON_WIDTH: f64 = 46.0;

/// The window controls a page draws: minimize, maximize or restore, and close.
#[cfg(any(windows, test))]
const CAPTION_BUTTONS: f64 = 3.0;

/// What both commands answer: the window's title bar mode, the room the page
/// must leave for the window controls, and whether it draws them. Lengths are
/// CSS px of the calling page, converted from points (macOS) or DIP (Windows)
/// through the page zoom. Field names are the page-side contract.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TitlebarChrome {
    /// The calling window's title bar hosts its page's tab bar.
    pub(crate) active: bool,
    /// The width the bar keeps free at its left edge for the traffic lights;
    /// 0 off macOS, when inactive and in fullscreen.
    pub(crate) inset_left: f64,
    /// The width the bar keeps free at its right edge for the window controls
    /// the page draws; 0 on macOS, when inactive and in fullscreen.
    pub(crate) inset_right: f64,
    /// The distance from the top of the page to the traffic lights' vertical
    /// centre; 0 when the window has none in view (fullscreen) and when the
    /// page draws its own controls, which it centres in the bar.
    pub(crate) controls_center_y: f64,
    /// The window is fullscreen.
    pub(crate) fullscreen: bool,
    /// The page draws minimize, maximize or restore, and close, in that order,
    /// as three equal buttons filling the right inset at the bar's full
    /// height: on Windows in the mode, out of fullscreen.
    pub(crate) draw_controls: bool,
    /// The window is maximized, so the page's maximize button restores.
    pub(crate) maximized: bool,
}

/// The windows whose title bar hosts their page's tab bar, by native label.
#[derive(Default)]
pub(crate) struct TitlebarWindows(Mutex<HashMap<String, Record>>);

/// One window in the mode. Only macOS and Windows record one; the type exists
/// on every platform so that its readers need no platform split.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
#[derive(Clone, Debug)]
struct Record {
    /// The origin of the page that turned the mode on.
    origin: url::Origin,
    /// The band the page draws its bar in, CSS px.
    band_height: f64,
    /// The height of this window's title bar in its normal style, points, on
    /// macOS, where it holds for the window's life. `None` on Windows, where it
    /// follows the window's DPI and is measured when read.
    title_bar_height: Option<f64>,
}

impl TitlebarWindows {
    /// Whether `label`'s title bar hosts its page's tab bar.
    pub(crate) fn is_active(&self, label: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(label)
    }

    /// The recorded normal title bar height of a window in the mode, in
    /// points; `None` for every other window and where it is measured instead.
    fn title_bar_height(&self, label: &str) -> Option<f64> {
        let windows = self.0.lock().unwrap_or_else(|e| e.into_inner());
        windows
            .get(label)
            .and_then(|record| record.title_bar_height)
    }

    /// Drop a destroyed window's record.
    pub(crate) fn forget(&self, label: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }
}

#[cfg(any(target_os = "macos", windows, test))]
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

/// Whether `window`'s title bar hosts its page's tab bar.
pub(crate) fn in_mode(window: &WebviewWindow) -> bool {
    window
        .try_state::<Arc<AppState>>()
        .is_some_and(|state| state.titlebar_windows.is_active(window.label()))
}

/// Whether a page loading from `loading` keeps the mode a page from `enabled`
/// turned on: only a page of the same scheme, host and port does. An opaque
/// origin, such as a bundled local page, matches nothing, itself included.
#[cfg(any(target_os = "macos", windows, test))]
fn keeps_mode(enabled: &url::Origin, loading: &url::Origin) -> bool {
    enabled.is_tuple() && enabled == loading
}

/// The content height, in points, a window would have under its normal title
/// bar, from its current content height and, for a window in the mode, how
/// much taller its content is than that ([`title_bar_overlap`]). In the mode
/// the content runs under the title bar, so it is taller; in fullscreen the
/// content fills the screen under either title bar.
pub(crate) fn normal_inner_height(
    inner_height: f64,
    overlap: Option<f64>,
    fullscreen: bool,
) -> f64 {
    match overlap {
        Some(overlap) if !fullscreen => (inner_height - overlap).max(0.0),
        _ => inner_height,
    }
}

/// How much taller, in points, the content of a window in the mode is than
/// the content its normal title bar leaves; `None` for every other window.
/// macOS records it when the mode turns on. Windows measures it from the
/// window as it is: a Windows title bar follows the window's DPI, and a
/// maximized frameless window's content starts lower in its frame than a
/// restored one's.
pub(crate) fn title_bar_overlap<R: tauri::Runtime>(
    window: &WebviewWindow<R>,
    titlebar_windows: &TitlebarWindows,
) -> Option<f64> {
    let label = window.label();
    if !titlebar_windows.is_active(label) {
        return None;
    }
    let recorded = titlebar_windows.title_bar_height(label);
    #[cfg(windows)]
    let recorded = recorded.or_else(|| win32::title_bar_overlap(window));
    recorded
}

/// The height, in points, by which a frameless window's content runs into the
/// band a normal title bar holds: the top frame a decorated window of the same
/// style has (`decorated_top`) less the top frame the window has now
/// (`top_now`), both in physical px at `scale`.
#[cfg(any(windows, test))]
fn overlap_points(decorated_top: i32, top_now: i32, scale: f64) -> f64 {
    f64::from((decorated_top - top_now).max(0)) / usable_factor(scale)
}

/// Check the band a page asks for, in CSS px.
#[cfg(any(target_os = "macos", windows, test))]
fn checked_band_height(band_height: f64) -> Result<f64, String> {
    if band_height.is_finite() && (0.0..=MAX_BAND_HEIGHT).contains(&band_height) {
        Ok(band_height)
    } else {
        Err(format!(
            "bandHeight must be between 0 and {MAX_BAND_HEIGHT} CSS px, got {band_height}"
        ))
    }
}

/// A page zoom or a window's scale usable as a factor: the value, or 1 when it
/// is unreadable.
#[cfg(any(target_os = "macos", windows, test))]
fn usable_factor(factor: f64) -> f64 {
    if factor.is_finite() && factor > 0.0 {
        factor
    } else {
        1.0
    }
}

/// The band's height in points, the unit the launcher panel is laid out in.
#[cfg(any(target_os = "macos", windows, test))]
fn band_points(band_height: f64, zoom: f64) -> f64 {
    band_height * usable_factor(zoom)
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

/// The chrome a macOS window answers, from its mode and state, AppKit's
/// report and the page zoom. A window without traffic lights leaves the page
/// no room to keep.
#[cfg(any(target_os = "macos", test))]
fn chrome_for(
    active: bool,
    fullscreen: bool,
    maximized: bool,
    controls: Option<Controls>,
    zoom: f64,
) -> TitlebarChrome {
    let zoom = usable_factor(zoom);
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
        draw_controls: false,
        maximized,
    }
}

/// The chrome a window whose page draws the window controls answers, from its
/// mode and state and the page zoom: the three buttons at the right of the
/// bar in the mode, and none in fullscreen, where the window has no controls.
#[cfg(any(windows, test))]
fn drawn_controls_chrome(
    active: bool,
    fullscreen: bool,
    maximized: bool,
    zoom: f64,
) -> TitlebarChrome {
    let draw_controls = active && !fullscreen;
    let inset_right = if draw_controls {
        CAPTION_BUTTONS * CAPTION_BUTTON_WIDTH / usable_factor(zoom)
    } else {
        0.0
    };
    TitlebarChrome {
        active,
        inset_left: 0.0,
        inset_right,
        controls_center_y: 0.0,
        fullscreen,
        draw_controls,
        maximized,
    }
}

/// Turn the calling window's title bar over to its page's tab bar
/// (`enabled`), or give it its normal look back. `bandHeight` is the bar's
/// height in CSS px; the launcher panel stays below it. On the GTK desktops
/// this answers an inactive chrome and changes nothing.
#[tauri::command]
pub(crate) async fn set_titlebar_tabs(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
    band_height: f64,
) -> Result<TitlebarChrome, String> {
    #[cfg(any(target_os = "macos", windows))]
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
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, enabled, band_height);
        Ok(inactive(&window))
    }
}

/// The calling window's title bar mode and the room its page must leave for
/// the window controls, read fresh: the page asks after its viewport resizes.
/// On the GTK desktops this answers an inactive chrome.
#[tauri::command]
pub(crate) async fn titlebar_chrome(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<TitlebarChrome, String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        crate::window_ops::on_main(&app, move || measure(&window)).await
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        Ok(inactive(&window))
    }
}

/// The chrome of a window that never enters the mode.
#[cfg(not(any(target_os = "macos", windows)))]
fn inactive(window: &WebviewWindow) -> TitlebarChrome {
    TitlebarChrome {
        maximized: window.is_maximized().unwrap_or(false),
        ..TitlebarChrome::default()
    }
}

/// A window control a page draws, as [`titlebar_window_control`] names it on
/// the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WindowControl {
    Minimize,
    ToggleMaximize,
    Close,
}

/// Act on the calling window as its own window controls do: minimize it,
/// maximize or restore it, or ask to close it. The close is the request the
/// native close button and Alt+F4 make: tauri-runtime-wry hands
/// `Window::close` and tao's `CloseRequested`, which tao sends on `WM_CLOSE`,
/// to the same `on_close_requested`, so the desktop's close handling
/// (`serve::on_close_requested`: the page's Hide, Close and Cancel prompt, a
/// silent hide, the transfer guards) runs as it does for those.
#[tauri::command]
pub(crate) fn titlebar_window_control(
    window: WebviewWindow,
    action: WindowControl,
) -> Result<(), String> {
    let done = match action {
        WindowControl::Minimize => window.minimize(),
        WindowControl::ToggleMaximize => match window.is_maximized() {
            Ok(true) => window.unmaximize(),
            Ok(false) => window.maximize(),
            Err(e) => Err(e),
        },
        WindowControl::Close => window.close(),
    };
    done.map_err(|e| format!("{action:?} on {}: {e}", window.label()))
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
    #[cfg(any(target_os = "macos", windows))]
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
            set_overlay(&host, false);
            crate::launcher_panel::title_bar_switched(&host);
        });
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (window, url);
}

/// The page zoom of `window` changed: a launcher panel below the band follows
/// the band's new height in points.
pub(crate) fn zoom_changed(window: &WebviewWindow) {
    #[cfg(any(target_os = "macos", windows))]
    if in_mode(window) {
        let host = window.clone();
        let _ = window.run_on_main_thread(move || crate::launcher_panel::sync_for_host(&host));
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = window;
}

/// The band the launcher panel leaves to `host`'s page, in points: the band
/// of a window whose title bar hosts its page's tab bar, 0 for every other
/// window. Main thread, where the page zoom reads live.
#[cfg(any(target_os = "macos", windows))]
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
#[cfg(any(target_os = "macos", windows))]
fn switch(
    window: &WebviewWindow,
    enabled: bool,
    band_height: f64,
    origin: url::Origin,
) -> TitlebarChrome {
    if let Some(state) = window.try_state::<Arc<AppState>>() {
        let label = window.label();
        if enabled {
            // What the hide-time capture subtracts on macOS, where the reading
            // holds in either style; Windows measures it when it is read.
            #[cfg(target_os = "macos")]
            let title_bar_height = Some(appkit::normal_title_bar_height(window).unwrap_or(0.0));
            #[cfg(windows)]
            let title_bar_height = None;
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
            set_overlay(window, true);
            // A window entering the mode under its shown launcher keeps its
            // title until the launcher hides.
            #[cfg(target_os = "macos")]
            if crate::launcher_panel::panel_is_visible(label) {
                appkit::set_title_shown(window, true);
            }
            crate::launcher_panel::title_bar_switched(window);
        } else if state.titlebar_windows.disable(label) {
            set_overlay(window, false);
            crate::launcher_panel::title_bar_switched(window);
        }
    }
    measure(window)
}

/// Give the window's title bar to its page's tab bar (`on`), or its normal
/// look back. Main thread.
#[cfg(any(target_os = "macos", windows))]
fn set_overlay(window: &WebviewWindow, on: bool) {
    #[cfg(target_os = "macos")]
    appkit::set_overlay(window, on);
    #[cfg(windows)]
    win32::set_frameless(window, on);
}

/// The chrome of `window` as it is now. Main thread.
#[cfg(any(target_os = "macos", windows))]
fn measure(window: &WebviewWindow) -> TitlebarChrome {
    let active = in_mode(window);
    let maximized = window.is_maximized().unwrap_or(false);
    #[cfg(target_os = "macos")]
    {
        let fullscreen = appkit::is_fullscreen(window);
        let controls = if active && !fullscreen {
            appkit::controls(window)
        } else {
            None
        };
        chrome_for(active, fullscreen, maximized, controls, page_zoom(window))
    }
    #[cfg(windows)]
    {
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        drawn_controls_chrome(active, fullscreen, maximized, page_zoom(window))
    }
}

/// The page zoom of `window`. The webview's own value is read on the main
/// thread, so a zoom the desktop's zoom tracking never sees counts too (Tauri's
/// wheel and key polyfill on macOS, WebView2's own Ctrl+wheel zoom on
/// Windows); elsewhere the tracked zoom stands in.
#[cfg(any(target_os = "macos", windows))]
fn page_zoom(window: &WebviewWindow) -> f64 {
    #[cfg(target_os = "macos")]
    let native = appkit::page_zoom(window);
    #[cfg(windows)]
    let native = win32::page_zoom(window);
    native.unwrap_or_else(|| {
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

/// The Windows side of the switch. The window calls go through Tauri, which
/// runs them at once on the main thread; the frame measurement reads the
/// window's own rectangles.
#[cfg(windows)]
mod win32 {
    use std::sync::OnceLock;

    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::{BOOL, HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, GetWindowRect, GWL_EXSTYLE, GWL_STYLE, WINDOW_EX_STYLE, WINDOW_STYLE,
        WS_CAPTION, WS_THICKFRAME,
    };

    /// Make the window frameless (`on`), or give it its decorations back.
    /// Each direction acts only on a window in the other state, so a second
    /// enable that updates the band changes nothing native.
    pub(super) fn set_frameless(window: &WebviewWindow, on: bool) {
        let decorated = window.is_decorated().unwrap_or(true);
        let switched = if on && decorated {
            // tao builds every window with the undecorated shadow on; it is
            // set here so the frameless window keeps DWM's frame whatever
            // built it. Only while decorated: on a frameless window
            // tauri-runtime-wry passes the new flag to its top-edge resize
            // child in the wrong message parameter, and the child then
            // claims a border around the whole page
            // (`update_drag_hwnd_rgn_for_undecorated`).
            window
                .set_shadow(true)
                .and_then(|()| window.set_decorations(false))
        } else if !on && !decorated {
            window.set_decorations(true)
        } else {
            Ok(())
        };
        if let Err(e) = switched {
            tracing::warn!(window = window.label(), error = %e, "switching the window frame failed");
        }
    }

    /// WebView2's zoom factor for the window's webview, which wry sets for
    /// every zoom and WebView2 changes itself on Ctrl+wheel. `None` off the
    /// main thread, where the read would only be queued.
    pub(super) fn page_zoom(window: &WebviewWindow) -> Option<f64> {
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .with_webview(move |webview| {
                let mut zoom = 0.0;
                // SAFETY: Tauri runs this on the main thread, which owns the
                // window's WebView2 controller, and `ZoomFactor` writes one
                // double.
                let read = unsafe { webview.controller().ZoomFactor(&mut zoom) };
                let _ = tx.send(read.is_ok().then_some(zoom));
            })
            .ok()?;
        // On the main thread Tauri runs the closure before returning.
        rx.try_recv().ok().flatten()
    }

    /// `AdjustWindowRectExForDpi`, which user32 exports from Windows 10 1607.
    type AdjustWindowRectExForDpi =
        unsafe extern "system" fn(*mut RECT, WINDOW_STYLE, BOOL, WINDOW_EX_STYLE, u32) -> BOOL;

    /// Looked up on first use, as tao and wry look up their DPI functions, so
    /// the binary still loads where user32 lacks it; there the capture goes
    /// without the correction.
    fn adjust_window_rect_ex_for_dpi() -> Option<AdjustWindowRectExForDpi> {
        static FUNCTION: OnceLock<Option<AdjustWindowRectExForDpi>> = OnceLock::new();
        *FUNCTION.get_or_init(|| {
            // SAFETY: user32 is loaded in every process that has a window, and
            // the export, where it exists, has the signature declared above.
            unsafe {
                let user32 = GetModuleHandleW(windows_sys::w!("user32.dll"));
                if user32.is_null() {
                    return None;
                }
                let found = GetProcAddress(user32, windows_sys::s!("AdjustWindowRectExForDpi"))?;
                Some(std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    AdjustWindowRectExForDpi,
                >(found))
            }
        })
    }

    /// How much taller, in points, the window's content is than the content a
    /// normal title bar leaves: the top frame a decorated window of the same
    /// style has at the window's DPI, less the top frame the window has now.
    /// Both readings follow the window's state, so a maximized window, whose
    /// frame hangs above its monitor either way, measures its caption alone.
    /// No menu is counted: the rebuilt window the height is stored for is born
    /// without one. `None` when the window cannot be read.
    pub(super) fn title_bar_overlap<R: tauri::Runtime>(window: &WebviewWindow<R>) -> Option<f64> {
        let adjust = adjust_window_rect_ex_for_dpi()?;
        let hwnd: HWND = window.hwnd().ok()?.0;
        let scale = window.scale_factor().ok()?;
        let dpi = (scale * 96.0).round() as u32;
        // SAFETY: `hwnd` is the window's live handle, and each call writes
        // only the RECT or POINT it is handed.
        let (decorated_top, top_now) = unsafe {
            let style = GetWindowLongW(hwnd, GWL_STYLE) as WINDOW_STYLE;
            let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as WINDOW_EX_STYLE;
            let mut decorated = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if adjust(
                &mut decorated,
                style | WS_CAPTION | WS_THICKFRAME,
                0,
                ex_style,
                dpi,
            ) == 0
            {
                return None;
            }
            let mut frame = decorated;
            let mut origin = POINT { x: 0, y: 0 };
            if GetWindowRect(hwnd, &mut frame) == 0 || ClientToScreen(hwnd, &mut origin) == 0 {
                return None;
            }
            (-decorated.top, origin.y - frame.top)
        };
        Some(super::overlap_points(decorated_top, top_now, scale))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(url: &str) -> url::Origin {
        url::Url::parse(url).expect("test URL parses").origin()
    }

    fn record(page: &str, band_height: f64, title_bar_height: Option<f64>) -> Record {
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
    /// seven keys and nothing else.
    #[test]
    fn the_chrome_serializes_the_contract_fields() {
        let chrome = TitlebarChrome {
            active: true,
            inset_left: 0.0,
            inset_right: 138.0,
            controls_center_y: 0.0,
            fullscreen: false,
            draw_controls: true,
            maximized: true,
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
                "drawControls",
                "fullscreen",
                "insetLeft",
                "insetRight",
                "maximized"
            ]
        );
        assert_eq!(value["insetRight"], 138.0);
        assert_eq!(value["drawControls"], true);
        assert_eq!(value["maximized"], true);
        let inactive = serde_json::to_value(TitlebarChrome::default()).expect("serializes");
        assert_eq!(
            inactive,
            serde_json::json!({
                "active": false,
                "insetLeft": 0.0,
                "insetRight": 0.0,
                "controlsCenterY": 0.0,
                "fullscreen": false,
                "drawControls": false,
                "maximized": false,
            })
        );
    }

    #[test]
    fn the_chrome_converts_points_to_the_pages_css_px() {
        let controls = Some(Controls {
            right: 70.0,
            center_y: 15.0,
        });
        let at_100 = chrome_for(true, false, false, controls, 1.0);
        assert_eq!(
            at_100,
            TitlebarChrome {
                active: true,
                inset_left: 78.0,
                inset_right: 0.0,
                controls_center_y: 15.0,
                fullscreen: false,
                draw_controls: false,
                maximized: false,
            }
        );
        // A zoomed-in page has fewer, larger CSS px over the same points.
        let at_125 = chrome_for(true, false, false, controls, 1.25);
        assert_eq!(at_125.inset_left, 78.0 / 1.25);
        assert_eq!(at_125.controls_center_y, 12.0);
        let at_50 = chrome_for(true, false, false, controls, 0.5);
        assert_eq!(at_50.inset_left, 156.0);
        assert_eq!(at_50.controls_center_y, 30.0);
        // AppKit draws the traffic lights; a zoomed window reports its state.
        let zoomed = chrome_for(true, false, true, controls, 1.0);
        assert!(zoomed.maximized);
        assert!(!zoomed.draw_controls);
    }

    #[test]
    fn fullscreen_and_inactive_windows_keep_no_room() {
        let controls = Some(Controls {
            right: 70.0,
            center_y: 15.0,
        });
        assert_eq!(
            chrome_for(true, true, false, controls, 1.0),
            TitlebarChrome {
                active: true,
                fullscreen: true,
                ..TitlebarChrome::default()
            }
        );
        assert_eq!(
            chrome_for(false, false, false, controls, 1.0),
            TitlebarChrome::default()
        );
        assert_eq!(
            chrome_for(false, true, false, None, 1.0),
            TitlebarChrome {
                fullscreen: true,
                ..TitlebarChrome::default()
            }
        );
        // No traffic lights to avoid: active, nothing to keep.
        assert_eq!(
            chrome_for(true, false, false, None, 1.0),
            TitlebarChrome {
                active: true,
                ..TitlebarChrome::default()
            }
        );
    }

    /// Windows: the page draws three 46 DIP buttons at the right, sized in
    /// its own CSS px, and centres them itself.
    #[test]
    fn a_page_that_draws_the_controls_keeps_three_caption_buttons_at_the_right() {
        let at_100 = drawn_controls_chrome(true, false, false, 1.0);
        assert_eq!(
            at_100,
            TitlebarChrome {
                active: true,
                inset_left: 0.0,
                inset_right: 138.0,
                controls_center_y: 0.0,
                fullscreen: false,
                draw_controls: true,
                maximized: false,
            }
        );
        // A zoomed-in page has fewer, larger CSS px over the same DIP.
        assert_eq!(
            drawn_controls_chrome(true, false, false, 1.25).inset_right,
            110.4
        );
        assert_eq!(
            drawn_controls_chrome(true, false, false, 0.5).inset_right,
            276.0
        );
        // Maximized: the same buttons, and the page shows restore.
        let maximized = drawn_controls_chrome(true, false, true, 1.0);
        assert_eq!(maximized.inset_right, 138.0);
        assert!(maximized.draw_controls && maximized.maximized);
    }

    #[test]
    fn fullscreen_and_inactive_windows_draw_no_controls() {
        assert_eq!(
            drawn_controls_chrome(true, true, false, 1.0),
            TitlebarChrome {
                active: true,
                fullscreen: true,
                ..TitlebarChrome::default()
            }
        );
        assert_eq!(
            drawn_controls_chrome(false, false, false, 1.0),
            TitlebarChrome::default()
        );
        assert_eq!(
            drawn_controls_chrome(false, false, true, 1.0),
            TitlebarChrome {
                maximized: true,
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
            assert_eq!(
                chrome_for(true, false, false, controls, zoom).inset_left,
                78.0
            );
            assert_eq!(
                drawn_controls_chrome(true, false, false, zoom).inset_right,
                138.0
            );
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

    /// The wire names the page sends as `action`.
    #[test]
    fn the_window_controls_parse_from_their_wire_names() {
        for (wire, control) in [
            ("minimize", WindowControl::Minimize),
            ("toggleMaximize", WindowControl::ToggleMaximize),
            ("close", WindowControl::Close),
        ] {
            assert_eq!(
                serde_json::from_value::<WindowControl>(serde_json::json!(wire)).ok(),
                Some(control),
                "{wire}"
            );
        }
        for bad in ["maximize", "toggle_maximize", "Close", "destroy", ""] {
            assert!(
                serde_json::from_value::<WindowControl>(serde_json::json!(bad)).is_err(),
                "{bad} must be refused"
            );
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
        windows.enable("local::w-1", record(page, 36.0, Some(28.0)));
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
        windows.enable("local::w-1", record(page, 36.0, Some(28.0)));
        // A Windows record measures its title bar when it is read.
        windows.enable("lib-0a1b::w-1", record(page, 40.0, None));
        assert_eq!(windows.title_bar_height("lib-0a1b::w-1"), None);
        // A second enable updates the band.
        windows.enable("local::w-1", record(page, 44.0, Some(28.0)));
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
        assert_eq!(windows.band_height("lib-0a1b::w-1"), None);
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

    /// Windows: the overlap is the decorated top frame less the frameless one,
    /// in points. At 100% on Windows 11 the decorated top is the 23 px caption
    /// over the 4 px sizing frame and 4 px padding, and a restored frameless
    /// window keeps a 1 px top border; a maximized one hangs its 8 px frame
    /// above the monitor in both styles; Windows 10 keeps no top border.
    #[test]
    fn a_frameless_window_overlaps_the_band_its_title_bar_held() {
        assert_eq!(overlap_points(31, 1, 1.0), 30.0);
        assert_eq!(overlap_points(31, 8, 1.0), 23.0);
        assert_eq!(overlap_points(31, 0, 1.0), 31.0);
        // Physical px convert to points through the window's scale.
        assert_eq!(overlap_points(46, 2, 1.5), 44.0 / 1.5);
        assert_eq!(overlap_points(60, 2, 2.0), 29.0);
        // A window still decorated, or one that reads oddly, overlaps nothing.
        assert_eq!(overlap_points(31, 31, 1.0), 0.0);
        assert_eq!(overlap_points(31, 40, 1.0), 0.0);
        for scale in [0.0, -1.0, f64::NAN] {
            assert_eq!(overlap_points(31, 1, scale), 30.0);
        }
    }

    /// The same drift on Windows, modelled on tao: a decorated window's frame
    /// is its content plus the decorated top and the bottom sizing frame, the
    /// rebuilt window restores the stored height as decorated content, and
    /// turning frameless keeps the frame and lets the content grow to the
    /// frameless top. Physical px at 125%.
    #[test]
    fn hiding_and_rebuilding_a_frameless_window_keeps_its_size() {
        const SCALE: f64 = 1.25;
        const DECORATED_TOP: i32 = 39;
        const FRAMELESS_TOP: i32 = 1;
        const BOTTOM: i32 = 10;
        let cycle = |stored: f64, corrected: bool| -> f64 {
            let content = (stored * SCALE).round() as i32;
            let frame = content + DECORATED_TOP + BOTTOM;
            let reported = f64::from(frame - FRAMELESS_TOP - BOTTOM) / SCALE;
            let overlap = corrected.then(|| overlap_points(DECORATED_TOP, FRAMELESS_TOP, SCALE));
            // The capture stores whole points.
            normal_inner_height(reported, overlap, false).round()
        };

        let mut stored = 800.0;
        for _ in 0..5 {
            stored = cycle(stored, true);
        }
        assert_eq!(stored, 800.0, "the window keeps its size across rebuilds");

        let mut drifting = 800.0;
        for _ in 0..5 {
            drifting = cycle(drifting, false);
        }
        assert!(
            drifting >= 800.0 + 5.0 * 30.0,
            "without the correction it grows by the title bar each cycle: {drifting}"
        );
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

    /// The readers of the record, pinned in the source because each needs a
    /// live native window to run.
    #[test]
    fn the_record_reaches_the_capture_the_launcher_and_destruction() {
        const SERVE_RS: &str = include_str!("serve.rs");
        const LAUNCHER_RS: &str = include_str!("launcher_panel.rs");
        let serve = production(SERVE_RS);

        let capture = function(serve, "\npub(crate) fn capture_window_geometry(");
        assert!(capture.contains("crate::titlebar_tabs::normal_inner_height("));
        assert!(capture
            .contains("crate::titlebar_tabs::title_bar_overlap(&window, &state.titlebar_windows)"));
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
        let menu = function(launcher, "\nfn sync_launcher_menu(");
        assert!(menu.contains("!crate::titlebar_tabs::in_mode(host)"));
        let show = function(launcher, "\nfn show_now(");
        assert!(show.contains("sync_launcher_menu(app, host)"));
        let switched = function(launcher, "\npub(crate) fn title_bar_switched(");
        assert!(switched.contains("sync_for_host(host)"));
        assert!(switched.contains("sync_launcher_menu("));
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
    /// requires and which makes the webview zoom read synchronous; every
    /// switch re-fits the launcher.
    #[test]
    fn both_commands_run_their_native_work_on_the_main_thread() {
        const SELF_RS: &str = include_str!("titlebar_tabs.rs");
        let module = production(SELF_RS);
        let set = function(module, "\npub(crate) async fn set_titlebar_tabs(");
        assert!(set.contains("crate::window_ops::on_main(&app, move ||"));
        assert!(set.contains("switch(&window, enabled, band_height, origin)"));
        let chrome = function(module, "\npub(crate) async fn titlebar_chrome(");
        assert!(chrome.contains("crate::window_ops::on_main(&app, move || measure(&window))"));
        let loaded = function(module, "\npub(crate) fn page_load_started(");
        assert!(loaded.contains("window.run_on_main_thread(move ||"));
        assert!(loaded.contains("crate::launcher_panel::title_bar_switched(&host)"));
        let switch = function(module, "\nfn switch(");
        assert_eq!(
            switch
                .matches("crate::launcher_panel::title_bar_switched(window)")
                .count(),
            2,
            "both directions re-fit the launcher"
        );
    }

    /// The page's close button closes as the native close button and Alt+F4
    /// do: a close request the desktop's close handling can hold, never a
    /// destroy that skips it.
    #[test]
    fn the_close_control_requests_a_close() {
        const SELF_RS: &str = include_str!("titlebar_tabs.rs");
        let control = function(
            production(SELF_RS),
            "\npub(crate) fn titlebar_window_control(",
        );
        assert!(control.contains("WindowControl::Close => window.close(),"));
        assert!(!control.contains(".destroy()"));
    }
}
