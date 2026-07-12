//! Per-user dashboard layout persistence.
//!
//! The dashboard's tile layout used to live only in the browser's
//! localStorage, so clearing site data (or switching browsers) wiped it. This
//! stores it server-side instead, keyed by the session's VyOS username, in
//! `/config/quartzfire/dashboards.json` — under `/config` so a saved layout
//! survives image upgrades, exactly like the other desired-state files.
//!
//! The layout body is opaque to the backend: the SPA owns the tile schema and
//! validates tile types on load. We only guard that the payload is a JSON
//! array and store it verbatim under the authenticated user, so evolving the
//! tile schema never needs a backend change.

use axum::{extract::State, Extension, Json};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

use crate::auth::Claims;
use crate::error::{AppError, Result};
use crate::AppState;

/// username → that user's saved tile layout (an opaque JSON array).
type Layouts = BTreeMap<String, Value>;

fn load_all(state: &AppState) -> Result<Layouts> {
    let path = &state.config.dashboard_layouts_file;
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("parsing {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Layouts::new()),
        Err(e) => Err(AppError::Internal(anyhow::anyhow!("reading {}: {e}", path.display()))),
    }
}

/// Atomic write (temp + rename in the same dir) so a concurrent reader never
/// sees a half-written document.
fn store_all(state: &AppState, layouts: &Layouts) -> Result<()> {
    let path = &state.config.dashboard_layouts_file;
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("layouts path has no parent directory")))?;
    let json = serde_json::to_string_pretty(layouts).map_err(|e| AppError::Internal(e.into()))?;
    let _ = std::fs::create_dir_all(dir);
    let tmp = dir.join(".dashboards.json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| {
        AppError::BadRequest(format!(
            "cannot save dashboard layout ({}): {e} — ensure /config/quartzfire is writable",
            tmp.display()
        ))
    })?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("activating {}: {e}", path.display())))?;
    Ok(())
}

/// GET /api/dashboard/layout — the caller's saved layout, or `null` when they
/// have never saved one (the SPA then keeps its built-in default).
pub async fn get_layout(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>> {
    let layouts = load_all(&state)?;
    Ok(Json(layouts.get(&claims.sub).cloned().unwrap_or(Value::Null)))
}

/// PUT /api/dashboard/layout — replace the caller's saved layout. The body is
/// the tile array the SPA renders; it is stored verbatim under the username.
pub async fn put_layout(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(layout): Json<Value>,
) -> Result<Json<Value>> {
    if !layout.is_array() {
        return Err(AppError::BadRequest(
            "dashboard layout must be a JSON array of tiles".into(),
        ));
    }
    // This is a read-modify-write of a file shared by every user, so serialize
    // writers: two admins saving at the same instant must not clobber each
    // other's layout. No `.await` is held across the guard, so the blocking
    // lock is fine here (the fs work is small and synchronous, as elsewhere).
    let _guard = state
        .dashboard_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut layouts = load_all(&state)?;
    layouts.insert(claims.sub.clone(), layout.clone());
    store_all(&state, &layouts)?;
    Ok(Json(layout))
}
