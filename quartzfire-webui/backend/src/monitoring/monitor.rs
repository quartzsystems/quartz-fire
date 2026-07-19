//! Live firewall-log streaming for the Traffic Monitor page.
//!
//! A VyOS filter rule with `log` set makes nftables emit a kernel-log line
//! whose prefix encodes exactly which rule fired, e.g.
//!
//! ```text
//! [ipv4-FWD-filter-10-A]IN=eth1 OUT=eth0 SRC=10.0.0.5 DST=1.1.1.1 LEN=60
//!     TOS=0x00 TTL=63 DF PROTO=TCP SPT=51000 DPT=443 SYN URGP=0
//! ```
//!
//! (`default-log` hits use `default` in place of the rule number.) Zone rules
//! live in a named ruleset rather than a base chain, and log as
//!
//! ```text
//! [ipv4-NAM-QZ-Z-LAN-TO-WAN-10-A]IN=eth1 OUT=eth0 SRC=…
//! ```
//!
//! This module follows the kernel journal with `journalctl -k -f -o json`,
//! parses those lines, and pushes them to the browser as Server-Sent Events.
//! The service user must be able to read the journal — the systemd unit grants
//! this via `SupplementaryGroups=systemd-journal`.

use axum::{
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use serde::Serialize;
use std::{convert::Infallible, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};
use tokio_stream::{wrappers::LinesStream, StreamExt};

/// One parsed firewall log line — the JSON payload of each SSE event. Fields
/// are pub(crate) so flows.rs can reuse the same parse for its rule-attribution
/// cache (tuple → rule) without a second nftables-prefix parser drifting.
#[derive(Serialize, Default)]
pub struct LogEntry {
    /// Journal receive time, milliseconds since the epoch.
    pub(crate) ts: u64,
    /// `ipv4` or `ipv6`.
    pub(crate) family: String,
    /// Base chain the rule lives in: `forward`, `input`, or `output`.
    pub(crate) chain: String,
    /// Rule number; null when the chain's default action fired.
    pub(crate) rule: Option<u32>,
    /// `accept`, `drop`, or `reject`.
    pub(crate) action: String,
    /// True when the rule queues matches to the IPS engine (`action queue`)
    /// — modeled as Allow with IPS on; Suricata gives the final verdict.
    pub(crate) ips: bool,
    #[serde(rename = "in", skip_serializing_if = "Option::is_none")]
    pub(crate) in_if: Option<String>,
    #[serde(rename = "out", skip_serializing_if = "Option::is_none")]
    pub(crate) out_if: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) dst: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) proto: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) spt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) dpt: Option<u32>,
    /// IP total length of the logged packet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) len: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) icmp_type: Option<u32>,
}

/// GET /api/monitor/firewall-log — SSE stream of parsed firewall log entries,
/// starting with a backfill of whatever is still in the kernel journal.
pub async fn firewall_log() -> Response {
    let mut child = match Command::new("journalctl")
        .args(["-k", "-f", "-n", "1000", "-o", "json", "--no-pager"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
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

    // The closure owns the child, so the stream keeps journalctl alive; when
    // the browser disconnects the stream is dropped and kill_on_drop reaps it.
    let stream = LinesStream::new(BufReader::new(stdout).lines()).filter_map(move |line| {
        let _keep_child_alive = &child;
        let entry = parse_journal_line(&line.ok()?)?;
        let json = serde_json::to_string(&entry).ok()?;
        Some(Ok::<Event, Infallible>(Event::default().data(json)))
    });
    // Immediate hello: EventSource only fires `open` once bytes arrive, and on
    // a quiet journal the first real bytes would be a keep-alive ping seconds
    // away.
    let stream = tokio_stream::once(Ok(Event::default().comment("connected"))).chain(stream);

    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// Parse one `journalctl -o json` line into a firewall log entry; None for
/// anything that isn't a base-chain firewall log message.
pub(crate) fn parse_journal_line(line: &str) -> Option<LogEntry> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    // Non-UTF8 messages come through as byte arrays — as_str skips those.
    let msg = v.get("MESSAGE")?.as_str()?;
    parse_message(msg, journal_ts(&v))
}

/// Journal receive time, milliseconds since the epoch (0 when absent).
fn journal_ts(v: &serde_json::Value) -> u64 {
    v.get("__REALTIME_TIMESTAMP")
        .and_then(|t| t.as_str())
        .and_then(|t| t.parse::<u64>().ok())
        .map(|us| us / 1000)
        .unwrap_or(0)
}

/// One system journal entry for the System → Audit Log page.
#[derive(Serialize)]
pub struct SystemLogEntry {
    /// Journal receive time, milliseconds since the epoch.
    ts: u64,
    /// Syslog identifier (or systemd unit) that emitted the line.
    unit: String,
    /// Syslog priority 0–7, lower = more severe.
    priority: u8,
    message: String,
}

/// GET /api/monitor/system-log — the recent system journal as JSON, newest
/// first. Firewall traffic lines are excluded (they belong to the Traffic
/// Monitor); everything else — commits, daemons, kernel, auth — is the
/// firewall OS's own story.
pub async fn system_log() -> Response {
    let output = match Command::new("journalctl")
        .args(["-n", "2000", "-o", "json", "--no-pager"])
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            tracing::error!("cannot start journalctl: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot read the system journal on this device",
            )
                .into_response();
        }
    };

    let mut entries: Vec<SystemLogEntry> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_system_line)
        .collect();
    entries.reverse(); // journalctl emits oldest-first
    Json(entries).into_response()
}

/// Parse one `journalctl -o json` line into a system log entry; None for
/// firewall traffic lines and non-text messages.
fn parse_system_line(line: &str) -> Option<SystemLogEntry> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let msg = v.get("MESSAGE")?.as_str()?;
    let trimmed = msg.trim_start();
    if trimmed.is_empty() || trimmed.starts_with("[ipv4-") || trimmed.starts_with("[ipv6-") {
        return None;
    }
    let unit = v
        .get("SYSLOG_IDENTIFIER")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("_SYSTEMD_UNIT").and_then(|x| x.as_str()))
        .unwrap_or("kernel")
        .to_string();
    let priority = v
        .get("PRIORITY")
        .and_then(|x| x.as_str())
        .and_then(|p| p.parse().ok())
        .unwrap_or(6);
    Some(SystemLogEntry { ts: journal_ts(&v), unit, priority, message: msg.to_string() })
}

/// Parse the nftables log text: `[family-HOOK-chain-rule-ACTION]KEY=VAL …`.
fn parse_message(msg: &str, ts: u64) -> Option<LogEntry> {
    let rest = msg.trim_start().strip_prefix('[')?;
    let (prefix, fields) = rest.split_once(']')?;

    // The chain name itself may contain '-', so peel the fixed pieces off both
    // ends: family and hook in front, rule number and action letter at the back.
    let parts: Vec<&str> = prefix.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    let family = parts[0];
    if family != "ipv4" && family != "ipv6" {
        return None;
    }
    // The base chains the GUI models, plus the named rulesets holding zone
    // rules. `NAM` lines carry the ruleset name in the middle segment, which is
    // exactly the `name:<ruleset>` scope the frontend keys rules by — a zone
    // pair's ruleset (QZ-Z-LAN-TO-WAN) contains '-', hence the rejoin. Other
    // named/NAT chains are not ours, but they're indistinguishable here, so
    // they surface as scopes the frontend simply won't match to a rule.
    let chain = match parts[1] {
        "FWD" => "forward".to_string(),
        "INP" => "input".to_string(),
        "OUT" => "output".to_string(),
        "NAM" => format!("name:{}", parts[2..parts.len() - 2].join("-")),
        _ => return None,
    };
    // The letter is the first character of the rule's action. Rules with IPS
    // enabled are stored as `action queue` and log with `Q`.
    let (action, ips) = match *parts.last()? {
        "A" => ("accept", false),
        "Q" => ("accept", true),
        "D" => ("drop", false),
        "R" => ("reject", false),
        _ => return None,
    };
    let rule_part = parts[parts.len() - 2];
    let rule = if rule_part == "default" { None } else { Some(rule_part.parse::<u32>().ok()?) };

    let mut e = LogEntry {
        ts,
        family: family.to_string(),
        chain,
        rule,
        action: action.to_string(),
        ips,
        ..LogEntry::default()
    };
    for tok in fields.split_whitespace() {
        let Some((k, val)) = tok.split_once('=') else { continue };
        if val.is_empty() {
            continue;
        }
        match k {
            "IN" => e.in_if = Some(val.to_string()),
            "OUT" => e.out_if = Some(val.to_string()),
            "SRC" => e.src = Some(val.to_string()),
            "DST" => e.dst = Some(val.to_string()),
            "PROTO" => e.proto = Some(val.to_ascii_lowercase()),
            "SPT" => e.spt = val.parse().ok(),
            "DPT" => e.dpt = val.parse().ok(),
            // LEN appears again for the L4 payload — keep the first (IP total).
            "LEN" if e.len.is_none() => e.len = val.parse().ok(),
            "TYPE" => e.icmp_type = val.parse().ok(),
            _ => {}
        }
    }
    Some(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_forward_accept() {
        let e = parse_message(
            "[ipv4-FWD-filter-10-A]IN=eth1 OUT=eth0 MAC=00:11:22:33:44:55:66:77:88:99:aa:bb:08:00 \
             SRC=10.0.0.5 DST=1.1.1.1 LEN=60 TOS=0x00 PREC=0x00 TTL=63 ID=12345 DF PROTO=TCP \
             SPT=51000 DPT=443 WINDOW=64240 RES=0x00 SYN URGP=0",
            1,
        )
        .expect("should parse");
        assert_eq!(e.chain, "forward");
        assert_eq!(e.rule, Some(10));
        assert_eq!(e.action, "accept");
        assert!(!e.ips);
        assert_eq!(e.src.as_deref(), Some("10.0.0.5"));
        assert_eq!(e.dpt, Some(443));
        assert_eq!(e.proto.as_deref(), Some("tcp"));
        assert_eq!(e.len, Some(60));
    }

    #[test]
    fn parses_ips_queue_as_accept() {
        let e = parse_message(
            "[ipv4-FWD-filter-10-Q]IN=eth1 OUT=eth6 SRC=10.0.0.5 DST=1.1.1.1 LEN=60 \
             PROTO=TCP SPT=51000 DPT=443 SYN URGP=0",
            1,
        )
        .expect("should parse");
        assert_eq!(e.chain, "forward");
        assert_eq!(e.rule, Some(10));
        assert_eq!(e.action, "accept");
        assert!(e.ips);
    }

    #[test]
    fn parses_zone_rule_in_named_ruleset() {
        // Zone rules live in `firewall ipv4 name <ruleset>`, which logs with the
        // NAM hook. The scope must come out as the `name:<ruleset>` key the
        // frontend builds, and the ruleset's own hyphens must survive.
        let e = parse_message(
            "[ipv4-NAM-QZ-Z-LAN-TO-WAN-10-A]IN=eth1 OUT=eth0 SRC=10.0.0.5 DST=1.1.1.1 LEN=60 \
             PROTO=TCP SPT=51000 DPT=443 SYN URGP=0",
            1,
        )
        .expect("should parse");
        assert_eq!(e.chain, "name:QZ-Z-LAN-TO-WAN");
        assert_eq!(e.rule, Some(10));
        assert_eq!(e.action, "accept");
    }

    #[test]
    fn parses_zone_default_action_drop() {
        let e = parse_message(
            "[ipv4-NAM-QZ-Z-WAN-TO-LAN-default-D]IN=eth0 OUT=eth1 SRC=192.0.2.9 DST=10.0.0.5 LEN=40 \
             PROTO=TCP SPT=55555 DPT=23",
            1,
        )
        .expect("should parse");
        assert_eq!(e.chain, "name:QZ-Z-WAN-TO-LAN");
        assert_eq!(e.rule, None);
        assert_eq!(e.action, "drop");
    }

    #[test]
    fn parses_default_log_drop() {
        let e = parse_message(
            "[ipv4-INP-filter-default-D]IN=eth0 OUT= SRC=192.0.2.9 DST=192.0.2.1 LEN=40 \
             PROTO=TCP SPT=55555 DPT=23",
            1,
        )
        .expect("should parse");
        assert_eq!(e.chain, "input");
        assert_eq!(e.rule, None);
        assert_eq!(e.action, "drop");
        assert_eq!(e.out_if, None);
    }

    #[test]
    fn ignores_unrelated_kernel_lines() {
        assert!(parse_message("usb 1-1: new high-speed USB device", 1).is_none());
        assert!(parse_message("[UFW BLOCK] IN=eth0 SRC=1.2.3.4", 1).is_none());
    }
}
