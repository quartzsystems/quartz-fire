//! Live MPLS / LDP status (Routing → MPLS → Status tab).
//!
//! The config side (`protocols mpls`) is edited through the VyOS API proxy +
//! commit guard in the frontend (`lib/mpls.ts`). This is the operational read
//! side, sourced from FRR's `ldpd`/`zebra` via `vtysh` JSON:
//!
//!   * GET /api/mpls/status    — LDP peers + discovery (hello) adjacencies
//!   * GET /api/mpls/bindings  — the Label Information Base (LIB)
//!   * GET /api/mpls/table     — the MPLS forwarding table (LFIB)
//!
//! FRR's LDP JSON field names have drifted across releases, so every field is
//! extracted with a small list of candidate keys and left optional — a missing
//! field renders as "—" rather than breaking the view. Strictly read-only.

use axum::Json;
use serde::Serialize;
use serde_json::Value;

use crate::error::Result;
use crate::frr::run_vtysh;

// ── JSON accessors (tolerant of FRR key drift) ──────────────────────────────

fn str_any(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(k).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// A label can arrive as a number, a numeric string, or a keyword ("imp-null",
/// "no-label"); normalize all three to a display string.
fn label_any(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        match v.get(k) {
            Some(Value::Number(n)) => return Some(n.to_string()),
            Some(Value::String(s)) if !s.is_empty() => return Some(s.clone()),
            _ => {}
        }
    }
    None
}

fn u64_any(v: &Value, keys: &[&str]) -> Option<u64> {
    for k in keys {
        if let Some(n) = v.get(k).and_then(Value::as_u64) {
            return Some(n);
        }
    }
    None
}

/// FRR sometimes returns a top-level array and sometimes wraps rows under a key
/// (`{"neighbors":[…]}`). Normalize both — and a bare object of rows — to a Vec.
fn rows<'a>(v: &'a Value, wrapper_keys: &[&str]) -> Vec<&'a Value> {
    if let Some(a) = v.as_array() {
        return a.iter().collect();
    }
    if let Some(obj) = v.as_object() {
        for k in wrapper_keys {
            if let Some(a) = obj.get(*k).and_then(Value::as_array) {
                return a.iter().collect();
            }
        }
        // A map keyed by id (e.g. the LFIB keyed by in-label): take the values.
        return obj.values().collect();
    }
    Vec::new()
}

// ── models ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, PartialEq)]
pub struct LdpNeighbor {
    neighbor_id: Option<String>,
    address_family: Option<String>,
    state: Option<String>,
    is_up: bool,
    transport_address: Option<String>,
    uptime: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct LdpAdjacency {
    address_family: Option<String>,
    interface: Option<String>,
    neighbor_id: Option<String>,
    source: Option<String>,
    hold_time: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct MplsStatus {
    /// True when LDP reports at least one neighbor or hello adjacency.
    ldp_running: bool,
    neighbors: Vec<LdpNeighbor>,
    discovery: Vec<LdpAdjacency>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct LdpBinding {
    prefix: Option<String>,
    local_label: Option<String>,
    remote_label: Option<String>,
    neighbor_id: Option<String>,
    /// The binding FRR selected for forwarding.
    in_use: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct MplsRoute {
    in_label: Option<String>,
    out_label: Option<String>,
    nexthop: Option<String>,
    interface: Option<String>,
    installed: bool,
}

// ── parsers ─────────────────────────────────────────────────────────────────

fn parse_neighbor(v: &Value) -> LdpNeighbor {
    let state = str_any(v, &["state", "operationalState"]);
    let is_up = state.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("OPERATIONAL"));
    LdpNeighbor {
        neighbor_id: str_any(v, &["neighborId", "peerId", "id", "lsrId"]),
        address_family: str_any(v, &["addressFamily", "af", "afi"]),
        state,
        is_up,
        transport_address: str_any(v, &["transportAddress", "transport", "peerAddress"]),
        uptime: str_any(v, &["upTime", "uptime"]),
    }
}

fn parse_adjacency(v: &Value) -> LdpAdjacency {
    LdpAdjacency {
        address_family: str_any(v, &["addressFamily", "af", "afi"]),
        interface: str_any(v, &["interface", "ifName", "iface"]),
        neighbor_id: str_any(v, &["neighborId", "peerId", "id", "lsrId"]),
        source: str_any(v, &["source", "sourceAddress", "helloSource"]),
        hold_time: u64_any(v, &["holdtime", "holdTime"]),
    }
}

fn parse_binding(v: &Value) -> LdpBinding {
    LdpBinding {
        prefix: str_any(v, &["prefix", "fec"]),
        local_label: label_any(v, &["localLabel", "local"]),
        remote_label: label_any(v, &["remoteLabel", "remote"]),
        neighbor_id: str_any(v, &["neighborId", "peerId", "id", "lsrId"]),
        in_use: v.get("inUse").and_then(Value::as_bool).unwrap_or_else(|| {
            // Some releases render it as "yes"/"no".
            str_any(v, &["inUse"]).as_deref().is_some_and(|s| s.eq_ignore_ascii_case("yes"))
        }),
    }
}

/// The LFIB carries one or more next-hops per in-label; flatten to one row per
/// next-hop so the table reads like a forwarding table.
fn parse_route_rows(v: &Value) -> Vec<MplsRoute> {
    let in_label = label_any(v, &["inLabel", "label"]);
    let installed = v.get("installed").and_then(Value::as_bool).unwrap_or(false);
    let nexthops = v.get("nexthops").and_then(Value::as_array);
    match nexthops {
        Some(nhs) if !nhs.is_empty() => nhs
            .iter()
            .map(|nh| MplsRoute {
                in_label: in_label.clone(),
                out_label: label_any(nh, &["outLabel", "label"]),
                nexthop: str_any(nh, &["nexthop", "ip", "address"]),
                interface: str_any(nh, &["interface", "ifName"]),
                installed: nh.get("installed").and_then(Value::as_bool).unwrap_or(installed),
            })
            .collect(),
        _ => vec![MplsRoute {
            in_label,
            out_label: label_any(v, &["outLabel"]),
            nexthop: str_any(v, &["nexthop", "ip", "address"]),
            interface: str_any(v, &["interface", "ifName"]),
            installed,
        }],
    }
}

fn parse_status(neighbors_v: &Value, discovery_v: &Value) -> MplsStatus {
    let neighbors: Vec<LdpNeighbor> = rows(neighbors_v, &["neighbors"])
        .into_iter()
        .map(parse_neighbor)
        .collect();
    let discovery: Vec<LdpAdjacency> = rows(discovery_v, &["adjacencies", "discovery", "interfaces"])
        .into_iter()
        .map(parse_adjacency)
        .collect();
    MplsStatus {
        ldp_running: !neighbors.is_empty() || !discovery.is_empty(),
        neighbors,
        discovery,
    }
}

// ── handlers ────────────────────────────────────────────────────────────────

/// GET /api/mpls/status — LDP peers + hello adjacencies.
pub async fn status() -> Result<Json<MplsStatus>> {
    let neighbors = run_vtysh("show mpls ldp neighbor json").await?;
    let discovery = run_vtysh("show mpls ldp discovery json").await?;
    Ok(Json(parse_status(&neighbors, &discovery)))
}

/// GET /api/mpls/bindings — the LDP Label Information Base (LIB).
pub async fn bindings() -> Result<Json<Vec<LdpBinding>>> {
    let v = run_vtysh("show mpls ldp binding json").await?;
    let mut out: Vec<LdpBinding> = rows(&v, &["bindings"]).into_iter().map(parse_binding).collect();
    out.sort_by(|a, b| a.prefix.cmp(&b.prefix));
    Ok(Json(out))
}

/// GET /api/mpls/table — the MPLS forwarding table (LFIB).
pub async fn table() -> Result<Json<Vec<MplsRoute>>> {
    let v = run_vtysh("show mpls table json").await?;
    let out: Vec<MplsRoute> = rows(&v, &["table", "routes"])
        .into_iter()
        .flat_map(parse_route_rows)
        .collect();
    Ok(Json(out))
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_ldp_neighbors_and_discovery() {
        let neighbors = json!([
            { "addressFamily": "ipv4", "neighborId": "10.0.0.2", "state": "OPERATIONAL",
              "transportAddress": "10.0.0.2", "upTime": "01:23:45" },
            { "addressFamily": "ipv4", "neighborId": "10.0.0.3", "state": "NONEXISTENT" }
        ]);
        let discovery = json!([
            { "addressFamily": "ipv4", "interface": "eth1", "neighborId": "10.0.0.2", "holdtime": 15 }
        ]);
        let s = parse_status(&neighbors, &discovery);
        assert!(s.ldp_running);
        assert_eq!(s.neighbors.len(), 2);
        assert!(s.neighbors[0].is_up);
        assert_eq!(s.neighbors[0].neighbor_id.as_deref(), Some("10.0.0.2"));
        assert!(!s.neighbors[1].is_up);
        assert_eq!(s.discovery[0].interface.as_deref(), Some("eth1"));
        assert_eq!(s.discovery[0].hold_time, Some(15));
    }

    #[test]
    fn not_running_when_empty() {
        let s = parse_status(&json!({}), &json!({}));
        assert!(!s.ldp_running);
        assert!(s.neighbors.is_empty());
    }

    #[test]
    fn parses_binding_wrapped_and_labels() {
        // Wrapper-key form, numeric + keyword labels.
        let v = json!({ "bindings": [
            { "prefix": "10.0.0.1/32", "localLabel": 16, "remoteLabel": "imp-null",
              "neighborId": "10.0.0.2", "inUse": true }
        ]});
        let b = &rows(&v, &["bindings"]).into_iter().map(parse_binding).collect::<Vec<_>>()[0];
        assert_eq!(b.prefix.as_deref(), Some("10.0.0.1/32"));
        assert_eq!(b.local_label.as_deref(), Some("16"));
        assert_eq!(b.remote_label.as_deref(), Some("imp-null"));
        assert!(b.in_use);
    }

    #[test]
    fn flattens_lfib_nexthops() {
        let v = json!({
            "16": {
                "inLabel": 16, "installed": true,
                "nexthops": [
                    { "outLabel": 3, "nexthop": "10.0.0.2", "interface": "eth1" },
                    { "outLabel": "imp-null", "nexthop": "10.0.0.6", "interface": "eth2" }
                ]
            }
        });
        let routes: Vec<MplsRoute> = rows(&v, &["table"]).into_iter().flat_map(parse_route_rows).collect();
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].in_label.as_deref(), Some("16"));
        assert_eq!(routes[0].out_label.as_deref(), Some("3"));
        assert_eq!(routes[0].interface.as_deref(), Some("eth1"));
        assert!(routes[0].installed);
        assert_eq!(routes[1].out_label.as_deref(), Some("imp-null"));
    }
}
