//! Client identification from a shell shared by several frontends.

use super::*;

#[derive(serde::Serialize)]
struct ClientSelfInfo {
    #[serde(flatten)]
    client: chan_library::client_sessions::ClientInfo,
    tenant: &'static str,
    participant: Option<chan_library::session_presence::WhoamiInfo>,
}

struct Identification<'a> {
    ctx: &'a ControlSocketCtx,
    window: &'a str,
    request: String,
}

impl Drop for Identification<'_> {
    fn drop(&mut self) {
        self.ctx.window_bus.retire_identification(&self.request);
        let _ = send_window_command(
            self.window,
            WindowCommand::SessionIdentifyEnd {
                request_id: self.request.clone(),
            },
            &self.ctx.events_tx,
        );
    }
}

pub(super) async fn handle_client_self<F>(
    ctx: &ControlSocketCtx,
    window: String,
    id: Option<String>,
    name: Option<String>,
    reset: bool,
    identify: bool,
    wait: ClientWait<'_, F>,
) -> ControlResponse
where
    F: std::future::Future<Output = ()> + Unpin,
{
    if reset && name.is_some() {
        return ControlResponse::Error {
            message: "--name conflicts with --reset".into(),
        };
    }
    let candidates = ctx.client_sessions.candidates(&window);
    let selected = match id {
        Some(id) => id,
        None if candidates.len() == 1 => candidates[0].id.clone(),
        None if candidates.is_empty() => return ControlResponse::Error {
            message: format!("no client session is attached to window {window}"),
        },
        None if !identify => return ControlResponse::Error {
            message: format!("{} client sessions share this window; run cs session self interactively to identify this client, or pass --id from cs session list", candidates.len()),
        },
        None => {
            let (request, reply) = ctx.window_bus.register_identification(&window);
            let pending = Identification { ctx, window: &window, request };
            if let Err(message) = send_window_command(&window, WindowCommand::SessionIdentify {
                request_id: pending.request.clone(),
            }, &ctx.events_tx) {
                return ControlResponse::Error { message };
            }
            tokio::select! {
                biased;
                _ = wait.client_eof => return ControlResponse::Error { message: "session identification cancelled".into() },
                _ = tokio::time::sleep(std::time::Duration::from_secs(wait.timeout_secs.min(300))) => return ControlResponse::Timeout { message: "session identification timed out; select Identify this client in the window you are using".into() },
                reply = reply => match reply.ok().and_then(|value| value["client_id"].as_str().map(str::to_owned)) {
                    Some(id) => id,
                    None => return ControlResponse::Error { message: "session identification dismissed".into() },
                }
            }
        }
    };
    // A reply can arrive after a client detached, or name a different window.
    // Re-resolve instead of trusting the snapshot from before the prompt.
    if !ctx
        .client_sessions
        .candidates(&window)
        .iter()
        .any(|c| c.id == selected)
    {
        return ControlResponse::Error {
            message: format!("client session {selected} is not attached to this window"),
        };
    }
    let registry = &ctx.client_sessions.registry;
    let result = (|| {
        let changing = name.is_some() || reset;
        if ctx.tenant == ControlTenant::Workspace {
            let (client, participant) = if changing {
                let (client, participant) = registry.rename_with_participant(
                    &selected,
                    name.as_deref(),
                    &ctx.session_registry,
                    &window,
                )?;
                (client, Some(participant))
            } else {
                let client = registry.info(&selected)?;
                let participant = ctx
                    .session_registry
                    .whoami(&window, std::time::Instant::now());
                (client, participant)
            };
            if changing {
                crate::session_roster::broadcast_session_roster(
                    &ctx.events_tx,
                    &ctx.session_registry,
                );
            }
            Ok(ClientSelfInfo {
                client,
                tenant: "workspace",
                participant,
            })
        } else {
            let client = if changing {
                registry.rename(&selected, name.as_deref())?
            } else {
                registry.info(&selected)?
            };
            Ok::<_, String>(ClientSelfInfo {
                client,
                tenant: "terminal",
                participant: None,
            })
        }
    })();
    into_response(result.and_then(|info| serde_json::to_string(&info).map_err(|e| e.to_string())))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn naming_repair_bare_workspace_self_without_event_participant_reports_client() {
        let ctx = naming_context(ControlTenant::Workspace);
        let client = ctx
            .client_sessions
            .connect(Some("work"), "w", "terminal")
            .unwrap();
        let response = handle_request(request(None, None), &ctx).await;
        assert_eq!(
            if matches!(&response, ControlResponse::Ok { .. }) {
                "ok"
            } else {
                "error"
            },
            "ok",
            "{response:?}"
        );
        let value = self_value(response);
        assert_eq!(value["id"], client.id());
        assert_eq!(value["tenant"], "workspace");
        assert_eq!(value.get("participant"), Some(&serde_json::Value::Null));
        let before = ctx.client_sessions.registry.info(client.id()).unwrap().name;
        for reset in [false, true] {
            let mut mutation = request(None, (!reset).then_some("override"));
            if let ControlRequest::SessionSelf { reset: flag, .. } = &mut mutation {
                *flag = reset;
            }
            let response = handle_request(mutation, &ctx).await;
            assert!(
                matches!(&response, ControlResponse::Error { message } if message.contains("not a session participant")),
                "{response:?}"
            );
            assert_eq!(
                ctx.client_sessions.registry.info(client.id()).unwrap().name,
                before
            );
        }
    }

    #[tokio::test]
    async fn naming_repair_self_names_its_tenant() {
        for (tenant, expected) in [
            (ControlTenant::Workspace, "workspace"),
            (ControlTenant::TerminalOnly, "terminal"),
        ] {
            let ctx = naming_context(tenant);
            let _participant = ctx.session_registry.join("w", true, None).guard;
            let _client = ctx
                .client_sessions
                .connect(Some("work"), "w", "events")
                .unwrap();
            for name in [None, Some("override")] {
                let value = self_value(handle_request(request(None, name), &ctx).await);
                assert_eq!(value["tenant"], expected);
            }
        }
    }

    fn naming_context(tenant: ControlTenant) -> ControlSocketCtx {
        let mut ctx = super::super::tests::test_ctx(Arc::new(RwLock::new(None)), tenant);
        ctx.events_tx = broadcast::channel(16).0;
        ctx
    }

    fn self_value(response: ControlResponse) -> serde_json::Value {
        let ControlResponse::Ok { message } = response else {
            panic!("{response:?}")
        };
        serde_json::from_str(&message).unwrap()
    }

    async fn refuses_name(name: &str, reason: &str) {
        let ctx = naming_context(ControlTenant::Workspace);
        let _participant = ctx.session_registry.join("w", true, None).guard;
        let client = ctx
            .client_sessions
            .connect(Some("work"), "w", "events")
            .unwrap();
        ctx.client_sessions
            .registry
            .rename(client.id(), Some("client before"))
            .unwrap();
        ctx.session_registry
            .rename("w", "participant before")
            .unwrap();
        let mut events = ctx.events_tx.subscribe();
        let response = handle_request(request(None, Some(name)), &ctx).await;
        assert!(
            matches!(&response, ControlResponse::Error { message } if message.contains(reason)),
            "{response:?}"
        );
        assert_eq!(
            ctx.client_sessions.registry.info(client.id()).unwrap().name,
            "client before"
        );
        assert_eq!(
            ctx.session_registry
                .whoami("w", std::time::Instant::now())
                .unwrap()
                .name,
            "participant before"
        );
        assert_eq!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        );
    }

    #[tokio::test]
    async fn self_refuses_empty_name() {
        refuses_name("   ", "empty").await;
    }

    #[tokio::test]
    async fn self_refuses_overlong_name() {
        refuses_name(&"x".repeat(65), "64").await;
    }

    #[tokio::test]
    async fn self_refuses_control_name() {
        refuses_name("name\u{85}", "control").await;
    }

    #[tokio::test]
    async fn self_refuses_zero_width_name() {
        refuses_name("na\u{200b}me", "format").await;
    }

    #[tokio::test]
    async fn self_refuses_bidi_name() {
        refuses_name("na\u{202e}me", "format").await;
    }

    #[tokio::test]
    async fn self_refuses_another_live_client_name_across_tenants() {
        let ctx = naming_context(ControlTenant::Workspace);
        let _participant = ctx.session_registry.join("w", true, None).guard;
        let client = ctx
            .client_sessions
            .connect(Some("work"), "w", "events")
            .unwrap();
        let other = ctx
            .client_sessions
            .registry
            .tenant("/other", "terminal")
            .connect(Some("home"), "other-window", "events")
            .unwrap();
        ctx.client_sessions
            .registry
            .rename(other.id(), Some("ALIce"))
            .unwrap();
        let before = ctx
            .session_registry
            .whoami("w", std::time::Instant::now())
            .unwrap();
        let client_before = ctx.client_sessions.registry.info(client.id()).unwrap().name;
        let response = handle_request(request(None, Some("alice")), &ctx).await;
        assert!(
            matches!(&response, ControlResponse::Error { message } if message.contains(other.id())),
            "{response:?}"
        );
        assert_eq!(
            ctx.client_sessions.registry.info(client.id()).unwrap().name,
            client_before
        );
        assert_eq!(
            ctx.session_registry
                .whoami("w", std::time::Instant::now())
                .unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn self_refuses_another_participant_name_without_partial_rename() {
        let ctx = naming_context(ControlTenant::Workspace);
        let _participant = ctx.session_registry.join("w", true, None).guard;
        let other = ctx.session_registry.join("other-window", false, None).guard;
        ctx.session_registry
            .rename("other-window", "ALIce")
            .unwrap();
        drop(other);
        let client = ctx
            .client_sessions
            .connect(Some("work"), "w", "events")
            .unwrap();
        let before = ctx
            .session_registry
            .whoami("w", std::time::Instant::now())
            .unwrap()
            .name;
        let client_before = ctx.client_sessions.registry.info(client.id()).unwrap().name;
        let mut events = ctx.events_tx.subscribe();
        let response = handle_request(request(None, Some("alice")), &ctx).await;
        assert!(
            matches!(&response, ControlResponse::Error { message } if message.contains("other-window")),
            "{response:?}"
        );
        assert_eq!(
            ctx.client_sessions.registry.info(client.id()).unwrap().name,
            client_before
        );
        assert_eq!(
            ctx.session_registry
                .whoami("w", std::time::Instant::now())
                .unwrap()
                .name,
            before
        );
        assert_eq!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        );
    }

    #[tokio::test]
    async fn self_names_both_and_broadcasts_the_participant_roster() {
        let ctx = naming_context(ControlTenant::Workspace);
        let _participant = ctx.session_registry.join("w", true, None).guard;
        let client = ctx
            .client_sessions
            .connect(Some("work"), "w", "events")
            .unwrap();
        let mut events = ctx.events_tx.subscribe();
        let value = self_value(handle_request(request(None, Some("  Alice  ")), &ctx).await);
        assert_eq!(value["name"], "Alice");
        assert_eq!(value["participant"]["name"], "Alice");
        assert_eq!(value["participant"]["window_id"], "w");
        assert_eq!(
            ctx.client_sessions.registry.info(client.id()).unwrap().name,
            "Alice"
        );
        assert_eq!(
            ctx.session_registry
                .whoami("w", std::time::Instant::now())
                .unwrap()
                .name,
            "Alice"
        );
        let frame: serde_json::Value = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "session_roster");
        assert_eq!(frame["participants"][0]["name"], "Alice");
        assert_eq!(frame["leader"], "w");
        let again = self_value(handle_request(request(None, Some("alice")), &ctx).await);
        assert_eq!(again["participant"]["name"], "alice");
    }

    #[tokio::test]
    async fn self_resets_both_to_identity_or_generated_defaults() {
        for identity in [
            None,
            Some(chan_library::session_presence::ParticipantIdentity {
                display_name: Some("Ada".into()),
                email: Some("ada@example.test".into()),
            }),
        ] {
            let ctx = naming_context(ControlTenant::Workspace);
            let _participant = ctx.session_registry.join("w", false, identity).guard;
            let client = ctx
                .client_sessions
                .connect(Some("work"), "w", "events")
                .unwrap();
            let client_default = ctx.client_sessions.registry.info(client.id()).unwrap().name;
            let participant_default = ctx
                .session_registry
                .whoami("w", std::time::Instant::now())
                .unwrap();
            ctx.client_sessions
                .registry
                .rename(client.id(), Some("override"))
                .unwrap();
            ctx.session_registry.rename("w", "override").unwrap();
            let mut reset = request(None, None);
            let ControlRequest::SessionSelf { reset: flag, .. } = &mut reset else {
                unreachable!()
            };
            *flag = true;
            let mut events = ctx.events_tx.subscribe();
            let value = self_value(handle_request(reset, &ctx).await);
            assert_eq!(value["name"], client_default);
            assert_eq!(
                value["participant"],
                serde_json::to_value(&participant_default).unwrap()
            );
            assert_eq!(
                ctx.session_registry
                    .whoami("w", std::time::Instant::now())
                    .unwrap(),
                participant_default
            );
            let frame: serde_json::Value =
                serde_json::from_str(&events.try_recv().unwrap()).unwrap();
            assert_eq!(frame["participants"][0]["name"], participant_default.name);
        }
    }

    #[tokio::test]
    async fn self_query_reports_both_parts_only_on_a_workspace() {
        for tenant in [ControlTenant::Workspace, ControlTenant::TerminalOnly] {
            let ctx = naming_context(tenant);
            let _participant = ctx
                .session_registry
                .join(
                    "w",
                    false,
                    Some(chan_library::session_presence::ParticipantIdentity {
                        display_name: Some("Ada".into()),
                        email: Some("ada@example.test".into()),
                    }),
                )
                .guard;
            let client = ctx
                .client_sessions
                .connect(Some("work"), "w", "events")
                .unwrap();
            let mut events = ctx.events_tx.subscribe();
            let value = self_value(handle_request(request(None, None), &ctx).await);
            assert_eq!(value["id"], client.id());
            assert_eq!(value["holder"], "work");
            assert_eq!(value["status"], "live");
            assert_eq!(value["connections"].as_array().unwrap().len(), 1);
            let participant = if tenant == ControlTenant::Workspace {
                serde_json::to_value(
                    ctx.session_registry
                        .whoami("w", std::time::Instant::now())
                        .unwrap(),
                )
                .unwrap()
            } else {
                serde_json::Value::Null
            };
            assert_eq!(value.get("participant"), Some(&participant));
            assert_eq!(
                events.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            );
            let info = self_value(
                handle_request(
                    ControlRequest::SessionInfo {
                        id: client.id().into(),
                    },
                    &ctx,
                )
                .await,
            );
            assert_eq!(info.get("participant"), None);
        }
    }

    #[tokio::test]
    async fn standalone_self_names_and_resets_the_client_only() {
        let ctx = naming_context(ControlTenant::TerminalOnly);
        let client = ctx
            .client_sessions
            .connect(Some("work"), "w", "events")
            .unwrap();
        let default = ctx.client_sessions.registry.info(client.id()).unwrap().name;
        let value = self_value(handle_request(request(None, Some("Alice")), &ctx).await);
        assert_eq!(value["name"], "Alice");
        assert_eq!(value.get("participant"), Some(&serde_json::Value::Null));
        let mut reset = request(None, None);
        let ControlRequest::SessionSelf { reset: flag, .. } = &mut reset else {
            unreachable!()
        };
        *flag = true;
        let value = self_value(handle_request(reset, &ctx).await);
        assert_eq!(value["name"], default);
        assert_eq!(value.get("participant"), Some(&serde_json::Value::Null));
    }

    fn request(id: Option<&str>, name: Option<&str>) -> ControlRequest {
        ControlRequest::SessionSelf {
            window_id: "w".into(),
            id: id.map(str::to_owned),
            name: name.map(str::to_owned),
            reset: false,
            identify: false,
            timeout_secs: 30,
        }
    }

    #[tokio::test]
    async fn standalone_self_refuses_ambiguity_and_renames_only_the_selected_client() {
        let ctx =
            super::super::tests::test_ctx(Arc::new(RwLock::new(None)), ControlTenant::TerminalOnly);
        let a = ctx
            .client_sessions
            .connect(Some("work"), "w", "events")
            .unwrap();
        let b = ctx
            .client_sessions
            .connect(Some("home"), "w", "events")
            .unwrap();
        assert!(matches!(
            handle_request(request(None, None), &ctx).await,
            ControlResponse::Error { .. }
        ));
        assert!(matches!(
            handle_request(request(Some(b.id()), Some("home laptop")), &ctx).await,
            ControlResponse::Ok { .. }
        ));
        assert_eq!(
            ctx.client_sessions.registry.info(b.id()).unwrap().name,
            "home laptop"
        );
        assert_ne!(
            ctx.client_sessions.registry.info(a.id()).unwrap().name,
            "home laptop"
        );
        assert!(matches!(
            handle_request(ControlRequest::SessionList, &ctx).await,
            ControlResponse::Ok { .. }
        ));
        assert!(matches!(
            handle_request(ControlRequest::SessionDetach { id: a.id().into() }, &ctx).await,
            ControlResponse::Ok { .. }
        ));
        assert!(matches!(
            handle_request(request(None, None), &ctx).await,
            ControlResponse::Ok { .. }
        ));
    }

    #[tokio::test]
    async fn interactive_self_selects_the_answering_client_and_rejects_stale_answers() {
        for detached in [false, true] {
            let mut ctx = super::super::tests::test_ctx(
                Arc::new(RwLock::new(None)),
                ControlTenant::TerminalOnly,
            );
            let _work = ctx
                .client_sessions
                .connect(Some("work"), "w", "events")
                .unwrap();
            let home = ctx
                .client_sessions
                .connect(Some("home"), "w", "events")
                .unwrap();
            ctx.events_tx = broadcast::channel(4).0;
            let mut events = ctx.events_tx.subscribe();
            let mut eof = std::future::pending();
            let handler = handle_client_self(
                &ctx,
                "w".into(),
                None,
                Some("home laptop".into()),
                false,
                true,
                ClientWait {
                    client_eof: &mut eof,
                    timeout_secs: 30,
                },
            );
            let answer = async {
                let frame: serde_json::Value =
                    serde_json::from_str(&events.recv().await.unwrap()).unwrap();
                assert_eq!(frame["command"], "session_identify");
                let request = frame["request_id"].as_str().unwrap();
                if detached {
                    ctx.client_sessions.registry.detach(home.id()).unwrap();
                }
                assert!(ctx
                    .window_bus
                    .complete(request, serde_json::json!({ "client_id": home.id() })));
                request.to_owned()
            };
            let (response, request) = tokio::join!(handler, answer);
            if detached {
                assert!(matches!(response, ControlResponse::Error { .. }));
            } else {
                let ControlResponse::Ok { message } = response else {
                    panic!("{response:?}")
                };
                let info: serde_json::Value = serde_json::from_str(&message).unwrap();
                assert_eq!(info["id"], home.id());
                assert_eq!(info["name"], "home laptop");
            }
            let end: serde_json::Value =
                serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            assert_eq!(end["command"], "session_identify_end");
            assert_eq!(end["request_id"], request);
            assert!(!ctx
                .window_bus
                .complete(&request, serde_json::json!({ "client_id": home.id() })));
        }
    }

    #[tokio::test]
    async fn identification_timeout_and_eof_retire_the_prompt() {
        for eof_ready in [false, true] {
            let mut ctx = super::super::tests::test_ctx(
                Arc::new(RwLock::new(None)),
                ControlTenant::TerminalOnly,
            );
            let _work = ctx
                .client_sessions
                .connect(Some("work"), "w", "events")
                .unwrap();
            let home = ctx
                .client_sessions
                .connect(Some("home"), "w", "events")
                .unwrap();
            ctx.events_tx = broadcast::channel(4).0;
            let mut events = ctx.events_tx.subscribe();
            let mut eof = Box::pin(async move {
                if !eof_ready {
                    std::future::pending::<()>().await;
                }
            });
            let handler = handle_client_self(
                &ctx,
                "w".into(),
                None,
                None,
                false,
                true,
                ClientWait {
                    client_eof: &mut eof,
                    timeout_secs: 0,
                },
            );
            let watch = async {
                let frame: serde_json::Value =
                    serde_json::from_str(&events.recv().await.unwrap()).unwrap();
                let end: serde_json::Value =
                    serde_json::from_str(&events.recv().await.unwrap()).unwrap();
                assert_eq!(end["command"], "session_identify_end");
                assert_eq!(end["request_id"], frame["request_id"]);
                frame["request_id"].as_str().unwrap().to_owned()
            };
            let (response, request) = tokio::join!(handler, watch);
            assert!(if eof_ready {
                matches!(response, ControlResponse::Error { .. })
            } else {
                matches!(response, ControlResponse::Timeout { .. })
            });
            assert!(!ctx
                .window_bus
                .complete(&request, serde_json::json!({ "client_id": home.id() })));
        }
    }
}
