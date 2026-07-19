//! Traffic Flow (Monitoring → Traffic Flow): bytes-weighted flow records with
//! firewall-rule attribution — the data behind the Sankey.
//!
//! No single source on the box knows both "which rule" and "how many bytes":
//!
//!   * qfdevd's `flow_buckets` (shared SQLite) has per-service-tuple byte
//!     deltas from conntrack — bytes, but no rule and no interfaces;
//!   * the nftables log prefix (kernel journal) has rule/chain/action and the
//!     in/out interfaces — but only one packet's length, not the flow's bytes.
//!
//! Their join key is the service tuple `(proto, src, dst, dport)`. This module
//! follows the kernel journal (reusing monitor.rs's parser so the two can't
//! drift) into an in-memory tuple → rule attribution cache, and the handler
//! joins it against the windowed byte sums read from `flow_buckets`.
//!
//! Honest limits, surfaced rather than hidden:
//!   * only rules with `log` enabled ever attribute — everything else returns
//!     with no attribution and renders as "(not logged)";
//!   * attribution starts at the follower's journal backfill, so a long-lived
//!     flow that last logged before that sits unattributed until it re-logs;
//!   * DNAT (port-forward) flows don't attribute: conntrack's original tuple
//!     keeps the pre-DNAT destination while the forward-filter log line shows
//!     the post-DNAT one, so the keys differ. A future refinement could key on
//!     the reply tuple as well.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::{AppError, Result};
use crate::monitor;
use crate::monitoring::open_db;
use crate::AppState;

/// Service tuple the two sides join on: (proto, src, dst, dport).
type AttrKey = (String, String, String, u16);

/// Keep at most this many attribution entries; above it the oldest half is
/// dropped. 100k tuples ≈ a few tens of MB worst case — a bound, not a budget.
const ATTR_CAP: usize = 100_000;


/// What one logged packet taught us about its flow's rule.
#[derive(Debug, Clone)]
pub struct Attr {
    chain: String,
    rule: Option<u32>,
    action: String,
    ips: bool,
    in_if: Option<String>,
    out_if: Option<String>,
    /// Journal ms timestamp of the sighting — the pruning order.
    ts: u64,
}

/// The tuple → rule cache. Lives in AppState; main.rs starts its journal
/// follower at backend startup so coverage begins the moment the box is up,
/// not when someone first opens the page.
#[derive(Default)]
pub struct Attribution {
    map: Mutex<HashMap<AttrKey, Attr>>,
    started: OnceLock<()>,
}

impl Attribution {
    /// Spawn the journal follower exactly once (idempotent, cheap after that).
    /// Called from main at startup; the request handler also calls it as a
    /// belt-and-braces fallback.
    pub fn ensure_started(self: &Arc<Self>) {
        self.started.get_or_init(|| {
            let attr = self.clone();
            tokio::spawn(async move { attr.follow_journal().await });
        });
    }

    /// Follow the kernel journal forever, folding every firewall log line into
    /// the cache. journalctl exiting (rotation, restart) just respawns it.
    ///
    /// `-b` replays the WHOLE current boot before following. Rule logging fires
    /// once per connection (only the first packet walks the rule chain), so a
    /// connection is attributable forever only if that one line is inside our
    /// replay — and conntrack entries cannot predate boot, so a boot-wide
    /// replay is the attribution ceiling. Bounded by journald's own retention
    /// caps; the replay is a startup burst of hash inserts, nothing more.
    async fn follow_journal(self: Arc<Self>) {
        loop {
            let child = Command::new("journalctl")
                .args(["-k", "-b", "-f", "-o", "json", "--no-pager"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn();
            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("flow attribution: cannot start journalctl: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    continue;
                }
            };
            let Some(stdout) = child.stdout.take() else {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                continue;
            };
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(e) = monitor::parse_journal_line(&line) {
                    self.record(&e);
                }
            }
            tracing::debug!("flow attribution journal stream ended; respawning");
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    }

    /// Fold one parsed firewall log entry into the cache. The newest sighting
    /// of a tuple wins — after a rule renumber or policy change the latest
    /// verdict is the one that matches what conntrack is now counting.
    fn record(&self, e: &monitor::LogEntry) {
        let (Some(src), Some(dst)) = (&e.src, &e.dst) else { return };
        let key: AttrKey = (
            e.proto.clone().unwrap_or_default(),
            src.clone(),
            dst.clone(),
            e.dpt.unwrap_or(0) as u16,
        );
        let attr = Attr {
            chain: e.chain.clone(),
            rule: e.rule,
            action: e.action.clone(),
            ips: e.ips,
            in_if: e.in_if.clone(),
            out_if: e.out_if.clone(),
            ts: e.ts,
        };
        let mut map = self.map.lock().unwrap();
        if map.len() >= ATTR_CAP && !map.contains_key(&key) {
            prune_oldest_half(&mut map);
        }
        map.insert(key, attr);
    }

    /// Attribution for a tuple, if any packet of it was ever logged.
    fn lookup(&self, proto: &str, src: &str, dst: &str, dport: u16) -> Option<Attr> {
        let key: AttrKey = (proto.to_string(), src.to_string(), dst.to_string(), dport);
        self.map.lock().unwrap().get(&key).cloned()
    }

    /// Re-point cached entries after a rule renumber (WebUI drag-reorder).
    ///
    /// The nftables log prefix carries only chain + rule NUMBER, and rule logs
    /// fire once per connection — so after a reorder, a long-lived flow's
    /// cached number resolves to whichever rule holds that number NOW, i.e. the
    /// wrong one. The reorder is the only place the old→new mapping exists, so
    /// the frontend posts it here in the same breath as the commit.
    ///
    /// Single pass over the map, each entry matched against its ORIGINAL
    /// (chain, rule) — two rules swapping numbers in one batch can't chain.
    /// Returns how many entries were re-pointed.
    pub fn renumber(&self, moves: &[RenumberMove]) -> usize {
        let mut map = self.map.lock().unwrap();
        let mut n = 0;
        for attr in map.values_mut() {
            let Some(rule) = attr.rule else { continue };
            if let Some(m) = moves.iter().find(|m| m.chain == attr.chain && m.from == rule) {
                attr.rule = Some(m.to);
                n += 1;
            }
        }
        n
    }
}

/// One rule move of a reorder: (chain, old number) → new number. `chain` uses
/// the same scope strings the log parser produces ("forward", "input",
/// "output", or "name:<ruleset>" for a zone pair's ruleset).
#[derive(Debug, Deserialize)]
pub struct RenumberMove {
    pub chain: String,
    pub from: u32,
    pub to: u32,
}

/// POST /api/monitoring/flows/renumber — apply a reorder's old→new rule-number
/// mapping to the attribution cache (see Attribution::renumber).
pub async fn renumber(
    State(state): State<Arc<AppState>>,
    Json(moves): Json<Vec<RenumberMove>>,
) -> Result<Json<serde_json::Value>> {
    if moves.len() > 10_000 {
        return Err(AppError::BadRequest("too many renumber entries".into()));
    }
    let remapped = state.flow_attr.renumber(&moves);
    Ok(Json(serde_json::json!({ "remapped": remapped })))
}

/// Drop the oldest half of the cache by sighting time. O(n log n) at the cap,
/// hit rarely; keeps recently-active tuples, which are the joinable ones.
fn prune_oldest_half(map: &mut HashMap<AttrKey, Attr>) {
    let mut stamps: Vec<u64> = map.values().map(|a| a.ts).collect();
    stamps.sort_unstable();
    let cutoff = stamps[stamps.len() / 2];
    map.retain(|_, a| a.ts >= cutoff);
}

// ── GET /api/monitoring/flows ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct FlowsQuery {
    /// Aggregation window: `5m` (default), `15m`, or `1h` (qfdevd's default
    /// flow retention ceiling).
    #[serde(default)]
    window: Option<String>,
    /// Max flow records returned (top by the chosen metric). Default 400,
    /// capped at 2000.
    #[serde(default)]
    limit: Option<u32>,
    /// Top-N ranking metric: `bytes` (default) or `hits` (connections begun).
    /// Whitelisted here — never interpolated from user input.
    #[serde(default)]
    metric: Option<String>,
}

fn window_secs(window: Option<&str>) -> i64 {
    match window.unwrap_or("5m") {
        "15m" => 900,
        "1h" => 3_600,
        _ => 300,
    }
}

/// One aggregated flow: the byte sums for a service tuple over the window,
/// plus rule attribution when the flow ever logged. `chain: None` means
/// unattributed (not logged / logged before our backfill) — distinct from
/// `chain: Some, rule: None`, which is a chain's default action.
#[derive(Debug, Serialize)]
pub struct FlowRecord {
    pub src: String,
    pub dst: String,
    pub proto: String,
    pub dport: u16,
    /// src → dst bytes over the window.
    pub bytes_orig: i64,
    /// dst → src bytes over the window.
    pub bytes_reply: i64,
    /// Convenience total (orig + reply) — the Sankey's byte ribbon weight.
    pub bytes: i64,
    /// Connections begun over the window — the "hits" ribbon weight.
    pub conns: i64,
    /// Device name (user description, else hostname) when the IP is a known
    /// client, so the UI can label nodes better than bare addresses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dst_name: Option<String>,
    // ── attribution (all None/false when the flow never logged) ──
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ips: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_if: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_if: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FlowsResponse {
    pub flows: Vec<FlowRecord>,
    /// Window totals over ALL tuples (not just the returned top-N), so the UI
    /// can render an honest "showing X of Y" and an Other rollup.
    pub total_bytes: i64,
    pub total_conns: i64,
    pub flow_count: i64,
    pub truncated: bool,
    /// Sums over returned flows that carry attribution — the "how much of this
    /// picture is rule-labeled" figures, one per metric.
    pub attributed_bytes: i64,
    pub attributed_conns: i64,
    /// False when qfdevd (or a version with flow recording) isn't running yet.
    pub available: bool,
    pub window: String,
    pub now: i64,
}

/// Raw row out of the blocking DB read, pre-attribution.
struct TupleRow {
    proto: String,
    src: String,
    dst: String,
    dport: u16,
    bytes_orig: i64,
    bytes_reply: i64,
    conns: i64,
}

// The queries against qfdevd's DB, as consts/builders so the tests below can
// run the VERBATIM strings against a qfdevd-shaped schema — the schema lives
// in another crate, and nothing else would catch the two drifting apart.

/// Top-N service tuples over the window, ranked by the chosen metric.
/// ?1 = since, ?2 = limit. `by_hits` comes from the whitelist match in the
/// handler, never from raw user input.
fn top_flows_sql(by_hits: bool) -> String {
    let rank = if by_hits { "SUM(conns)" } else { "SUM(bytes_orig + bytes_reply)" };
    format!(
        "SELECT proto, src, dst, dport, SUM(bytes_orig), SUM(bytes_reply), SUM(conns)
         FROM flow_buckets WHERE bucket_ts >= ?1
         GROUP BY proto, src, dst, dport
         ORDER BY {rank} DESC
         LIMIT ?2"
    )
}

/// Window totals over ALL tuples (inner: one row per tuple with its byte and
/// connection sums; outer aggregates them). ?1 = since.
const TOTALS_SQL: &str = "SELECT COALESCE(SUM(b), 0), COALESCE(SUM(c), 0), COUNT(*) FROM
       (SELECT SUM(bytes_orig + bytes_reply) AS b, SUM(conns) AS c FROM flow_buckets
        WHERE bucket_ts >= ?1 GROUP BY proto, src, dst, dport)";

/// IP → display name over the whole (small) device table.
const NAMES_SQL: &str = "SELECT current_ip, COALESCE(description, hostname)
     FROM devices
     WHERE current_ip IS NOT NULL
       AND COALESCE(description, hostname) IS NOT NULL";

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FlowsQuery>,
) -> Result<Json<FlowsResponse>> {
    // First use of the page arms the journal follower; by the next poll tick
    // its backfill has usually landed.
    state.flow_attr.ensure_started();

    let db_path = state.config.devices_db_file.clone();
    let window = q.window.clone().unwrap_or_else(|| "5m".into());
    let win_secs = window_secs(q.window.as_deref());
    let limit = q.limit.unwrap_or(400).clamp(1, 2000) as i64;
    // Whitelist the ranking metric — anything unrecognized falls back to bytes.
    let by_hits = q.metric.as_deref() == Some("hits");

    let (rows, names, total_bytes, total_conns, flow_count, available) =
        tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let now = now_secs();
            let since = now - win_secs;
            let Some(conn) = open_db(&db_path)? else {
                return Ok((Vec::new(), HashMap::new(), 0, 0, 0, false));
            };

            // An older qfdevd has no flow_buckets table ("no such table"), or a
            // pre-hits one that hasn't migrated the conns column yet ("no such
            // column"); both mean "not available yet", not an error.
            let mut stmt = match conn.prepare(&top_flows_sql(by_hits)) {
                Ok(s) => s,
                Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
                    if msg.contains("no such table") || msg.contains("no such column") =>
                {
                    return Ok((Vec::new(), HashMap::new(), 0, 0, 0, false));
                }
                Err(e) => return Err(e.into()),
            };
            let rows = stmt
                .query_map(rusqlite::params![since, limit], |r| {
                    Ok(TupleRow {
                        proto: r.get(0)?,
                        src: r.get(1)?,
                        dst: r.get(2)?,
                        dport: r.get::<_, i64>(3)? as u16,
                        bytes_orig: r.get(4)?,
                        bytes_reply: r.get(5)?,
                        conns: r.get(6)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;

            let (total_bytes, total_conns, flow_count): (i64, i64, i64) =
                conn.query_row(TOTALS_SQL, rusqlite::params![since], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;

            // IP → display name for every known client, so Sankey nodes read
            // "Front desk printer" instead of 10.0.0.23. The device table is
            // small (hundreds), so loading the whole map beats a dynamic IN.
            let mut names: HashMap<String, String> = HashMap::new();
            let mut nstmt = conn.prepare(NAMES_SQL)?;
            for row in nstmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })? {
                if let Ok((ip, name)) = row {
                    names.insert(ip, name);
                }
            }

            Ok((rows, names, total_bytes, total_conns, flow_count, true))
        })
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .map_err(AppError::Internal)?;

    let truncated = flow_count > rows.len() as i64;
    let mut attributed_bytes = 0i64;
    let mut attributed_conns = 0i64;
    let flows: Vec<FlowRecord> = rows
        .into_iter()
        .map(|t| {
            let attr = state.flow_attr.lookup(&t.proto, &t.src, &t.dst, t.dport);
            let bytes = t.bytes_orig + t.bytes_reply;
            if attr.is_some() {
                attributed_bytes += bytes;
                attributed_conns += t.conns;
            }
            let (chain, rule, action, ips, in_if, out_if) = match attr {
                Some(a) => (Some(a.chain), a.rule, Some(a.action), a.ips, a.in_if, a.out_if),
                None => (None, None, None, false, None, None),
            };
            FlowRecord {
                src_name: names.get(&t.src).cloned(),
                dst_name: names.get(&t.dst).cloned(),
                src: t.src,
                dst: t.dst,
                proto: t.proto,
                dport: t.dport,
                bytes_orig: t.bytes_orig,
                bytes_reply: t.bytes_reply,
                bytes,
                conns: t.conns,
                chain,
                rule,
                action,
                ips,
                in_if,
                out_if,
            }
        })
        .collect();

    Ok(Json(FlowsResponse {
        flows,
        total_bytes,
        total_conns,
        flow_count,
        truncated,
        attributed_bytes,
        attributed_conns,
        available,
        window,
        now: now_secs(),
    }))
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

    fn entry(proto: &str, src: &str, dst: &str, dpt: Option<u32>, rule: Option<u32>, ts: u64) -> monitor::LogEntry {
        monitor::LogEntry {
            ts,
            family: "ipv4".into(),
            chain: "forward".into(),
            rule,
            action: "accept".into(),
            src: Some(src.into()),
            dst: Some(dst.into()),
            proto: Some(proto.into()),
            dpt,
            ..Default::default()
        }
    }

    #[test]
    fn windows_parse_with_default() {
        assert_eq!(window_secs(Some("5m")), 300);
        assert_eq!(window_secs(Some("15m")), 900);
        assert_eq!(window_secs(Some("1h")), 3_600);
        assert_eq!(window_secs(None), 300);
        assert_eq!(window_secs(Some("bogus")), 300);
    }

    #[test]
    fn record_then_lookup_round_trip() {
        let attr = Attribution::default();
        attr.record(&entry("tcp", "10.0.0.5", "1.1.1.1", Some(443), Some(10), 1));
        let a = attr.lookup("tcp", "10.0.0.5", "1.1.1.1", 443).expect("attributed");
        assert_eq!(a.chain, "forward");
        assert_eq!(a.rule, Some(10));
        assert_eq!(a.action, "accept");
        // Different port → no attribution.
        assert!(attr.lookup("tcp", "10.0.0.5", "1.1.1.1", 80).is_none());
    }

    #[test]
    fn portless_protocols_key_on_zero() {
        // ICMP has no DPT in the log line and dport 0 in conntrack — the two
        // sides must land on the same key.
        let attr = Attribution::default();
        attr.record(&entry("icmp", "10.0.0.5", "1.1.1.1", None, Some(20), 1));
        assert!(attr.lookup("icmp", "10.0.0.5", "1.1.1.1", 0).is_some());
    }

    #[test]
    fn newest_sighting_wins() {
        // After a renumber the tuple re-logs under the new rule; the cache must
        // follow it, not stay pinned to the first sighting.
        let attr = Attribution::default();
        attr.record(&entry("tcp", "10.0.0.5", "1.1.1.1", Some(443), Some(10), 1));
        attr.record(&entry("tcp", "10.0.0.5", "1.1.1.1", Some(443), Some(30), 2));
        assert_eq!(attr.lookup("tcp", "10.0.0.5", "1.1.1.1", 443).unwrap().rule, Some(30));
    }

    #[test]
    fn entries_without_endpoints_are_ignored() {
        let attr = Attribution::default();
        let mut e = entry("tcp", "10.0.0.5", "1.1.1.1", Some(443), Some(10), 1);
        e.dst = None;
        attr.record(&e);
        assert!(attr.map.lock().unwrap().is_empty());
    }

    /// Run the handler's VERBATIM SQL against a DB shaped exactly like
    /// qfdevd's (see qfdevd/src/db.rs init_schema). The schema lives in the
    /// other crate, so nothing else pins this seam — the totals query once
    /// shipped referencing a column its subquery didn't expose, which every
    /// per-query unit test missed and every real box hit.
    #[test]
    fn handler_sql_runs_against_qfdevd_schema() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE devices (
                mac TEXT PRIMARY KEY, description TEXT, first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL, hostname TEXT, vendor TEXT, client_type TEXT,
                os_guess TEXT, current_ip TEXT, current_ipv6 TEXT, interface TEXT, vlan TEXT,
                dhcp_static INTEGER, lease_expiry INTEGER, neigh_state TEXT,
                online INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE flow_buckets (
                bucket_ts INTEGER NOT NULL, proto TEXT NOT NULL, src TEXT NOT NULL,
                dst TEXT NOT NULL, dport INTEGER NOT NULL DEFAULT 0,
                bytes_orig INTEGER NOT NULL DEFAULT 0, bytes_reply INTEGER NOT NULL DEFAULT 0,
                conns INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (bucket_ts, proto, src, dst, dport));",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO devices (mac, first_seen, last_seen, hostname, current_ip)
             VALUES ('aa', 1, 1, 'laptop', '10.0.0.5')",
            [],
        )
        .unwrap();
        // Two buckets of one tuple (must merge), one other tuple (few bytes but
        // MANY connections — the hits ranking must surface it), one aged out.
        for (ts, dport, o, r, h) in
            [(600, 443, 100, 900, 1), (900, 443, 50, 100, 2), (900, 53, 10, 20, 40), (0, 443, 999, 999, 9)]
        {
            conn.execute(
                "INSERT INTO flow_buckets VALUES (?1, 'tcp', '10.0.0.5', '1.1.1.1', ?2, ?3, ?4, ?5)",
                rusqlite::params![ts, dport, o, r, h],
            )
            .unwrap();
        }

        let since = 300i64;
        let mut stmt = conn.prepare(&top_flows_sql(false)).unwrap();
        let rows: Vec<(String, String, String, i64, i64, i64, i64)> = stmt
            .query_map(rusqlite::params![since, 10i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2, "two live tuples; the aged bucket is out of window");
        // By bytes: the 443 tuple's two buckets merged (150 orig / 1000 reply, 3 conns).
        assert_eq!(rows[0].3, 443);
        assert_eq!((rows[0].4, rows[0].5, rows[0].6), (150, 1000, 3));

        // By hits: the chatty low-byte DNS tuple must rank first instead.
        let mut hstmt = conn.prepare(&top_flows_sql(true)).unwrap();
        let hrows: Vec<(i64, i64)> = hstmt
            .query_map(rusqlite::params![since, 10i64], |r| Ok((r.get::<_, i64>(3)?, r.get::<_, i64>(6)?)))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert_eq!(hrows[0], (53, 40));

        let (total, total_conns, count): (i64, i64, i64) = conn
            .query_row(TOTALS_SQL, rusqlite::params![since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!(count, 2);
        assert_eq!(total, 150 + 1000 + 10 + 20);
        assert_eq!(total_conns, 3 + 40);

        let mut nstmt = conn.prepare(NAMES_SQL).unwrap();
        let names: Vec<(String, String)> = nstmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert_eq!(names, vec![("10.0.0.5".into(), "laptop".into())]);
    }

    #[test]
    fn renumber_repoints_by_original_number_so_swaps_cannot_chain() {
        let attr = Attribution::default();
        attr.record(&entry("tcp", "10.0.0.5", "1.1.1.1", Some(443), Some(10), 1));
        attr.record(&entry("tcp", "10.0.0.5", "2.2.2.2", Some(443), Some(20), 1));
        attr.record(&entry("udp", "10.0.0.5", "3.3.3.3", Some(53), Some(30), 1));

        // Rules 10 and 20 swap in one reorder batch. Chained application would
        // collapse both onto one number; original-value matching must not.
        let n = attr.renumber(&[
            RenumberMove { chain: "forward".into(), from: 10, to: 20 },
            RenumberMove { chain: "forward".into(), from: 20, to: 10 },
        ]);
        assert_eq!(n, 2);
        assert_eq!(attr.lookup("tcp", "10.0.0.5", "1.1.1.1", 443).unwrap().rule, Some(20));
        assert_eq!(attr.lookup("tcp", "10.0.0.5", "2.2.2.2", 443).unwrap().rule, Some(10));
        // Untouched rule keeps its number.
        assert_eq!(attr.lookup("udp", "10.0.0.5", "3.3.3.3", 53).unwrap().rule, Some(30));
    }

    #[test]
    fn renumber_is_chain_scoped_and_skips_default_actions() {
        let attr = Attribution::default();
        // Same number in a different chain must not be caught by the move.
        let mut e = entry("tcp", "10.0.0.5", "1.1.1.1", Some(443), Some(10), 1);
        e.chain = "input".into();
        attr.record(&e);
        // Default-action attribution has no number to move.
        attr.record(&entry("tcp", "10.0.0.5", "4.4.4.4", Some(80), None, 1));

        let n = attr.renumber(&[RenumberMove { chain: "forward".into(), from: 10, to: 20 }]);
        assert_eq!(n, 0);
        assert_eq!(attr.lookup("tcp", "10.0.0.5", "1.1.1.1", 443).unwrap().rule, Some(10));
        assert_eq!(attr.lookup("tcp", "10.0.0.5", "4.4.4.4", 80).unwrap().rule, None);
    }

    #[test]
    fn cap_prunes_the_oldest_half() {
        let mut map: HashMap<AttrKey, Attr> = HashMap::new();
        for i in 0..10u64 {
            map.insert(
                ("tcp".into(), format!("10.0.0.{i}"), "1.1.1.1".into(), 443),
                Attr {
                    chain: "forward".into(),
                    rule: Some(1),
                    action: "accept".into(),
                    ips: false,
                    in_if: None,
                    out_if: None,
                    ts: i,
                },
            );
        }
        prune_oldest_half(&mut map);
        assert_eq!(map.len(), 5);
        // The survivors are the recent half.
        assert!(map.values().all(|a| a.ts >= 5));
    }
}
