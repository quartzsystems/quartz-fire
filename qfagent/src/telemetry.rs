//! Periodic security-service telemetry.
//!
//! Every `INTERVAL` seconds the control channel asks this module for a
//! [`SecurityTelemetry`] snapshot and pushes it up the existing ControlStream
//! (see `control::connected_wait`). Collection is deliberately independent of
//! the local web UI: qfagent runs as root, so it reads each subsystem's own
//! on-disk counter/log artifacts directly. That keeps telemetry flowing even
//! when quartzfire-webui is down, and means a disabled or not-installed
//! service simply yields zero counters rather than an error — nothing here
//! fails the snapshot; a missing, unreadable, or unparsable source degrades to
//! zeros for that one service.
//!
//! Counter provenance (all cumulative, monotonic within the source's current
//! run; they reset on service restart / ruleset reload / log rotation):
//!
//!   IPS            — tallied from the persistent EVE alert log
//!                    /var/log/quartzfire/ips-alerts.json; `scans` is the
//!                    latest EVE `stats` snapshot's decoder.pkts (packets
//!                    inspected) from /var/log/quartzfire/ips-stats.json.
//!   App Control    — /run/qfappd/status.json (decisions/blocked/unknown_pct).
//!   Geolocation    — /run/quartzfire-geoip/counters.json (named nft counters).
//!   Content Filter — tallied from /var/log/quartzfire/content-filtering.json.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::proto::device::{
    AppControlCounters, ContentFilterCounters, GeoCounters, IpsCounters, SecurityTelemetry,
};

/// How often the control channel emits a snapshot.
pub const INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// On-disk locations of each subsystem's telemetry sources. These mirror the
/// defaults quartzfire-webui's backend config uses; a test builds one rooted
/// in a tempdir. Production callers use [`Paths::system`].
#[derive(Clone, Debug)]
pub struct Paths {
    pub ips_settings: PathBuf,      // /config/quartzfire/ips.json (desired state)
    pub ips_alerts: PathBuf,        // /var/log/quartzfire/ips-alerts.json (EVE)
    pub ips_stats: PathBuf,         // /var/log/quartzfire/ips-stats.json (EVE stats)
    pub suricata_pidfile: PathBuf,  // /run/suricata/suricata.pid
    pub appcontrol_status: PathBuf, // /run/qfappd/status.json
    pub geo_counters: PathBuf,      // /run/quartzfire-geoip/counters.json
    pub geo_status: PathBuf,        // /run/quartzfire-geoip/status.json
    pub cf_status: PathBuf,         // /run/quartzfire-content-filtering/status.json
    pub cf_log: PathBuf,            // /var/log/quartzfire/content-filtering.json
}

impl Paths {
    pub fn system() -> Self {
        Self {
            ips_settings: PathBuf::from("/config/quartzfire/ips.json"),
            ips_alerts: PathBuf::from("/var/log/quartzfire/ips-alerts.json"),
            ips_stats: PathBuf::from("/var/log/quartzfire/ips-stats.json"),
            suricata_pidfile: PathBuf::from("/run/suricata/suricata.pid"),
            appcontrol_status: PathBuf::from("/run/qfappd/status.json"),
            geo_counters: PathBuf::from("/run/quartzfire-geoip/counters.json"),
            geo_status: PathBuf::from("/run/quartzfire-geoip/status.json"),
            cf_status: PathBuf::from("/run/quartzfire-content-filtering/status.json"),
            cf_log: PathBuf::from("/var/log/quartzfire/content-filtering.json"),
        }
    }
}

/// Collect a full snapshot from the system's default locations.
pub fn collect() -> SecurityTelemetry {
    collect_from(&Paths::system())
}

/// Collect a snapshot from an explicit path set (production or test).
pub fn collect_from(p: &Paths) -> SecurityTelemetry {
    SecurityTelemetry {
        time_unix: crate::state::now_unix(),
        interval_secs: INTERVAL.as_secs() as u32,
        ips: Some(collect_ips(p)),
        app_control: Some(collect_appcontrol(p)),
        geolocation: Some(collect_geo(p)),
        content_filtering: Some(collect_cf(p)),
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
}

/// Stream a newline-delimited JSON file, folding each parsed object into an
/// accumulator. Streams line-by-line so a large log never lands in memory
/// whole; a missing file yields the zero accumulator. Non-JSON and
/// blank lines are skipped (suricata mixes non-alert events into the same
/// file).
fn fold_jsonl<A: Default>(path: &Path, mut f: impl FnMut(&mut A, &Value)) -> A {
    let mut acc = A::default();
    let Ok(file) = File::open(path) else { return acc };
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            f(&mut acc, &v);
        }
    }
    acc
}

// ── IPS ───────────────────────────────────────────────────────────────────────

/// suricata liveness via its pidfile + /proc comm, matching the WebUI backend's
/// unprivileged check (systemctl is unreliable in the sandbox / dev boxes).
fn suricata_alive(pidfile: &Path) -> bool {
    let Ok(pid) = std::fs::read_to_string(pidfile) else { return false };
    let pid = pid.trim();
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match std::fs::read_to_string(format!("/proc/{pid}/comm")) {
        Ok(comm) => comm.trim().to_ascii_lowercase().starts_with("suricata"),
        Err(_) => false,
    }
}

fn collect_ips(p: &Paths) -> IpsCounters {
    // Desired-state "enabled" (ips.json), gated on suricata actually running so
    // the card reflects enforcement, not just intent.
    let desired_enabled = read_json(&p.ips_settings)
        .and_then(|v| v.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false);
    let enabled = desired_enabled && suricata_alive(&p.suricata_pidfile);

    // Tally the persistent EVE alert log: every alert is a detection; the
    // subset with alert.action == "blocked" was dropped inline (prevented).
    #[derive(Default)]
    struct Acc {
        detected: u64,
        prevented: u64,
    }
    let acc = fold_jsonl::<Acc>(&p.ips_alerts, |a, v| {
        if v.get("event_type").and_then(Value::as_str) != Some("alert") {
            return;
        }
        a.detected += 1;
        if v.get("alert").and_then(|al| al.get("action")).and_then(Value::as_str) == Some("blocked")
        {
            a.prevented += 1;
        }
    });

    // Packets inspected, from the latest EVE `stats` snapshot (deltas:no, so
    // each line is cumulative-since-start). Every line is a full snapshot, so
    // the last parseable one wins; a missing file / absent field means the
    // stats output isn't running → not available.
    let scans = last_stats_pkts(&p.ips_stats);

    IpsCounters {
        enabled,
        prevented: acc.prevented,
        detected: acc.detected,
        scans: scans.unwrap_or(0),
        scans_available: scans.is_some(),
    }
}

/// The `stats.decoder.pkts` value from the most recent EVE stats line, or None
/// when the stats file is absent/empty or carries no such counter.
fn last_stats_pkts(path: &Path) -> Option<u64> {
    let latest = fold_jsonl::<Option<u64>>(path, |acc, v| {
        if v.get("event_type").and_then(Value::as_str) != Some("stats") {
            return;
        }
        if let Some(pkts) = v
            .get("stats")
            .and_then(|s| s.get("decoder"))
            .and_then(|d| d.get("pkts"))
            .and_then(Value::as_u64)
        {
            *acc = Some(pkts);
        }
    });
    latest
}

// ── Application Control ─────────────────────────────────────────────────────────

fn collect_appcontrol(p: &Paths) -> AppControlCounters {
    // A fresh /run/qfappd/status.json means qfappd is running; its absence
    // means the service is stopped or not installed → zeros.
    let Some(v) = read_json(&p.appcontrol_status) else {
        return AppControlCounters::default();
    };
    let decisions = v.get("decisions").and_then(Value::as_u64).unwrap_or(0);
    let blocked = v.get("blocked").and_then(Value::as_u64).unwrap_or(0);
    // qfappd exposes the unknown share as a percentage; "detected" (flows where
    // nDPI identified an application) is the classified remainder. The raw
    // unknown count lives only on the gRPC FlowStats, so this is derived.
    let unknown_pct = v.get("unknown_pct").and_then(Value::as_f64).unwrap_or(0.0);
    let unknown = ((decisions as f64) * unknown_pct / 100.0).round() as u64;
    let detected = decisions.saturating_sub(unknown);

    AppControlCounters { enabled: true, blocked, detected, total_requests: decisions }
}

// ── Geolocation ───────────────────────────────────────────────────────────────

/// Sum the `packets` fields of an object of `{name: {packets, bytes}}`.
fn sum_packets(obj: Option<&Value>) -> u64 {
    obj.and_then(Value::as_object)
        .map(|m| {
            m.values()
                .filter_map(|e| e.get("packets").and_then(Value::as_u64))
                .sum()
        })
        .unwrap_or(0)
}

fn collect_geo(p: &Paths) -> GeoCounters {
    let Some(v) = read_json(&p.geo_counters) else {
        // No counters file: the geo table may still be installed but inactive.
        // Reflect installed-but-off rather than inventing counters.
        let enabled = read_json(&p.geo_status)
            .and_then(|s| s.get("active").and_then(Value::as_bool))
            .unwrap_or(false);
        return GeoCounters { enabled, ..Default::default() };
    };
    // Every geo action counter ends in `drop`, so all action packets are
    // blocked packets. Policy jump-rule counters count new connections checked.
    let blocked = sum_packets(v.get("actions"));
    let connections = sum_packets(v.get("policies"));
    // Zero-hit countries are already omitted from `countries` by the geoip
    // helper, so its length is the number of countries actually blocked.
    let countries_blocked = v
        .get("countries")
        .and_then(Value::as_object)
        .map(|m| m.len() as u32)
        .unwrap_or(0);

    GeoCounters { enabled: true, blocked, connections, countries_blocked }
}

// ── Content Filtering ───────────────────────────────────────────────────────────

fn collect_cf(p: &Paths) -> ContentFilterCounters {
    // "enabled" from the CF status.json when present; the log tally is
    // independent of it.
    let enabled = read_json(&p.cf_status)
        .and_then(|v| {
            // qfcf-status writes either a top-level `enabled` or nests under
            // `status`; accept both.
            v.get("enabled")
                .or_else(|| v.get("status").and_then(|s| s.get("enabled")))
                .and_then(Value::as_bool)
        })
        .unwrap_or_else(|| p.cf_log.exists());

    // Each access-log line carries action == "blocked" | "allowed".
    #[derive(Default)]
    struct Acc {
        blocked: u64,
        allowed: u64,
    }
    let acc = fold_jsonl::<Acc>(&p.cf_log, |a, v| {
        match v.get("action").and_then(Value::as_str) {
            Some("blocked") => a.blocked += 1,
            Some(_) => a.allowed += 1,
            None => {}
        }
    });

    ContentFilterCounters {
        enabled,
        blocked: acc.blocked,
        allowed: acc.allowed,
        total_requests: acc.blocked + acc.allowed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        let mut f = File::create(&path).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        path
    }

    fn paths_in(dir: &Path) -> Paths {
        Paths {
            ips_settings: dir.join("ips.json"),
            ips_alerts: dir.join("ips-alerts.json"),
            ips_stats: dir.join("ips-stats.json"),
            suricata_pidfile: dir.join("suricata.pid"), // absent → not alive
            appcontrol_status: dir.join("qfappd-status.json"),
            geo_counters: dir.join("geo-counters.json"),
            geo_status: dir.join("geo-status.json"),
            cf_status: dir.join("cf-status.json"),
            cf_log: dir.join("cf.json"),
        }
    }

    #[test]
    fn all_sources_absent_yields_zeroed_but_present_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let t = collect_from(&paths_in(dir.path()));
        // Every service block is present so the console always has six cards.
        let ips = t.ips.unwrap();
        assert!(!ips.enabled && ips.detected == 0 && ips.prevented == 0);
        assert!(!ips.scans_available && ips.scans == 0);
        let ac = t.app_control.unwrap();
        assert!(!ac.enabled && ac.total_requests == 0);
        let geo = t.geolocation.unwrap();
        assert!(!geo.enabled && geo.blocked == 0 && geo.countries_blocked == 0);
        let cf = t.content_filtering.unwrap();
        assert!(!cf.enabled && cf.total_requests == 0);
        assert_eq!(t.interval_secs, 60);
    }

    #[test]
    fn ips_tallies_alerts_and_blocked_subset() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        write(dir.path(), "ips.json", r#"{"enabled":true}"#);
        // Two blocked, one alert-only, plus a non-alert line that must be
        // ignored, plus junk.
        let log = concat!(
            r#"{"event_type":"alert","alert":{"action":"blocked","signature_id":1}}"#,
            "\n",
            r#"{"event_type":"alert","alert":{"action":"allowed","signature_id":2}}"#,
            "\n",
            r#"{"event_type":"alert","alert":{"action":"blocked","signature_id":3}}"#,
            "\n",
            r#"{"event_type":"stats","stats":{}}"#,
            "\n",
            "not json at all\n",
        );
        write(dir.path(), "ips-alerts.json", log);
        let ips = collect_ips(&p);
        assert_eq!(ips.detected, 3);
        assert_eq!(ips.prevented, 2);
        // suricata pidfile absent → not "enabled" even though desired=true.
        assert!(!ips.enabled);
        assert!(!ips.scans_available);
    }

    #[test]
    fn ips_scans_reads_latest_stats_decoder_pkts() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        write(dir.path(), "ips.json", r#"{"enabled":true}"#);
        // Two cumulative snapshots plus a non-stats line: the last stats wins.
        let stats = concat!(
            r#"{"event_type":"stats","stats":{"decoder":{"pkts":100}}}"#,
            "\n",
            r#"{"event_type":"alert","alert":{"action":"blocked"}}"#,
            "\n",
            r#"{"event_type":"stats","stats":{"decoder":{"pkts":250},"detect":{"alert":5}}}"#,
            "\n",
        );
        write(dir.path(), "ips-stats.json", stats);
        let ips = collect_ips(&p);
        assert!(ips.scans_available);
        assert_eq!(ips.scans, 250);
    }

    #[test]
    fn appcontrol_derives_detected_from_unknown_pct() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        write(
            dir.path(),
            "qfappd-status.json",
            r#"{"decisions":1000,"blocked":40,"unknown_pct":25.0}"#,
        );
        let ac = collect_appcontrol(&p);
        assert!(ac.enabled);
        assert_eq!(ac.total_requests, 1000);
        assert_eq!(ac.blocked, 40);
        assert_eq!(ac.detected, 750); // 1000 - 25%
    }

    #[test]
    fn geo_sums_action_packets_and_counts_countries() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        let counters = r#"{
            "time": 1,
            "actions": {"geo_Geo": {"packets": 120, "bytes": 9000},
                        "geo_Block2": {"packets": 30, "bytes": 100}},
            "policies": {"1": {"packets": 555, "bytes": 1}},
            "countries": {"CN": {"packets": 100, "bytes": 1},
                          "RU": {"packets": 50, "bytes": 1}}
        }"#;
        write(dir.path(), "geo-counters.json", counters);
        let geo = collect_geo(&p);
        assert!(geo.enabled);
        assert_eq!(geo.blocked, 150);
        assert_eq!(geo.connections, 555);
        assert_eq!(geo.countries_blocked, 2);
    }

    #[test]
    fn geo_installed_but_inactive_without_counters() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        write(dir.path(), "geo-status.json", r#"{"active": false}"#);
        let geo = collect_geo(&p);
        assert!(!geo.enabled);
        assert_eq!(geo.blocked, 0);
    }

    /// Compile-time guard for the exact wrapping `control.rs` uses to put a
    /// snapshot on the ControlStream. If the generated oneof variant name or
    /// the message type ever drifts, this fails to build (control.rs is
    /// Linux-only, so the host build would otherwise not catch it).
    #[test]
    fn snapshot_wraps_into_a_device_message() {
        use crate::proto::device::{device_message, DeviceMessage};
        let dir = tempfile::tempdir().unwrap();
        let snapshot = collect_from(&paths_in(dir.path()));
        let msg = DeviceMessage {
            msg: Some(device_message::Msg::SecurityTelemetry(snapshot)),
        };
        assert!(matches!(
            msg.msg,
            Some(device_message::Msg::SecurityTelemetry(_))
        ));
    }

    #[test]
    fn cf_tallies_blocked_and_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        let log = concat!(
            r#"{"action":"blocked","url":"http://evil.test"}"#,
            "\n",
            r#"{"action":"allowed","url":"http://ok.test"}"#,
            "\n",
            r#"{"action":"allowed","url":"http://ok2.test"}"#,
            "\n",
        );
        write(dir.path(), "cf.json", log);
        let cf = collect_cf(&p);
        assert_eq!(cf.blocked, 1);
        assert_eq!(cf.allowed, 2);
        assert_eq!(cf.total_requests, 3);
        assert!(cf.enabled); // no status.json → falls back to log presence
    }
}
