//! Local management-API client backing the control channel's proxy requests.
//!
//! The cloud console sends `ProxyRequest { method, path, body, … }` down the
//! ControlStream; this module replays each one against the local
//! quartzfire-webui backend (which fronts the VyOS HTTP API plus the device's
//! own endpoints) and returns the raw response. Authentication is a session
//! JWT we mint ourselves: qfagent runs as root and reads the same signing
//! secret the web UI uses, so no credentials are stored and the web UI needs
//! no special internal endpoint. The token's `sub` is "quartz-command", which
//! is how cloud-initiated changes appear in the device's audit log.
//!
//! Configuration (listen address, JWT secret path) is read from the same
//! `/etc/quartzfire/webui.toml` the web UI uses; missing config falls back to
//! the web UI's own defaults so the two stay in lockstep.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// The subset of webui.toml we need. Unknown fields are ignored.
#[derive(Debug, Deserialize)]
struct WebuiConfig {
    #[serde(default = "default_listen")]
    listen: String,
    #[serde(default = "default_jwt_secret_file")]
    jwt_secret_file: PathBuf,
}

fn default_listen() -> String {
    // Matches quartzfire-webui's default (loopback-only; nginx fronts it).
    "127.0.0.1:8181".to_string()
}

fn default_jwt_secret_file() -> PathBuf {
    PathBuf::from("/var/lib/quartzfire-webui/jwt.secret")
}

impl Default for WebuiConfig {
    fn default() -> Self {
        Self {
            listen: default_listen(),
            jwt_secret_file: default_jwt_secret_file(),
        }
    }
}

/// Session claims in the shape quartzfire-webui's auth middleware validates.
#[derive(Serialize)]
struct Claims {
    sub: String,
    exp: u64,
    iat: u64,
}

pub struct LocalApi {
    base: String,
    jwt_secret_file: PathBuf,
    http: reqwest::Client,
}

impl LocalApi {
    /// Build the client from webui.toml (`QUARTZFIRE_WEBUI_CONFIG` overrides
    /// the path, mirroring the web UI). A missing or unparsable config falls
    /// back to defaults — errors then surface per-call, not at startup.
    pub fn load() -> Self {
        let path = std::env::var("QUARTZFIRE_WEBUI_CONFIG")
            .unwrap_or_else(|_| "/etc/quartzfire/webui.toml".into());
        let config = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| match toml::from_str::<WebuiConfig>(&s) {
                Ok(c) => Some(c),
                Err(e) => {
                    tracing::warn!("parsing {path} failed ({e}); using default web UI settings");
                    None
                }
            })
            .unwrap_or_default();

        let http = reqwest::Client::builder()
            // Loopback HTTP; the deadline leaves headroom under the cloud's
            // own 120 s write timeout so slow commits fail there, not here.
            .timeout(Duration::from_secs(110))
            .build()
            .expect("building the local HTTP client cannot fail");

        Self {
            base: format!("http://{}", config.listen),
            jwt_secret_file: config.jwt_secret_file,
            http,
        }
    }

    /// Mint a short-lived session token. The secret is read per call so a
    /// rotated secret (web UI restart) applies without restarting us.
    fn token(&self) -> Result<String, String> {
        let secret = std::fs::read_to_string(&self.jwt_secret_file)
            .map(|s| s.trim().to_string())
            .map_err(|e| {
                format!(
                    "reading {} failed ({e}) — is quartzfire-webui installed and started?",
                    self.jwt_secret_file.display()
                )
            })?;
        if secret.is_empty() {
            return Err(format!("{} is empty", self.jwt_secret_file.display()));
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let claims = Claims { sub: "quartz-command".into(), exp: now + 300, iat: now };
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
        )
        .map_err(|e| format!("minting session token failed: {e}"))
    }

    /// Replay one proxied call. Returns `(http_status, content_type, body,
    /// error)` — `error` is non-empty (and status 0) only when the local call
    /// itself failed; API-level failures come back as their real status +
    /// body for the cloud to pass through.
    pub async fn call(
        &self,
        method: &str,
        path: &str,
        content_type: &str,
        body: Vec<u8>,
    ) -> (u32, String, Vec<u8>, String) {
        // Same surface the cloud already enforces; refuse anything else so a
        // compromised controller can't reach beyond the management API.
        if !path.starts_with("/api/") || path.contains("..") {
            return (0, String::new(), Vec::new(), format!("invalid path {path:?}"));
        }
        let method = match method {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "DELETE" => reqwest::Method::DELETE,
            other => {
                return (0, String::new(), Vec::new(), format!("unsupported method {other:?}"))
            }
        };
        let token = match self.token() {
            Ok(t) => t,
            Err(e) => return (0, String::new(), Vec::new(), e),
        };

        let mut req = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .header("authorization", format!("Bearer {token}"));
        if !content_type.is_empty() {
            req = req.header("content-type", content_type);
        }
        if !body.is_empty() {
            req = req.body(body);
        }

        match req.send().await {
            Ok(r) => {
                let status = r.status().as_u16() as u32;
                let ctype = r
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                match r.bytes().await {
                    Ok(b) => (status, ctype, b.to_vec(), String::new()),
                    Err(e) => (
                        0,
                        String::new(),
                        Vec::new(),
                        format!("reading local API response: {e}"),
                    ),
                }
            }
            Err(e) => (
                0,
                String::new(),
                Vec::new(),
                format!("local management API unreachable: {e}"),
            ),
        }
    }
}
