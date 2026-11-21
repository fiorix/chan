//! A cache an earlier chan wrote through hf-hub's layout, with each file a
//! link into `blobs/`, opens offline at a commit other than the pinned one.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::tests::pins;
use super::Client;

const FILES: [&str; 3] = ["config.json", "tokenizer.json", "model.safetensors"];
const REFERENCE: &[u8] = include_bytes!("testdata/hf-hub-cache/refs-main.bin");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    model: String,
    commit: String,
    files: BTreeMap<String, Payload>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    body_path: String,
    commit: String,
    etag: String,
    sha256: String,
    size: usize,
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    link_target: Option<String>,
    size: Option<u64>,
    sha256: Option<String>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn payload(path: &str) -> &'static [u8] {
    match path {
        "payloads/config.json" => include_bytes!("testdata/hf-hub-cache/payloads/config.json"),
        "payloads/tokenizer.json" => {
            include_bytes!("testdata/hf-hub-cache/payloads/tokenizer.json")
        }
        "payloads/model.safetensors" => {
            include_bytes!("testdata/hf-hub-cache/payloads/model.safetensors")
        }
        _ => panic!("unknown captured payload: {path}"),
    }
}

fn fixture() -> Fixture {
    let fixture: Fixture =
        serde_json::from_str(include_str!("testdata/hf-hub-cache/fixture.json")).unwrap();
    assert_eq!(fixture.files.len(), FILES.len());
    assert_eq!(REFERENCE, fixture.commit.as_bytes());
    for filename in FILES {
        let file = &fixture.files[filename];
        let bytes = payload(&file.body_path);
        assert_eq!(bytes.len(), file.size);
        assert_eq!(digest(bytes), file.sha256);
        assert_eq!(file.etag, file.sha256);
        assert_eq!(file.commit, fixture.commit);
    }
    fixture
}

fn captured_layout() -> Vec<Entry> {
    include_str!("testdata/hf-hub-cache/layout.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn inventory(root: &Path) -> Vec<Entry> {
    let mut entries = Vec::new();
    for result in walkdir::WalkDir::new(root).min_depth(1).follow_links(false) {
        let found = result.unwrap();
        let path = found.path();
        let metadata = std::fs::symlink_metadata(path).unwrap();
        let mut entry = Entry {
            path: path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned(),
            kind: String::new(),
            link_target: None,
            size: None,
            sha256: None,
        };
        if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(path).unwrap();
            let target = target.to_str().unwrap();
            entry.kind = "symlink".to_owned();
            entry.link_target = Some(target.to_owned());
            entry.size = Some(metadata.len());
            entry.sha256 = Some(digest(target.as_bytes()));
        } else if metadata.is_file() {
            entry.kind = "file".to_owned();
            entry.size = Some(metadata.len());
            entry.sha256 = Some(digest(&std::fs::read(path).unwrap()));
        } else {
            assert!(metadata.is_dir(), "the cache contains no special files");
            entry.kind = "directory".to_owned();
        }
        entries.push(entry);
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    entries
}

fn materialize(root: &Path, fixture: &Fixture, entries: &[Entry]) {
    for entry in entries {
        let relative = Path::new(&entry.path);
        assert!(relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_))));
        let destination = root.join(relative);
        match entry.kind.as_str() {
            "directory" => std::fs::create_dir(&destination).unwrap(),
            "symlink" => {
                std::os::unix::fs::symlink(entry.link_target.as_ref().unwrap(), &destination)
                    .unwrap()
            }
            "file" => {
                let bytes = if entry.path.ends_with("/refs/main") {
                    REFERENCE
                } else if entry.path.ends_with(".lock") {
                    &[]
                } else {
                    let name = relative.file_name().unwrap().to_str().unwrap();
                    let file = fixture
                        .files
                        .values()
                        .find(|file| file.etag == name)
                        .unwrap();
                    payload(&file.body_path)
                };
                std::fs::write(destination, bytes).unwrap();
            }
            kind => panic!("unexpected captured cache entry {kind}"),
        }
    }
}

#[test]
fn captured_hf_hub_cache_is_read_without_initializing_a_transport() {
    let fixture = fixture();
    let entries = captured_layout();
    let cache = tempfile::tempdir().unwrap();
    materialize(cache.path(), &fixture, &entries);
    assert_eq!(
        inventory(cache.path()),
        entries,
        "the copied cache must match the unchanged hf-hub capture"
    );
    // Pinned at another commit, the files come through `refs/main`. An
    // unsupported URL scheme cannot open a socket if the lookup regresses.
    let files: Vec<_> = FILES
        .into_iter()
        .map(|name| (name, payload(&fixture.files[name].body_path)))
        .collect();
    let model: &'static str = fixture.model.clone().leak();
    let client = Client::with_config(
        cache.path(),
        "cache-only://offline.invalid/",
        chan_tls::client_config().unwrap(),
    )
    .pinned(pins(
        model,
        "1111111111111111111111111111111111111111",
        &files,
    ));
    for filename in FILES {
        let downloaded = client
            .get(&fixture.model, filename)
            .expect("the captured hf-hub cache must open without a fetch");
        let pointer = entries
            .iter()
            .find(|entry| {
                entry.kind == "symlink"
                    && Path::new(&entry.path).file_name() == Some(std::ffi::OsStr::new(filename))
            })
            .unwrap();
        let pointer = cache.path().join(&pointer.path);
        assert_eq!(
            downloaded, pointer,
            "chan must return the captured snapshot path"
        );
        assert_eq!(
            std::fs::read(&downloaded).unwrap(),
            payload(&fixture.files[filename].body_path)
        );
    }
    assert!(
        client.agent.get().is_none(),
        "reading the captured hf-hub cache must not initialize an HTTP transport"
    );
    assert_eq!(
        inventory(cache.path()),
        entries,
        "reading the captured hf-hub cache must not change any entry"
    );
}
