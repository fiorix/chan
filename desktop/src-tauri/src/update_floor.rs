//! The macOS floor of an offered update. A release that raises the bundle's
//! minimum system version says so in its updater manifest
//! (`minimum_system_version`, keyed by the updater's target name), because
//! the updater itself checks no such thing: it would replace a working app
//! with one LaunchServices refuses to open. So before a check is answered or
//! an install starts, the offered floor is compared with the running macOS,
//! and a Mac below it is told why and left as it is. A manifest without a
//! floor, or with one that does not read as a version, installs as before;
//! only a floor the manifest states refuses.

use std::fmt;

use serde_json::Value;

/// A dotted operating system version as the bundle setting spells it; the
/// parts it leaves off read as zero, so `14.0` and `14` are the same floor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct OsVersion(u64, u64, u64);

impl OsVersion {
    fn parse(text: &str) -> Option<Self> {
        let mut parts = [0u64; 3];
        let mut count = 0;
        for part in text.trim().split('.') {
            if count == parts.len() {
                return None;
            }
            parts[count] = part.parse().ok()?;
            count += 1;
        }
        (count > 0).then_some(OsVersion(parts[0], parts[1], parts[2]))
    }
}

impl fmt::Display for OsVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.0, self.1)?;
        if self.2 != 0 {
            write!(f, ".{}", self.2)?;
        }
        Ok(())
    }
}

/// Why `update` must not be installed on this machine, or `None` to proceed.
pub fn refusal(update: &tauri_plugin_updater::Update) -> Option<String> {
    refusal_for(
        &update.raw_json,
        &update.target,
        &update.version,
        running_os_version(),
    )
}

fn refusal_for(
    manifest: &Value,
    target: &str,
    version: &str,
    running: Option<OsVersion>,
) -> Option<String> {
    let running = running?;
    let floor = manifest
        .get("minimum_system_version")?
        .get(target)?
        .as_str()
        .and_then(OsVersion::parse)?;
    (running < floor).then(|| {
        format!(
            "chan-desktop {version} needs macOS {floor} or later and this Mac runs macOS {running}; update macOS first, or stay on this version"
        )
    })
}

#[cfg(target_os = "macos")]
fn running_os_version() -> Option<OsVersion> {
    let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
    let part = |n: isize| u64::try_from(n).unwrap_or(0);
    Some(OsVersion(
        part(version.majorVersion),
        part(version.minorVersion),
        part(version.patchVersion),
    ))
}

/// Only macOS states a floor today; elsewhere nothing is compared.
#[cfg(not(target_os = "macos"))]
fn running_os_version() -> Option<OsVersion> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(floor: &str) -> Value {
        json!({
            "version": "0.124.0",
            "platforms": { "darwin-aarch64": { "url": "https://example.invalid/a", "signature": "sig" } },
            "minimum_system_version": { "darwin": floor }
        })
    }

    #[test]
    fn versions_parse_as_the_bundle_setting_spells_them() {
        assert_eq!(OsVersion::parse("14.0"), Some(OsVersion(14, 0, 0)));
        assert_eq!(OsVersion::parse("14"), Some(OsVersion(14, 0, 0)));
        assert_eq!(OsVersion::parse(" 13.6.7 "), Some(OsVersion(13, 6, 7)));
        assert_eq!(OsVersion::parse("fourteen"), None);
        assert_eq!(OsVersion::parse("1.2.3.4"), None);
        assert_eq!(OsVersion::parse(""), None);
        assert_eq!(OsVersion::parse("14."), None);
    }

    #[test]
    fn versions_print_without_a_zero_patch() {
        assert_eq!(OsVersion(14, 0, 0).to_string(), "14.0");
        assert_eq!(OsVersion(13, 6, 7).to_string(), "13.6.7");
        assert_eq!(OsVersion(15, 0, 1).to_string(), "15.0.1");
    }

    #[test]
    fn a_mac_below_the_floor_is_refused_with_both_versions() {
        let message = refusal_for(
            &manifest("14.0"),
            "darwin",
            "0.124.0",
            Some(OsVersion(13, 6, 7)),
        )
        .expect("refused");
        assert!(
            message.contains("chan-desktop 0.124.0 needs macOS 14.0"),
            "{message}"
        );
        assert!(message.contains("runs macOS 13.6.7"), "{message}");
    }

    #[test]
    fn a_mac_at_or_above_the_floor_installs() {
        for running in [
            OsVersion(14, 0, 0),
            OsVersion(14, 1, 0),
            OsVersion(26, 0, 1),
        ] {
            assert_eq!(
                refusal_for(&manifest("14.0"), "darwin", "0.124.0", Some(running)),
                None,
                "{running}"
            );
        }
    }

    #[test]
    fn a_floor_the_manifest_does_not_state_never_refuses() {
        let running = Some(OsVersion(13, 0, 0));
        let without = json!({ "version": "0.124.0", "platforms": {} });
        assert_eq!(refusal_for(&without, "darwin", "0.124.0", running), None);
        assert_eq!(
            refusal_for(&manifest("14.0"), "linux", "0.124.0", running),
            None,
            "another target's floor is not this one's"
        );
        assert_eq!(
            refusal_for(&manifest("fourteen"), "darwin", "0.124.0", running),
            None,
            "a floor that does not read as a version is no floor"
        );
        assert_eq!(
            refusal_for(&manifest("14.0"), "darwin", "0.124.0", None),
            None,
            "no running version, nothing to compare"
        );
    }
}
