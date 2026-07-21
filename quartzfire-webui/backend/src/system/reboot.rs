//! Local "Reboot Device" endpoint (POST /api/system/reboot).
//!
//! The cloud console's "Reboot Device" button proxies an authenticated call
//! down the QuartzCommand control stream to this local management API (the
//! agent injects its own credentials, so this lives under `/api/*` behind
//! `require_auth`, not under `/api/auth`). The cloud already gates the button
//! to org owner/admin before it reaches the device.
//!
//! The backend runs as a sandboxed static user with `NoNewPrivileges` and so
//! cannot reboot itself — exactly like factory reset. It therefore only drops
//! a trigger file (atomically, temp + rename) that the root
//! `quartzfire-reboot.path` unit acts on; the paired helper verifies the
//! confirmation token and, a couple seconds later, runs `systemctl reboot`.
//!
//! We must ACK before the box goes down: the control stream drops the instant
//! the device reboots, and the caller has to receive the ack first. So the
//! handler responds as soon as the trigger is armed (a synchronous, fallible
//! step), and the actual reboot fires just after — this request never blocks
//! on it.

use axum::{extract::State, Json};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::AppState;

/// The JSON envelope the control-stream proxy passes back to the cloud:
/// `{ "success": bool, "error": string|null, "data": null }`.
fn ok() -> Json<Value> {
    Json(json!({ "success": true, "error": null, "data": null }))
}

fn fail(error: impl std::fmt::Display) -> Json<Value> {
    Json(json!({ "success": false, "error": error.to_string(), "data": null }))
}

/// POST /api/system/reboot — arm a device reboot.
///
/// Responds promptly with the standard envelope; the reboot itself happens a
/// couple seconds later via the root helper, so the caller always gets the ack
/// before the control stream drops. A trigger-file write failure is reported
/// synchronously as `{ success: false, error }`.
pub async fn reboot(State(state): State<Arc<AppState>>) -> Json<Value> {
    let path = &state.config.reboot_request_file;
    let Some(dir) = path.parent() else {
        return fail("reboot trigger path has no parent directory");
    };
    let _ = std::fs::create_dir_all(dir);

    // A confirmation token the root helper checks, so a stray/empty file can't
    // trip a reboot — only a deliberate request with this marker.
    let body = json!({
        "confirm": "reboot",
        "requested_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });
    let tmp = dir.join(".reboot-request.tmp");
    if let Err(e) = std::fs::write(&tmp, body.to_string()) {
        return fail(format!(
            "cannot write the reboot trigger ({}): {e} — ensure quartzfire-webui is installed \
             and /config/quartzfire is writable",
            tmp.display()
        ));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        return fail(format!("activating {}: {e}", path.display()));
    }

    tracing::warn!("reboot requested via /api/system/reboot — the device will reboot shortly");
    ok()
}
