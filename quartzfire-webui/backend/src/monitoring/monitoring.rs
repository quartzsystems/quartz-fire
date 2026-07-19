//! Device/client monitoring (Monitoring → Devices).
//!
//! The data is collected by qfdevd (a separate root-capable daemon: neighbor
//! table + Kea leases + conntrack byte accounting) into a shared SQLite file.
//! This module is the read side plus the one field the user owns — the
//! `description`. We open the same DB in WAL mode (qfdevd makes it
//! group-writable to the `quartzfire` group we run under):
//!
//!   * GET  /api/monitoring/devices        — paginated, filtered, windowed list
//!   * GET  /api/monitoring/devices/{mac}   — one device + a usage timeseries
//!   * PATCH /api/monitoring/devices/{mac}  — set the user description
//!
//! qfdevd owns every collected column and never touches `description`; we own
//! `description` and never touch a collected column. So a shared WAL DB needs
//! no locking protocol between the two processes beyond SQLite's own.
//!
//! rusqlite is synchronous; every DB access runs on `spawn_blocking` so it
//! never stalls the async runtime. We open a fresh connection per request
//! (opening a local SQLite file is cheap) rather than sharing one across the
//! async handlers.

use std::path::Path;
use std::sync::Arc;

use std::convert::Infallible;
use std::process::Stdio;

use axum::{
    extract::{Path as AxumPath, Query, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_stream::{wrappers::LinesStream, StreamExt};

use crate::error::{AppError, Result};
use crate::AppState;

// ── query params ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    /// Usage window: `1h`, `24h` (default), or `7d`.
    #[serde(default)]
    window: Option<String>,
    /// `online`, `offline`, or `all` (default).
    #[serde(default)]
    status: Option<String>,
    /// Substring match over description / hostname / MAC / IP.
    #[serde(default)]
    search: Option<String>,
    /// Sort key: last_seen (default), description, usage, client_type, ip, status.
    #[serde(default)]
    sort: Option<String>,
    /// `asc` or `desc` (default desc).
    #[serde(default)]
    dir: Option<String>,
    #[serde(default)]
    page: Option<u32>,
    #[serde(default)]
    page_size: Option<u32>,
}

/// Window label → seconds. Anything unrecognized falls back to 24h.
fn window_secs(window: Option<&str>) -> i64 {
    match window.unwrap_or("24h") {
        "1h" => 3_600,
        "7d" => 7 * 86_400,
        _ => 86_400,
    }
}

// ── response models ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DeviceRow {
    pub mac: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_guess: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_ip: Option<String>,
    /// Link-local IPv6, kept separate so the WebUI's IPv4 column stays IPv4.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_ipv6: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlan: Option<String>,
    /// Some(true) static reservation, Some(false) dynamic lease, None non-DHCP.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dhcp_static: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_expiry: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub neigh_state: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
    pub online: bool,
    /// Bytes over the requested window.
    pub bytes_in: i64,
    pub bytes_out: i64,
}

#[derive(Debug, Serialize)]
pub struct DeviceList {
    pub devices: Vec<DeviceRow>,
    /// Total matching the search+status filter (before pagination).
    pub total: i64,
    /// Online/offline counts over the search filter (ignoring the status
    /// filter) so the UI can label the All/Online/Offline chips.
    pub online_count: i64,
    pub offline_count: i64,
    pub page: u32,
    pub page_size: u32,
    pub window: String,
    /// qfdevd health, if its status file is present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collector: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct UsagePoint {
    pub ts: i64,
    pub bytes_in: i64,
    pub bytes_out: i64,
}

#[derive(Debug, Serialize)]
pub struct DeviceDetail {
    #[serde(flatten)]
    pub device: DeviceRow,
    /// 5-minute usage buckets over the window, oldest first (sparkline input).
    pub usage: Vec<UsagePoint>,
    /// Our clock when this ran. See `UsageSeries::now`.
    pub now: i64,
}

/// Aggregate usage timeseries across every client (GET /api/monitoring/usage).
#[derive(Debug, Serialize)]
pub struct UsageSeries {
    /// 5-minute buckets over the window, oldest first.
    pub points: Vec<UsagePoint>,
    /// Window totals (sum of all points), for the header figure.
    pub bytes_in: i64,
    pub bytes_out: i64,
    pub window: String,
    /// Our clock when this ran, so the chart can lay out its time axis against
    /// the same clock that stamped `points[].ts` and picked the window cutoff.
    /// A browser whose clock differs from ours would otherwise scale buckets
    /// against the wrong "now" — inflating the live bucket's rate, and sliding
    /// real buckets outside the rendered span so they vanish from the graph
    /// while still counting toward the totals above it.
    pub now: i64,
}

/// One-shot ping result (POST /api/monitoring/devices/{mac}/ping).
#[derive(Debug, Serialize)]
pub struct PingResult {
    /// IPv4 that was pinged.
    pub target: String,
    pub transmitted: u32,
    pub received: u32,
    pub loss_pct: f64,
    /// Average round-trip in ms; None when nothing came back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_ms: Option<f64>,
    /// Per-reply round-trip times in ms (the mini latency chart).
    pub samples: Vec<f64>,
}

// ── DB access helpers ───────────────────────────────────────────────────────

/// Open the inventory read/write WITHOUT creating it. A missing file means
/// qfdevd hasn't run yet; callers decide whether that's empty-or-error.
fn open_db(path: &Path) -> std::result::Result<Option<Connection>, rusqlite::Error> {
    match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE) {
        Ok(conn) => {
            // Match qfdevd's pragmas; a WAL reader must not force a rollback
            // journal. Busy timeout rides out qfdevd's brief write locks.
            conn.busy_timeout(std::time::Duration::from_secs(5))?;
            Ok(Some(conn))
        }
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::CannotOpen => Ok(None),
        Err(e) => Err(e),
    }
}

/// The SQL fragment that computes `online` from the freshness rule, so the list
/// is fresh regardless of qfdevd's last sweep. `?online_now`/`?online_to` are
/// bound to now and the timeout.
const ONLINE_EXPR: &str = "CASE WHEN neigh_state IN ('REACHABLE','DELAY','PROBE') THEN 1 \
     WHEN (:now - last_seen) <= :timeout THEN 1 ELSE 0 END";

/// Whitelist a sort request to a real, indexed-or-cheap ORDER BY expression.
/// Never interpolate user input into SQL — map it to a fixed column.
fn sort_expr(sort: Option<&str>) -> &'static str {
    match sort.unwrap_or("last_seen") {
        "description" => "COALESCE(description, hostname, current_ip, mac)",
        "usage" => "(win_in + win_out)",
        "client_type" => "COALESCE(client_type, '')",
        "ip" => "current_ip",
        "hostname" => "COALESCE(hostname, '')",
        "status" => "online",
        _ => "last_seen",
    }
}

fn read_collector_status(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

// ── GET /api/monitoring/devices ─────────────────────────────────────────────

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<DeviceList>> {
    let db_path = state.config.devices_db_file.clone();
    let status_path = state.config.qfdevd_status_file.clone();
    let timeout = state.config.devices_online_timeout_secs as i64;

    let window = q.window.clone().unwrap_or_else(|| "24h".into());
    let win_secs = window_secs(q.window.as_deref());
    let status = q.status.clone().unwrap_or_else(|| "all".into());
    let search = q.search.clone().unwrap_or_default();
    let sort = sort_expr(q.sort.as_deref());
    let dir = if q.dir.as_deref() == Some("asc") { "ASC" } else { "DESC" };
    let page = q.page.unwrap_or(1).max(1);
    let page_size = q.page_size.unwrap_or(50).clamp(1, 500);

    let collector = read_collector_status(&status_path);

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<DeviceList> {
        let now = now_secs();
        let Some(conn) = open_db(&db_path)? else {
            // Daemon hasn't created the DB yet — an empty, honest list.
            return Ok(DeviceList {
                devices: Vec::new(),
                total: 0,
                online_count: 0,
                offline_count: 0,
                page,
                page_size,
                window,
                collector,
            });
        };

        let usage_since = now - win_secs;
        // LIKE pattern; empty search matches everything.
        let like = format!("%{}%", search.replace('%', "\\%").replace('_', "\\_"));
        let has_search = !search.is_empty();

        // A single query joins per-device windowed usage, computes `online`,
        // and applies search; status/sort/pagination wrap it. Bind everything —
        // only `sort`/`dir`/status are chosen from fixed whitelists above.
        let base = format!(
            "WITH usage AS (
                 SELECT mac, SUM(bytes_in) AS win_in, SUM(bytes_out) AS win_out
                 FROM usage_buckets WHERE bucket_ts >= :since GROUP BY mac
             ),
             joined AS (
                 SELECT d.*,
                        COALESCE(u.win_in, 0)  AS win_in,
                        COALESCE(u.win_out, 0) AS win_out,
                        {online} AS online
                 FROM devices d LEFT JOIN usage u ON u.mac = d.mac
                 WHERE (:has_search = 0 OR
                        d.mac LIKE :like ESCAPE '\\' OR
                        IFNULL(d.description,'') LIKE :like ESCAPE '\\' OR
                        IFNULL(d.hostname,'')    LIKE :like ESCAPE '\\' OR
                        IFNULL(d.current_ip,'')  LIKE :like ESCAPE '\\')
             )",
            online = ONLINE_EXPR,
        );

        // Counts over the search filter (status-independent) for the chips.
        let (online_count, offline_count): (i64, i64) = conn.query_row(
            &format!(
                "{base} SELECT
                    SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN online = 0 THEN 1 ELSE 0 END) FROM joined"
            ),
            named(&[
                (":since", &usage_since),
                (":now", &now),
                (":timeout", &timeout),
                (":has_search", &(has_search as i64)),
                (":like", &like),
            ]),
            |r| Ok((r.get::<_, Option<i64>>(0)?.unwrap_or(0), r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
        )?;

        let status_filter = match status.as_str() {
            "online" => "WHERE online = 1",
            "offline" => "WHERE online = 0",
            _ => "",
        };

        let total: i64 = conn.query_row(
            &format!("{base} SELECT COUNT(*) FROM joined {status_filter}"),
            named(&[
                (":since", &usage_since),
                (":now", &now),
                (":timeout", &timeout),
                (":has_search", &(has_search as i64)),
                (":like", &like),
            ]),
            |r| r.get(0),
        )?;

        let offset = ((page - 1) as i64) * page_size as i64;
        let list_sql = format!(
            "{base}
             SELECT mac, description, hostname, vendor, client_type, os_guess,
                    current_ip, current_ipv6, interface, vlan, dhcp_static, lease_expiry,
                    neigh_state, first_seen, last_seen, online, win_in, win_out
             FROM joined {status_filter}
             ORDER BY {sort} {dir}, last_seen DESC
             LIMIT :limit OFFSET :offset"
        );
        let mut stmt = conn.prepare(&list_sql)?;
        let rows = stmt
            .query_map(
                named(&[
                    (":since", &usage_since),
                    (":now", &now),
                    (":timeout", &timeout),
                    (":has_search", &(has_search as i64)),
                    (":like", &like),
                    (":limit", &(page_size as i64)),
                    (":offset", &offset),
                ]),
                row_to_device,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(DeviceList {
            devices: rows,
            total,
            online_count,
            offline_count,
            page,
            page_size,
            window,
            collector,
        })
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .map_err(AppError::Internal)?;

    Ok(Json(result))
}

// ── GET /api/monitoring/usage ───────────────────────────────────────────────

/// Combined usage timeseries over every client, for the page's header graph.
/// Sums the per-device 5-minute buckets by bucket, so it uses the same source
/// as the per-client sparkline just aggregated across all MACs.
pub async fn usage(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<UsageSeries>> {
    let db_path = state.config.devices_db_file.clone();
    let window = q.window.clone().unwrap_or_else(|| "24h".into());
    let win_secs = window_secs(q.window.as_deref());

    let series = tokio::task::spawn_blocking(move || -> anyhow::Result<UsageSeries> {
        let now = now_secs();
        let since = now - win_secs;
        let Some(conn) = open_db(&db_path)? else {
            return Ok(UsageSeries { points: Vec::new(), bytes_in: 0, bytes_out: 0, window, now });
        };
        let mut stmt = conn.prepare(
            "SELECT bucket_ts, SUM(bytes_in), SUM(bytes_out)
             FROM usage_buckets WHERE bucket_ts >= :since
             GROUP BY bucket_ts ORDER BY bucket_ts ASC",
        )?;
        let points = stmt
            .query_map(named(&[(":since", &since)]), |r| {
                Ok(UsagePoint { ts: r.get(0)?, bytes_in: r.get(1)?, bytes_out: r.get(2)? })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let bytes_in = points.iter().map(|p| p.bytes_in).sum();
        let bytes_out = points.iter().map(|p| p.bytes_out).sum();
        Ok(UsageSeries { points, bytes_in, bytes_out, window, now })
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .map_err(AppError::Internal)?;

    Ok(Json(series))
}

// ── GET /api/monitoring/devices/{mac} ───────────────────────────────────────

pub async fn detail(
    State(state): State<Arc<AppState>>,
    AxumPath(mac): AxumPath<String>,
    Query(q): Query<ListQuery>,
) -> Result<Json<DeviceDetail>> {
    let mac = normalize_mac(&mac)?;
    let db_path = state.config.devices_db_file.clone();
    let timeout = state.config.devices_online_timeout_secs as i64;
    let win_secs = window_secs(q.window.as_deref());
    let mac_for_err = mac.clone();

    let detail = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<DeviceDetail>> {
        let now = now_secs();
        let Some(conn) = open_db(&db_path)? else {
            return Ok(None);
        };
        let usage_since = now - win_secs;

        let device = conn
            .query_row(
                &format!(
                    "SELECT d.mac, d.description, d.hostname, d.vendor, d.client_type, d.os_guess,
                            d.current_ip, d.current_ipv6, d.interface, d.vlan, d.dhcp_static, d.lease_expiry,
                            d.neigh_state, d.first_seen, d.last_seen,
                            {ONLINE_EXPR} AS online,
                            COALESCE((SELECT SUM(bytes_in)  FROM usage_buckets WHERE mac=d.mac AND bucket_ts>=:since),0),
                            COALESCE((SELECT SUM(bytes_out) FROM usage_buckets WHERE mac=d.mac AND bucket_ts>=:since),0)
                     FROM devices d WHERE d.mac = :mac"
                ),
                named(&[(":now", &now), (":timeout", &timeout), (":since", &usage_since), (":mac", &mac)]),
                row_to_device,
            )
            .optional()?;

        let Some(device) = device else {
            return Ok(None);
        };

        let mut stmt = conn.prepare(
            "SELECT bucket_ts, bytes_in, bytes_out FROM usage_buckets
             WHERE mac = :mac AND bucket_ts >= :since ORDER BY bucket_ts ASC",
        )?;
        let usage = stmt
            .query_map(named(&[(":mac", &mac), (":since", &usage_since)]), |r| {
                Ok(UsagePoint { ts: r.get(0)?, bytes_in: r.get(1)?, bytes_out: r.get(2)? })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(Some(DeviceDetail { device, usage, now }))
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .map_err(AppError::Internal)?;

    detail
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("no device {mac_for_err} on record")))
}

// ── PATCH /api/monitoring/devices/{mac} ─────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DescriptionPatch {
    /// New description; null or empty clears it (falls back to hostname/etc).
    pub description: Option<String>,
}

pub async fn patch(
    State(state): State<Arc<AppState>>,
    AxumPath(mac): AxumPath<String>,
    Json(body): Json<DescriptionPatch>,
) -> Result<Json<DeviceRow>> {
    let mac = normalize_mac(&mac)?;
    let db_path = state.config.devices_db_file.clone();
    let timeout = state.config.devices_online_timeout_secs as i64;
    // Trim; an empty string becomes NULL so it doesn't shadow the hostname.
    let desc = body
        .description
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(d) = &desc {
        if d.chars().count() > 128 {
            return Err(AppError::BadRequest("description must be 128 characters or fewer".into()));
        }
    }

    let updated = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<DeviceRow>> {
        let now = now_secs();
        // PATCH is meaningless if the daemon never created the DB. Distinguish
        // that from "device not found" so the UI can tell the user to enable
        // monitoring rather than reporting a phantom device.
        let conn = match open_db(&db_path)? {
            Some(c) => c,
            None => anyhow::bail!("device monitoring is not running yet"),
        };
        let n = conn.execute(
            "UPDATE devices SET description = ?1 WHERE mac = ?2",
            params![desc, mac],
        )?;
        if n == 0 {
            return Ok(None);
        }
        let row = conn.query_row(
            &format!(
                "SELECT mac, description, hostname, vendor, client_type, os_guess,
                        current_ip, current_ipv6, interface, vlan, dhcp_static, lease_expiry,
                        neigh_state, first_seen, last_seen, {ONLINE_EXPR} AS online, 0, 0
                 FROM devices WHERE mac = :mac"
            ),
            named(&[(":now", &now), (":timeout", &timeout), (":mac", &mac)]),
            row_to_device,
        )?;
        Ok(Some(row))
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .map_err(AppError::Internal)?;

    updated
        .map(Json)
        .ok_or_else(|| AppError::NotFound("no such device".into()))
}

// ── POST /api/monitoring/devices/{mac}/ping ─────────────────────────────────

/// Echo requests a ping run sends (one-shot and streaming alike). Paced at one
/// per second, so a run lasts about this many seconds.
const PING_COUNT: u32 = 10;

/// Look up the client's current IPv4 from the inventory and revalidate it as an
/// IPv4 literal before it can reach the `ping` command line — nothing
/// user-controlled is ever passed to the process.
async fn resolve_ping_target(state: &Arc<AppState>, mac: &str) -> Result<String> {
    let mac = normalize_mac(mac)?;
    let db_path = state.config.devices_db_file.clone();

    let ip: String = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<String>> {
        let Some(conn) = open_db(&db_path)? else {
            anyhow::bail!("device monitoring is not running yet");
        };
        let ip: Option<String> = conn
            .query_row("SELECT current_ip FROM devices WHERE mac = ?1", params![mac], |r| r.get(0))
            .optional()?
            .flatten();
        Ok(ip)
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .map_err(AppError::Internal)?
    .ok_or_else(|| AppError::BadRequest("this client has no known IPv4 address to ping".into()))?;

    if ip.parse::<std::net::Ipv4Addr>().is_err() {
        return Err(AppError::BadRequest(format!("{ip:?} is not a pingable IPv4 address")));
    }
    Ok(ip)
}

/// Fire a short ICMP burst at the client's IPv4 and summarize it. The `ping`
/// binary carries `cap_net_raw`, so the unprivileged backend can run it. Used
/// as a non-streaming fallback; the UI drives the streaming variant below.
pub async fn ping(
    State(state): State<Arc<AppState>>,
    AxumPath(mac): AxumPath<String>,
) -> Result<Json<PingResult>> {
    let ip = resolve_ping_target(&state, &mac).await?;

    let out = Command::new("ping")
        .args(["-n", "-c", &PING_COUNT.to_string(), "-w", "12", &ip])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("cannot run ping: {e}")))?;

    // ping exits non-zero when every packet is lost — that's a valid result
    // (100% loss), not an error, so we parse stdout regardless of exit status.
    let text = String::from_utf8_lossy(&out.stdout);
    let result = parse_ping(&ip, &text);

    // A real run always prints an "N packets transmitted" line, even at 100%
    // loss — so transmitted == 0 means ping never got that far (e.g. it could
    // not open an ICMP socket because it lacks cap_net_raw / the service runs
    // with NoNewPrivileges, or the gid is outside net.ipv4.ping_group_range).
    // Surface stderr instead of reporting a misleading "100% loss (0/0)".
    if result.transmitted == 0 {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let detail = stderr
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("ping produced no output");
        return Err(AppError::Internal(anyhow::anyhow!("ping could not run: {detail}")));
    }

    Ok(Json(result))
}

/// Parse `ping -c` output into a `PingResult`. Reads per-reply `time=…` values,
/// the `N transmitted, M received, P% packet loss` line, and the
/// `rtt … = min/avg/max/…` summary. Robust to 100%-loss output (no rtt line).
fn parse_ping(target: &str, text: &str) -> PingResult {
    let mut samples = Vec::new();
    let mut transmitted = 0u32;
    let mut received = 0u32;
    let mut loss_pct = 100.0;
    let mut avg_ms = None;

    for line in text.lines() {
        let line = line.trim();
        if let Some(idx) = line.find("time=") {
            // "… time=0.234 ms"
            let rest = &line[idx + 5..];
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if let Ok(v) = num.parse::<f64>() {
                samples.push(v);
            }
        } else if line.contains("packets transmitted") {
            // "10 packets transmitted, 8 received, 20% packet loss, time 9012ms"
            for part in line.split(',') {
                let p = part.trim();
                if let Some(n) = p.strip_suffix(" packets transmitted") {
                    transmitted = n.trim().parse().unwrap_or(0);
                } else if let Some(n) = p.strip_suffix(" received") {
                    received = n.trim().parse().unwrap_or(0);
                } else if let Some(n) = p.strip_suffix("% packet loss") {
                    loss_pct = n.trim().parse().unwrap_or(100.0);
                }
            }
        } else if let Some(idx) = line.find('=') {
            if line.starts_with("rtt") || line.starts_with("round-trip") {
                // "rtt min/avg/max/mdev = 0.201/0.245/0.300/0.030 ms"
                let vals = line[idx + 1..].trim();
                if let Some(avg) = vals.split('/').nth(1) {
                    avg_ms = avg.trim().split_whitespace().next().and_then(|s| s.parse().ok());
                }
            }
        }
    }

    PingResult { target: target.to_string(), transmitted, received, loss_pct, avg_ms, samples }
}

// ── GET /api/monitoring/devices/{mac}/ping/stream ───────────────────────────

/// Run the same ICMP burst as `ping`, but stream each reply/timeout to the
/// browser over SSE as it happens so the UI can plot latency live and advance a
/// `k/N` progress counter. Events are JSON, one of:
///
/// ```text
/// {"kind":"start","target":"10.0.0.5","count":10}
/// {"kind":"reply","seq":1,"ms":0.234}
/// {"kind":"timeout","seq":2}
/// ```
///
/// `-O` makes `ping` print a "no answer yet for icmp_seq=N" line per lost
/// packet, so losses stream in real time too — a run that gets neither replies
/// nor timeouts is one `ping` could not start (the client treats that as an
/// error). The client derives the final loss/latency summary from the events.
pub async fn ping_stream(
    State(state): State<Arc<AppState>>,
    AxumPath(mac): AxumPath<String>,
) -> Result<Response> {
    let ip = resolve_ping_target(&state, &mac).await?;

    let mut child = Command::new("ping")
        .args(["-n", "-O", "-c", &PING_COUNT.to_string(), "-i", "1", "-W", "1", &ip])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("cannot run ping: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("ping produced no output")))?;

    // The filter_map closure owns the child, keeping ping alive for as long as
    // the browser reads; on disconnect the stream drops and kill_on_drop reaps.
    let body = LinesStream::new(BufReader::new(stdout).lines()).filter_map(move |line| {
        let _keep_child_alive = &child;
        let data = ping_line_event(&line.ok()?)?;
        Some(Ok::<Event, Infallible>(Event::default().data(data)))
    });

    // Lead with the target + count so the UI can render "0 / N" immediately,
    // before the first reply (iputils paces the first echo one interval in).
    let start =
        serde_json::json!({ "kind": "start", "target": ip, "count": PING_COUNT }).to_string();
    let stream = tokio_stream::once(Ok(Event::default().data(start))).chain(body);

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response())
}

/// Map one line of `ping -O` output to an SSE event payload, or None for lines
/// that are neither a reply nor a per-packet timeout (banner, stats, rtt).
fn ping_line_event(line: &str) -> Option<String> {
    let line = line.trim();
    // "no answer yet for icmp_seq=2"
    if let Some(seq) = line.strip_prefix("no answer yet for icmp_seq=") {
        let seq: u32 = seq.trim().parse().ok()?;
        return Some(serde_json::json!({ "kind": "timeout", "seq": seq }).to_string());
    }
    // "64 bytes from 10.0.0.5: icmp_seq=1 ttl=63 time=0.234 ms"
    if let (Some(si), Some(ti)) = (line.find("icmp_seq="), line.find("time=")) {
        let seq: u32 = line[si + 9..].split_whitespace().next()?.parse().ok()?;
        let num: String =
            line[ti + 5..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        let ms: f64 = num.parse().ok()?;
        return Some(serde_json::json!({ "kind": "reply", "seq": seq, "ms": ms }).to_string());
    }
    None
}

// ── row mapping + helpers ───────────────────────────────────────────────────

/// Map the 18-column device SELECT (in the exact order used everywhere above)
/// into a `DeviceRow`. `bytes_in`/`bytes_out` are the last two columns.
fn row_to_device(r: &rusqlite::Row) -> rusqlite::Result<DeviceRow> {
    Ok(DeviceRow {
        mac: r.get(0)?,
        description: r.get(1)?,
        hostname: r.get(2)?,
        vendor: r.get(3)?,
        client_type: r.get(4)?,
        os_guess: r.get(5)?,
        current_ip: r.get(6)?,
        current_ipv6: r.get(7)?,
        interface: r.get(8)?,
        vlan: r.get(9)?,
        dhcp_static: r.get::<_, Option<i64>>(10)?.map(|v| v != 0),
        lease_expiry: r.get(11)?,
        neigh_state: r.get(12)?,
        first_seen: r.get(13)?,
        last_seen: r.get(14)?,
        online: r.get::<_, i64>(15)? != 0,
        bytes_in: r.get(16)?,
        bytes_out: r.get(17)?,
    })
}

/// Validate + normalize a MAC path param (lowercase; colon/dash separated hex).
/// Rejects anything else so a bad path can't reach SQL as a bound value that
/// silently matches nothing (or worse, in a future non-parameterized query).
fn normalize_mac(raw: &str) -> Result<String> {
    let mac = raw.trim().to_ascii_lowercase().replace('-', ":");
    let ok = mac.split(':').count() == 6
        && mac.split(':').all(|o| o.len() == 2 && o.bytes().all(|b| b.is_ascii_hexdigit()));
    if !ok {
        return Err(AppError::BadRequest(format!("'{raw}' is not a MAC address")));
    }
    Ok(mac)
}

/// Named-parameter slice helper — rusqlite wants `&[(&str, &dyn ToSql)]`.
fn named<'a>(
    pairs: &'a [(&'a str, &'a dyn rusqlite::ToSql)],
) -> &'a [(&'a str, &'a dyn rusqlite::ToSql)] {
    pairs
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_seconds() {
        assert_eq!(window_secs(Some("1h")), 3_600);
        assert_eq!(window_secs(Some("24h")), 86_400);
        assert_eq!(window_secs(Some("7d")), 7 * 86_400);
        assert_eq!(window_secs(None), 86_400);
        assert_eq!(window_secs(Some("bogus")), 86_400);
    }

    #[test]
    fn sort_is_whitelisted() {
        assert_eq!(sort_expr(Some("usage")), "(win_in + win_out)");
        assert_eq!(sort_expr(Some("ip")), "current_ip");
        // Unknown / injection attempt collapses to the safe default.
        assert_eq!(sort_expr(Some("last_seen; DROP TABLE devices")), "last_seen");
        assert_eq!(sort_expr(None), "last_seen");
    }

    #[test]
    fn parses_ping_summary() {
        let out = "\
PING 10.0.0.5 (10.0.0.5) 56(84) bytes of data.
64 bytes from 10.0.0.5: icmp_seq=1 ttl=64 time=0.234 ms
64 bytes from 10.0.0.5: icmp_seq=2 ttl=64 time=0.300 ms

--- 10.0.0.5 ping statistics ---
10 packets transmitted, 8 received, 20% packet loss, time 9012ms
rtt min/avg/max/mdev = 0.201/0.245/0.300/0.030 ms
";
        let r = parse_ping("10.0.0.5", out);
        assert_eq!(r.transmitted, 10);
        assert_eq!(r.received, 8);
        assert_eq!(r.loss_pct, 20.0);
        assert_eq!(r.avg_ms, Some(0.245));
        assert_eq!(r.samples, vec![0.234, 0.300]);
    }

    #[test]
    fn parses_ping_total_loss() {
        let out = "\
PING 10.0.0.9 (10.0.0.9) 56(84) bytes of data.

--- 10.0.0.9 ping statistics ---
10 packets transmitted, 0 received, 100% packet loss, time 9200ms
";
        let r = parse_ping("10.0.0.9", out);
        assert_eq!(r.transmitted, 10);
        assert_eq!(r.received, 0);
        assert_eq!(r.loss_pct, 100.0);
        assert_eq!(r.avg_ms, None);
        assert!(r.samples.is_empty());
    }

    #[test]
    fn ping_line_events() {
        // A reply carries seq + rtt.
        let ev = ping_line_event("64 bytes from 10.0.0.5: icmp_seq=3 ttl=63 time=0.234 ms").unwrap();
        assert_eq!(ev, r#"{"kind":"reply","ms":0.234,"seq":3}"#);
        // `-O` emits a per-packet timeout line.
        let ev = ping_line_event("no answer yet for icmp_seq=2").unwrap();
        assert_eq!(ev, r#"{"kind":"timeout","seq":2}"#);
        // Banner / stats / rtt lines are not events.
        assert!(ping_line_event("PING 10.0.0.5 (10.0.0.5) 56(84) bytes of data.").is_none());
        assert!(ping_line_event("10 packets transmitted, 8 received, 20% packet loss").is_none());
        assert!(ping_line_event("rtt min/avg/max/mdev = 0.201/0.245/0.300/0.030 ms").is_none());
    }

    #[test]
    fn mac_normalization() {
        assert_eq!(normalize_mac("AA-BB-CC-DD-EE-FF").unwrap(), "aa:bb:cc:dd:ee:ff");
        assert_eq!(normalize_mac("aa:bb:cc:dd:ee:ff").unwrap(), "aa:bb:cc:dd:ee:ff");
        assert!(normalize_mac("not-a-mac").is_err());
        assert!(normalize_mac("aa:bb:cc:dd:ee").is_err());
        assert!(normalize_mac("zz:bb:cc:dd:ee:ff").is_err());
    }

    /// End-to-end against a real in-memory DB laid out like qfdevd's, exercising
    /// the exact SELECT/ORDER/window SQL the handlers build.
    #[test]
    fn list_query_windows_and_sorts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE devices (mac TEXT PRIMARY KEY, description TEXT, first_seen INTEGER, last_seen INTEGER,
                hostname TEXT, vendor TEXT, client_type TEXT, os_guess TEXT, current_ip TEXT, interface TEXT,
                vlan TEXT, dhcp_static INTEGER, lease_expiry INTEGER, neigh_state TEXT, online INTEGER);
             CREATE TABLE usage_buckets (mac TEXT, bucket_ts INTEGER, bytes_in INTEGER, bytes_out INTEGER,
                PRIMARY KEY(mac,bucket_ts));",
        )
        .unwrap();
        let now = now_secs();
        conn.execute("INSERT INTO devices VALUES ('a','laptop',1,?1,'a-host','Acme',NULL,NULL,'10.0.0.5','eth1',NULL,0,NULL,'REACHABLE',1)", params![now]).unwrap();
        conn.execute("INSERT INTO devices VALUES ('b',NULL,1,?1,'b-host','Beta',NULL,NULL,'10.0.0.6','eth1',NULL,NULL,NULL,'STALE',0)", params![now - 10_000]).unwrap();
        // 'a' has 1000 bytes inside 1h; 'b' has 5000 bytes but 3h ago (outside 1h).
        conn.execute("INSERT INTO usage_buckets VALUES ('a', ?1, 600, 400)", params![now - 300]).unwrap();
        conn.execute("INSERT INTO usage_buckets VALUES ('b', ?1, 3000, 2000)", params![now - 3 * 3600]).unwrap();

        // Reproduce the windowed usage sum for 1h.
        let since = now - window_secs(Some("1h"));
        let a_bytes: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(bytes_in+bytes_out),0) FROM usage_buckets WHERE mac='a' AND bucket_ts>=?1",
                params![since],
                |r| r.get(0),
            )
            .unwrap();
        let b_bytes: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(bytes_in+bytes_out),0) FROM usage_buckets WHERE mac='b' AND bucket_ts>=?1",
                params![since],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(a_bytes, 1000);
        assert_eq!(b_bytes, 0); // outside the 1h window

        // The online freshness expression flips 'b' offline (stale + old).
        let online_b: i64 = conn
            .query_row(
                &format!("SELECT {ONLINE_EXPR} FROM devices WHERE mac='b'"),
                named(&[(":now", &now), (":timeout", &300i64)]),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(online_b, 0);
    }
}
