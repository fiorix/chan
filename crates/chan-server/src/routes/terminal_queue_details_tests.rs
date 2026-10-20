use super::*;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as ClientMessage;

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn frame(client: &mut Client) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let message = client.next().await.expect("socket open").expect("frame");
            if let ClientMessage::Text(text) = message {
                return serde_json::from_str(&text).expect("JSON frame");
            }
        }
    })
    .await
    .expect("frame deadline")
}

async fn until(client: &mut Client, kind: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        let next = frame(client).await;
        let done = next["type"] == kind;
        frames.push(next);
        if done {
            return frames;
        }
    }
}

async fn send(client: &mut Client, value: Value) {
    client
        .send(ClientMessage::Text(value.to_string().into()))
        .await
        .expect("send");
}

#[tokio::test]
async fn queue_details_subscribes_snapshots_updates_and_stops_on_close() {
    let state = crate::state::test_support::make_test_state_with_program_status();
    let terminal = state
        .terminal_sessions
        .create(CreateOptions {
            size: pty_size(Some(80), Some(24)),
            command: Some("read -r line".into()),
            tab_name: None,
            tab_group: None,
            window_id: None,
            mcp_env: false,
            cwd: None,
            env: BTreeMap::new(),
            profile: None,
        })
        .expect("terminal");
    let app = axum::Router::new()
        .route("/api/terminal/ws", axum::routing::get(api_terminal_ws))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve")
    }));
    let (mut client, _) = tokio_tungstenite::connect_async(format!(
        "ws://{address}/api/terminal/ws?session={}",
        terminal.id()
    ))
    .await
    .expect("connect");
    until(&mut client, "ready").await;
    terminal.enqueue_prompt("first".into(), None, Some("p1".into()));
    until(&mut client, "queue").await;
    send(&mut client, json!({"type": "ping"})).await;
    assert!(until(&mut client, "pong")
        .await
        .iter()
        .all(|f| f["type"] != "queue-details"));

    send(
        &mut client,
        json!({"type": "queue-details", "enabled": true}),
    )
    .await;
    let snapshot = until(&mut client, "queue-details").await.pop().unwrap();
    assert_eq!(
        snapshot["messages"],
        json!([{"text": "first", "source": "rich_prompt", "prompt_id": "p1", "awaiting_submit": false}])
    );
    terminal.enqueue_prompt("second".into(), None, Some("p2".into()));
    let snapshot = until(&mut client, "queue-details").await.pop().unwrap();
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["messages"][1]["text"], "second");
    assert!(terminal.cancel_prompt("p1"));
    let snapshot = until(&mut client, "queue-details").await.pop().unwrap();
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["messages"][0]["text"], "second");

    send(
        &mut client,
        json!({"type": "queue-details", "enabled": false}),
    )
    .await;
    send(&mut client, json!({"type": "ping"})).await;
    until(&mut client, "pong").await;
    terminal.enqueue_prompt("third".into(), None, Some("p3".into()));
    until(&mut client, "queue").await;
    send(&mut client, json!({"type": "ping"})).await;
    assert!(until(&mut client, "pong")
        .await
        .iter()
        .all(|f| f["type"] != "queue-details"));
    client.close(None).await.expect("close");
    state
        .terminal_sessions
        .close(terminal.id(), CloseReason::Explicit);
}
