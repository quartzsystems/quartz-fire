//! Live BGP session status (Routing → BGP → Status tab).
//!
//! The config side of BGP (`protocols bgp`) is edited through the VyOS API
//! proxy + commit guard, entirely in the frontend (`lib/bgp.ts`). This module
//! is the *operational* side — "is the session up, how many prefixes did we
//! learn, how long has it been established" — which no config read can answer.
//!
//! VyOS routes with FRR, so the richest source is FRR's own `vtysh` with its
//! native `json` output. We run read-only `show …` commands and reshape the
//! JSON into the flat structs the Status tab renders:
//!
//!   * GET /api/bgp/summary        — router-level counters + per-AF neighbor table
//!   * GET /api/bgp/neighbor/{id}  — one neighbor: timers, capabilities, counters
//!
//! This is strictly read-only: no `configure`/commit path is touched, so a
//! failed query can never affect the running fabric. Reaching the FRR VTY
//! sockets requires the service to be in the `frrvty` group (granted in the
//! systemd unit); when it isn't, `vtysh` fails and we surface a clean gateway
//! error rather than a 500.

use axum::{extract::Path as AxumPath, Json};
use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::frr::run_vtysh;

// ── address-family key mapping ──────────────────────────────────────────────

/// FRR's camelCase AFI/SAFI key → the hyphenated key the frontend already uses
/// for BGP config (`lib/bgp.ts` `AddressFamily`). Anything else is ignored so a
/// future FRR AF doesn't surface as a mystery table.
fn af_key(frr: &str) -> Option<&'static str> {
    match frr {
        "ipv4Unicast" => Some("ipv4-unicast"),
        "ipv6Unicast" => Some("ipv6-unicast"),
        "l2VpnEvpn" => Some("l2vpn-evpn"),
        _ => None,
    }
}

// ── JSON accessors ──────────────────────────────────────────────────────────

fn get_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn get_u64(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

/// FRR reports ASNs as JSON numbers; render them back to strings so they line
/// up with the config layer (which carries `remote-as` as text, incl. keywords).
fn get_as(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

// ── summary model ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, PartialEq)]
pub struct PeerSummary {
    /// Neighbor address, or interface name for an unnumbered peer.
    neighbor: String,
    remote_as: Option<String>,
    /// FRR session state: `Established`, `Idle`, `Connect`, `Active`, …
    state: String,
    is_up: bool,
    /// Seconds the session has been up; null when it has never come up.
    uptime_secs: Option<u64>,
    prefixes_received: Option<u64>,
    prefixes_sent: Option<u64>,
    msg_rcvd: Option<u64>,
    msg_sent: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct AfSummary {
    /// Hyphenated key: `ipv4-unicast`, `ipv6-unicast`, `l2vpn-evpn`.
    af: String,
    total_peers: u64,
    established_peers: u64,
    peers: Vec<PeerSummary>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Summary {
    router_id: Option<String>,
    local_as: Option<String>,
    address_families: Vec<AfSummary>,
}

fn parse_peer_summary(neighbor: &str, p: &Value) -> PeerSummary {
    // FRR uses `state` in newer releases and `peerState`/no-field in older ones;
    // an Established peer sometimes omits `state` entirely, so fall back.
    let state = get_str(p, "state")
        .or_else(|| get_str(p, "peerState"))
        .unwrap_or_else(|| "Unknown".to_string());
    let is_up = state.eq_ignore_ascii_case("Established");
    // Uptime is only meaningful once the session has come up.
    let uptime_secs = get_u64(p, "peerUptimeMsec")
        .filter(|_| is_up)
        .map(|ms| ms / 1000);
    PeerSummary {
        neighbor: neighbor.to_string(),
        remote_as: get_as(p, "remoteAs"),
        state,
        is_up,
        uptime_secs,
        prefixes_received: get_u64(p, "pfxRcd"),
        prefixes_sent: get_u64(p, "pfxSnt"),
        msg_rcvd: get_u64(p, "msgRcvd"),
        msg_sent: get_u64(p, "msgSent"),
    }
}

/// Reshape `show bgp summary json` (one object per AFI/SAFI) into a flat
/// `Summary`. An empty object (no BGP instance) yields empty address families.
fn parse_summary(v: &Value) -> Summary {
    let mut router_id = None;
    let mut local_as = None;
    let mut address_families = Vec::new();

    let Some(obj) = v.as_object() else {
        return Summary { router_id, local_as, address_families };
    };

    for (frr_af, block) in obj {
        let Some(af) = af_key(frr_af) else { continue };
        // router-id / local-as are the same across AFs for the default instance;
        // take them from the first AF that carries them.
        if router_id.is_none() {
            router_id = get_str(block, "routerId");
        }
        if local_as.is_none() {
            local_as = get_as(block, "as");
        }

        let mut peers: Vec<PeerSummary> = block
            .get("peers")
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(n, p)| parse_peer_summary(n, p)).collect())
            .unwrap_or_default();
        peers.sort_by(|a, b| a.neighbor.cmp(&b.neighbor));

        let established_peers = peers.iter().filter(|p| p.is_up).count() as u64;
        let total_peers = get_u64(block, "totalPeers").unwrap_or(peers.len() as u64);

        address_families.push(AfSummary { af: af.to_string(), total_peers, established_peers, peers });
    }

    // Stable AF order: v4, v6, evpn (the order the frontend lists them).
    address_families.sort_by_key(|a| match a.af.as_str() {
        "ipv4-unicast" => 0,
        "ipv6-unicast" => 1,
        "l2vpn-evpn" => 2,
        _ => 3,
    });

    Summary { router_id, local_as, address_families }
}

// ── neighbor-detail model ───────────────────────────────────────────────────

#[derive(Debug, Serialize, PartialEq)]
pub struct Capability {
    name: String,
    /// e.g. `advertisedAndReceived`, `advertised`, `received`.
    value: String,
}

#[derive(Debug, Serialize, Default, PartialEq)]
pub struct MessageStats {
    opens_sent: u64,
    opens_recv: u64,
    notifications_sent: u64,
    notifications_recv: u64,
    updates_sent: u64,
    updates_recv: u64,
    keepalives_sent: u64,
    keepalives_recv: u64,
    route_refresh_sent: u64,
    route_refresh_recv: u64,
    total_sent: u64,
    total_recv: u64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct AfPrefixes {
    af: String,
    accepted_prefixes: Option<u64>,
    sent_prefixes: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct NeighborDetail {
    neighbor: String,
    remote_as: Option<String>,
    local_as: Option<String>,
    description: Option<String>,
    remote_router_id: Option<String>,
    state: String,
    is_up: bool,
    uptime_secs: Option<u64>,
    hold_time_secs: Option<u64>,
    keepalive_secs: Option<u64>,
    connections_established: Option<u64>,
    connections_dropped: Option<u64>,
    last_reset: Option<String>,
    capabilities: Vec<Capability>,
    message_stats: MessageStats,
    address_families: Vec<AfPrefixes>,
}

fn parse_message_stats(v: &Value) -> MessageStats {
    let g = |k: &str| get_u64(v, k).unwrap_or(0);
    MessageStats {
        opens_sent: g("opensSent"),
        opens_recv: g("opensRecv"),
        notifications_sent: g("notificationsSent"),
        notifications_recv: g("notificationsRecv"),
        updates_sent: g("updatesSent"),
        updates_recv: g("updatesRecv"),
        keepalives_sent: g("keepalivesSent"),
        keepalives_recv: g("keepalivesRecv"),
        route_refresh_sent: g("routeRefreshSent"),
        route_refresh_recv: g("routeRefreshRecv"),
        total_sent: g("totalSent"),
        total_recv: g("totalRecv"),
    }
}

/// The `neighborCapabilities` block mixes string-valued entries
/// (`4byteAs: "advertisedAndReceived"`) with nested objects (`multipaths`).
/// We surface only the string-valued ones — the negotiated capability list a
/// human reads — and skip the rest.
fn parse_capabilities(v: &Value) -> Vec<Capability> {
    let mut caps: Vec<Capability> = v
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(name, val)| {
                    val.as_str().map(|s| Capability { name: name.clone(), value: s.to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    caps.sort_by(|a, b| a.name.cmp(&b.name));
    caps
}

fn parse_af_prefixes(v: &Value) -> Vec<AfPrefixes> {
    let mut out: Vec<AfPrefixes> = v
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(frr_af, block)| {
                    af_key(frr_af).map(|af| AfPrefixes {
                        af: af.to_string(),
                        accepted_prefixes: get_u64(block, "acceptedPrefixCounter"),
                        sent_prefixes: get_u64(block, "sentPrefixCounter"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|a| match a.af.as_str() {
        "ipv4-unicast" => 0,
        "ipv6-unicast" => 1,
        "l2vpn-evpn" => 2,
        _ => 3,
    });
    out
}

/// Reshape one neighbor object from `show bgp neighbor <id> json`. Returns None
/// when the requested id isn't in the response (unknown neighbor).
fn parse_neighbor(id: &str, v: &Value) -> Option<NeighborDetail> {
    // The response is keyed by neighbor id; there's exactly one key for a
    // single-neighbor query, but match the requested id to be safe.
    let n = v.get(id).or_else(|| v.as_object().and_then(|m| m.values().next()))?;

    let state = get_str(n, "bgpState").unwrap_or_else(|| "Unknown".to_string());
    let is_up = state.eq_ignore_ascii_case("Established");
    Some(NeighborDetail {
        neighbor: id.to_string(),
        remote_as: get_as(n, "remoteAs"),
        local_as: get_as(n, "localAs"),
        description: get_str(n, "nbrDescription"),
        remote_router_id: get_str(n, "remoteRouterId"),
        state,
        is_up,
        uptime_secs: get_u64(n, "bgpTimerUpMsec").filter(|_| is_up).map(|ms| ms / 1000),
        hold_time_secs: get_u64(n, "bgpTimerHoldTimeMsecs").map(|ms| ms / 1000),
        keepalive_secs: get_u64(n, "bgpTimerKeepAliveIntervalMsecs").map(|ms| ms / 1000),
        connections_established: get_u64(n, "connectionsEstablished"),
        connections_dropped: get_u64(n, "connectionsDropped"),
        last_reset: get_str(n, "lastResetDueTo"),
        capabilities: n.get("neighborCapabilities").map(parse_capabilities).unwrap_or_default(),
        message_stats: n.get("messageStats").map(parse_message_stats).unwrap_or_default(),
        address_families: n.get("addressFamilyInfo").map(parse_af_prefixes).unwrap_or_default(),
    })
}

// ── handlers ────────────────────────────────────────────────────────────────

/// GET /api/bgp/summary — router-level counters plus a per-AF neighbor table.
pub async fn summary() -> Result<Json<Summary>> {
    let v = run_vtysh("show bgp summary json").await?;
    Ok(Json(parse_summary(&v)))
}

/// A neighbor id is an address or an interface name. Restrict to the characters
/// those can contain so nothing shell/vtysh-special can reach the command even
/// though we already pass it as a separate token.
fn valid_neighbor_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '_'))
}

/// GET /api/bgp/neighbor/{id} — one neighbor's timers, capabilities, counters.
pub async fn neighbor(AxumPath(id): AxumPath<String>) -> Result<Json<NeighborDetail>> {
    if !valid_neighbor_id(&id) {
        return Err(AppError::BadRequest("invalid neighbor identifier".into()));
    }
    let v = run_vtysh(&format!("show bgp neighbor {id} json")).await?;
    parse_neighbor(&id, &v)
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("no BGP neighbor {id}")))
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_multi_af_summary() {
        let v = json!({
            "ipv4Unicast": {
                "routerId": "10.0.0.1",
                "as": 65001,
                "totalPeers": 2,
                "peers": {
                    "10.0.0.2": {
                        "remoteAs": 65000,
                        "msgRcvd": 100,
                        "msgSent": 102,
                        "peerUptimeMsec": 5025000u64,
                        "pfxRcd": 5,
                        "pfxSnt": 3,
                        "state": "Established"
                    },
                    "10.0.0.3": {
                        "remoteAs": 65002,
                        "msgRcvd": 0,
                        "msgSent": 0,
                        "peerUptimeMsec": 0,
                        "state": "Active"
                    }
                }
            },
            "l2VpnEvpn": {
                "routerId": "10.0.0.1",
                "as": 65001,
                "totalPeers": 1,
                "peers": {
                    "eth1": {
                        "remoteAs": 65000,
                        "msgRcvd": 50,
                        "msgSent": 51,
                        "peerUptimeMsec": 5025000u64,
                        "pfxRcd": 12,
                        "pfxSnt": 4,
                        "state": "Established"
                    }
                }
            }
        });

        let s = parse_summary(&v);
        assert_eq!(s.router_id.as_deref(), Some("10.0.0.1"));
        assert_eq!(s.local_as.as_deref(), Some("65001"));
        assert_eq!(s.address_families.len(), 2);

        // AF order is v4 then evpn.
        let v4 = &s.address_families[0];
        assert_eq!(v4.af, "ipv4-unicast");
        assert_eq!(v4.total_peers, 2);
        assert_eq!(v4.established_peers, 1);
        // Peers sorted by neighbor; the established one carries prefixes/uptime.
        let up = &v4.peers[0];
        assert_eq!(up.neighbor, "10.0.0.2");
        assert!(up.is_up);
        assert_eq!(up.uptime_secs, Some(5025));
        assert_eq!(up.prefixes_received, Some(5));
        assert_eq!(up.prefixes_sent, Some(3));
        // The Active peer is not up and has no uptime even though msec was 0.
        let down = &v4.peers[1];
        assert!(!down.is_up);
        assert_eq!(down.uptime_secs, None);

        let evpn = &s.address_families[1];
        assert_eq!(evpn.af, "l2vpn-evpn");
        assert_eq!(evpn.peers[0].neighbor, "eth1");
        assert_eq!(evpn.peers[0].prefixes_received, Some(12));
    }

    #[test]
    fn empty_summary_when_no_bgp() {
        let s = parse_summary(&json!({}));
        assert!(s.address_families.is_empty());
        assert_eq!(s.router_id, None);
    }

    #[test]
    fn state_falls_back_when_field_absent() {
        // Older FRR omits `state` on an Established peer.
        let s = parse_summary(&json!({
            "ipv4Unicast": { "peers": { "10.0.0.9": { "peerState": "Established", "pfxRcd": 1 } } }
        }));
        assert!(s.address_families[0].peers[0].is_up);
    }

    #[test]
    fn parses_neighbor_detail() {
        let v = json!({
            "10.0.0.2": {
                "remoteAs": 65000,
                "localAs": 65001,
                "nbrDescription": "spine1",
                "remoteRouterId": "10.0.0.2",
                "bgpState": "Established",
                "bgpTimerUpMsec": 5025000u64,
                "bgpTimerHoldTimeMsecs": 9000,
                "bgpTimerKeepAliveIntervalMsecs": 3000,
                "connectionsEstablished": 1,
                "connectionsDropped": 0,
                "lastResetDueTo": "Waiting for peer OPEN",
                "neighborCapabilities": {
                    "4byteAs": "advertisedAndReceived",
                    "routeRefresh": "advertisedAndReceivedOldNew",
                    "multipaths": { "ipv4Unicast": "received" }
                },
                "messageStats": {
                    "opensSent": 1, "opensRecv": 1,
                    "updatesSent": 3, "updatesRecv": 5,
                    "keepalivesSent": 100, "keepalivesRecv": 100,
                    "totalSent": 104, "totalRecv": 106
                },
                "addressFamilyInfo": {
                    "ipv4Unicast": { "acceptedPrefixCounter": 5, "sentPrefixCounter": 3 },
                    "l2VpnEvpn": { "acceptedPrefixCounter": 12 }
                }
            }
        });

        let d = parse_neighbor("10.0.0.2", &v).expect("neighbor present");
        assert_eq!(d.remote_as.as_deref(), Some("65000"));
        assert_eq!(d.description.as_deref(), Some("spine1"));
        assert!(d.is_up);
        assert_eq!(d.uptime_secs, Some(5025));
        assert_eq!(d.hold_time_secs, Some(9));
        assert_eq!(d.keepalive_secs, Some(3));
        assert_eq!(d.message_stats.updates_recv, 5);
        assert_eq!(d.message_stats.total_sent, 104);
        // Only string-valued caps surface; the nested `multipaths` object is skipped.
        assert!(d.capabilities.iter().any(|c| c.name == "4byteAs"));
        assert!(!d.capabilities.iter().any(|c| c.name == "multipaths"));
        // AF prefixes ordered v4 then evpn.
        assert_eq!(d.address_families[0].af, "ipv4-unicast");
        assert_eq!(d.address_families[0].accepted_prefixes, Some(5));
        assert_eq!(d.address_families[1].af, "l2vpn-evpn");
    }

    #[test]
    fn unknown_neighbor_is_none() {
        assert!(parse_neighbor("10.0.0.9", &json!({})).is_none());
    }

    #[test]
    fn neighbor_id_validation() {
        assert!(valid_neighbor_id("10.0.0.2"));
        assert!(valid_neighbor_id("fe80::1"));
        assert!(valid_neighbor_id("eth1"));
        assert!(!valid_neighbor_id(""));
        assert!(!valid_neighbor_id("10.0.0.2; reboot"));
        assert!(!valid_neighbor_id("$(whoami)"));
    }
}
