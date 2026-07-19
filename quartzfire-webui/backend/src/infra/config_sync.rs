//! Config-sync helper (`service config-sync`).
//!
//! The config-sync CONFIG itself is real VyOS config, so the frontend reads and
//! edits it through the authenticated VyOS API proxy under the commit guard.
//! This module covers only what the config tree can't: a server-side
//! reachability probe of the secondary's HTTPS API.
//!
//!   * POST /api/high-availability/config-sync/test — verify the secondary's
//!     HTTPS API answers with the given key (the browser can't: cross-origin +
//!     self-signed certs). Reports reachable / authenticated / remote version.

use std::sync::Arc;
use std::time::Duration;

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::Result;
use crate::AppState;

#[derive(Deserialize)]
pub struct TestBody {
    address: String,
    #[serde(default)]
    port: Option<u16>,
    key: String,
    #[serde(default)]
    timeout: Option<u64>,
}

/// Probe the secondary's VyOS HTTPS API with the supplied credentials. Never
/// errors out (a probe failure is a normal, reportable result), so it always
/// returns 200 with a structured verdict.
pub async fn test(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TestBody>,
) -> Result<Json<Value>> {
    let address = body.address.trim();
    if address.is_empty() {
        return Ok(Json(json!({
            "reachable": false, "authenticated": false, "version": Value::Null,
            "error": "No secondary address given.",
        })));
    }
    let port = body.port.unwrap_or(443);
    // A UI probe shouldn't hang: honour the configured timeout but cap it.
    let timeout = Duration::from_secs(body.timeout.unwrap_or(10).clamp(1, 30));

    // IPv6 literals need brackets in the URL authority.
    let host = if address.contains(':') && !address.starts_with('[') {
        format!("[{address}]")
    } else {
        address.to_string()
    };
    let url = format!("https://{host}:{port}/show");

    // `show version` doubles as the auth check and yields the remote version.
    let data = json!({ "op": "show", "path": ["version"] }).to_string();
    let resp = state
        .http
        .post(&url)
        .timeout(timeout)
        .form(&[("data", data.as_str()), ("key", body.key.as_str())])
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            // Connection refused / TLS / DNS / timeout → not reachable.
            return Ok(Json(json!({
                "reachable": false, "authenticated": false, "version": Value::Null,
                "error": format!("Could not reach {host}:{port}: {e}"),
            })));
        }
    };

    // We got an HTTP response, so the secondary's API is reachable.
    let status = resp.status();
    let parsed: std::result::Result<Value, _> = resp.json().await;
    let (authenticated, version, error) = match parsed {
        Ok(v) => {
            let ok = v.get("success").and_then(Value::as_bool) == Some(true);
            if ok {
                let ver = v
                    .get("data")
                    .and_then(Value::as_str)
                    .and_then(parse_version);
                (true, ver, None)
            } else {
                let err = v
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("API rejected the request ({status})"));
                (false, None, Some(err))
            }
        }
        Err(_) => (false, None, Some(format!("Unexpected response ({status})"))),
    };

    Ok(Json(json!({
        "reachable": true,
        "authenticated": authenticated,
        "version": version,
        "error": error,
    })))
}

/// Pull the version string out of `show version` output (the value after the
/// `Version:` label).
fn parse_version(text: &str) -> Option<String> {
    for line in text.lines() {
        let lower = line.trim().to_lowercase();
        if lower.starts_with("version") {
            if let Some(i) = line.find(':') {
                let v = line[i + 1..].trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}
