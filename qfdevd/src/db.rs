//! The shared device inventory (SQLite, WAL).
//!
//! qfdevd is the sole *writer of collected facts*; the WebUI backend opens the
//! same file to read the inventory and to write the one column qfdevd must
//! never touch — the user-assigned `description`. WAL mode lets a writer and
//! readers coexist without blocking each other.
//!
//! Merge discipline: a sighting from one collector must not erase what another
//! learned. Every device upsert `COALESCE`s new values over old, so a bare
//! neighbor-table sighting (MAC + IP, no hostname) keeps the hostname a DHCP
//! lease previously supplied. `description` is never in any collector UPDATE.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

/// 5-minute usage buckets, so 1h/24h/7d windows are cheap sums.
pub const BUCKET_SECS: i64 = 300;

/// Align a unix timestamp down to its 5-minute bucket.
pub fn bucket_of(ts: i64) -> i64 {
    ts - ts.rem_euclid(BUCKET_SECS)
}

/// One device sighting to merge in. All the identity fields are optional: a
/// collector supplies only what it observed, and `upsert_sighting` merges it
/// over whatever is already recorded without clobbering richer prior data.
#[derive(Debug, Default, Clone)]
pub struct Sighting {
    pub mac: String,
    pub seen_at: i64,
    pub current_ip: Option<String>,
    pub hostname: Option<String>,
    pub vendor: Option<String>,
    pub client_type: Option<String>,
    pub os_guess: Option<String>,
    pub interface: Option<String>,
    pub vlan: Option<String>,
    /// Some(true) = static reservation, Some(false) = dynamic lease,
    /// None = not learned from DHCP on this sighting.
    pub dhcp_static: Option<bool>,
    pub lease_expiry: Option<i64>,
    pub neigh_state: Option<String>,
    /// Some(true/false) sets the online flag; None leaves it unchanged.
    pub online: Option<bool>,
}

/// Open (creating if needed) the inventory DB in WAL mode and ensure the
/// schema. `create_dirs` makes the parent directory when missing — qfdevd
/// passes true (it owns the file); a reader can pass false.
pub fn open(path: &Path, create_dirs: bool) -> Result<Connection> {
    if create_dirs {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
    }
    let conn = Connection::open(path)
        .with_context(|| format!("opening device DB {}", path.display()))?;
    // WAL: concurrent reader (WebUI) + writer (us) without blocking. NORMAL
    // sync is the WAL-recommended durability/throughput trade-off. A generous
    // busy timeout rides out the brief moments the other process holds a lock.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Create tables/indexes if absent. Idempotent, so it doubles as the migration
/// entry point (bump SCHEMA_VERSION and add ALTERs here when the shape changes).
fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS devices (
            mac          TEXT PRIMARY KEY,
            description  TEXT,
            first_seen   INTEGER NOT NULL,
            last_seen    INTEGER NOT NULL,
            hostname     TEXT,
            vendor       TEXT,
            client_type  TEXT,
            os_guess     TEXT,
            current_ip   TEXT,
            interface    TEXT,
            vlan         TEXT,
            dhcp_static  INTEGER,          -- 1 static, 0 dynamic, NULL unknown
            lease_expiry INTEGER,
            neigh_state  TEXT,
            online       INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen);
        CREATE INDEX IF NOT EXISTS idx_devices_current_ip ON devices(current_ip);

        CREATE TABLE IF NOT EXISTS usage_buckets (
            mac       TEXT NOT NULL,
            bucket_ts INTEGER NOT NULL,     -- 5-minute aligned unix time
            bytes_in  INTEGER NOT NULL DEFAULT 0,
            bytes_out INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (mac, bucket_ts)
        );
        CREATE INDEX IF NOT EXISTS idx_usage_bucket_ts ON usage_buckets(bucket_ts);

        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        "#,
    )
    .context("initializing device DB schema")?;
    Ok(())
}

/// Merge a sighting. Inserts a new device or updates identity fields over the
/// existing row, keeping the earliest `first_seen` and the latest `last_seen`.
/// COALESCE(new, old) means a null field never erases a known value; a
/// non-null field always wins (the freshest IP/state/lease replaces the old).
/// `description` is deliberately absent — only the WebUI writes it.
pub fn upsert_sighting(conn: &Connection, s: &Sighting) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO devices
            (mac, first_seen, last_seen, hostname, vendor, client_type, os_guess,
             current_ip, interface, vlan, dhcp_static, lease_expiry, neigh_state, online)
        VALUES
            (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, COALESCE(?13, 0))
        ON CONFLICT(mac) DO UPDATE SET
            last_seen    = MAX(devices.last_seen, excluded.last_seen),
            hostname     = COALESCE(excluded.hostname,     devices.hostname),
            vendor       = COALESCE(excluded.vendor,       devices.vendor),
            client_type  = COALESCE(excluded.client_type,  devices.client_type),
            os_guess     = COALESCE(excluded.os_guess,     devices.os_guess),
            current_ip   = COALESCE(excluded.current_ip,   devices.current_ip),
            interface    = COALESCE(excluded.interface,    devices.interface),
            vlan         = COALESCE(excluded.vlan,         devices.vlan),
            dhcp_static  = COALESCE(excluded.dhcp_static,  devices.dhcp_static),
            lease_expiry = COALESCE(excluded.lease_expiry, devices.lease_expiry),
            neigh_state  = COALESCE(excluded.neigh_state,  devices.neigh_state),
            online       = COALESCE(?13, devices.online)
        "#,
        params![
            s.mac,
            s.seen_at,
            s.hostname,
            s.vendor,
            s.client_type,
            s.os_guess,
            s.current_ip,
            s.interface,
            s.vlan,
            s.dhcp_static.map(|b| b as i64),
            s.lease_expiry,
            s.neigh_state,
            s.online.map(|b| b as i64),
        ],
    )
    .with_context(|| format!("upserting device {}", s.mac))?;
    Ok(())
}

/// Recompute the `online` flag for every device from the freshness rule: a
/// REACHABLE/DELAY/PROBE neighbor entry, or traffic within `timeout_secs`.
/// Run after a neighbor poll so stale entries flip to Offline on schedule.
pub fn refresh_online(conn: &Connection, now: i64, timeout_secs: i64) -> Result<()> {
    conn.execute(
        r#"
        UPDATE devices SET online =
            CASE
                WHEN neigh_state IN ('REACHABLE','DELAY','PROBE') THEN 1
                WHEN (?1 - last_seen) <= ?2 THEN 1
                ELSE 0
            END
        "#,
        params![now, timeout_secs],
    )?;
    Ok(())
}

/// Add byte deltas to a device's current 5-minute bucket. Deltas are already
/// resolved to a known MAC by the caller; unattributable flows are dropped.
pub fn add_usage(conn: &Connection, mac: &str, bucket_ts: i64, bytes_in: u64, bytes_out: u64) -> Result<()> {
    if bytes_in == 0 && bytes_out == 0 {
        return Ok(());
    }
    conn.execute(
        r#"
        INSERT INTO usage_buckets (mac, bucket_ts, bytes_in, bytes_out)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(mac, bucket_ts) DO UPDATE SET
            bytes_in  = usage_buckets.bytes_in  + excluded.bytes_in,
            bytes_out = usage_buckets.bytes_out + excluded.bytes_out
        "#,
        params![mac, bucket_ts, bytes_in as i64, bytes_out as i64],
    )?;
    Ok(())
}

/// Prune aged usage buckets and long-unseen devices. Returns (buckets, devices)
/// deleted. `device_retention_days == 0` disables device pruning.
pub fn prune(conn: &Connection, now: i64, usage_days: i64, device_days: i64) -> Result<(usize, usize)> {
    let usage_cutoff = now - usage_days * 86_400;
    let buckets = conn.execute("DELETE FROM usage_buckets WHERE bucket_ts < ?1", params![usage_cutoff])?;

    let devices = if device_days > 0 {
        let dev_cutoff = now - device_days * 86_400;
        // Take the device's usage history with it so orphan buckets can't
        // accumulate under a MAC no longer in `devices`.
        let n = conn.execute("DELETE FROM devices WHERE last_seen < ?1", params![dev_cutoff])?;
        conn.execute(
            "DELETE FROM usage_buckets WHERE mac NOT IN (SELECT mac FROM devices)",
            [],
        )?;
        n
    } else {
        0
    };
    Ok((buckets, devices))
}

/// Total device rows — for the status snapshot.
pub fn device_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM devices", [], |r| r.get(0))?)
}

/// A device's current (hostname, vendor) — the inputs the fingerprint step
/// recomputes from. Returns (None, None) if the device row is gone.
pub fn identity(conn: &Connection, mac: &str) -> Result<(Option<String>, Option<String>)> {
    Ok(conn
        .query_row(
            "SELECT hostname, vendor FROM devices WHERE mac = ?1",
            params![mac],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or((None, None)))
}

/// Set a device's fingerprint. Authoritative + idempotent: the fingerprint is a
/// deterministic function of (hostname, vendor), recomputed after every
/// sighting, so writing it directly (not via COALESCE) keeps a later, richer
/// signal from being pinned to an earlier weak guess.
pub fn set_fingerprint(conn: &Connection, mac: &str, client_type: Option<&str>, os_guess: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE devices SET client_type = ?2, os_guess = ?3 WHERE mac = ?1",
        params![mac, client_type, os_guess],
    )?;
    Ok(())
}

/// A meta value (small key/value scratch, e.g. schema notes).
pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()?)
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_schema(&c).unwrap();
        c
    }

    #[test]
    fn bucket_alignment() {
        assert_eq!(bucket_of(0), 0);
        assert_eq!(bucket_of(299), 0);
        assert_eq!(bucket_of(300), 300);
        assert_eq!(bucket_of(301), 300);
        assert_eq!(bucket_of(1_000_000), 1_000_000 - (1_000_000 % 300));
    }

    #[test]
    fn upsert_merges_without_clobbering() {
        let c = mem();
        // Lease sighting: MAC + hostname, no vendor.
        upsert_sighting(&c, &Sighting {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            seen_at: 100,
            hostname: Some("laptop".into()),
            current_ip: Some("10.0.0.5".into()),
            dhcp_static: Some(false),
            ..Default::default()
        }).unwrap();
        // Later neighbor sighting: newer time + state, NO hostname → must keep it.
        upsert_sighting(&c, &Sighting {
            mac: "aa:bb:cc:dd:ee:ff".into(),
            seen_at: 200,
            neigh_state: Some("REACHABLE".into()),
            vendor: Some("Acme".into()),
            ..Default::default()
        }).unwrap();

        let (first, last, host, vendor, ip, state): (i64, i64, Option<String>, Option<String>, Option<String>, Option<String>) =
            c.query_row(
                "SELECT first_seen,last_seen,hostname,vendor,current_ip,neigh_state FROM devices WHERE mac=?1",
                params!["aa:bb:cc:dd:ee:ff"],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            ).unwrap();
        assert_eq!(first, 100);          // earliest kept
        assert_eq!(last, 200);           // latest wins
        assert_eq!(host.as_deref(), Some("laptop")); // not clobbered by null
        assert_eq!(vendor.as_deref(), Some("Acme"));
        assert_eq!(ip.as_deref(), Some("10.0.0.5"));
        assert_eq!(state.as_deref(), Some("REACHABLE"));
    }

    #[test]
    fn description_survives_collector_upserts() {
        let c = mem();
        upsert_sighting(&c, &Sighting { mac: "m".into(), seen_at: 1, ..Default::default() }).unwrap();
        c.execute("UPDATE devices SET description=?1 WHERE mac=?2", params!["Front desk printer", "m"]).unwrap();
        // Another sighting must NOT touch description.
        upsert_sighting(&c, &Sighting { mac: "m".into(), seen_at: 2, hostname: Some("h".into()), ..Default::default() }).unwrap();
        let desc: Option<String> = c.query_row("SELECT description FROM devices WHERE mac='m'", [], |r| r.get(0)).unwrap();
        assert_eq!(desc.as_deref(), Some("Front desk printer"));
    }

    #[test]
    fn usage_accumulates_per_bucket() {
        let c = mem();
        add_usage(&c, "m", 300, 10, 20).unwrap();
        add_usage(&c, "m", 300, 5, 1).unwrap();
        add_usage(&c, "m", 600, 100, 0).unwrap();
        let (b_in, b_out): (i64, i64) = c.query_row(
            "SELECT bytes_in,bytes_out FROM usage_buckets WHERE mac='m' AND bucket_ts=300",
            [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((b_in, b_out), (15, 21));
        let n: i64 = c.query_row("SELECT COUNT(*) FROM usage_buckets WHERE mac='m'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn refresh_online_rule() {
        let c = mem();
        let now = 10_000i64;
        // Reachable neighbor → online regardless of last_seen age.
        upsert_sighting(&c, &Sighting { mac: "a".into(), seen_at: now - 9999, neigh_state: Some("REACHABLE".into()), ..Default::default() }).unwrap();
        // Stale neighbor but recent traffic → online.
        upsert_sighting(&c, &Sighting { mac: "b".into(), seen_at: now - 10, neigh_state: Some("STALE".into()), ..Default::default() }).unwrap();
        // Stale + old → offline.
        upsert_sighting(&c, &Sighting { mac: "c".into(), seen_at: now - 5000, neigh_state: Some("STALE".into()), ..Default::default() }).unwrap();
        refresh_online(&c, now, 300).unwrap();
        let online = |mac: &str| -> i64 {
            c.query_row("SELECT online FROM devices WHERE mac=?1", params![mac], |r| r.get(0)).unwrap()
        };
        assert_eq!(online("a"), 1);
        assert_eq!(online("b"), 1);
        assert_eq!(online("c"), 0);
    }

    #[test]
    fn prune_drops_aged_rows() {
        let c = mem();
        let now = 100 * 86_400;
        upsert_sighting(&c, &Sighting { mac: "old".into(), seen_at: now - 200 * 86_400, ..Default::default() }).unwrap();
        upsert_sighting(&c, &Sighting { mac: "new".into(), seen_at: now, ..Default::default() }).unwrap();
        add_usage(&c, "old", bucket_of(now - 40 * 86_400), 1, 1).unwrap();
        add_usage(&c, "new", bucket_of(now), 1, 1).unwrap();
        let (buckets, devices) = prune(&c, now, 30, 90).unwrap();
        assert_eq!(devices, 1);          // "old" device gone
        assert!(buckets >= 1);           // its aged bucket gone
        let remaining: i64 = c.query_row("SELECT COUNT(*) FROM devices", [], |r| r.get(0)).unwrap();
        assert_eq!(remaining, 1);
    }
}
