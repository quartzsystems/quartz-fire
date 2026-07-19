//! Application Control (qfappd) management.
//!
//! Same desired-state pattern as the IPS module: the backend runs unprivileged
//! and never touches qfappd directly. It edits a desired-state file
//! (`/config/quartzfire/appcontrol.json`; `/config` persists across image
//! upgrades) that the root `qfappd-apply` helper validates and publishes to
//! `/run/qfappd/policy.json`. qfappd hot-reloads it and writes back a status
//! snapshot (`/run/qfappd/status.json`) and an nDPI catalog dump
//! (`/run/qfappd/catalog.json`) for us to read.
//!
//! The schema written here is qfappd's policy schema v2 (named actions +
//! per-firewall-rule bindings — see qfappd/crates/qfappd-core/src/policy.rs).
//! Application/category names come from the catalog dump so the WebUI's
//! Actions editor tracks the installed signature set.
//!
//! Alerts have two paths, exactly like IPS. Live ones stream from the journal:
//! qfappd writes one flat JSON event per flow decision to stdout, captured by
//! journald under `SyslogIdentifier=qfappd`, so `journalctl -t qfappd -f`
//! yields one document per decision. History comes from the persistent events
//! file qfappd also writes (`/var/log/qfappd/events.json`, logrotated).

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, convert::Infallible, path::Path, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};
use tokio_stream::{wrappers::LinesStream, StreamExt};

use crate::error::{AppError, Result};
use crate::AppState;

/// The ct-mark ACTION_ID field is 3 bits by default → at most 7 actions may be
/// bound at once. We enforce it here for a clear error before the file is even
/// written (qfappd's check-policy enforces it authoritatively too).
const MAX_BOUND_ACTIONS: usize = 7;

// ── desired-state schema (qfappd policy v2) ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcAction {
    /// "allow" | "block" — WatchGuard's "when application does not match".
    pub default_action: String,
    /// "drop" | "reset".
    #[serde(default = "default_block_mode")]
    pub block_mode: String,
    #[serde(default)]
    pub categories: BTreeMap<String, String>,
    #[serde(default)]
    pub applications: BTreeMap<String, String>,
}

fn default_block_mode() -> String {
    "drop".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcBinding {
    pub id: u32,
    pub action: String,
    #[serde(default)]
    pub description: String,
    /// nft match (iifname/oifname/saddr/daddr/l4). Opaque here; qfappd
    /// validates it. The Policies tab fills it from the firewall rule.
    #[serde(default, rename = "match")]
    pub match_spec: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcConfig {
    pub version: u32,
    #[serde(default)]
    pub actions: BTreeMap<String, AcAction>,
    #[serde(default)]
    pub bindings: Vec<AcBinding>,
}

impl Default for AcConfig {
    fn default() -> Self {
        let mut actions = BTreeMap::new();
        actions.insert(
            "Global".to_string(),
            AcAction {
                default_action: "allow".into(),
                block_mode: "drop".into(),
                categories: BTreeMap::new(),
                applications: BTreeMap::new(),
            },
        );
        Self { version: 2, actions, bindings: Vec::new() }
    }
}

fn load_config(state: &AppState) -> Result<AcConfig> {
    let path = &state.config.appcontrol_settings_file;
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("parsing {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AcConfig::default()),
        Err(e) => Err(AppError::Internal(anyhow::anyhow!("reading {}: {e}", path.display()))),
    }
}

/// Atomic write (temp + rename in the same dir) so the root helper never sees
/// a half-written document.
fn store_config(state: &AppState, cfg: &AcConfig) -> Result<()> {
    let path = &state.config.appcontrol_settings_file;
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("settings path has no parent directory")))?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| AppError::Internal(e.into()))?;
    let _ = std::fs::create_dir_all(dir);
    let tmp = dir.join(".appcontrol.json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| {
        AppError::BadRequest(format!(
            "cannot write Application Control settings ({}): {e} — ensure qfappd is installed and \
             /config/quartzfire is writable, then try again",
            tmp.display()
        ))
    })?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("activating {}: {e}", path.display())))?;
    Ok(())
}

fn validate(cfg: &AcConfig) -> Result<()> {
    if cfg.version != 2 {
        return Err(AppError::BadRequest(format!(
            "unsupported schema version {} (expected 2)",
            cfg.version
        )));
    }
    for (name, a) in &cfg.actions {
        for v in std::iter::once(&a.default_action)
            .chain(a.categories.values())
            .chain(a.applications.values())
        {
            if v != "allow" && v != "block" {
                return Err(AppError::BadRequest(format!(
                    "action {name:?}: verdict must be \"allow\" or \"block\", got {v:?}"
                )));
            }
        }
        if a.block_mode != "drop" && a.block_mode != "reset" {
            return Err(AppError::BadRequest(format!(
                "action {name:?}: block_mode must be \"drop\" or \"reset\""
            )));
        }
    }
    let mut bound = std::collections::BTreeSet::new();
    for b in &cfg.bindings {
        if !cfg.actions.contains_key(&b.action) {
            return Err(AppError::BadRequest(format!(
                "binding {} references unknown action {:?}",
                b.id, b.action
            )));
        }
        bound.insert(b.action.clone());
    }
    if bound.len() > MAX_BOUND_ACTIONS {
        return Err(AppError::BadRequest(format!(
            "{} actions bound but at most {MAX_BOUND_ACTIONS} may be active at once — \
             unbind an action or widen the mark layout",
            bound.len()
        )));
    }
    Ok(())
}

// ── status ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct AcStatus {
    pub settings: AcConfig,
    /// qfappd's runtime status (`/run/qfappd/status.json`): policy generation,
    /// last error, per-queue counters. Null until qfappd has run once.
    pub status: Option<serde_json::Value>,
    /// Whether qfappd is alive (its status file is fresh / pidfile present).
    pub running: bool,
    /// qfappd-apply's last-run report (`/run/qfappd/apply.json`): whether the
    /// desired state was published, and the mtime/size of the desired file
    /// that run processed. Null until the helper has run once. A failure here
    /// means the PREVIOUS policy is still enforced — qfappd never saw the
    /// refused file, so its own status shows no error.
    pub apply: Option<serde_json::Value>,
    /// Current desired-state file mtime (epoch seconds). Compared against
    /// `apply.desired_mtime` to detect a saved-but-never-applied state (e.g.
    /// the apply trigger not firing).
    pub settings_mtime: Option<u64>,
}

const QFAPPD_PIDFILE: &str = "/run/qfappd/qfappd.pid";

/// qfappd liveness without privileges: prefer a fresh status file (qfappd
/// rewrites it every few seconds), fall back to the process table.
fn qfappd_alive(status: &Option<serde_json::Value>) -> bool {
    if status.is_some() {
        return true;
    }
    if let Ok(pid) = std::fs::read_to_string(QFAPPD_PIDFILE) {
        let pid = pid.trim();
        if !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
                return comm.trim() == "qfappd";
            }
        }
    }
    false
}

/// GET /api/appcontrol/status — desired settings plus the applied reality.
pub async fn status(State(state): State<Arc<AppState>>) -> Result<Json<AcStatus>> {
    let settings = load_config(&state)?;
    let status = std::fs::read_to_string(&state.config.appcontrol_status_file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let running = qfappd_alive(&status);
    let apply = std::fs::read_to_string(&state.config.appcontrol_apply_file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let settings_mtime = std::fs::metadata(&state.config.appcontrol_settings_file)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    Ok(Json(AcStatus { settings, status, running, apply, settings_mtime }))
}

/// PUT /api/appcontrol/settings — replace the desired state; qfappd-apply
/// validates and publishes it asynchronously.
pub async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(desired): Json<AcConfig>,
) -> Result<Json<AcConfig>> {
    validate(&desired)?;
    store_config(&state, &desired)?;
    Ok(Json(desired))
}

// ── catalog ───────────────────────────────────────────────────────────────────

/// GET /api/appcontrol/catalog — the nDPI application/category catalog qfappd
/// dumped at startup. `available:false` (with an empty list) when qfappd
/// hasn't run yet, so the UI can fall back to its shipped fixture.
#[derive(Serialize)]
pub struct CatalogResponse {
    pub available: bool,
    #[serde(flatten)]
    pub catalog: serde_json::Value,
}

pub async fn catalog(State(state): State<Arc<AppState>>) -> Result<Json<CatalogResponse>> {
    match std::fs::read_to_string(&state.config.appcontrol_catalog_file) {
        Ok(text) => {
            let catalog: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
                AppError::Internal(anyhow::anyhow!("parsing the qfappd catalog: {e}"))
            })?;
            Ok(Json(CatalogResponse { available: true, catalog }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Json(CatalogResponse {
            available: false,
            catalog: serde_json::json!({ "ndpi_version": null, "num_protocols": 0, "applications": [] }),
        })),
        Err(e) => Err(AppError::Internal(anyhow::anyhow!("reading the qfappd catalog: {e}"))),
    }
}

// ── alert stream ──────────────────────────────────────────────────────────────

/// One decision event — the SSE payload and history row. A flattened subset of
/// qfappd's event schema (docs/event-schema.md), plus a millisecond `ts`.
#[derive(Serialize)]
pub struct AcEvent {
    ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dst: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dpt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proto: Option<String>,
    app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    /// "allow" | "block".
    action: String,
    action_name: String,
    block_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sni: Option<String>,
}

/// GET /api/appcontrol/alerts — SSE stream of decision events from the journal
/// (live only; history comes from /api/appcontrol/alerts/history).
pub async fn alerts() -> Response {
    let mut child = match Command::new("journalctl")
        .args(["-t", "qfappd", "-f", "-n", "0", "-o", "cat", "--no-pager"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("cannot start journalctl: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot read the system journal on this device",
            )
                .into_response();
        }
    };
    let Some(stdout) = child.stdout.take() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "journalctl produced no output").into_response();
    };

    // `-o cat` gives the raw MESSAGE (the event JSON line qfappd wrote to
    // stdout). Non-JSON lines (tracing diagnostics on stderr share the tag)
    // and non-app_control events are skipped.
    let stream = LinesStream::new(BufReader::new(stdout).lines()).filter_map(move |line| {
        let _keep_child_alive = &child;
        let entry = parse_event(&line.ok()?)?;
        let json = serde_json::to_string(&entry).ok()?;
        Some(Ok::<Event, Infallible>(Event::default().data(json)))
    });
    let stream = tokio_stream::once(Ok(Event::default().comment("connected"))).chain(stream);
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// Parse one qfappd event line into an alert row; None for non-app_control
/// lines and log chatter.
fn parse_event(line: &str) -> Option<AcEvent> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("event_type")?.as_str()? != "app_control" {
        return None;
    }
    let opt_str = |key: &str| v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string());
    let opt_port = |key: &str| v.get(key).and_then(|x| x.as_u64()).and_then(|p| u32::try_from(p).ok());
    let ts = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(rfc3339_ms)
        .unwrap_or(0);
    Some(AcEvent {
        ts,
        src: opt_str("src_ip"),
        spt: opt_port("src_port"),
        dst: opt_str("dest_ip"),
        dpt: opt_port("dest_port"),
        proto: opt_str("proto"),
        app: opt_str("app").unwrap_or_else(|| "Unknown".into()),
        category: opt_str("category").filter(|c| !c.is_empty()),
        action: opt_str("action").unwrap_or_else(|| "allow".into()),
        action_name: opt_str("action_name").unwrap_or_default(),
        block_mode: opt_str("block_mode").unwrap_or_else(|| "drop".into()),
        confidence: opt_str("confidence"),
        sni: opt_str("sni"),
    })
}

/// RFC 3339 UTC ("2026-07-11T14:03:22.117Z") → ms since epoch. qfappd always
/// emits UTC with a trailing Z, so this is deliberately narrower than the IPS
/// EVE parser (no numeric offsets).
fn rfc3339_ms(s: &str) -> Option<u64> {
    let s = s.trim().strip_suffix('Z').unwrap_or(s.trim());
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut t = time.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next()?.parse().ok()?;
    let (sec_str, frac) = t.next()?.split_once('.').unwrap_or((t.clone().next().unwrap_or("0"), ""));
    let second: i64 = sec_str.parse().ok()?;
    let ms: i64 = format!("{:0<3.3}", frac).parse().unwrap_or(0);

    // Days-from-civil (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    u64::try_from(secs * 1000 + ms).ok()
}

// ── alert history ─────────────────────────────────────────────────────────────

/// GET /api/appcontrol/alerts/history — persisted decision events, newest
/// first, from the events file qfappd writes (survives reboots).
pub async fn alerts_history(State(state): State<Arc<AppState>>) -> Result<Json<Vec<AcEvent>>> {
    let path = state.config.appcontrol_events_file.clone();
    let display = path.display().to_string();
    let entries = tokio::task::spawn_blocking(move || read_event_tail(&path, 2 * 1024 * 1024, 500))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .map_err(|e| AppError::Internal(anyhow::anyhow!("reading the events log {display}: {e}")))?;
    Ok(Json(entries))
}

fn read_event_tail(path: &Path, tail_bytes: u64, max: usize) -> std::io::Result<Vec<AcEvent>> {
    use std::io::{ErrorKind, Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    let start = len.saturating_sub(tail_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut out: Vec<AcEvent> = text
        .lines()
        .skip(if start > 0 { 1 } else { 0 })
        .filter_map(parse_event)
        .collect();
    out.reverse();
    out.truncate(max);
    Ok(out)
}

// ── application usage (bytes-per-app for the Devices page pie) ───────────────

#[derive(Debug, Deserialize)]
pub struct UsageQuery {
    /// `1h`, `24h` (default), or `7d`.
    #[serde(default)]
    window: Option<String>,
    /// Restrict to one client's source IP (per-client pie). Empty = all clients.
    #[serde(default)]
    ip: Option<String>,
}

#[derive(Serialize)]
pub struct AppBytes {
    pub app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct AppUsage {
    /// Apps sorted by bytes, descending.
    pub apps: Vec<AppBytes>,
    pub total: u64,
    /// False when the events file is absent (App Control never reported) — the
    /// UI shows an empty state rather than an empty pie.
    pub available: bool,
}

fn window_secs_ac(window: Option<&str>) -> u64 {
    match window.unwrap_or("24h") {
        "1h" => 3_600,
        "7d" => 7 * 86_400,
        _ => 86_400,
    }
}

/// Per-application buckets are hourly (qfdevd's `APP_BUCKET_SECS`).
const APP_BUCKET_SECS: i64 = 3_600;

/// GET /api/appcontrol/usage — bytes-per-application over the window, optionally
/// scoped to one client IP.
///
/// This reports the traffic each application actually moved, read from the
/// per-app byte buckets qfdevd accumulates by decoding App Control's verdict off
/// each flow's conntrack mark.
///
/// It deliberately does *not* come from qfappd's decision-event log, which is
/// what it used to read. Those events carry only the bytes the classifier
/// inspected before reaching a verdict — capped at a few KB per flow, after
/// which the flow is offloaded to nftables and stops being counted. Summing them
/// measures roughly how many flows an app opened, not its traffic: a 4 GB
/// download and a 4 KB one contribute about the same. Beside a byte total on the
/// same page, that reads as a bug.
pub async fn usage(
    State(state): State<Arc<AppState>>,
    Query(q): Query<UsageQuery>,
) -> Result<Json<AppUsage>> {
    let db_path = state.config.devices_db_file.clone();
    let catalog_path = state.config.appcontrol_catalog_file.clone();
    let win_secs = window_secs_ac(q.window.as_deref()) as i64;
    let ip = q.ip.filter(|s| !s.is_empty());

    let result = tokio::task::spawn_blocking(move || {
        let now = now_secs_i64();
        // Align the cutoff down to a bucket boundary. An hourly bucket is
        // stamped with the hour it opened, so an unaligned cutoff would drop the
        // bucket the window starts inside — at 10:05 a "1h" window would keep
        // only the 10:00 bucket and report five minutes of traffic as an hour's.
        // Rounding down instead includes up to an extra hour at the leading
        // edge. For a mix, over-covering beats silently truncating.
        let since = (now - win_secs) - (now - win_secs).rem_euclid(APP_BUCKET_SECS);
        aggregate_app_usage(&db_path, &catalog_path, since, ip.as_deref())
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .map_err(AppError::Internal)?;
    Ok(Json(result))
}

fn now_secs_i64() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Sum qfdevd's per-application buckets over the window, resolving nDPI protocol
/// ids to names through qfappd's published catalog.
///
/// The ids are stored, not the names, so a signature update renames apps
/// everywhere at once instead of leaving old rows labelled with stale names. An
/// id the catalog doesn't know (rows written before an nDPI downgrade, say)
/// still shows up, labelled by number rather than dropped.
fn aggregate_app_usage(
    db_path: &Path,
    catalog_path: &Path,
    since: i64,
    ip: Option<&str>,
) -> anyhow::Result<AppUsage> {
    use rusqlite::{OpenFlags, OptionalExtension};

    let conn = match rusqlite::Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        // No inventory yet → qfdevd has never run; nothing to report.
        Err(_) => return Ok(AppUsage { apps: Vec::new(), total: 0, available: false }),
    };
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    // A device's panel scopes by the client's current IP; the page header does
    // not scope at all.
    let mac: Option<String> = match ip {
        Some(ip) => {
            let found = conn
                .query_row("SELECT mac FROM devices WHERE current_ip = ?1", [ip], |r| r.get::<_, String>(0))
                .optional()?;
            match found {
                Some(m) => Some(m),
                // A known IP with no device row can't have buckets; reporting
                // every app on the LAN here would be worse than reporting none.
                None => return Ok(AppUsage { apps: Vec::new(), total: 0, available: true }),
            }
        }
        None => None,
    };

    let mut rows: Vec<(i64, u64)> = Vec::new();
    match &mac {
        Some(mac) => {
            let mut stmt = conn.prepare(
                "SELECT app_id, SUM(bytes_in + bytes_out) FROM app_usage_buckets
                 WHERE bucket_ts >= ?1 AND mac = ?2 GROUP BY app_id",
            )?;
            let it = stmt.query_map(rusqlite::params![since, mac], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? as u64))
            })?;
            for r in it {
                rows.push(r?);
            }
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT app_id, SUM(bytes_in + bytes_out) FROM app_usage_buckets
                 WHERE bucket_ts >= ?1 GROUP BY app_id",
            )?;
            let it = stmt.query_map(rusqlite::params![since], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? as u64))
            })?;
            for r in it {
                rows.push(r?);
            }
        }
    }

    let names = catalog_names(catalog_path);
    let mut total: u64 = 0;
    let mut apps: Vec<AppBytes> = rows
        .into_iter()
        .filter(|(_, bytes)| *bytes > 0)
        .map(|(id, bytes)| {
            total += bytes;
            let app = names
                .get(&(id as u16))
                .map(|(name, _)| name.clone())
                .unwrap_or_else(|| format!("App {id}"));
            let category = names.get(&(id as u16)).and_then(|(_, c)| c.clone());
            AppBytes { app, category, bytes }
        })
        .collect();
    apps.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.app.cmp(&b.app)));
    Ok(AppUsage { apps, total, available: true })
}

/// nDPI protocol id → (name, category) from qfappd's published catalog. Empty
/// when App Control isn't installed — ids then render as "App <n>".
fn catalog_names(path: &Path) -> BTreeMap<u16, (String, Option<String>)> {
    let mut out = BTreeMap::new();
    let Ok(text) = std::fs::read_to_string(path) else { return out };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return out };
    let Some(apps) = v.get("applications").and_then(|a| a.as_array()) else { return out };
    for a in apps {
        let (Some(id), Some(name)) = (a.get("id").and_then(|x| x.as_u64()), a.get("name").and_then(|x| x.as_str()))
        else {
            continue;
        };
        let category = a.get("category").and_then(|x| x.as_str()).filter(|c| !c.is_empty()).map(String::from);
        out.insert(id as u16, (name.to_string(), category));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A devices.db with qfdevd's per-app schema, plus a catalog naming the ids.
    /// Returns (dir, db_path, catalog_path); the caller removes the dir.
    fn fixture(name: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("qz-appusage-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("devices.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE devices (mac TEXT PRIMARY KEY, current_ip TEXT);
             CREATE TABLE app_usage_buckets (mac TEXT, bucket_ts INTEGER, app_id INTEGER,
                bytes_in INTEGER, bytes_out INTEGER, PRIMARY KEY (mac, bucket_ts, app_id));",
        )
        .unwrap();
        conn.execute("INSERT INTO devices VALUES ('aa','10.0.1.23')", []).unwrap();
        conn.execute("INSERT INTO devices VALUES ('bb','10.0.1.24')", []).unwrap();
        drop(conn);

        let cat = dir.join("catalog.json");
        std::fs::write(
            &cat,
            r#"{"ndpi_version":"4.8.0","num_protocols":2,
                "applications":[{"id":91,"name":"TLS","category_id":1,"category":"Web"},
                                {"id":244,"name":"ChatGPT","category_id":33,"category":"AI"}]}"#,
        )
        .unwrap();
        (dir, db, cat)
    }

    fn add(db: &std::path::Path, mac: &str, ts: i64, app_id: i64, b_in: i64, b_out: i64) {
        let c = rusqlite::Connection::open(db).unwrap();
        c.execute(
            "INSERT INTO app_usage_buckets VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![mac, ts, app_id, b_in, b_out],
        )
        .unwrap();
    }

    #[test]
    fn sums_real_bytes_per_app_and_resolves_names() {
        let (dir, db, cat) = fixture("sums");
        add(&db, "aa", 3600, 91, 4_000_000_000, 1_000); // a 4 GB TLS download
        add(&db, "aa", 7200, 91, 1_000_000, 0);
        add(&db, "aa", 3600, 244, 5_000, 5_000);
        add(&db, "bb", 3600, 91, 7, 3);

        let all = aggregate_app_usage(&db, &cat, 0, None).unwrap();
        assert!(all.available);
        // Sorted by bytes desc: TLS dominates.
        assert_eq!(all.apps[0].app, "TLS");
        assert_eq!(all.apps[0].bytes, 4_000_000_000 + 1_000 + 1_000_000 + 10);
        assert_eq!(all.apps[1].app, "ChatGPT");
        assert_eq!(all.apps[1].bytes, 10_000);
        assert_eq!(all.apps[1].category.as_deref(), Some("AI"));
        assert_eq!(all.total, all.apps.iter().map(|a| a.bytes).sum::<u64>());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scopes_to_one_client_by_ip() {
        let (dir, db, cat) = fixture("scope");
        add(&db, "aa", 3600, 91, 1_000, 0);
        add(&db, "bb", 3600, 244, 9_999, 0);

        let one = aggregate_app_usage(&db, &cat, 0, Some("10.0.1.23")).unwrap();
        assert_eq!(one.apps.len(), 1);
        assert_eq!(one.apps[0].app, "TLS");
        assert_eq!(one.total, 1_000);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_ip_reports_nothing_rather_than_everything() {
        // An IP with no device row must not silently widen to the whole LAN.
        let (dir, db, cat) = fixture("unknownip");
        add(&db, "aa", 3600, 91, 1_000, 0);
        let r = aggregate_app_usage(&db, &cat, 0, Some("192.0.2.99")).unwrap();
        assert!(r.available);
        assert_eq!(r.total, 0);
        assert!(r.apps.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn window_cutoff_excludes_older_buckets() {
        let (dir, db, cat) = fixture("cutoff");
        add(&db, "aa", 3600, 91, 1_000, 0);
        add(&db, "aa", 90_000, 244, 2_000, 0);

        let recent = aggregate_app_usage(&db, &cat, 90_000, None).unwrap();
        assert_eq!(recent.apps.len(), 1);
        assert_eq!(recent.apps[0].app, "ChatGPT");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn app_id_absent_from_the_catalog_is_labelled_not_dropped() {
        let (dir, db, cat) = fixture("unknownapp");
        add(&db, "aa", 3600, 1234, 500, 0);
        let r = aggregate_app_usage(&db, &cat, 0, None).unwrap();
        assert_eq!(r.apps.len(), 1);
        assert_eq!(r.apps[0].app, "App 1234");
        assert_eq!(r.total, 500);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_catalog_still_reports_bytes() {
        // App Control uninstalled after the fact: the numbers are still real.
        let (dir, db, _) = fixture("nocat");
        add(&db, "aa", 3600, 91, 500, 0);
        let r = aggregate_app_usage(&db, Path::new("/nonexistent/catalog.json"), 0, None).unwrap();
        assert_eq!(r.apps[0].app, "App 91");
        assert_eq!(r.total, 500);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_inventory_is_unavailable() {
        let r = aggregate_app_usage(
            Path::new("/nonexistent/devices.db"),
            Path::new("/nonexistent/catalog.json"),
            0,
            None,
        )
        .unwrap();
        assert!(!r.available);
        assert_eq!(r.total, 0);
    }

    #[test]
    fn hourly_cutoff_alignment_keeps_the_bucket_the_window_starts_inside() {
        // The trap: buckets are stamped with the hour they opened, so at 10:05 a
        // 1h window whose cutoff is 09:05 would exclude the 09:00 bucket and
        // report 5 minutes of traffic as an hour's worth.
        let now: i64 = 10 * 3600 + 300; // 10:05
        let raw = now - 3600; // 09:05
        let aligned = raw - raw.rem_euclid(APP_BUCKET_SECS);
        assert_eq!(aligned, 9 * 3600);
        assert!(9 * 3600 >= aligned, "the 09:00 bucket must survive the cutoff");
        assert!(9 * 3600 < raw, "...and would not have, unaligned");
    }

    #[test]
    fn parses_app_control_event() {
        let line = r#"{"timestamp":"2026-07-11T14:03:22.117Z","event_type":"app_control","src_ip":"10.0.1.23","src_port":51544,"dest_ip":"104.16.1.1","dest_port":443,"proto":"TCP","vlan":0,"in_iface":"eth1","app":"ChatGPT","app_id":244,"category":"AI","action":"block","action_name":"Global","block_mode":"drop","confidence":"dpi","default_applied":false,"sni":"chatgpt.com","bytes":3908,"pkts":7}"#;
        let e = parse_event(line).expect("parses");
        assert_eq!(e.app, "ChatGPT");
        assert_eq!(e.action, "block");
        assert_eq!(e.action_name, "Global");
        assert_eq!(e.dpt, Some(443));
        assert_eq!(e.sni.as_deref(), Some("chatgpt.com"));
        assert_eq!(e.ts, rfc3339_ms("2026-07-11T14:03:22.117Z").unwrap());
    }

    #[test]
    fn skips_non_app_control_lines() {
        assert!(parse_event("2026-07-11T14:03:22Z  INFO qfappd: queue 100 started").is_none());
        assert!(parse_event(r#"{"event_type":"other"}"#).is_none());
        assert!(parse_event("not json").is_none());
    }

    #[test]
    fn rfc3339_anchor() {
        assert_eq!(rfc3339_ms("1970-01-02T00:00:00.000Z"), Some(86_400_000));
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00.789Z"), Some(789));
        assert_eq!(rfc3339_ms("garbage"), None);
    }

    #[test]
    fn validate_rejects_too_many_actions() {
        let mut cfg = AcConfig { version: 2, actions: BTreeMap::new(), bindings: Vec::new() };
        for i in 0..8 {
            cfg.actions.insert(
                format!("A{i}"),
                AcAction {
                    default_action: "allow".into(),
                    block_mode: "drop".into(),
                    categories: BTreeMap::new(),
                    applications: BTreeMap::new(),
                },
            );
            cfg.bindings.push(AcBinding {
                id: i,
                action: format!("A{i}"),
                description: String::new(),
                match_spec: serde_json::json!({}),
            });
        }
        assert!(validate(&cfg).is_err());
    }

    #[test]
    fn validate_accepts_default() {
        assert!(validate(&AcConfig::default()).is_ok());
    }
}
