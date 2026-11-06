//! The WireGuard key pairs the desktop generates for its gateways.
//!
//! A gateway whose discovery offers enrollment gets a key pair of its own:
//! the private half in `<gateway id>.key` under the desktop's `wireguard`
//! directory (base64 and a newline), the public half on the gateway row,
//! where the launcher shows it and a sign-in sends it. The client file a
//! sign-in writes from the key sits beside it as `<gateway id>.conf`. The
//! directory is owner-only (0700) and so is each file (0600) on Unix; on
//! Windows the profile directory's ACL applies, as the file reader accepts.
//! The private key is read back only to write the client file, so it never
//! reaches the config, a log, the projection or a request.

use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use chan_wireguard::x25519::{PublicKey, StaticSecret};

/// The key file of `gateway_id` under the key directory `dir`.
pub fn key_path(dir: &Path, gateway_id: &str) -> PathBuf {
    dir.join(format!("{gateway_id}.key"))
}

/// The client file of `gateway_id` under the key directory `dir`.
pub fn conf_path(dir: &Path, gateway_id: &str) -> PathBuf {
    dir.join(format!("{gateway_id}.conf"))
}

/// Generate an X25519 key pair for `gateway_id` from 32 bytes of the OS's
/// randomness, replace its key file under `dir` with the private half, and
/// answer the public half in base64 as `wg` prints it. An error names the
/// file and never the key.
pub fn generate(dir: &Path, gateway_id: &str) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("CSPRNG unavailable: {e}"))?;
    let secret = StaticSecret::from(bytes);
    let public = encode(PublicKey::from(&secret).as_bytes());
    let mut text = encode(&secret.to_bytes());
    text.push('\n');
    let path = key_path(dir, gateway_id);
    write_owner_only(dir, &path, text.as_bytes())
        .map_err(|e| format!("WireGuard: writing {}: {e}", path.display()))?;
    Ok(public)
}

/// Delete `gateway_id`'s key and client files under `dir`; a file that is
/// not there is not an error.
pub fn remove(dir: &Path, gateway_id: &str) -> io::Result<()> {
    for path in [key_path(dir, gateway_id), conf_path(dir, gateway_id)] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Replace `path` inside `dir` with `bytes` through the config's atomic
/// write, the directory and the file narrowed to the owner. The staged file
/// is created owner-only and the directory admits no one else, so the key
/// is never readable by another user, even while an old file's mode carries
/// across the rename.
fn write_owner_only(dir: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)?;
    chan_workspace::fs_ops::atomic_write(path, bytes)
        .map_err(|e| io::Error::other(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The public key the private key in `path` derives.
    fn derived_public(path: &Path) -> String {
        let text = std::fs::read_to_string(path).unwrap();
        let line = text
            .strip_suffix('\n')
            .expect("the key ends with a newline");
        let bytes: [u8; 32] = base64::engine::general_purpose::STANDARD
            .decode(line)
            .unwrap()
            .try_into()
            .unwrap();
        encode(PublicKey::from(&StaticSecret::from(bytes)).as_bytes())
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn generate_writes_an_owner_only_key_and_answers_its_public_half() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("desktop").join("wireguard");
        let public = generate(&dir, "gw-1a2b3c4d").unwrap();
        let key = key_path(&dir, "gw-1a2b3c4d");
        assert_eq!(key, dir.join("gw-1a2b3c4d.key"));
        assert_eq!(derived_public(&key), public);
        assert_eq!(public.len(), 44);
        assert!(!std::fs::read_to_string(&key).unwrap().contains(&public));
        #[cfg(unix)]
        {
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&key), 0o600);
        }
        // Nothing but the key file is left in the directory.
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("gw-1a2b3c4d.key")]);
    }

    #[test]
    fn generate_again_replaces_the_key_and_narrows_a_loose_file() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let first = generate(&dir, "gw-1a2b3c4d").unwrap();
        let key = key_path(&dir, "gw-1a2b3c4d");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let second = generate(&dir, "gw-1a2b3c4d").unwrap();
        assert_ne!(first, second);
        assert_eq!(derived_public(&key), second);
        #[cfg(unix)]
        {
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&key), 0o600);
        }
    }

    #[test]
    fn a_client_file_written_from_the_key_derives_its_public_half() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let public = generate(&dir, "gw-1a2b3c4d").unwrap();
        let text = std::fs::read_to_string(key_path(&dir, "gw-1a2b3c4d")).unwrap();
        let server = encode(PublicKey::from(&StaticSecret::from([7u8; 32])).as_bytes());
        let config = chan_wireguard::config::Config::parse(&format!(
            "[Interface]\nPrivateKey = {}\nAddress = 10.7.0.23/32\n[Peer]\nPublicKey = {server}\nEndpoint = wg.chan.app:51820\nAllowedIPs = 10.7.0.1/32\n",
            text.trim_end(),
        ))
        .unwrap();
        let conf = conf_path(&dir, "gw-1a2b3c4d");
        chan_wireguard::config::write_file(&conf, &config).unwrap();
        let read = chan_wireguard::config::read_file(&conf).unwrap();
        assert_eq!(
            encode(PublicKey::from(&read.private_key).as_bytes()),
            public
        );
    }

    #[test]
    fn remove_deletes_both_files_and_tolerates_their_absence() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        generate(&dir, "gw-1a2b3c4d").unwrap();
        generate(&dir, "gw-99999999").unwrap();
        std::fs::write(conf_path(&dir, "gw-1a2b3c4d"), "conf").unwrap();
        remove(&dir, "gw-1a2b3c4d").unwrap();
        assert!(!key_path(&dir, "gw-1a2b3c4d").exists());
        assert!(!conf_path(&dir, "gw-1a2b3c4d").exists());
        // Another gateway's key stays.
        assert!(key_path(&dir, "gw-99999999").exists());
        remove(&dir, "gw-1a2b3c4d").unwrap();
        remove(&home.path().join("never"), "gw-1a2b3c4d").unwrap();
    }
}
