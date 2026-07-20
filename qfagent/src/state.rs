//! Persistent enrollment state and the live status contract.
//!
//! * `/config/quartzfire/qfagent/state.json` — enrollment outcome (device ID,
//!   org, gateways, cert validity, trust path, last-consumed token hash).
//!   Written by the conf-mode owner on enrollment and by the renewal loop.
//! * `/config/quartzfire/qfagent/config.json` — the committed
//!   `system quartz-command` settings, snapshotted by the conf-mode owner so
//!   the daemon never needs cli-shell-api (which is unavailable early at
//!   boot). Same pattern as quartzfire-geoip's `desired.json`.
//! * `/run/qfagent/status.json` — merged live status for `show quartz-command
//!   status` and the WebUI (0644, atomic replace).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::identity::atomic_write;

pub const CONFIG_ROOT: &str = "/config/quartzfire/qfagent";
pub const RUN_DIR: &str = "/run/qfagent";

pub fn state_file() -> PathBuf {
    PathBuf::from(CONFIG_ROOT).join("state.json")
}
pub fn config_snapshot_file() -> PathBuf {
    PathBuf::from(CONFIG_ROOT).join("config.json")
}
pub fn identity_dir() -> PathBuf {
    PathBuf::from(CONFIG_ROOT).join("identity")
}
pub fn status_file() -> PathBuf {
    PathBuf::from(RUN_DIR).join("status.json")
}
pub fn scrub_request_file() -> PathBuf {
    PathBuf::from(RUN_DIR).join("scrub-request")
}

/// Which trust path validated the controller connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrustPath {
    WebPki,
    PinnedCa,
}

/// Snapshot of the committed `system quartz-command` config tree.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfigSnapshot {
    pub gateway: Option<String>,
    pub port: u16,
    /// PEM of the configured `ca-certificate` PKI cert, resolved at commit.
    pub ca_certificate_pem: Option<String>,
    /// The PKI cert name (for display only).
    pub ca_certificate_name: Option<String>,
}

impl ConfigSnapshot {
    pub fn default_port() -> u16 {
        443
    }
}

/// Durable enrollment state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EnrollmentState {
    pub enrolled: bool,
    pub device_id: Option<String>,
    pub org_id: Option<String>,
    /// host:port from the consumed token.
    pub token_gateway: Option<String>,
    /// host:port assigned by the controller (preferred when non-empty).
    pub assigned_gateway: Option<String>,
    pub trust_path: Option<TrustPath>,
    /// SHA-256 hex of the full consumed token string — makes the conf-mode
    /// owner idempotent when config.boot still carries an already-consumed
    /// enroll-token (boot replay before the scrub landed).
    pub last_token_sha256: Option<String>,
    pub enrolled_at_unix: Option<i64>,
    pub cert_not_before_unix: Option<i64>,
    pub cert_not_after_unix: Option<i64>,
    /// Renew at/after this time (server value when the renewal RPC supplied
    /// one, else 2/3 of the cert lifetime).
    pub renew_after_unix: Option<i64>,
}

impl EnrollmentState {
    /// The gateway the control channel should dial: controller-assigned,
    /// falling back to the token's.
    pub fn control_gateway(&self) -> Option<String> {
        self.assigned_gateway
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| self.token_gateway.clone())
    }

    pub fn load(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("parse {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        atomic_write(path, serde_json::to_string_pretty(self)?.as_bytes())
    }
}

impl ConfigSnapshot {
    pub fn load(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("parse {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(Self { port: Self::default_port(), ..Self::default() })
            }
            Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        atomic_write(path, serde_json::to_string_pretty(self)?.as_bytes())
    }
}

// ── live status ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ControlState {
    Unenrolled,
    HostMismatch,
    Connecting,
    Connected,
    Backoff,
}

/// The status.json document. Everything the CLI/WebUI shows comes from here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusDoc {
    pub time_unix: i64,
    pub enrolled: bool,
    pub device_id: Option<String>,
    pub org_id: Option<String>,
    /// Gateway the control channel uses (assigned, else token's).
    pub gateway: Option<String>,
    pub trust_path: Option<TrustPath>,
    pub cert_not_after_unix: Option<i64>,
    pub renew_after_unix: Option<i64>,
    /// Set when the cert expires in under 7 days and renewal has not
    /// succeeded — surfaced as an alarm by the CLI and WebUI.
    pub cert_renewal_alarm: bool,
    pub control: ControlState,
    pub control_since_unix: Option<i64>,
    pub last_error: Option<String>,
    /// Human-readable flags, e.g. the host-mismatch banner.
    pub flags: Vec<String>,
}

impl StatusDoc {
    pub fn write(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        atomic_write(path, serde_json::to_vec_pretty(self)?.as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrollment_state_roundtrip_and_gateway_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");

        // Missing file → default (unenrolled).
        let st = EnrollmentState::load(&path).unwrap();
        assert!(!st.enrolled);
        assert_eq!(st.control_gateway(), None);

        let st = EnrollmentState {
            enrolled: true,
            token_gateway: Some("token.example:443".into()),
            assigned_gateway: Some("assigned.example:7443".into()),
            ..Default::default()
        };
        st.save(&path).unwrap();
        let loaded = EnrollmentState::load(&path).unwrap();
        assert!(loaded.enrolled);
        // Controller-assigned gateway wins…
        assert_eq!(loaded.control_gateway().as_deref(), Some("assigned.example:7443"));
        // …but an EMPTY assigned gateway falls back to the token's.
        let fallback = EnrollmentState { assigned_gateway: Some(String::new()), ..loaded };
        assert_eq!(fallback.control_gateway().as_deref(), Some("token.example:443"));
    }

    #[test]
    fn config_snapshot_roundtrip_and_default_port() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        assert_eq!(ConfigSnapshot::load(&path).unwrap().port, 443);

        let snap = ConfigSnapshot {
            gateway: Some("qc.example.net".into()),
            port: 8443,
            ca_certificate_pem: None,
            ca_certificate_name: None,
        };
        snap.save(&path).unwrap();
        assert_eq!(ConfigSnapshot::load(&path).unwrap().port, 8443);
    }

    #[test]
    fn bump_trigger_replaces_stray_directory() {
        // qfagent ≤0.1.0's path unit (MakeDirectory=yes) left a DIRECTORY at
        // the trigger path; bumping must replace it with the trigger file.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scrub-request");
        std::fs::create_dir(&path).unwrap();
        bump_trigger(&path).unwrap();
        assert!(path.is_file());

        // And a plain re-bump still works.
        bump_trigger(&path).unwrap();
        assert!(path.is_file());
    }

    #[test]
    fn status_doc_writes_readable_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let doc = StatusDoc {
            time_unix: 1,
            enrolled: false,
            device_id: Some("QF-TEST".into()),
            org_id: None,
            gateway: None,
            trust_path: Some(TrustPath::PinnedCa),
            cert_not_after_unix: None,
            renew_after_unix: None,
            cert_renewal_alarm: false,
            control: ControlState::Unenrolled,
            control_since_unix: None,
            last_error: None,
            flags: vec!["identity/host mismatch — run 'qf identity regenerate'".into()],
        };
        doc.write(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        // Wire names are kebab-case — the WebUI backend passes them through.
        assert_eq!(v["control"], "unenrolled");
        assert_eq!(v["trust_path"], "pinned-ca");
    }
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Bump a path-unit trigger file (temp + rename, the repo-wide contract).
pub fn bump_trigger(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Self-heal: qfagent ≤0.1.0 shipped the scrub path unit with
    // MakeDirectory=yes, which mkdir'd the trigger path itself — a directory
    // there makes the rename below fail EISDIR until reboot clears /run.
    if path.is_dir() {
        std::fs::remove_dir_all(path)
            .with_context(|| format!("remove stray directory at {}", path.display()))?;
    }
    atomic_write(path, format!("{}\n", now_unix()).as_bytes())
}
