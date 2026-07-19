//! QuartzCommand cloud management (System → Management).
//!
//! The `system quartz-command` CONFIG (gateway / port / ca-certificate /
//! enroll-token) is real VyOS config shipped by the qfagent package, so the
//! frontend reads and edits it through the authenticated VyOS API proxy —
//! including enrollment itself: committing `enroll-token` runs the qfagent
//! conf-mode owner synchronously, so enrollment errors come back as commit
//! errors on the same request the UI made. This module only covers what the
//! config tree can't:
//!
//!   * GET /api/quartz-command/status — qfagent's live status
//!     (`/run/qfagent/status.json`: control channel, cert expiry, alarms,
//!     host-mismatch flags) merged with the durable enrollment state
//!     (`/config/quartzfire/qfagent/state.json`: device ID, org, gateways).
//!     Both null-tolerant: absent until qfagent has run once.

use axum::{extract::State, Json};
use serde::Serialize;
use std::{path::Path, sync::Arc};

use crate::error::Result;
use crate::AppState;

fn read_json(path: &Path) -> Option<serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
}

#[derive(Serialize)]
pub struct QuartzCommandStatus {
    /// Live daemon status (`status.json`). Null until qfagent runs.
    pub status: Option<serde_json::Value>,
    /// Durable enrollment state (`state.json`). Null until first
    /// enrollment/identity creation.
    pub state: Option<serde_json::Value>,
}

/// GET /api/quartz-command/status
pub async fn status(State(state): State<Arc<AppState>>) -> Result<Json<QuartzCommandStatus>> {
    Ok(Json(QuartzCommandStatus {
        status: read_json(&state.config.qfagent_status_file),
        state: read_json(&state.config.qfagent_state_file),
    }))
}
