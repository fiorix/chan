//! Connection lifetime for an operational client session. Dropping a pump
//! releases its transport without invoking any resource-removal route.

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use chan_library::client_sessions::{
    cancelled, ClientConnection, ClientTenant, DETACHED_CLOSE_CODE,
};

pub(crate) async fn serve<F, Fut>(
    mut socket: WebSocket,
    tenant: ClientTenant,
    holder: Option<String>,
    window: String,
    transport: &str,
    run: F,
) where
    F: FnOnce(WebSocket, ClientConnection) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let connection = match tenant.connect(holder.as_deref(), &window, transport) {
        Ok(connection) => connection,
        Err(message) => {
            let detached = holder
                .as_deref()
                .is_some_and(|h| tenant.registry.is_detached(h));
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: if detached { DETACHED_CLOSE_CODE } else { 1013 },
                    reason: message.into(),
                })))
                .await;
            return;
        }
    };
    let cancellation = connection.cancellation();
    // Also cancels a pump blocked sending a replay to a sleeping laptop. A
    // retry receives the explicit detached close code before any PTY spawn.
    tokio::select! {
        biased;
        _ = cancelled(cancellation) => {}
        _ = run(socket, connection) => {}
    }
}
