//! Shared helper for read-only FRR operational queries via `vtysh`.
//!
//! VyOS routes with FRR, so live routing state (BGP sessions, MPLS/LDP, …) is
//! read straight from FRR's `json` op-mode output. Reaching the per-daemon VTY
//! sockets requires the service to be in the `frrvty` group (granted in the
//! systemd unit); when it isn't, `vtysh` fails and we surface a clean gateway
//! error rather than a 500. Callers pass only fixed command literals — never
//! interpolated request data (see the validation in `bgp`/`mpls`).

use serde_json::Value;
use tokio::process::Command;

use crate::error::{AppError, Result};

/// Run `vtysh -c "<command>"` and parse its stdout as JSON. An empty stdout
/// (the feature isn't running / nothing to show) parses as an empty JSON object
/// so callers can degrade to an empty view instead of erroring.
pub async fn run_vtysh(command: &str) -> Result<Value> {
    let output = Command::new("vtysh")
        .args(["-c", command])
        .output()
        .await
        .map_err(|e| AppError::Gateway(format!("cannot query the routing engine (vtysh: {e})")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Gateway(format!(
            "routing engine query failed: {}",
            stderr.trim()
        )));
    }

    let stdout = output.stdout;
    if stdout.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    serde_json::from_slice(&stdout)
        .map_err(|e| AppError::Gateway(format!("routing engine returned unparsable output: {e}")))
}
