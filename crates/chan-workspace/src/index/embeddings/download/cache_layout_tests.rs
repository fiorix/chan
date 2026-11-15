use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{tests::Server, Client};

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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordedRequest {
    path: String,
    range: String,
    user_agent: String,
    authorization_present: bool,
    status: u16,
    response_headers: BTreeMap<String, String>,
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
    let entries: Vec<Entry> = include_str!("testdata/hf-hub-cache/layout.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let mut tsv = String::from("path\ttype\tlink_target\tsize\tsha256\n");
    for entry in &entries {
        tsv.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\n",
            entry.path,
            entry.kind,
            entry.link_target.as_deref().unwrap_or("-"),
            entry
                .size
                .map_or_else(|| "-".to_owned(), |size| size.to_string()),
            entry.sha256.as_deref().unwrap_or("-")
        ));
    }
    assert_eq!(tsv, include_str!("testdata/hf-hub-cache/layout.tsv"));
    entries
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

fn header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn request_shape(request: &str) -> (String, String, String, bool) {
    let first: Vec<_> = request.lines().next().unwrap().split_whitespace().collect();
    assert_eq!(first[0], "GET", "captured model transfers use GET");
    (
        first[1].to_owned(),
        header(request, "range").unwrap_or("").to_owned(),
        header(request, "user-agent").unwrap_or("").to_owned(),
        header(request, "authorization").is_some(),
    )
}

fn replay_response(request: &str, records: &[RecordedRequest], fixture: &Fixture) -> Vec<u8> {
    let (path, range, _, _) = request_shape(request);
    let record = records
        .iter()
        .find(|record| record.path == path && record.range == range)
        .expect("the request has a captured response");
    let body = match record.status {
        302 => &[][..],
        206 => {
            let filename = record.path.rsplit('/').next().unwrap();
            let bytes = payload(&fixture.files[filename].body_path);
            let content_range = record.response_headers["Content-Range"]
                .strip_prefix("bytes ")
                .unwrap();
            let (bounds, size) = content_range.split_once('/').unwrap();
            let (start, end) = bounds.split_once('-').unwrap();
            assert_eq!(size.parse::<usize>().unwrap(), bytes.len());
            &bytes[start.parse::<usize>().unwrap()..=end.parse::<usize>().unwrap()]
        }
        status => panic!("unexpected captured response status {status}"),
    };
    assert_eq!(
        record.response_headers["Content-Length"]
            .parse::<usize>()
            .unwrap(),
        body.len(),
        "the captured response length matches its original payload slice"
    );
    let reason = if record.status == 302 {
        "Found"
    } else {
        "Partial Content"
    };
    let mut response = format!("HTTP/1.0 {} {reason}\r\n", record.status);
    for (name, value) in &record.response_headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    let mut response = response.into_bytes();
    response.extend_from_slice(body);
    response
}

fn assert_hub_reads(root: &Path, fixture: &Fixture, filename: &str, downloaded: &Path) {
    let reader = hf_hub::Cache::new(root.to_owned()).model(fixture.model.clone());
    assert_eq!(
        reader.get(filename).as_deref(),
        Some(downloaded),
        "hf-hub must resolve the same captured snapshot as chan"
    );
    assert_eq!(
        std::fs::read(downloaded).unwrap(),
        payload(&fixture.files[filename].body_path),
        "the captured model payload must retain its exact bytes"
    );
}

#[test]
fn download_matches_the_cache_and_requests_captured_from_hf_hub() {
    let fixture = Arc::new(fixture());
    let records: Arc<Vec<RecordedRequest>> = Arc::new(
        include_str!("testdata/hf-hub-cache/requests.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect(),
    );
    let handler_fixture = Arc::clone(&fixture);
    let handler_records = Arc::clone(&records);
    let server =
        Server::start(move |request| replay_response(request, &handler_records, &handler_fixture));
    let cache = tempfile::tempdir().unwrap();
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    for filename in FILES {
        let downloaded = client
            .get(&fixture.model, filename)
            .expect("the captured hf-hub transfer must download successfully");
        assert_hub_reads(cache.path(), &fixture, filename, &downloaded);
    }
    let observed: Vec<_> = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|request| request_shape(request))
        .collect();
    let expected: Vec<_> = records
        .iter()
        .map(|record| {
            (
                record.path.clone(),
                record.range.clone(),
                record.user_agent.clone(),
                record.authorization_present,
            )
        })
        .collect();
    assert_eq!(
        observed, expected,
        "chan must send the model request sequence captured from hf-hub"
    );
    assert_eq!(
        inventory(cache.path()),
        captured_layout(),
        "chan must produce the complete cache layout captured from hf-hub"
    );
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
    // An unsupported URL scheme cannot open a socket if the cache lookup regresses.
    let client = Client::with_config(
        cache.path(),
        "cache-only://offline.invalid/",
        chan_tls::client_config().unwrap(),
    );
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
        assert_hub_reads(cache.path(), &fixture, filename, &downloaded);
    }
    assert!(
        client.agents.get().is_none(),
        "reading the captured hf-hub cache must not initialize an HTTP transport"
    );
    assert_eq!(
        inventory(cache.path()),
        entries,
        "reading the captured hf-hub cache must not change any entry"
    );
}
