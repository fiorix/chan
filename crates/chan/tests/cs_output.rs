//! Byte-level pins of what `cs` prints for the commands that answer with a
//! JSON record from the control socket. `--json` is the server's bytes
//! verbatim plus a newline; `--json --pretty` re-indents through a
//! `serde_json::Value`, whose keys are sorted because serde_json is built
//! without `preserve_order`; the default is the markdown rendering, which
//! ends its own output. `cs search` parses the reply into the typed result
//! before printing, so its pretty form keeps the struct's field order, and
//! it exits non-zero after printing when the result carries structured
//! errors.
//!
//! Each case runs the `cs` binary (the chan binary invoked as `cs`, as in
//! cs_alias.rs) against a one-shot fake control server on a temp Unix
//! socket that answers one fixed `Ok { message }` line. The reply payloads
//! keep their keys out of alphabetical order on purpose, so the three paths
//! are told apart by the expected strings alone. Unix-only: the control
//! socket is a named pipe on Windows.

#![cfg(unix)]

use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use chan_shell::{ControlRequest, ControlResponse};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::process::Command;
use tokio::time::timeout;

/// Every wait in a case: the fake server's accept and reads, and the `cs`
/// exit. Generous for a loaded CI box; a hang fails the test instead of
/// stalling the run.
const BUDGET: Duration = Duration::from_secs(30);

/// One command under test: how to invoke it, what the fake server answers,
/// and the exact bytes each output mode must print.
struct Case {
    name: &'static str,
    args: &'static [&'static str],
    /// The reply's name in the `--json --pretty` parse error.
    noun: &'static str,
    /// Environment the command reads before it sends, beyond the socket.
    env: &'static [(&'static str, &'static str)],
    /// The `Ok.message` payload the fake server answers with.
    reply: &'static str,
    /// The `--json --pretty` bytes.
    pretty: &'static str,
    /// The default (markdown) bytes.
    markdown: &'static str,
    /// The request the command must have sent to get that reply.
    request: fn(&ControlRequest) -> bool,
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "window list",
            args: &["window", "list"],
            noun: "window list",
            env: &[],
            reply: r#"[{"window_id":"w-1","title":"Notes","kind":"workspace","library_id":"lib-1","ordinal":2,"connected":true}]"#,
            pretty: r#"[
  {
    "connected": true,
    "kind": "workspace",
    "library_id": "lib-1",
    "ordinal": 2,
    "title": "Notes",
    "window_id": "w-1"
  }
]
"#,
            markdown: "| window | library | kind | title | # | status |\n\
                       | --- | --- | --- | --- | --- | --- |\n\
                       | w-1 | lib-1 | workspace | Notes | 2 | connected |\n",
            request: |request| matches!(request, ControlRequest::WindowList),
        },
        Case {
            name: "session list",
            args: &["session", "list"],
            noun: "session list",
            env: &[],
            reply: r#"[{"window_id":"w-1","status":"live","role":"leader","name":"alice"}]"#,
            pretty: r#"[
  {
    "name": "alice",
    "role": "leader",
    "status": "live",
    "window_id": "w-1"
  }
]
"#,
            markdown: "| window | name | role | status |\n\
                       | --- | --- | --- | --- |\n\
                       | w-1 | alice | leader | live |\n",
            request: |request| matches!(request, ControlRequest::SessionList),
        },
        Case {
            name: "session self",
            args: &["session", "self"],
            noun: "session self",
            env: &[("CHAN_WINDOW_ID", "w-1")],
            reply: r#"{"window_id":"w-1","name":"alice","role":"leader","status":"live","is_leader":true,"identity":"alice@example.test"}"#,
            pretty: r#"{
  "identity": "alice@example.test",
  "is_leader": true,
  "name": "alice",
  "role": "leader",
  "status": "live",
  "window_id": "w-1"
}
"#,
            markdown: "| field | value |\n\
                       | --- | --- |\n\
                       | window | w-1 |\n\
                       | name | alice |\n\
                       | role | leader |\n\
                       | status | live |\n\
                       | leader | yes |\n\
                       | identity | alice@example.test |\n",
            request: |request| {
                matches!(
                    request,
                    ControlRequest::SessionSelf {
                        window_id,
                        name: None,
                        reset: false,
                    } if window_id == "w-1"
                )
            },
        },
        Case {
            name: "pane",
            args: &["pane"],
            noun: "pane reply",
            env: &[("CHAN_WINDOW_ID", "w-1")],
            reply: r#"{"panes":[{"id":"p-1","activeSide":"b","sides":{"b":{"activeTabId":"t-2","tabs":[{"id":"t-2","title":"Notes","kind":"editor","dirty":true}]},"a":{"tabs":[]}}}],"activePaneId":"p-1"}"#,
            pretty: r#"{
  "activePaneId": "p-1",
  "panes": [
    {
      "activeSide": "b",
      "id": "p-1",
      "sides": {
        "a": {
          "tabs": []
        },
        "b": {
          "activeTabId": "t-2",
          "tabs": [
            {
              "dirty": true,
              "id": "t-2",
              "kind": "editor",
              "title": "Notes"
            }
          ]
        }
      }
    }
  ]
}
"#,
            markdown: "## pane p-1 (active, side B)\n\
                       \n\
                       | side | tab | kind | title | flags |\n\
                       | --- | --- | --- | --- | --- |\n\
                       | A | (empty) | | | |\n\
                       | B | t-2* | editor | Notes | dirty |\n\
                       \n",
            request: |request| {
                matches!(
                    request,
                    ControlRequest::PaneQuery {
                        window_id: Some(window_id),
                        tab_name: None,
                    } if window_id == "w-1"
                )
            },
        },
        Case {
            name: "terminal list",
            args: &["terminal", "list"],
            noun: "terminal list",
            env: &[],
            reply: r#"{"groups":{"team":[{"name":"@@A","spawn_name":"@@A","agent":"claude","session_id":"s-1","window":"w-1","pane":"p-1","side":"a","tab":"t-1","window_kind":"workspace","window_status":"connected","queue_depth":3,"cwd":"/work"}]}}"#,
            pretty: r#"{
  "groups": {
    "team": [
      {
        "agent": "claude",
        "cwd": "/work",
        "name": "@@A",
        "pane": "p-1",
        "queue_depth": 3,
        "session_id": "s-1",
        "side": "a",
        "spawn_name": "@@A",
        "tab": "t-1",
        "window": "w-1",
        "window_kind": "workspace",
        "window_status": "connected"
      }
    ]
  }
}
"#,
            markdown: "## team\n\
                       \n\
                       | name | spawn | agent | session | window | pane | side | tab | kind | status | queue | cwd |\n\
                       | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n\
                       | @@A | @@A | claude | s-1 | w-1 | p-1 | a | t-1 | workspace | connected | 3 | /work |\n\
                       \n",
            request: |request| matches!(request, ControlRequest::TermList),
        },
        Case {
            name: "search",
            args: &["search", "hello"],
            noun: "workspace search",
            env: &[],
            // Scrambled at every level: the typed parse restores the struct's
            // field order, which is neither this order nor alphabetical.
            reply: r#"{"search":{"mode":"bm25","ready":true,"requested":true},"errors":[],"workspace":{"display_name":"Work","root":"/work","metadata_key":"k-1"},"content_hits":[{"score":1.5,"snippet":"a <b>hit</b>\nhere","start_line":4,"heading":"Intro","chunk_id":"c-1","path":"notes/a.md"}],"readiness":{"generation":3,"state":"ready"},"entity_matches":[],"nodes":[],"relationships":[],"traversal":{"profiles":[],"spine_forced":false,"relationship_kinds":[],"direction":"auto","depth":0},"truncation":{"frontier_stopped":false,"graph_edges_observed":0,"graph_edges":false,"graph_nodes_observed":0,"graph_nodes":false,"entity_matches_observed":0,"entity_matches":false,"content_hits_observed":1,"content_hits":false},"warnings":[]}"#,
            pretty: r#"{
  "workspace": {
    "root": "/work",
    "metadata_key": "k-1",
    "display_name": "Work"
  },
  "readiness": {
    "state": "ready",
    "generation": 3
  },
  "search": {
    "requested": true,
    "ready": true,
    "mode": "bm25"
  },
  "content_hits": [
    {
      "path": "notes/a.md",
      "chunk_id": "c-1",
      "heading": "Intro",
      "start_line": 4,
      "snippet": "a <b>hit</b>\nhere",
      "score": 1.5
    }
  ],
  "entity_matches": [],
  "nodes": [],
  "relationships": [],
  "traversal": {
    "depth": 0,
    "direction": "auto",
    "relationship_kinds": [],
    "spine_forced": false,
    "profiles": []
  },
  "truncation": {
    "content_hits": false,
    "content_hits_observed": 1,
    "entity_matches": false,
    "entity_matches_observed": 0,
    "graph_nodes": false,
    "graph_nodes_observed": 0,
    "graph_edges": false,
    "graph_edges_observed": 0,
    "frontier_stopped": false
  },
  "warnings": [],
  "errors": []
}
"#,
            markdown: "## Content\n\
                       \n\
                       - notes/a.md:4 - Intro\n\
                       \x20 a **hit** here\n\
                       \n",
            request: |request| {
                matches!(
                    request,
                    ControlRequest::WorkspaceSearch { request }
                        if request.query.as_deref() == Some("hello")
                )
            },
        },
    ]
}

/// A `cs search` reply that carries a structured error: every mode still
/// prints it, and the command exits non-zero afterwards.
fn search_with_errors() -> Case {
    Case {
        name: "search with errors",
        args: &["search", "hello"],
        noun: "workspace search",
        env: &[],
        reply: r#"{"errors":[{"message":"index is rebuilding","code":"index_not_ready"}],"search":{"mode":"not_run","ready":false,"requested":true},"workspace":{"display_name":"Work","root":"/work","metadata_key":"k-1"},"content_hits":[],"readiness":{"generation":3,"state":"ready"},"entity_matches":[],"nodes":[],"relationships":[],"traversal":{"profiles":[],"spine_forced":false,"relationship_kinds":[],"direction":"auto","depth":0},"truncation":{"frontier_stopped":false,"graph_edges_observed":0,"graph_edges":false,"graph_nodes_observed":0,"graph_nodes":false,"entity_matches_observed":0,"entity_matches":false,"content_hits_observed":0,"content_hits":false},"warnings":[]}"#,
        pretty: r#"{
  "workspace": {
    "root": "/work",
    "metadata_key": "k-1",
    "display_name": "Work"
  },
  "readiness": {
    "state": "ready",
    "generation": 3
  },
  "search": {
    "requested": true,
    "ready": false,
    "mode": "not_run"
  },
  "content_hits": [],
  "entity_matches": [],
  "nodes": [],
  "relationships": [],
  "traversal": {
    "depth": 0,
    "direction": "auto",
    "relationship_kinds": [],
    "spine_forced": false,
    "profiles": []
  },
  "truncation": {
    "content_hits": false,
    "content_hits_observed": 0,
    "entity_matches": false,
    "entity_matches_observed": 0,
    "graph_nodes": false,
    "graph_nodes_observed": 0,
    "graph_edges": false,
    "graph_edges_observed": 0,
    "frontier_stopped": false
  },
  "warnings": [],
  "errors": [
    {
      "code": "index_not_ready",
      "message": "index is rebuilding"
    }
  ]
}
"#,
        markdown: "## Errors\n\
                   \n\
                   - index is rebuilding\n\
                   \n",
        request: |request| {
            matches!(
                request,
                ControlRequest::WorkspaceSearch { request }
                    if request.query.as_deref() == Some("hello")
            )
        },
    }
}

/// The three output modes, as the flags appended to a case's arguments.
const MODES: [(&str, &[&str]); 3] = [
    ("--json", &["--json"]),
    ("--json --pretty", &["--json", "--pretty"]),
    ("markdown", &[]),
];

/// What one `cs` run produced: its process output and the request line it
/// sent, decoded.
struct Run {
    output: std::process::Output,
    request: ControlRequest,
}

/// When the fake server answers, relative to the client's half-close. A real
/// control server reads the request line, dispatches, writes its reply and
/// closes without waiting for the client's EOF.
#[derive(Clone, Copy)]
enum Answer {
    /// Only after `cs` has half-closed its write side, so the fake's close
    /// can never land before the client's shutdown and the byte-level cases
    /// are deterministic on every platform.
    AfterClientEof,
    /// Straight after the request line, closing without reading to the
    /// client's EOF: the real server's order. It races the client's
    /// shutdown, which macOS refuses with ENOTCONN when the close lands
    /// first.
    AtOnce,
}

/// Run `cs <args> <mode flags>` against a one-shot fake control server that
/// answers `reply` as one `Ok` line, timed by `answer`. The socket lives
/// under the system temp dir with a short name, inside the Unix socket path
/// limit on macOS.
async fn run_cs(case: &Case, reply: &str, mode: &[&str], answer: Answer) -> Run {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let socket: PathBuf = std::env::temp_dir().join(format!(
        "cs-out-{}-{}.sock",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).expect("bind fake control socket");
    let reply = ControlResponse::Ok {
        message: reply.to_string(),
    };
    let mut line = serde_json::to_string(&reply).expect("encode reply");
    line.push('\n');
    let server = tokio::spawn(async move {
        let (conn, _) = timeout(BUDGET, listener.accept())
            .await
            .expect("cs connects within the budget")
            .expect("accept");
        let (read, mut write) = conn.into_split();
        let mut reader = BufReader::new(read);
        let mut request = String::new();
        timeout(BUDGET, reader.read_line(&mut request))
            .await
            .expect("cs sends its request within the budget")
            .expect("read request line");
        match answer {
            // `cs` half-closes its write side right after the request line
            // and only then reads the reply. Waiting for that EOF keeps this
            // task's exit, which closes the socket, behind the client's
            // shutdown.
            Answer::AfterClientEof => {
                let mut trailing = Vec::new();
                timeout(BUDGET, reader.read_to_end(&mut trailing))
                    .await
                    .expect("cs half-closes its write side within the budget")
                    .expect("read to the client's EOF");
                assert!(
                    trailing.is_empty(),
                    "cs sent bytes after its request line: {trailing:?}"
                );
            }
            Answer::AtOnce => {}
        }
        // A `cs` that failed between its request and its read may already
        // be gone, and then the write breaks the pipe. Let that show as
        // `cs`'s own stderr through the exit assertions, not as a panic in
        // this task.
        let _ = write.write_all(line.as_bytes()).await;
        request
    });

    // `cs -> chan` in a fresh tempdir, so the binary parses argv as cs.
    let dir = tempfile::tempdir().expect("tempdir");
    let cs = dir.path().join("cs");
    symlink(env!("CARGO_BIN_EXE_chan"), &cs).expect("symlink cs -> chan");
    let mut cmd = Command::new(&cs);
    cmd.env_clear()
        .envs(chan::test_env::scrubbed_process_env())
        .env("CHAN_CONTROL_SOCKET", &socket)
        .envs(case.env.iter().copied())
        .args(case.args)
        .args(mode)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = timeout(BUDGET, cmd.output())
        .await
        .expect("cs exits within the budget")
        .expect("run cs");
    let request = timeout(BUDGET, server)
        .await
        .expect("fake server finishes within the budget")
        .expect("fake server task");
    let _ = std::fs::remove_file(&socket);
    let request: ControlRequest =
        serde_json::from_str(request.trim_end()).expect("cs sent a control request");
    Run { output, request }
}

/// The exact stdout of a successful run, with the request checked first so
/// a wrong environment shows up as the request it produced, not as output.
async fn stdout_of(case: &Case, mode: &[&str]) -> String {
    let run = run_cs(case, case.reply, mode, Answer::AfterClientEof).await;
    assert!(
        (case.request)(&run.request),
        "{}: unexpected request {:?}",
        case.name,
        run.request
    );
    assert!(
        run.output.status.success(),
        "{} {mode:?}: exit {:?}, stderr: {}",
        case.name,
        run.output.status,
        String::from_utf8_lossy(&run.output.stderr)
    );
    String::from_utf8(run.output.stdout).expect("utf-8 stdout")
}

#[tokio::test]
async fn json_prints_the_reply_verbatim_plus_a_newline() {
    for case in cases() {
        let expected = format!("{}\n", case.reply);
        assert_eq!(
            stdout_of(&case, &["--json"]).await,
            expected,
            "{}",
            case.name
        );
    }
}

#[tokio::test]
async fn json_pretty_sorts_keys_except_the_typed_search_result() {
    for case in cases() {
        assert_eq!(
            stdout_of(&case, &["--json", "--pretty"]).await,
            case.pretty,
            "{}",
            case.name
        );
    }
}

#[tokio::test]
async fn markdown_is_the_renderer_output_without_an_extra_newline() {
    for case in cases() {
        assert_eq!(stdout_of(&case, &[]).await, case.markdown, "{}", case.name);
    }
}

#[tokio::test]
async fn search_prints_then_fails_when_the_result_carries_errors() {
    let case = search_with_errors();
    for (label, mode) in MODES {
        let run = run_cs(&case, case.reply, mode, Answer::AfterClientEof).await;
        assert!((case.request)(&run.request), "{label}: {:?}", run.request);
        let expected = match label {
            "--json" => format!("{}\n", case.reply),
            "--json --pretty" => case.pretty.to_string(),
            _ => case.markdown.to_string(),
        };
        assert_eq!(
            String::from_utf8(run.output.stdout).expect("utf-8 stdout"),
            expected,
            "{label}"
        );
        assert!(
            !run.output.status.success(),
            "{label}: a result with errors must exit non-zero"
        );
        let stderr = String::from_utf8_lossy(&run.output.stderr);
        assert!(
            stderr.contains("workspace search completed with structured errors"),
            "{label}: stderr: {stderr}"
        );
    }
}

/// The real server dispatches the request, then replies and closes without
/// waiting for `cs` to half-close. When that close arrives first, macOS
/// answers the client's shutdown with ENOTCONN, and `cs` must still print the
/// reply it already has. Which side wins is a scheduling race, so one command
/// runs several times to make a regression likely to show; the fake answers
/// every command alike, and `window list` needs no environment beyond the
/// socket. On Linux the shutdown never fails either way.
#[tokio::test]
async fn a_server_that_answers_and_closes_at_once_still_gets_its_reply_printed() {
    let case = cases()
        .into_iter()
        .find(|case| case.name == "window list")
        .expect("the window list case");
    let expected = format!("{}\n", case.reply);
    for round in 0..16 {
        let run = run_cs(&case, case.reply, &["--json"], Answer::AtOnce).await;
        assert!(
            (case.request)(&run.request),
            "round {round}: unexpected request {:?}",
            run.request
        );
        assert!(
            run.output.status.success(),
            "round {round}: exit {:?}, stderr: {}",
            run.output.status,
            String::from_utf8_lossy(&run.output.stderr)
        );
        assert_eq!(
            String::from_utf8(run.output.stdout).expect("utf-8 stdout"),
            expected,
            "round {round}"
        );
    }
}

/// A reply that is not JSON: plain `--json` still prints it verbatim and
/// exits zero, since nothing parses it; `--json --pretty` fails naming the
/// reply. `cs search` parses before printing, so it fails in both modes.
#[tokio::test]
async fn json_pretty_names_the_reply_it_could_not_parse() {
    for case in cases() {
        let plain = run_cs(&case, "not json", &["--json"], Answer::AfterClientEof).await;
        let pretty = run_cs(
            &case,
            "not json",
            &["--json", "--pretty"],
            Answer::AfterClientEof,
        )
        .await;
        let parse_error = format!("parsing {} JSON", case.noun);
        if case.name == "search" {
            for (label, run) in [("--json", &plain), ("--json --pretty", &pretty)] {
                assert!(!run.output.status.success(), "{}: {label}", case.name);
                let stderr = String::from_utf8_lossy(&run.output.stderr);
                assert!(
                    stderr.contains(&parse_error),
                    "{}: {label}: {stderr}",
                    case.name
                );
            }
            continue;
        }
        assert!(plain.output.status.success(), "{}: --json", case.name);
        assert_eq!(
            String::from_utf8_lossy(&plain.output.stdout),
            "not json\n",
            "{}: --json",
            case.name
        );
        assert!(
            !pretty.output.status.success(),
            "{}: --json --pretty",
            case.name
        );
        let stderr = String::from_utf8_lossy(&pretty.output.stderr);
        assert!(
            stderr.contains(&parse_error),
            "{}: --json --pretty: {stderr}",
            case.name
        );
    }
}
