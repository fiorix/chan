//! Permission policy for the desktop webviews.
//!
//! The embedded server's own pages capture the microphone for host-owned extension takes, so they get it without a prompt. A page from any other origin, such as a remote devserver's, has to be allowed first: by the webview's prompt on macOS and Windows, and by a chan dialog on the GTK desktops, where WebKitGTK has no prompt and an unanswered request is denied. WebKitGTK keeps an allow for as long as the webview lives, through reloads, and asks again after a deny. The camera and display capture are denied everywhere. Every other kind returns `Default`, which keeps the platform flow the webview had before this handler existed.

use std::net::{IpAddr, SocketAddr};

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Url;

/// A webview surface for permission purposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionSurface {
    /// A window showing a page of the embedded server.
    LocalWorkspace,
    /// A workspace window showing a page from anywhere else.
    RemoteWorkspace,
    /// A surface that never captures, such as the launcher panel or the About window.
    NonCapturing,
}

/// The one permission mapping for the desktop's webviews. `Default` on the microphone of a remote page means the viewer is asked.
pub(crate) fn permission_response(
    kind: PermissionKind,
    surface: PermissionSurface,
) -> PermissionResponse {
    match (surface, kind) {
        (_, PermissionKind::Camera | PermissionKind::DisplayCapture) => PermissionResponse::Deny,
        (PermissionSurface::LocalWorkspace, PermissionKind::Microphone) => {
            PermissionResponse::Allow
        }
        (PermissionSurface::NonCapturing, PermissionKind::Microphone) => PermissionResponse::Deny,
        _ => PermissionResponse::Default,
    }
}

/// The surface a workspace window is showing now. A page that cannot be read counts as remote, so the failure asks the viewer.
pub(crate) fn workspace_surface(
    page: Option<&Url>,
    embedded: Option<SocketAddr>,
) -> PermissionSurface {
    match (page, embedded) {
        (Some(page), Some(embedded)) if is_embedded_origin(page, embedded) => {
            PermissionSurface::LocalWorkspace
        }
        _ => PermissionSurface::RemoteWorkspace,
    }
}

/// Loopback alone proves nothing: a tunnel or another devserver can also listen there, so the port must be the embedded server's.
fn is_embedded_origin(page: &Url, embedded: SocketAddr) -> bool {
    let host = match page.host() {
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
        _ => return false,
    };
    page.scheme() == "http"
        && host == embedded.ip()
        && page.port_or_known_default() == Some(embedded.port())
}

/// Install the workspace policy on a window builder where the webview's own prompt can answer for a remote page.
#[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
pub(crate) fn with_workspace_policy<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    embedded: Option<SocketAddr>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    builder.on_permission_request(move |webview, kind| {
        // Guarded as `serve::webview_url` guards the same read.
        let page = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| webview.url()))
            .ok()
            .and_then(Result::ok);
        permission_response(kind, workspace_surface(page.as_ref(), embedded))
    })
}

/// The GTK desktops install the policy on the built webview instead.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
pub(crate) fn with_workspace_policy<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    _embedded: Option<SocketAddr>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    builder
}

#[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
pub(crate) fn attach_workspace_policy<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _embedded: Option<SocketAddr>,
) {
}

/// Answer the webview's capture requests. Any other request stays unhandled, which is WebKitGTK's default. If this fails to attach, capture stays denied.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
pub(crate) fn attach_workspace_policy<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    embedded: Option<SocketAddr>,
) {
    use gtk::prelude::*;
    use webkit2gtk::{
        PermissionRequestExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt,
    };

    let attached = window.with_webview(move |webview| {
        let asking = std::rc::Rc::new(std::cell::Cell::new(false));
        webview
            .inner()
            .connect_permission_request(move |view, request| {
                let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                    return false;
                };
                let kind = media_kind(media.is_for_audio_device(), media.is_for_video_device());
                let page = view.uri().and_then(|uri| uri.parse::<Url>().ok());
                match permission_response(kind, workspace_surface(page.as_ref(), embedded)) {
                    PermissionResponse::Allow => request.allow(),
                    PermissionResponse::Deny => request.deny(),
                    PermissionResponse::Default if asking.replace(true) => request.deny(),
                    PermissionResponse::Default => {
                        ask_for_microphone(view, request.clone(), page.as_ref(), asking.clone());
                    }
                }
                true
            });
    });
    if let Err(error) = attached {
        tracing::warn!(%error, "attaching the webview permission policy failed");
    }
}

/// WebKitGTK names display capture only by naming neither device. A request for both is held to the camera's answer.
#[cfg(any(target_os = "linux", target_os = "freebsd", test))]
fn media_kind(audio: bool, video: bool) -> PermissionKind {
    match (audio, video) {
        (true, false) => PermissionKind::Microphone,
        (_, true) => PermissionKind::Camera,
        (false, false) => PermissionKind::DisplayCapture,
    }
}

/// `host[:port]` as the viewer would recognize the page.
#[cfg(any(target_os = "linux", target_os = "freebsd", test))]
fn page_label(page: Option<&Url>) -> String {
    let Some(host) = page.and_then(Url::host_str) else {
        return "This page".to_owned();
    };
    match page.and_then(Url::port) {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// Ask without blocking the main loop and without a modal grab, so a remote page that keeps asking cannot take input from the app's other windows. A dialog destroyed unanswered drops the request, which WebKit denies.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
fn ask_for_microphone(
    view: &webkit2gtk::WebView,
    request: webkit2gtk::PermissionRequest,
    page: Option<&Url>,
    asking: std::rc::Rc<std::cell::Cell<bool>>,
) {
    use gtk::prelude::*;
    use webkit2gtk::PermissionRequestExt;

    let parent = view
        .toplevel()
        .and_then(|widget| widget.downcast::<gtk::Window>().ok());
    let dialog = gtk::MessageDialog::new(
        parent.as_ref(),
        gtk::DialogFlags::DESTROY_WITH_PARENT,
        gtk::MessageType::Question,
        gtk::ButtonsType::None,
        &format!("Allow {} to use your microphone?", page_label(page)),
    );
    dialog.set_title("Microphone access");
    dialog.set_secondary_text(Some(
        "This remote page is asking to record from this computer's microphone. If you allow it, this window can use the microphone until it closes.",
    ));
    dialog.add_button("Deny", gtk::ResponseType::Reject);
    dialog.add_button("Allow", gtk::ResponseType::Accept);
    dialog.set_default_response(gtk::ResponseType::Reject);
    // Closing the dialog emits a second response, which finds nothing to answer.
    let pending = std::cell::Cell::new(Some(request));
    dialog.connect_response(move |dialog, response| {
        let Some(request) = pending.take() else {
            return;
        };
        asking.set(false);
        if response == gtk::ResponseType::Accept {
            request.allow();
        } else {
            request.deny();
        }
        dialog.close();
    });
    dialog.show();
}

/// The same mapping for the launcher panel, which builds a raw wry webview outside Tauri.
pub(crate) fn launcher_permission_response(kind: wry::PermissionKind) -> wry::PermissionResponse {
    let kind = match kind {
        wry::PermissionKind::Microphone => PermissionKind::Microphone,
        wry::PermissionKind::Camera => PermissionKind::Camera,
        wry::PermissionKind::DisplayCapture => PermissionKind::DisplayCapture,
        _ => PermissionKind::Other,
    };
    match permission_response(kind, PermissionSurface::NonCapturing) {
        PermissionResponse::Allow => wry::PermissionResponse::Allow,
        PermissionResponse::Deny => wry::PermissionResponse::Deny,
        PermissionResponse::Default => wry::PermissionResponse::Default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_KINDS: [PermissionKind; 16] = [
        PermissionKind::Microphone,
        PermissionKind::Camera,
        PermissionKind::Geolocation,
        PermissionKind::Notifications,
        PermissionKind::ClipboardRead,
        PermissionKind::DisplayCapture,
        PermissionKind::Midi,
        PermissionKind::Sensors,
        PermissionKind::MediaKeySystemAccess,
        PermissionKind::LocalFonts,
        PermissionKind::WindowManagement,
        PermissionKind::PointerLock,
        PermissionKind::AutomaticDownloads,
        PermissionKind::FileSystemAccess,
        PermissionKind::Autoplay,
        PermissionKind::Other,
    ];

    fn embedded() -> SocketAddr {
        "127.0.0.1:4100".parse().unwrap()
    }

    fn surface(page: &str) -> PermissionSurface {
        workspace_surface(Some(&page.parse().unwrap()), Some(embedded()))
    }

    #[test]
    fn only_a_local_workspace_gets_the_microphone_without_asking() {
        for kind in ALL_KINDS {
            let capture_denied = matches!(
                kind,
                PermissionKind::Camera | PermissionKind::DisplayCapture
            );
            let local = if kind == PermissionKind::Microphone {
                PermissionResponse::Allow
            } else if capture_denied {
                PermissionResponse::Deny
            } else {
                PermissionResponse::Default
            };
            let remote = if capture_denied {
                PermissionResponse::Deny
            } else {
                PermissionResponse::Default
            };
            assert_eq!(
                permission_response(kind, PermissionSurface::LocalWorkspace),
                local,
                "{kind} on a local page"
            );
            assert_eq!(
                permission_response(kind, PermissionSurface::RemoteWorkspace),
                remote,
                "{kind} on a remote page"
            );
        }
    }

    #[test]
    fn non_capturing_surfaces_deny_every_capture_kind() {
        for kind in ALL_KINDS {
            let expected = match kind {
                PermissionKind::Microphone
                | PermissionKind::Camera
                | PermissionKind::DisplayCapture => PermissionResponse::Deny,
                _ => PermissionResponse::Default,
            };
            assert_eq!(
                permission_response(kind, PermissionSurface::NonCapturing),
                expected,
                "{kind} on a non-capturing surface"
            );
        }
    }

    #[test]
    fn only_the_embedded_origin_is_local() {
        assert_eq!(
            surface("http://127.0.0.1:4100/w/a/index.html?t=x"),
            PermissionSurface::LocalWorkspace
        );
        for page in [
            "http://127.0.0.1:4101/",
            "https://127.0.0.1:4100/",
            "http://localhost:4100/",
            "http://127.0.0.2:4100/",
            "http://[::1]:4100/",
            "http://127.0.0.1/",
            "https://devserver.example.com/",
            "http://127.0.0.1.example.com:4100/",
            "file:///etc/passwd",
            "about:blank",
        ] {
            assert_eq!(surface(page), PermissionSurface::RemoteWorkspace, "{page}");
        }
    }

    #[test]
    fn an_unknown_page_or_server_is_remote() {
        let page: Url = "http://127.0.0.1:4100/".parse().unwrap();
        assert_eq!(
            workspace_surface(None, Some(embedded())),
            PermissionSurface::RemoteWorkspace
        );
        assert_eq!(
            workspace_surface(Some(&page), None),
            PermissionSurface::RemoteWorkspace
        );
    }

    #[test]
    fn a_request_naming_a_camera_or_no_device_is_never_the_microphone() {
        assert_eq!(media_kind(true, false), PermissionKind::Microphone);
        assert_eq!(media_kind(false, true), PermissionKind::Camera);
        assert_eq!(media_kind(true, true), PermissionKind::Camera);
        assert_eq!(media_kind(false, false), PermissionKind::DisplayCapture);
    }

    #[test]
    fn the_prompt_names_the_page_host_and_port() {
        let with_port: Url = "https://dev.example.com:8443/w/?t=secret".parse().unwrap();
        let plain: Url = "https://dev.example.com/w/".parse().unwrap();
        assert_eq!(page_label(Some(&with_port)), "dev.example.com:8443");
        assert_eq!(page_label(Some(&plain)), "dev.example.com");
        assert_eq!(page_label(None), "This page");
    }

    #[test]
    fn launcher_denies_capture_and_defaults_the_rest() {
        assert_eq!(
            launcher_permission_response(wry::PermissionKind::Microphone),
            wry::PermissionResponse::Deny
        );
        assert_eq!(
            launcher_permission_response(wry::PermissionKind::Camera),
            wry::PermissionResponse::Deny
        );
        assert_eq!(
            launcher_permission_response(wry::PermissionKind::DisplayCapture),
            wry::PermissionResponse::Deny
        );
        assert_eq!(
            launcher_permission_response(wry::PermissionKind::Geolocation),
            wry::PermissionResponse::Default
        );
    }

    #[test]
    fn the_macos_entitlements_grant_audio_input_only() {
        let source = include_str!("../Entitlements.plist");
        assert_eq!(
            source.matches("<key>").count(),
            1,
            "exactly one entitlement key"
        );
        assert!(source.contains("<key>com.apple.security.device.audio-input</key>"));
        assert!(source.contains("<true/>"));
    }

    #[test]
    fn the_bundle_references_the_entitlements_file() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(
            config["bundle"]["macOS"]["entitlements"],
            serde_json::json!("Entitlements.plist")
        );
    }
}
