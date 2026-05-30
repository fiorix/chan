use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use chan_llm::mcp::{
    AgentInboxProvider, AgentInboxProviderError, ListAgentTasksResult, SendAgentTaskResult,
};
use chan_llm::team_work::{canonical_agent_handle, canonical_team_name, TeamWorkIdentity};
use serde::Serialize;

use crate::config::sanitize_team_work_inbox_depth;
use crate::terminal_sessions::Registry as TerminalRegistry;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentTask {
    pub id: u64,
    pub from: String,
    pub to: String,
    pub context_path: String,
    pub created_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentTaskList {
    pub team: String,
    pub agent: String,
    pub oldest_retained_id: Option<u64>,
    pub latest_id: Option<u64>,
    pub tasks: Vec<AgentTask>,
}

#[derive(Debug, thiserror::Error)]
pub enum AgentInboxError {
    #[error("invalid {field}: {reason}")]
    InvalidParam { field: &'static str, reason: String },
    #[error("task id overflow")]
    IdOverflow,
    #[error("agent inbox lock poisoned")]
    LockPoisoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct InboxKey {
    team: String,
    agent: String,
}

#[derive(Debug)]
pub struct AgentInbox {
    inner: Mutex<Inner>,
}

pub struct ServerAgentInboxProvider {
    inbox: Arc<AgentInbox>,
    terminal_sessions: Arc<TerminalRegistry>,
    workspace_for: Arc<dyn Fn() -> Option<Arc<chan_workspace::Workspace>> + Send + Sync>,
}

#[derive(Debug)]
struct Inner {
    next_id: u64,
    depth: usize,
    tasks: HashMap<InboxKey, VecDeque<AgentTask>>,
}

impl ServerAgentInboxProvider {
    pub fn new<F>(
        inbox: Arc<AgentInbox>,
        terminal_sessions: Arc<TerminalRegistry>,
        workspace_for: F,
    ) -> Self
    where
        F: Fn() -> Option<Arc<chan_workspace::Workspace>> + Send + Sync + 'static,
    {
        Self {
            inbox,
            terminal_sessions,
            workspace_for: Arc::new(workspace_for),
        }
    }
}

#[async_trait::async_trait]
impl AgentInboxProvider for ServerAgentInboxProvider {
    async fn send_agent_task(
        &self,
        identity: TeamWorkIdentity,
        to: String,
        context_path: String,
    ) -> Result<SendAgentTaskResult, AgentInboxProviderError> {
        let workspace = (self.workspace_for)().ok_or_else(|| {
            AgentInboxProviderError::Internal("workspace state unavailable".into())
        })?;
        let inbox = self.inbox.clone();
        let team = identity.team.clone().unwrap_or_default();
        let recipient = to.clone();
        let task = tokio::task::spawn_blocking(move || {
            inbox.send(&workspace, &identity, &to, &context_path)
        })
        .await
        .map_err(|e| AgentInboxProviderError::Internal(format!("agent inbox task failed: {e}")))?
        .map_err(agent_inbox_provider_error)?;
        self.terminal_sessions
            .poke_team_work_agent(&team, &recipient);
        Ok(SendAgentTaskResult { id: task.id })
    }

    async fn list_agent_tasks(
        &self,
        identity: TeamWorkIdentity,
        since_id: Option<u64>,
    ) -> Result<ListAgentTasksResult, AgentInboxProviderError> {
        let inbox = self.inbox.clone();
        let list = tokio::task::spawn_blocking(move || inbox.list(&identity, since_id))
            .await
            .map_err(|e| {
                AgentInboxProviderError::Internal(format!("agent inbox task failed: {e}"))
            })?
            .map_err(agent_inbox_provider_error)?;
        Ok(ListAgentTasksResult {
            team: list.team,
            agent: list.agent,
            oldest_retained_id: list.oldest_retained_id,
            latest_id: list.latest_id,
            tasks: list
                .tasks
                .into_iter()
                .map(|task| chan_llm::mcp::AgentTask {
                    id: task.id,
                    from: task.from,
                    to: task.to,
                    context_path: task.context_path,
                    created_at_unix_ms: task.created_at_unix_ms,
                })
                .collect(),
        })
    }
}

fn agent_inbox_provider_error(err: AgentInboxError) -> AgentInboxProviderError {
    match err {
        AgentInboxError::InvalidParam { .. } => {
            AgentInboxProviderError::InvalidParams(err.to_string())
        }
        AgentInboxError::IdOverflow | AgentInboxError::LockPoisoned => {
            AgentInboxProviderError::Internal(err.to_string())
        }
    }
}

impl AgentInbox {
    pub fn new(depth: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                next_id: 1,
                depth: sanitize_team_work_inbox_depth(depth),
                tasks: HashMap::new(),
            }),
        }
    }

    pub fn set_depth(&self, depth: usize) -> Result<(), AgentInboxError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| AgentInboxError::LockPoisoned)?;
        inner.depth = sanitize_team_work_inbox_depth(depth);
        trim_all(&mut inner);
        Ok(())
    }

    #[cfg(test)]
    pub fn depth(&self) -> Result<usize, AgentInboxError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| AgentInboxError::LockPoisoned)?;
        Ok(inner.depth)
    }

    #[cfg(test)]
    fn set_next_id_for_test(&self, next_id: u64) {
        self.inner.lock().expect("agent inbox lock").next_id = next_id;
    }

    pub fn send(
        &self,
        workspace: &chan_workspace::Workspace,
        identity: &TeamWorkIdentity,
        to: &str,
        context_path: &str,
    ) -> Result<AgentTask, AgentInboxError> {
        let team = identity_team(identity)?;
        let from = identity_agent(identity)?;
        let to = canonical_agent_handle(to).map_err(|reason| AgentInboxError::InvalidParam {
            field: "to",
            reason,
        })?;
        let context_path = validate_context_path(workspace, context_path)?;
        let created_at_unix_ms = current_unix_ms();
        self.enqueue(team, from, to, context_path, created_at_unix_ms)
    }

    pub fn list(
        &self,
        identity: &TeamWorkIdentity,
        since_id: Option<u64>,
    ) -> Result<AgentTaskList, AgentInboxError> {
        let team = identity_team(identity)?;
        let agent = identity_agent(identity)?;
        let key = InboxKey {
            team: team.clone(),
            agent: agent.clone(),
        };
        let inner = self
            .inner
            .lock()
            .map_err(|_| AgentInboxError::LockPoisoned)?;
        let retained = inner.tasks.get(&key);
        let oldest_retained_id = retained.and_then(|tasks| tasks.front().map(|task| task.id));
        let latest_id = retained.and_then(|tasks| tasks.back().map(|task| task.id));
        let tasks = retained
            .map(|tasks| {
                tasks
                    .iter()
                    .filter(|task| since_id.is_none_or(|since_id| task.id > since_id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        Ok(AgentTaskList {
            team,
            agent,
            oldest_retained_id,
            latest_id,
            tasks,
        })
    }

    fn enqueue(
        &self,
        team: String,
        from: String,
        to: String,
        context_path: String,
        created_at_unix_ms: u64,
    ) -> Result<AgentTask, AgentInboxError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| AgentInboxError::LockPoisoned)?;
        let Some(next_id) = inner.next_id.checked_add(1) else {
            return Err(AgentInboxError::IdOverflow);
        };
        let task = AgentTask {
            id: inner.next_id,
            from,
            to: to.clone(),
            context_path,
            created_at_unix_ms,
        };
        inner.next_id = next_id;
        let depth = inner.depth;
        let retained = inner.tasks.entry(InboxKey { team, agent: to }).or_default();
        retained.push_back(task.clone());
        trim_retained(retained, depth);
        Ok(task)
    }
}

pub fn validate_context_path(
    workspace: &chan_workspace::Workspace,
    context_path: &str,
) -> Result<String, AgentInboxError> {
    if context_path.is_empty() {
        return invalid_context_path("must be non-empty");
    }
    if context_path.trim() != context_path {
        return invalid_context_path("must not have leading or trailing whitespace");
    }
    if context_path.starts_with('/') {
        return invalid_context_path("absolute paths are not allowed");
    }
    if context_path == "." || context_path.starts_with("./") {
        return invalid_context_path("leading ./ is not allowed");
    }
    if context_path.contains('\\') {
        return invalid_context_path("windows separators are not allowed");
    }
    if context_path.contains('#') || context_path.contains('?') {
        return invalid_context_path("query strings and fragments are not allowed");
    }
    if context_path
        .bytes()
        .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return invalid_context_path("control characters are not allowed");
    }
    if context_path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return invalid_context_path("path segments must be normal names");
    }
    workspace
        .read_text_with_stat(context_path)
        .map(|_| context_path.to_string())
        .map_err(context_path_workspace_error)
}

fn invalid_context_path<T>(reason: impl Into<String>) -> Result<T, AgentInboxError> {
    Err(AgentInboxError::InvalidParam {
        field: "context_path",
        reason: reason.into(),
    })
}

fn context_path_workspace_error(err: chan_workspace::ChanError) -> AgentInboxError {
    use chan_workspace::ChanError;
    let reason = match err {
        ChanError::PathEmpty => "path is empty",
        ChanError::PathEscape | ChanError::SymlinkEscape(_) => "path escapes workspace",
        ChanError::NotEditableText(_) => "not a readable text file",
        ChanError::SpecialFile { .. } => "not a regular file",
        ChanError::Io(message) if is_not_found_message(&message) => "file not found",
        ChanError::Io(_) => "file is not readable",
        _ => "file is not readable",
    };
    AgentInboxError::InvalidParam {
        field: "context_path",
        reason: reason.to_string(),
    }
}

fn is_not_found_message(message: &str) -> bool {
    message.contains("No such file")
        || message.contains("not found")
        || message.contains("entity not found")
}

fn identity_team(identity: &TeamWorkIdentity) -> Result<String, AgentInboxError> {
    let team = identity
        .team
        .as_deref()
        .ok_or_else(|| AgentInboxError::InvalidParam {
            field: "team",
            reason: "identity unavailable".into(),
        })?;
    canonical_team_name(team).map_err(|reason| AgentInboxError::InvalidParam {
        field: "team",
        reason,
    })
}

fn identity_agent(identity: &TeamWorkIdentity) -> Result<String, AgentInboxError> {
    let agent = identity
        .agent
        .as_deref()
        .ok_or_else(|| AgentInboxError::InvalidParam {
            field: "agent",
            reason: "identity unavailable".into(),
        })?;
    canonical_agent_handle(agent).map_err(|reason| AgentInboxError::InvalidParam {
        field: "agent",
        reason,
    })
}

fn trim_all(inner: &mut Inner) {
    for retained in inner.tasks.values_mut() {
        trim_retained(retained, inner.depth);
    }
}

fn trim_retained(retained: &mut VecDeque<AgentTask>, depth: usize) {
    while retained.len() > depth {
        retained.pop_front();
    }
}

fn current_unix_ms() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    millis.min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_llm::mcp::AgentInboxProvider;
    use chan_llm::team_work::TeamWorkIdentity;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn workspace_fixture() -> (TempDir, TempDir, std::sync::Arc<chan_workspace::Workspace>) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("tasks/one.md", "one").unwrap();
        workspace.write_text("tasks/two.md", "two").unwrap();
        workspace.write_text("tasks/three.md", "three").unwrap();
        (cfg, root, workspace)
    }

    fn identity(team: &str, agent: &str) -> TeamWorkIdentity {
        TeamWorkIdentity::validated(team, agent).unwrap()
    }

    #[test]
    fn send_stores_metadata_and_uses_process_global_ids() {
        let (_cfg, _root, workspace) = workspace_fixture();
        let inbox = AgentInbox::new(10);
        let architect = identity("alpha", "@@Architect");
        let beta_architect = identity("beta", "@@Architect");

        let first = inbox
            .send(&workspace, &architect, "@@FullStackA", "tasks/one.md")
            .unwrap();
        let second = inbox
            .send(&workspace, &beta_architect, "@@FullStackA", "tasks/two.md")
            .unwrap();
        let self_send = inbox
            .send(&workspace, &architect, "@@Architect", "tasks/three.md")
            .unwrap();

        assert_eq!(first.id, 1);
        assert_eq!(second.id, 2);
        assert_eq!(self_send.id, 3);
        assert_eq!(first.from, "@@Architect");
        assert_eq!(first.to, "@@FullStackA");
        assert_eq!(first.context_path, "tasks/one.md");
        assert!(first.created_at_unix_ms > 0);
    }

    #[test]
    fn list_is_team_scoped_and_cursor_based() {
        let (_cfg, _root, workspace) = workspace_fixture();
        let inbox = AgentInbox::new(2);
        let architect = identity("alpha", "@@Architect");
        let beta_architect = identity("beta", "@@Architect");
        let recipient = identity("alpha", "@@FullStackA");
        let beta_recipient = identity("beta", "@@FullStackA");

        inbox
            .send(&workspace, &architect, "@@FullStackA", "tasks/one.md")
            .unwrap();
        inbox
            .send(&workspace, &architect, "@@FullStackA", "tasks/two.md")
            .unwrap();
        inbox
            .send(&workspace, &architect, "@@FullStackA", "tasks/three.md")
            .unwrap();
        inbox
            .send(&workspace, &beta_architect, "@@FullStackA", "tasks/one.md")
            .unwrap();

        let retained = inbox.list(&recipient, None).unwrap();
        assert_eq!(retained.team, "alpha");
        assert_eq!(retained.agent, "@@FullStackA");
        assert_eq!(retained.oldest_retained_id, Some(2));
        assert_eq!(retained.latest_id, Some(3));
        assert_eq!(
            retained.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![2, 3]
        );

        let newer = inbox.list(&recipient, Some(2)).unwrap();
        assert_eq!(
            newer.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![3]
        );

        let future = inbox.list(&recipient, Some(99)).unwrap();
        assert_eq!(future.oldest_retained_id, Some(2));
        assert_eq!(future.latest_id, Some(3));
        assert!(future.tasks.is_empty());

        let other_team = inbox.list(&beta_recipient, Some(0)).unwrap();
        assert_eq!(
            other_team.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![4]
        );
    }

    #[test]
    fn runtime_depth_shrink_evicts_each_retained_inbox() {
        let (_cfg, _root, workspace) = workspace_fixture();
        let inbox = AgentInbox::new(10);
        let architect = identity("alpha", "@@Architect");
        let recipient = identity("alpha", "@@FullStackA");
        let other = identity("alpha", "@@Reviewer");

        inbox
            .send(&workspace, &architect, "@@FullStackA", "tasks/one.md")
            .unwrap();
        inbox
            .send(&workspace, &architect, "@@FullStackA", "tasks/two.md")
            .unwrap();
        inbox
            .send(&workspace, &architect, "@@Reviewer", "tasks/one.md")
            .unwrap();
        inbox
            .send(&workspace, &architect, "@@Reviewer", "tasks/two.md")
            .unwrap();

        inbox.set_depth(1).unwrap();

        let listed = inbox.list(&recipient, None).unwrap();
        assert_eq!(
            listed.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![2]
        );
        let listed = inbox.list(&other, None).unwrap();
        assert_eq!(
            listed.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![4]
        );
    }

    #[test]
    fn id_overflow_fails_without_wrapping() {
        let (_cfg, _root, workspace) = workspace_fixture();
        let inbox = AgentInbox::new(10);
        inbox.set_next_id_for_test(u64::MAX);

        let err = inbox
            .send(
                &workspace,
                &identity("alpha", "@@Architect"),
                "@@FullStackA",
                "tasks/one.md",
            )
            .unwrap_err();

        assert!(matches!(err, AgentInboxError::IdOverflow));
        let listed = inbox
            .list(&identity("alpha", "@@FullStackA"), None)
            .unwrap();
        assert!(listed.tasks.is_empty());
    }

    #[test]
    fn repeated_sends_are_not_deduplicated() {
        let (_cfg, _root, workspace) = workspace_fixture();
        let inbox = AgentInbox::new(10);
        let architect = identity("alpha", "@@Architect");
        let recipient = identity("alpha", "@@FullStackA");

        inbox
            .send(&workspace, &architect, "@@FullStackA", "tasks/one.md")
            .unwrap();
        inbox
            .send(&workspace, &architect, "@@FullStackA", "tasks/one.md")
            .unwrap();

        let listed = inbox.list(&recipient, None).unwrap();
        assert_eq!(listed.tasks.len(), 2);
        assert_ne!(listed.tasks[0].id, listed.tasks[1].id);
    }

    #[test]
    fn empty_inbox_returns_null_metadata() {
        let inbox = AgentInbox::new(10);
        let listed = inbox
            .list(&identity("alpha", "@@FullStackA"), None)
            .unwrap();
        assert_eq!(listed.team, "alpha");
        assert_eq!(listed.agent, "@@FullStackA");
        assert_eq!(listed.oldest_retained_id, None);
        assert_eq!(listed.latest_id, None);
        assert!(listed.tasks.is_empty());
    }

    #[test]
    fn context_path_validation_uses_workspace_text_boundary() {
        let (_cfg, root, workspace) = workspace_fixture();
        std::fs::write(root.path().join("image.png"), b"\x89PNG\r\n").unwrap();
        let inbox = AgentInbox::new(10);
        let architect = identity("alpha", "@@Architect");

        inbox
            .send(&workspace, &architect, "@@FullStackA", "tasks/one.md")
            .unwrap();

        for path in [
            "",
            " tasks/one.md",
            "/tasks/one.md",
            "./tasks/one.md",
            "tasks//one.md",
            "tasks/../one.md",
            "tasks/one.md#frag",
            "tasks/one.md?q=1",
            "tasks\\one.md",
            "missing.md",
            "image.png",
        ] {
            let err = inbox
                .send(&workspace, &architect, "@@FullStackA", path)
                .unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("invalid context_path"), "{path:?}: {msg}");
            assert!(
                !msg.contains(root.path().to_string_lossy().as_ref()),
                "{path:?} leaked host path: {msg}"
            );
        }
    }

    #[tokio::test]
    async fn server_provider_sends_and_lists_offline_tasks() {
        let (_cfg, _root, workspace) = workspace_fixture();
        let inbox = Arc::new(AgentInbox::new(10));
        let registry = Arc::new(crate::terminal_sessions::Registry::new(
            crate::terminal_sessions::RegistryConfig {
                workspace_root: workspace.root().to_path_buf(),
                mcp_socket_path: None,
                control_socket_path: None,
                terminal: crate::config::TerminalConfig::default(),
            },
        ));
        let provider = ServerAgentInboxProvider::new(inbox, registry, {
            let workspace = workspace.clone();
            move || Some(workspace.clone())
        });

        let result = provider
            .send_agent_task(
                identity("alpha", "@@Architect"),
                "@@FullStackA".into(),
                "tasks/one.md".into(),
            )
            .await
            .unwrap();
        let listed = provider
            .list_agent_tasks(identity("alpha", "@@FullStackA"), None)
            .await
            .unwrap();

        assert_eq!(result.id, 1);
        assert_eq!(listed.tasks.len(), 1);
        assert_eq!(listed.tasks[0].from, "@@Architect");
        assert_eq!(listed.tasks[0].context_path, "tasks/one.md");
    }
}
