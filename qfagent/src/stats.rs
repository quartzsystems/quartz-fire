//! Periodic device health & traffic telemetry.
//!
//! Every `INTERVAL` seconds the control channel asks this module for a
//! [`DeviceStats`] snapshot and pushes it up the existing ControlStream (see
//! `control::connected_wait`), independent of the ~60 s security telemetry
//! cadence. Like `telemetry`, collection reads the box directly (qfagent runs
//! as root), and a source that is missing or unreadable degrades to a zero /
//! empty field for just that one gauge — the console renders partial snapshots
//! fine, so nothing here fails the whole message.
//!
//! Field provenance:
//!   cpu_pct    — busy/total delta of /proc/stat's aggregate `cpu` line across
//!                a short in-call sample window (a point-in-time average).
//!   mem_pct    — (MemTotal - MemAvailable) / MemTotal from /proc/meminfo.
//!   disk_pct   — used% of the root filesystem via statvfs(3) (Linux only).
//!   uptime_secs— first field of /proc/uptime.
//!   public_ip  — the source address the kernel picks for the default route
//!                (the WAN interface's own address, as the device sees itself);
//!                "" when there is no route out.
//!   top_policies — the busiest VyOS firewall rules by bytes, read from the
//!                nftables `vyos_filter` table's per-rule counters, each named
//!                as the operator sees it on the Rules page (the configured
//!                rule description / `[dn:…]` display name) via the running
//!                VyOS config, falling back to the raw chain+rule label.

use std::time::Duration;

use serde_json::Value;

use crate::proto::device::{DeviceStats, PolicyStat};
use crate::vyoscfg::{CliShellApi, ConfigRead};

/// How often the control channel emits a snapshot.
pub const INTERVAL: Duration = Duration::from_secs(30);

/// In-call CPU sample window. Short enough not to stall the collector's
/// blocking task, long enough for a stable busy/total ratio.
const CPU_SAMPLE: Duration = Duration::from_millis(200);

/// Cap on `top_policies` (the busiest rules; the console shows a handful).
const MAX_POLICIES: usize = 8;

/// Collect a full snapshot from the system's live sources.
pub fn collect() -> DeviceStats {
    // Read memory and root-fs usage once each; the gauge and the absolute
    // figures come from the same sample so they can't disagree.
    let mem = read_mem();
    let disk = read_disk("/");
    DeviceStats {
        time_unix: crate::state::now_unix(),
        interval_secs: INTERVAL.as_secs() as u32,
        cpu_pct: clamp_pct(sample_cpu_pct().unwrap_or(0.0)),
        mem_pct: clamp_pct(mem.map(|m| m.pct()).unwrap_or(0.0)),
        disk_pct: clamp_pct(disk.map(|d| d.pct).unwrap_or(0.0)),
        uptime_secs: read_uptime_secs().unwrap_or(0),
        public_ip: outbound_ip().unwrap_or_default(),
        top_policies: top_policies(),
        mem_used_bytes: mem.map(|m| m.used_bytes).unwrap_or(0),
        mem_total_bytes: mem.map(|m| m.total_bytes).unwrap_or(0),
        disk_used_bytes: disk.map(|d| d.used_bytes).unwrap_or(0),
        disk_total_bytes: disk.map(|d| d.total_bytes).unwrap_or(0),
    }
}

/// Clamp a gauge to the 0–100 range the contract promises.
fn clamp_pct(v: f64) -> f64 {
    if v.is_nan() {
        0.0
    } else {
        v.clamp(0.0, 100.0)
    }
}

// ── CPU ─────────────────────────────────────────────────────────────────────

/// Sample /proc/stat twice `CPU_SAMPLE` apart and return the busy percentage
/// over that window — a point-in-time reading, no persistent state needed.
fn sample_cpu_pct() -> Option<f64> {
    let first = cpu_snapshot(&std::fs::read_to_string("/proc/stat").ok()?)?;
    std::thread::sleep(CPU_SAMPLE);
    let second = cpu_snapshot(&std::fs::read_to_string("/proc/stat").ok()?)?;
    cpu_pct_from(first, second)
}

/// (busy, total) jiffies from the aggregate `cpu` line of /proc/stat. Busy is
/// everything except idle + iowait.
fn cpu_snapshot(stat: &str) -> Option<(u64, u64)> {
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let vals: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|t| t.parse::<u64>().ok())
        .collect();
    // user, nice, system, idle, iowait, irq, softirq, steal, …
    if vals.len() < 4 {
        return None;
    }
    let total: u64 = vals.iter().sum();
    let idle = vals[3] + vals.get(4).copied().unwrap_or(0); // idle + iowait
    Some((total.saturating_sub(idle), total))
}

/// Busy percentage between two snapshots. None when the counters didn't
/// advance (total delta 0) — nothing to average over.
fn cpu_pct_from(prev: (u64, u64), cur: (u64, u64)) -> Option<f64> {
    let busy = cur.0.saturating_sub(prev.0) as f64;
    let total = cur.1.saturating_sub(prev.1) as f64;
    if total <= 0.0 {
        return None;
    }
    Some(busy / total * 100.0)
}

// ── memory ──────────────────────────────────────────────────────────────────

/// Memory figures in bytes, mirroring the local WebUI's Memory card: total is
/// MemTotal, used is MemTotal - MemAvailable (so free = MemAvailable). The
/// `mem_pct` gauge is derived from these, keeping the two in lockstep.
#[derive(Clone, Copy)]
struct MemStats {
    used_bytes: u64,
    total_bytes: u64,
}

impl MemStats {
    /// used / total * 100 — the `mem_pct` gauge. 0 when total is unknown.
    fn pct(&self) -> f64 {
        if self.total_bytes == 0 {
            0.0
        } else {
            self.used_bytes as f64 / self.total_bytes as f64 * 100.0
        }
    }
}

fn read_mem() -> Option<MemStats> {
    mem_from(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

/// MemTotal and MemTotal - MemAvailable from /proc/meminfo (values in kB → bytes).
fn mem_from(meminfo: &str) -> Option<MemStats> {
    let field = |name: &str| -> Option<u64> {
        meminfo.lines().find_map(|l| {
            let rest = l.strip_prefix(name)?.strip_prefix(':')?;
            rest.split_whitespace().next()?.parse::<u64>().ok()
        })
    };
    let total = field("MemTotal")?;
    let available = field("MemAvailable")?;
    if total == 0 {
        return None;
    }
    Some(MemStats {
        used_bytes: total.saturating_sub(available) * 1024,
        total_bytes: total * 1024,
    })
}

// ── uptime ──────────────────────────────────────────────────────────────────

fn read_uptime_secs() -> Option<i64> {
    uptime_from(&std::fs::read_to_string("/proc/uptime").ok()?)
}

/// The integer seconds from the first field of /proc/uptime ("12345.67 …").
fn uptime_from(text: &str) -> Option<i64> {
    text.split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .map(|s| s as i64)
}

// ── disk ────────────────────────────────────────────────────────────────────

/// Root-filesystem figures, matching the local WebUI's Disk card (`df`
/// semantics): total is the whole filesystem, used is total - free (reserved
/// blocks included), and `pct` is `df`'s Use% — used / (used + available),
/// where available excludes root-reserved blocks. Because reserved space is in
/// `used` but not the pct denominator, `used_bytes / total_bytes` need not
/// equal `pct`.
#[derive(Clone, Copy)]
struct DiskStats {
    used_bytes: u64,
    total_bytes: u64,
    pct: f64,
}

#[cfg(target_os = "linux")]
fn read_disk(path: &str) -> Option<DiskStats> {
    let c = std::ffi::CString::new(path).ok()?;
    // SAFETY: statvfs fills a zeroed struct and we only read it on rc == 0.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    disk_from(s.f_frsize as u64, s.f_blocks as u64, s.f_bfree as u64, s.f_bavail as u64)
}

#[cfg(not(target_os = "linux"))]
fn read_disk(_path: &str) -> Option<DiskStats> {
    None // statvfs is Linux-only; the daemon runs on VyOS.
}

/// Pure half of `read_disk`: fold the statvfs block counts into byte totals and
/// `df`'s Use%. `frsize` is the fundamental block size (df's unit). None when
/// there's nothing to divide by (no used-or-available blocks).
fn disk_from(frsize: u64, blocks: u64, bfree: u64, bavail: u64) -> Option<DiskStats> {
    let used_blocks = blocks.saturating_sub(bfree);
    let denom = used_blocks + bavail; // df's Use% denominator (excludes reserved)
    if denom == 0 {
        return None;
    }
    Some(DiskStats {
        used_bytes: used_blocks * frsize,
        total_bytes: blocks * frsize,
        pct: used_blocks as f64 / denom as f64 * 100.0,
    })
}

// ── public IP ─────────────────────────────────────────────────────────────────

/// The source address the kernel would use to reach the public internet — the
/// WAN interface's own address as the device sees itself. `connect` on a UDP
/// socket only does the route lookup and binds a source; it sends nothing.
/// None when there is no default route (or only a loopback source).
fn outbound_ip() -> Option<String> {
    // IPv4 default route first (the common WAN), then IPv6.
    outbound_ip_via("1.1.1.1:80").or_else(|| outbound_ip_via("[2606:4700:4700::1111]:80"))
}

fn outbound_ip_via(dest: &str) -> Option<String> {
    let bind = if dest.starts_with('[') { "[::]:0" } else { "0.0.0.0:0" };
    let sock = std::net::UdpSocket::bind(bind).ok()?;
    sock.connect(dest).ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(ip.to_string())
}

// ── firewall rule counters ────────────────────────────────────────────────────

/// The busiest firewall rules by bytes. Reads the nftables ruleset as JSON and
/// tallies the per-rule counters in VyOS's `vyos_filter` table. Empty when nft
/// is unavailable, the table has no counted rules, or parsing fails.
///
/// Each rule is named as the operator sees it on the Rules page — its
/// configured description (or `[dn:…]` display name), read from the running
/// VyOS config — with the raw chain+rule label as the fallback.
fn top_policies() -> Vec<PolicyStat> {
    // nft reaches the kernel netfilter subsystem over a netlink socket, so the
    // qfagent unit must allow AF_NETLINK in RestrictAddressFamilies (that
    // seccomp filter is inherited by this child) — otherwise nft's socket() is
    // blocked, it exits non-zero, and every snapshot reports no policies.
    let output = std::process::Command::new("nft")
        .args(["-j", "list", "ruleset"])
        .output();
    let stdout = match output {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    match serde_json::from_slice::<Value>(&stdout) {
        Ok(v) => parse_policies(&v, &CliShellApi::active()),
        Err(_) => Vec::new(),
    }
}

/// Pure half of `top_policies`: from an `nft -j list ruleset` document, pull
/// every counted rule in the firewall table, sort by bytes desc, cap at
/// `MAX_POLICIES`, then name each survivor from `conf`. The config lookup runs
/// only for the capped survivors — never every counted rule — so a box with a
/// large ruleset doesn't fan out to `cli-shell-api`.
fn parse_policies(doc: &Value, conf: &dyn ConfigRead) -> Vec<PolicyStat> {
    let Some(items) = doc.get("nftables").and_then(Value::as_array) else {
        return Vec::new();
    };
    // (rule node, bytes, packets) for every counted firewall rule; names are
    // resolved after the cap so config reads stay bounded by MAX_POLICIES.
    let mut counted: Vec<(&Value, u64, u64)> = Vec::new();
    for item in items {
        let Some(rule) = item.get("rule") else { continue };
        // Firewall rules only — VyOS's filter table. NAT (`vyos_nat`), App
        // Control (`qfappd`), geo (`qz_geo`), etc. are not UI "policies".
        if rule.get("table").and_then(Value::as_str) != Some("vyos_filter") {
            continue;
        }
        let Some(counter) = rule_counter(rule) else { continue };
        let bytes = counter.get("bytes").and_then(Value::as_u64).unwrap_or(0);
        let packets = counter.get("packets").and_then(Value::as_u64).unwrap_or(0);
        counted.push((rule, bytes, packets));
    }
    counted.sort_by_key(|c| std::cmp::Reverse(c.1));
    counted.truncate(MAX_POLICIES);
    counted
        .into_iter()
        .map(|(rule, bytes, packets)| PolicyStat {
            name: policy_name(rule, conf),
            bytes,
            hits: packets,
        })
        .collect()
}

/// The inline `counter` statement of a rule, if it has one.
fn rule_counter(rule: &Value) -> Option<&Value> {
    rule.get("expr")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|e| e.get("counter"))
}

/// A human-readable name for a rule, matching what the Rules page shows. When
/// the rule maps to an operator-configured firewall rule, its VyOS description
/// (or `[dn:…]` display name) wins — that's the friendly "Block QUIC" the
/// console wants. Otherwise it's an internal rule with no configured name
/// (state policy, a raw-table default action, a hidden `[qz-sys]` baseline
/// rule): we render the VyOS `comment` — of the form `<family>-<HOOK>-<chain>-
/// <rule>`, the same identity as the firewall-log prefix — readably
/// (`ipv4-FWD-filter-10` → "Forward rule 10"), falling back to the raw comment
/// or the nftables chain + handle.
fn policy_name(rule: &Value, conf: &dyn ConfigRead) -> String {
    if let Some(c) = rule.get("comment").and_then(Value::as_str) {
        if !c.is_empty() {
            if let Some(name) = configured_rule_name(c, conf) {
                return name;
            }
            return pretty_comment(c);
        }
    }
    let chain = rule.get("chain").and_then(Value::as_str).unwrap_or("rule");
    match rule.get("handle").and_then(Value::as_u64) {
        Some(h) => format!("{} #{h}", pretty_chain(chain)),
        None => pretty_chain(chain),
    }
}

/// The operator-configured name of the rule a VyOS `comment` identifies, or
/// None when there is none — the comment isn't a numbered user rule, the rule
/// carries no `description`, or the description marks a hidden `[qz-sys]`
/// baseline rule. A description opening with a `[dn:<name>]` marker yields the
/// marker text (the display name, which may contain spaces); otherwise the
/// description itself is the name.
fn configured_rule_name(comment: &str, conf: &dyn ConfigRead) -> Option<String> {
    let mut path = rule_config_path(comment)?;
    path.push("description".to_string());
    let refs: Vec<&str> = path.iter().map(String::as_str).collect();
    friendly_from_description(&conf.return_value(&refs)?)
}

/// The VyOS config path of the rule a `comment` names, up to the `rule <N>`
/// node: `firewall <family> <chain> filter rule <N>` for a base chain,
/// `firewall <family> name <ruleset> rule <N>` for a zone ruleset. None unless
/// the comment is a numbered user rule — a `default`-action rule or an
/// unrecognized comment has no configured name.
fn rule_config_path(comment: &str) -> Option<Vec<String>> {
    let parts: Vec<&str> = comment.split('-').collect();
    if parts.len() < 4 {
        return None;
    }
    let family = match parts[0] {
        "ipv4" | "ipv6" => parts[0],
        _ => return None,
    };
    // A user rule is numbered; `default` (the chain's default-action) is not.
    let rule = parts[parts.len() - 1];
    if rule.parse::<u32>().is_err() {
        return None;
    }
    let base_chain = |chain: &str| {
        vec![
            "firewall".to_string(),
            family.to_string(),
            chain.to_string(),
            "filter".to_string(),
            "rule".to_string(),
            rule.to_string(),
        ]
    };
    match parts[1] {
        "FWD" => Some(base_chain("forward")),
        "INP" => Some(base_chain("input")),
        "OUT" => Some(base_chain("output")),
        // `ipv4-NAM-<ruleset>-<rule>`; the ruleset may itself contain dashes.
        "NAM" => Some(vec![
            "firewall".to_string(),
            family.to_string(),
            "name".to_string(),
            parts[2..parts.len() - 1].join("-"),
            "rule".to_string(),
            rule.to_string(),
        ]),
        _ => None,
    }
}

/// Resolve a rule's `description` leaf to the user-facing name, or None to keep
/// the raw label. A `[qz-sys] …` description is a hidden baseline rule (no user
/// name); a `[dn:<name>] …` marker's text is the name; anything else is itself.
fn friendly_from_description(desc: &str) -> Option<String> {
    if desc.is_empty() || desc.starts_with("[qz-sys]") {
        return None;
    }
    if let Some(rest) = desc.strip_prefix("[dn:") {
        if let Some(end) = rest.find(']') {
            let inner = &rest[..end];
            if !inner.is_empty() {
                return Some(inner.to_string());
            }
        }
    }
    Some(desc.to_string())
}

/// Render a VyOS rule comment (`ipv4-FWD-filter-10`, `ipv4-NAM-QZ-Z-LAN-TO-WAN-10`)
/// as "Forward rule 10" / "QZ-Z-LAN-TO-WAN rule 10". Unrecognized comments pass
/// through verbatim.
fn pretty_comment(comment: &str) -> String {
    let parts: Vec<&str> = comment.split('-').collect();
    if parts.len() >= 4 && matches!(parts[0], "ipv4" | "ipv6") {
        let rule = parts[parts.len() - 1];
        let ruleset = parts[2..parts.len() - 1].join("-");
        let scope = match parts[1] {
            "FWD" => "Forward".to_string(),
            "INP" => "Input".to_string(),
            "OUT" => "Output".to_string(),
            "NAM" => ruleset,
            _ => return comment.to_string(),
        };
        return if rule == "default" {
            format!("{scope} default")
        } else {
            format!("{scope} rule {rule}")
        };
    }
    comment.to_string()
}

/// Readable form of an nftables chain name for the no-comment fallback.
fn pretty_chain(chain: &str) -> String {
    match chain {
        "VYOS_FORWARD_filter" => "Forward".to_string(),
        "VYOS_INPUT_filter" => "Input".to_string(),
        "VYOS_OUTPUT_filter" => "Output".to_string(),
        other => other
            .strip_prefix("NAME_")
            .or_else(|| other.strip_prefix("NAME6_"))
            .unwrap_or(other)
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vyoscfg::testutil::FakeConfig;

    #[test]
    fn cpu_percentage_from_two_snapshots() {
        // total advances 100, busy advances 25 → 25%.
        let a = (100, 400);
        let b = (125, 500);
        assert_eq!(cpu_pct_from(a, b), Some(25.0));
        // No advance → None (nothing to average).
        assert_eq!(cpu_pct_from(b, b), None);
    }

    #[test]
    fn cpu_snapshot_parses_aggregate_line() {
        let stat = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\nintr 999\n";
        // total = 1000, idle+iowait = 800+50 = 850, busy = 150.
        assert_eq!(cpu_snapshot(stat), Some((150, 1000)));
        assert_eq!(cpu_snapshot("garbage\n"), None);
    }

    #[test]
    fn mem_bytes_and_pct_from_meminfo() {
        let meminfo = "MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    250 kB\nBuffers:  0 kB\n";
        let mem = mem_from(meminfo).expect("parses");
        // kB → bytes; used = (1000 - 250) kB = 750 kB.
        assert_eq!(mem.total_bytes, 1000 * 1024);
        assert_eq!(mem.used_bytes, 750 * 1024);
        // The gauge is derived from the same bytes: 750/1000 = 75%.
        assert_eq!(mem.pct(), 75.0);
        assert!(mem_from("MemTotal: 0 kB\nMemAvailable: 0 kB\n").is_none());
        assert!(mem_from("nope\n").is_none());
    }

    #[test]
    fn disk_bytes_and_pct_from_statvfs_blocks() {
        // 4 KiB blocks: 100 total, 40 free, 30 available (10 blocks reserved).
        let d = disk_from(4096, 100, 40, 30).expect("computes");
        // total = 100 blocks, used = 60 blocks.
        assert_eq!(d.total_bytes, 100 * 4096);
        assert_eq!(d.used_bytes, 60 * 4096);
        // df Use% = used / (used + avail) = 60 / 90 → 66.66…%, not used/total.
        assert!((d.pct - 66.666_666).abs() < 1e-4);
        // Empty filesystem (no used or available blocks) → None.
        assert!(disk_from(4096, 0, 0, 0).is_none());
    }

    #[test]
    fn uptime_takes_the_first_field_as_seconds() {
        assert_eq!(uptime_from("12345.67 98765.43\n"), Some(12345));
        assert_eq!(uptime_from("0.00 0.00"), Some(0));
        assert_eq!(uptime_from(""), None);
    }

    #[test]
    fn clamp_keeps_gauges_in_range() {
        assert_eq!(clamp_pct(-5.0), 0.0);
        assert_eq!(clamp_pct(150.0), 100.0);
        assert_eq!(clamp_pct(42.5), 42.5);
        assert_eq!(clamp_pct(f64::NAN), 0.0);
    }

    #[test]
    fn comment_renders_readably() {
        assert_eq!(pretty_comment("ipv4-FWD-filter-10"), "Forward rule 10");
        assert_eq!(pretty_comment("ipv4-INP-filter-default"), "Input default");
        assert_eq!(pretty_comment("ipv6-OUT-filter-5"), "Output rule 5");
        assert_eq!(
            pretty_comment("ipv4-NAM-QZ-Z-LAN-TO-WAN-10"),
            "QZ-Z-LAN-TO-WAN rule 10"
        );
        // Unrecognized → verbatim.
        assert_eq!(pretty_comment("my custom label"), "my custom label");
    }

    #[test]
    fn parse_policies_ranks_firewall_rules_by_bytes_and_caps() {
        // Two firewall rules (one with a comment, one without) plus a NAT rule
        // that must be ignored, and a firewall rule with no counter.
        let doc = serde_json::json!({
            "nftables": [
                { "metainfo": { "version": "1.0.6" } },
                { "rule": {
                    "family": "ip", "table": "vyos_filter", "chain": "VYOS_FORWARD_filter",
                    "handle": 5, "comment": "ipv4-FWD-filter-10",
                    "expr": [ { "match": {} }, { "counter": { "packets": 3, "bytes": 100 } }, { "accept": null } ]
                }},
                { "rule": {
                    "family": "ip", "table": "vyos_filter", "chain": "NAME_QZ-Z-LAN-TO-WAN",
                    "handle": 9,
                    "expr": [ { "counter": { "packets": 7, "bytes": 9000 } }, { "drop": null } ]
                }},
                { "rule": {
                    "family": "ip", "table": "vyos_nat", "chain": "POSTROUTING",
                    "handle": 1,
                    "expr": [ { "counter": { "packets": 999, "bytes": 999999 } } ]
                }},
                { "rule": {
                    "family": "ip", "table": "vyos_filter", "chain": "VYOS_INPUT_filter",
                    "handle": 2,
                    "expr": [ { "accept": null } ]
                }},
            ]
        });
        // Empty config → no configured names, so every rule keeps its raw label.
        let policies = parse_policies(&doc, &FakeConfig::default());
        assert_eq!(policies.len(), 2, "NAT rule and counterless rule excluded");
        // Highest bytes first.
        assert_eq!(policies[0].bytes, 9000);
        assert_eq!(policies[0].hits, 7);
        assert_eq!(policies[0].name, "QZ-Z-LAN-TO-WAN #9"); // no comment → chain + handle
        assert_eq!(policies[1].bytes, 100);
        assert_eq!(policies[1].name, "Forward rule 10");
    }

    #[test]
    fn parse_policies_tolerates_missing_or_empty() {
        let conf = FakeConfig::default();
        assert!(parse_policies(&serde_json::json!({}), &conf).is_empty());
        assert!(parse_policies(&serde_json::json!({ "nftables": [] }), &conf).is_empty());
    }

    /// Pins the parser to the real on-device shape: a verbatim fragment of
    /// `nft -j list chain ip vyos_filter VYOS_FORWARD_filter` captured from a
    /// live firewall (QS-HQ-FW1, nftables 1.0.9). Confirms `vyos_filter` rules
    /// carry an inline `{"counter": {...}}`, are named from the `ipv4-FWD-…`
    /// comment, and that a bare chain-dispatch rule (a `jump` with no counter)
    /// is dropped. The empty-list bug was the sandbox blocking nft's netlink
    /// socket, not this parse — this guards the shape the fix relies on.
    #[test]
    fn parse_policies_reads_real_vyos_forward_chain() {
        let doc = serde_json::json!({
            "nftables": [
                { "metainfo": { "version": "1.0.9", "release_name": "Old Doc Yak #3", "json_schema_version": 1 } },
                { "chain": {
                    "family": "ip", "table": "vyos_filter", "name": "VYOS_FORWARD_filter",
                    "handle": 1, "type": "filter", "hook": "forward", "prio": 0, "policy": "accept"
                }},
                // Chain-dispatch jump: no counter → excluded.
                { "rule": {
                    "family": "ip", "table": "vyos_filter", "chain": "VYOS_FORWARD_filter", "handle": 13,
                    "expr": [ { "jump": { "target": "VYOS_STATE_POLICY_FORWARD" } } ]
                }},
                // IPS baseline (ct mark 81 → queue), counted.
                { "rule": {
                    "family": "ip", "table": "vyos_filter", "chain": "VYOS_FORWARD_filter", "handle": 14,
                    "comment": "ipv4-FWD-filter-1",
                    "expr": [
                        { "match": { "op": "==", "left": { "ct": { "key": "mark" } }, "right": 81 } },
                        { "counter": { "packets": 934, "bytes": 106594 } },
                        { "queue": { "num": 0, "flags": "bypass" } }
                    ]
                }},
                // A logged drop rule — the log node precedes the counter in expr.
                { "rule": {
                    "family": "ip", "table": "vyos_filter", "chain": "VYOS_FORWARD_filter", "handle": 17,
                    "comment": "ipv4-FWD-filter-10",
                    "expr": [
                        { "match": { "op": "==", "left": { "payload": { "protocol": "udp", "field": "dport" } }, "right": "@P_QUIC" } },
                        { "match": { "op": "==", "left": { "meta": { "key": "oifname" } }, "right": "eth1" } },
                        { "log": { "prefix": "[ipv4-FWD-filter-10-D]" } },
                        { "counter": { "packets": 415, "bytes": 476704 } },
                        { "drop": null }
                    ]
                }},
                // The chain's default-action rule: counted, unconventional comment.
                { "rule": {
                    "family": "ip", "table": "vyos_filter", "chain": "VYOS_FORWARD_filter", "handle": 24,
                    "comment": "FWD-filter default-action drop",
                    "expr": [
                        { "counter": { "packets": 0, "bytes": 0 } },
                        { "log": { "prefix": "[ipv4-FWD-filter-default-D]" } },
                        { "drop": null }
                    ]
                }},
            ]
        });
        // Empty config → configured names unavailable, so the raw comment labels
        // (below) stand in — the same shape as before name resolution existed.
        let policies = parse_policies(&doc, &FakeConfig::default());
        // The metainfo, chain object, and the counterless jump rule are all skipped.
        assert_eq!(policies.len(), 3, "three counted vyos_filter rules");
        // Ranked by bytes: rule 10 (476704) > rule 1 (106594) > default (0).
        assert_eq!(policies[0].bytes, 476704);
        assert_eq!(policies[0].hits, 415);
        assert_eq!(policies[0].name, "Forward rule 10");
        assert_eq!(policies[1].bytes, 106594);
        assert_eq!(policies[1].hits, 934);
        assert_eq!(policies[1].name, "Forward rule 1");
        // Unconventional comment (no ipv4/ipv6 prefix) passes through verbatim.
        assert_eq!(policies[2].bytes, 0);
        assert_eq!(policies[2].name, "FWD-filter default-action drop");
    }

    #[test]
    fn friendly_from_description_reads_markers() {
        // Plain description is the name.
        assert_eq!(friendly_from_description("Block QUIC").as_deref(), Some("Block QUIC"));
        // `[dn:…]` marker → its text (spaces allowed), trailing note dropped.
        assert_eq!(
            friendly_from_description("[dn:Block QUIC] drop quic egress").as_deref(),
            Some("Block QUIC")
        );
        // Hidden baseline rule → no user name.
        assert_eq!(friendly_from_description("[qz-sys] allow established/related replies"), None);
        // Empty leaf → none.
        assert_eq!(friendly_from_description(""), None);
        // Malformed marker (never closed) is used verbatim, not swallowed.
        assert_eq!(friendly_from_description("[dn:oops").as_deref(), Some("[dn:oops"));
        // Empty marker body falls through to the whole string.
        assert_eq!(friendly_from_description("[dn:]").as_deref(), Some("[dn:]"));
    }

    #[test]
    fn rule_config_path_maps_comment_to_config_node() {
        assert_eq!(
            rule_config_path("ipv4-FWD-filter-10"),
            Some(vec![
                "firewall".into(),
                "ipv4".into(),
                "forward".into(),
                "filter".into(),
                "rule".into(),
                "10".into(),
            ])
        );
        assert_eq!(
            rule_config_path("ipv6-INP-filter-5"),
            Some(vec![
                "firewall".into(),
                "ipv6".into(),
                "input".into(),
                "filter".into(),
                "rule".into(),
                "5".into(),
            ])
        );
        // Named ruleset (zone pair); ruleset name keeps its own dashes.
        assert_eq!(
            rule_config_path("ipv4-NAM-QZ-Z-LAN-TO-WAN-20"),
            Some(vec![
                "firewall".into(),
                "ipv4".into(),
                "name".into(),
                "QZ-Z-LAN-TO-WAN".into(),
                "rule".into(),
                "20".into(),
            ])
        );
        // Default-action rules and unrecognized comments are not user rules.
        assert_eq!(rule_config_path("ipv4-FWD-filter-default"), None);
        assert_eq!(rule_config_path("FWD-filter default-action drop"), None);
        assert_eq!(rule_config_path("ipv4-XYZ-filter-3"), None);
    }

    #[test]
    fn configured_rule_name_prefers_description_and_dn_marker() {
        let mut cfg = FakeConfig::default();
        cfg.set(
            "firewall ipv4 forward filter rule 10 description",
            "[dn:Block QUIC] drop quic egress",
        );
        cfg.set(
            "firewall ipv4 forward filter rule 1 description",
            "[qz-sys] IPS: inspect flows selected by IPS rules",
        );
        cfg.set("firewall ipv4 name QZ-Z-LAN-TO-WAN rule 20 description", "Allow web");

        // `[dn:…]` display name.
        assert_eq!(configured_rule_name("ipv4-FWD-filter-10", &cfg).as_deref(), Some("Block QUIC"));
        // Named ruleset, plain description.
        assert_eq!(
            configured_rule_name("ipv4-NAM-QZ-Z-LAN-TO-WAN-20", &cfg).as_deref(),
            Some("Allow web")
        );
        // Hidden baseline rule keeps its raw label (no configured name).
        assert_eq!(configured_rule_name("ipv4-FWD-filter-1", &cfg), None);
        // No description leaf set → fall back to the raw label.
        assert_eq!(configured_rule_name("ipv4-INP-filter-3", &cfg), None);
        // Not a numbered user rule → no lookup.
        assert_eq!(configured_rule_name("ipv4-FWD-filter-default", &cfg), None);
    }

    #[test]
    fn parse_policies_names_rules_from_config() {
        let doc = serde_json::json!({
            "nftables": [
                { "rule": {
                    "family": "ip", "table": "vyos_filter", "chain": "VYOS_FORWARD_filter",
                    "handle": 5, "comment": "ipv4-FWD-filter-10",
                    "expr": [ { "counter": { "packets": 3, "bytes": 5000 } }, { "drop": null } ]
                }},
                // A hidden baseline rule: has a comment, but its description is
                // `[qz-sys]` → the raw label stands, never the description.
                { "rule": {
                    "family": "ip", "table": "vyos_filter", "chain": "VYOS_FORWARD_filter",
                    "handle": 6, "comment": "ipv4-FWD-filter-1",
                    "expr": [ { "counter": { "packets": 9, "bytes": 100 } }, { "queue": {} } ]
                }},
            ]
        });
        let mut cfg = FakeConfig::default();
        cfg.set("firewall ipv4 forward filter rule 10 description", "[dn:Block QUIC]");
        cfg.set(
            "firewall ipv4 forward filter rule 1 description",
            "[qz-sys] IPS: inspect flows selected by IPS rules",
        );
        let policies = parse_policies(&doc, &cfg);
        assert_eq!(policies.len(), 2);
        // Configured display name replaces the raw "Forward rule 10".
        assert_eq!(policies[0].name, "Block QUIC");
        assert_eq!(policies[0].bytes, 5000);
        // The baseline rule keeps its raw label.
        assert_eq!(policies[1].name, "Forward rule 1");
    }

    /// Compile-time guard for the wrapping `control.rs` uses to put a snapshot
    /// on the ControlStream — mirrors telemetry's guard (control.rs is
    /// Linux-only, so the host build would otherwise not catch a drift).
    #[test]
    fn snapshot_wraps_into_a_device_message() {
        use crate::proto::device::{device_message, DeviceMessage};
        let snapshot = DeviceStats {
            time_unix: 1,
            interval_secs: INTERVAL.as_secs() as u32,
            ..Default::default()
        };
        let msg = DeviceMessage {
            msg: Some(device_message::Msg::DeviceStats(snapshot)),
        };
        assert!(matches!(msg.msg, Some(device_message::Msg::DeviceStats(_))));
    }
}
