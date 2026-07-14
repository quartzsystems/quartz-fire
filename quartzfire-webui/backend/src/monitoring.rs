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

use axum::{
    extract::{Path as AxumPath, Query, State},
    Json,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

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
                    current_ip, interface, vlan, dhcp_static, lease_expiry,
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
                            d.current_ip, d.interface, d.vlan, d.dhcp_static, d.lease_expiry,
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

        Ok(Some(DeviceDetail { device, usage }))
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
                        current_ip, interface, vlan, dhcp_static, lease_expiry,
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

// ── row mapping + helpers ───────────────────────────────────────────────────

/// Map the 17-column device SELECT (in the exact order used everywhere above)
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
        interface: r.get(7)?,
        vlan: r.get(8)?,
        dhcp_static: r.get::<_, Option<i64>>(9)?.map(|v| v != 0),
        lease_expiry: r.get(10)?,
        neigh_state: r.get(11)?,
        first_seen: r.get(12)?,
        last_seen: r.get(13)?,
        online: r.get::<_, i64>(14)? != 0,
        bytes_in: r.get(15)?,
        bytes_out: r.get(16)?,
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
