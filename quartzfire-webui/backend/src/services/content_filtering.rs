//! Content Filtering management.
//!
//! Like ssl-inspection/geolocation, the CONFIG (`service content-filtering …`,
//! shipped by the quartzfire-content-filtering package) is real VyOS config, so
//! the frontend reads and edits it through the authenticated VyOS API proxy
//! under the commit-confirm guard. This module covers only what the config tree
//! can't:
//!
//!   * GET  /api/content-filtering/status      — e2guardian/ICAP/updater state
//!     from `/run/quartzfire-content-filtering/status.json` (root qfcf helper).
//!   * GET  /api/content-filtering/categories   — installed UT1 categories +
//!     entry counts (`qfcf-categories`).
//!   * POST /api/content-filtering/update        — request an immediate blocklist
//!     update (writes the trigger the quartzfire-cf-update-request.path watches).
//!   * GET  /api/content-filtering/logs          — recent JSON access-log entries
//!     (filterable by group/action), from the qfcf-logfeed output.
//!   * POST /api/content-filtering/test-url       — what a group would do with a
//!     URL (`qfcf-testurl`), for the WebUI "Test URL" widget.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;
use tokio::process::Command;

use crate::error::{AppError, Result};
use crate::AppState;

fn read_json(path: &std::path::Path) -> Option<serde_json::Value> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
}

// ── status ──────────────────────────────────────────────────────────────────

/// GET /api/content-filtering/status
///
/// The e2guardian/ICAP probe fields (`e2guardian_active`, `icap_listening`,
/// `installed_categories`) are only ever written by `qfcf-status` — nothing runs
/// it on a schedule, so the on-disk status.json carries only what the last
/// commit/apply wrote (enabled, apply_ok, …) and the daemon indicators would
/// otherwise read as perpetually "stopped/down". So we run `qfcf-status` live
/// here (same pattern as the categories endpoint) and overlay its fresh probe
/// onto the persisted apply state. The helper's stdout is authoritative because
/// its status.json write needs root; ours is an unprivileged read.
pub async fn status(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    let mut status = read_json(&state.config.cf_status_file).unwrap_or(serde_json::json!({}));
    if let Ok(output) = Command::new(&state.config.cf_status_helper).output().await {
        if let Ok(probe) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            if let (Some(obj), Some(p)) = (status.as_object_mut(), probe.as_object()) {
                for (k, v) in p {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
    }
    Ok(Json(serde_json::json!({ "status": status })))
}

// ── categories ───────────────────────────────────────────────────────────────

/// GET /api/content-filtering/categories — installed UT1 categories + counts.
pub async fn categories(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    let output = Command::new(&state.config.cf_categories_helper)
        .output()
        .await
        .map_err(|e| {
            AppError::BadRequest(format!(
                "cannot run the categories helper ({}): {e} — is quartzfire-content-filtering installed?",
                state.config.cf_categories_helper.display()
            ))
        })?;
    let body: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("parsing qfcf-categories output: {e}")))?;
    Ok(Json(body))
}

// ── update (request blocklist refresh) ────────────────────────────────────────

/// POST /api/content-filtering/update — bump the trigger the update path unit
/// watches. Runs unprivileged; /config/quartzfire is writable by the WebUI.
pub async fn update(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    let path = &state.config.cf_update_request_file;
    let seq = read_json(path)
        .and_then(|v| v.get("seq").and_then(|s| s.as_u64()))
        .unwrap_or(0)
        + 1;
    let body = serde_json::json!({
        "seq": seq,
        "requested_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("trigger path has no parent directory")))?;
    let _ = std::fs::create_dir_all(dir);
    let tmp = dir.join(".content-filtering-update-request.tmp");
    std::fs::write(&tmp, body.to_string()).map_err(|e| {
        AppError::BadRequest(format!(
            "cannot write the update trigger ({}): {e} — ensure quartzfire-content-filtering is \
             installed and /config/quartzfire is writable",
            tmp.display()
        ))
    })?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("activating {}: {e}", path.display())))?;
    Ok(Json(serde_json::json!({ "requested": true, "seq": seq })))
}

// ── logs ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LogsQuery {
    limit: Option<usize>,
    group: Option<String>,
    action: Option<String>,
}

/// GET /api/content-filtering/logs?limit=&group=&action= — newest-first entries
/// from the JSON access-log feed.
pub async fn logs(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LogsQuery>,
) -> Result<Json<serde_json::Value>> {
    let limit = q.limit.unwrap_or(100).min(2000);
    let text = std::fs::read_to_string(&state.config.cf_log_file).unwrap_or_default();
    let entries: Vec<serde_json::Value> = text
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|e| {
            q.group
                .as_deref()
                .map_or(true, |g| e.get("group").and_then(|v| v.as_str()) == Some(g))
        })
        .filter(|e| {
            q.action
                .as_deref()
                .map_or(true, |a| e.get("action").and_then(|v| v.as_str()) == Some(a))
        })
        .take(limit)
        .collect();
    Ok(Json(serde_json::json!({ "entries": entries })))
}

// ── test-url ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TestUrlBody {
    url: String,
    group: Option<String>,
}

/// POST /api/content-filtering/test-url — verdict a filter group would give a URL.
pub async fn test_url(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TestUrlBody>,
) -> Result<Json<serde_json::Value>> {
    let url = body.url.trim();
    if url.is_empty() {
        return Err(AppError::BadRequest("url is required".into()));
    }
    // A crude sanity gate so we don't shell out with obvious junk.
    if url.len() > 2048 || url.contains(char::is_whitespace) {
        return Err(AppError::BadRequest("url looks malformed".into()));
    }
    let mut cmd = Command::new(&state.config.cf_testurl_helper);
    cmd.arg(url);
    if let Some(g) = body.group.as_deref().filter(|g| !g.is_empty()) {
        cmd.arg(g);
    }
    let output = cmd.output().await.map_err(|e| {
        AppError::BadRequest(format!(
            "cannot run the test-url helper ({}): {e} — is quartzfire-content-filtering installed?",
            state.config.cf_testurl_helper.display()
        ))
    })?;
    let verdict: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("parsing qfcf-testurl output: {e}")))?;
    Ok(Json(verdict))
}
