use std::fs::File;
use std::io::Read;

use super::tests::Server;
use super::{publish_ref, repo_dir_name, Client, DownloadError};

const OLD_COMMIT: &str = "0000000000000000000000000000000000000000";
const NEW_COMMIT: &str = "1111111111111111111111111111111111111111";
const ETAG: &str = "2222222222222222222222222222222222222222";

#[test]
fn reference_replacement_preserves_open_readers() {
    let repo = tempfile::tempdir().unwrap();
    publish_ref(repo.path(), OLD_COMMIT).unwrap();
    let reference = repo.path().join("refs/main");
    // File::open also permits deletion on Windows, so replacement can retain
    // the old reader without blocking publication of the new reference.
    let mut original_reader = File::open(&reference).unwrap();

    publish_ref(repo.path(), NEW_COMMIT).unwrap();

    assert_eq!(std::fs::read_to_string(&reference).unwrap(), NEW_COMMIT);
    let mut original_commit = String::new();
    original_reader
        .read_to_string(&mut original_commit)
        .unwrap();
    assert_eq!(
        original_commit, OLD_COMMIT,
        "reference replacement must not truncate or overwrite an open reader's file"
    );
}

#[test]
fn blob_publication_failure_preserves_the_current_reference() {
    const BODY: &[u8] = b"fixture model";
    let cache = tempfile::tempdir().unwrap();
    let repo = cache.path().join(repo_dir_name("fixture/model"));
    publish_ref(&repo, OLD_COMMIT).unwrap();
    let blob = repo.join("blobs").join(ETAG);
    std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
    std::fs::write(&blob, BODY).unwrap();
    let pointer = repo.join("snapshots").join(NEW_COMMIT).join("config.json");
    // A directory at the file path rejects both symlink publication and the
    // rename fallback used when Windows symlink privileges are unavailable.
    std::fs::create_dir_all(&pointer).unwrap();
    let server = Server::start(|_| {
        let mut response = format!(
            "HTTP/1.1 206 Partial Content\r\nConnection: close\r\nContent-Length: 1\r\nContent-Range: bytes 0-0/{}\r\nx-repo-commit: {NEW_COMMIT}\r\netag: \"{ETAG}\"\r\n\r\n",
            BODY.len()
        )
        .into_bytes();
        response.extend_from_slice(&BODY[..1]);
        response
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );

    let error = client
        .get_inner("fixture/model", "config.json")
        .expect_err("a directory must prevent publishing the snapshot file");

    assert!(matches!(error, DownloadError::Io(_)));
    assert_eq!(
        std::fs::read_to_string(repo.join("refs/main")).unwrap(),
        OLD_COMMIT,
        "a failed blob publication must not advance the current reference"
    );
    assert_eq!(std::fs::read(&blob).unwrap(), BODY);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}
