//! Permission policy for the desktop webviews.
//!
//! The workspace app captures the microphone for host-owned extension takes, so its webviews allow the microphone and deny the camera and display capture. Every other kind returns `Default`, which keeps the platform flow the webview had before this handler existed. Surfaces that never capture deny all three capture kinds.

use tauri::webview::{PermissionKind, PermissionResponse};

/// A webview surface for permission purposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionSurface {
    /// A window that loads the workspace app.
    Workspace,
    /// A surface that never captures, such as the launcher panel or the About window.
    NonCapturing,
}

/// The one permission mapping for Tauri webviews.
pub(crate) fn permission_response(
    kind: PermissionKind,
    surface: PermissionSurface,
) -> PermissionResponse {
    match (surface, kind) {
        (PermissionSurface::Workspace, PermissionKind::Microphone) => PermissionResponse::Allow,
        (_, PermissionKind::Camera) | (_, PermissionKind::DisplayCapture) => {
            PermissionResponse::Deny
        }
        (PermissionSurface::NonCapturing, PermissionKind::Microphone) => PermissionResponse::Deny,
        _ => PermissionResponse::Default,
    }
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

    #[test]
    fn workspace_allows_only_the_microphone() {
        for kind in ALL_KINDS {
            let expected = match kind {
                PermissionKind::Microphone => PermissionResponse::Allow,
                PermissionKind::Camera | PermissionKind::DisplayCapture => PermissionResponse::Deny,
                _ => PermissionResponse::Default,
            };
            assert_eq!(
                permission_response(kind, PermissionSurface::Workspace),
                expected,
                "{kind} on the workspace surface"
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
    fn the_surfaces_differ_only_on_the_microphone() {
        for kind in ALL_KINDS {
            let workspace = permission_response(kind, PermissionSurface::Workspace);
            let non_capturing = permission_response(kind, PermissionSurface::NonCapturing);
            if kind == PermissionKind::Microphone {
                assert_eq!(workspace, PermissionResponse::Allow);
                assert_eq!(non_capturing, PermissionResponse::Deny);
            } else {
                assert_eq!(workspace, non_capturing, "{kind} agrees across surfaces");
            }
        }
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
