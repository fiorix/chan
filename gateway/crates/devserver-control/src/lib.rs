#![forbid(unsafe_code)]

mod actor;
mod config;
mod http;
mod server;
mod state;

pub use actor::{
    spawn_controller, spawn_controller_owned, ActorError, ControllerHandle, KillPlan,
    MutationStatus, ProxyControlSession, SessionRevocationPlan,
};
pub use config::{AdminCredentials, AdminScope, Config, ProxyCredentials};
pub use http::router as admin_router;
pub use server::serve_control_listener;
pub use state::{
    BrowserSessionView, CommandOutcome, ProxyStatus, ProxyView, SessionIncarnation, StateError,
    TunnelView, ADMISSION_CLAIM_TTL, COMMAND_TIMEOUT, CONVERGENCE_WINDOW, HEARTBEAT_INTERVAL,
    SESSION_DEAD_AFTER,
};

pub(crate) use state::{ControllerState, Effect, SessionKey};
