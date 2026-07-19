//! Live OSPFv2 status (Routing → OSPF → Status tab).
//!
//! The config side (`protocols ospf`) is edited through the VyOS API proxy +
//! commit guard in the frontend (`lib/ospf.ts`). This module is the operational
//! read side — adjacency states, per-area counters, per-interface roles — which
//! no config read can answer.
//!
//!   * GET /api/ospf/summary — router-id, areas, neighbors, interfaces
//!
//! Sourced from FRR's `ospfd` via `vtysh` JSON (`show ip ospf …`). Strictly
//! read-only: no `configure`/commit path is touched, so a failed query can
//! never affect the running fabric. FRR's OSPF JSON key names have drifted
//! across releases, so every optional field is extracted with a small list of
//! candidate keys and left optional — a missing field renders as "—".

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

fn u64_any(v: &Value, keys: &[&str]) -> Option<u64> {
    for k in keys {
        if let Some(n) = v.get(k).and_then(Value::as_u64) {
            return Some(n);
        }
    }
    None
}

fn bool_any(v: &Value, keys: &[&str]) -> bool {
    keys.iter().any(|k| v.get(*k).and_then(Value::as_bool).unwrap_or(false))
}

// ── models ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, PartialEq)]
pub struct AreaSummary {
    area: String,
    backbone: bool,
    interfaces_total: Option<u64>,
    interfaces_active: Option<u64>,
    neighbors_full: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct OspfNeighbor {
    /// Neighbor router-id.
    neighbor_id: String,
    /// Neighbor interface address.
    address: Option<String>,
    interface: Option<String>,
    /// FRR state string, e.g. `Full/DR`, `2-Way/DROther`, `Init`.
    state: String,
    is_up: bool,
    priority: Option<u64>,
    dead_time_secs: Option<u64>,
    uptime_secs: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct OspfInterface {
    name: String,
    area: Option<String>,
    state: Option<String>,
    cost: Option<u64>,
    network_type: Option<String>,
    hello_secs: Option<u64>,
    dead_secs: Option<u64>,
    neighbor_count: Option<u64>,
    passive: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Summary {
    /// True when ospfd reports a router-id (the process is running).
    running: bool,
    router_id: Option<String>,
    areas: Vec<AreaSummary>,
    neighbors: Vec<OspfNeighbor>,
    interfaces: Vec<OspfInterface>,
}

// ── parsers ─────────────────────────────────────────────────────────────────

/// `show ip ospf json` — router-id plus a per-area counter map.
fn parse_router(v: &Value) -> (Option<String>, Vec<AreaSummary>) {
    let router_id = str_any(v, &["routerId", "routerid"]);
    let mut areas: Vec<AreaSummary> = v
        .get("areas")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(area, block)| AreaSummary {
                    area: area.clone(),
                    backbone: bool_any(block, &["backbone"]),
                    interfaces_total: u64_any(block, &["areaIfTotalCounter"]),
                    interfaces_active: u64_any(block, &["areaIfActiveCounter"]),
                    neighbors_full: u64_any(block, &["nbrFullAdjacentCounter"]),
                })
                .collect()
        })
        .unwrap_or_default();
    areas.sort_by(|a, b| a.area.cmp(&b.area));
    (router_id, areas)
}

fn parse_neighbor(neighbor_id: &str, v: &Value) -> OspfNeighbor {
    // The DR/BDR role is folded into the state string (`Full/DR`); an adjacency
    // is "up" once it reaches Full (or 2-Way on a broadcast segment where the
    // pair are both DROther — but Full is the only fully-usable state).
    let state = str_any(v, &["nbrState", "state"]).unwrap_or_else(|| "Unknown".to_string());
    let is_up = state.to_ascii_lowercase().starts_with("full");
    OspfNeighbor {
        neighbor_id: neighbor_id.to_string(),
        address: str_any(v, &["ifaceAddress", "address", "nbrIpAddress"]),
        interface: str_any(v, &["ifaceName", "interface", "ifName"]),
        state,
        is_up,
        priority: u64_any(v, &["priority", "nbrPriority"]),
        dead_time_secs: u64_any(v, &["routerDeadIntervalTimerDueMsec", "deadTimeMsecs"])
            .map(|ms| ms / 1000),
        uptime_secs: u64_any(v, &["upTimeInMsec", "upTimeMsec"]).map(|ms| ms / 1000),
    }
}

/// `show ip ospf neighbor json` — the map is keyed by neighbor router-id and
/// each value is an array (a neighbor can be reached over several interfaces).
fn parse_neighbors(v: &Value) -> Vec<OspfNeighbor> {
    let mut out = Vec::new();
    if let Some(map) = v.get("neighbors").and_then(Value::as_object) {
        for (id, entries) in map {
            match entries {
                Value::Array(arr) => out.extend(arr.iter().map(|e| parse_neighbor(id, e))),
                Value::Object(_) => out.push(parse_neighbor(id, entries)),
                _ => {}
            }
        }
    }
    out.sort_by(|a, b| a.neighbor_id.cmp(&b.neighbor_id).then(a.interface.cmp(&b.interface)));
    out
}

fn parse_interface(name: &str, v: &Value) -> OspfInterface {
    OspfInterface {
        name: name.to_string(),
        area: str_any(v, &["area"]),
        state: str_any(v, &["state"]),
        cost: u64_any(v, &["cost"]),
        network_type: str_any(v, &["networkType", "type"]),
        hello_secs: u64_any(v, &["timerMsecs", "timerHelloInMsecs"]).map(|ms| ms / 1000),
        dead_secs: u64_any(v, &["timerDeadMsecs", "timerDeadInMsecs"]).map(|ms| ms / 1000),
        neighbor_count: u64_any(v, &["nbrCount"]),
        passive: bool_any(v, &["timerPassiveIface", "passive"]),
    }
}

/// `show ip ospf interface json` — a map keyed by interface name.
fn parse_interfaces(v: &Value) -> Vec<OspfInterface> {
    let mut out: Vec<OspfInterface> = v
        .get("interfaces")
        .and_then(Value::as_object)
        .or_else(|| v.as_object())
        .map(|m| m.iter().map(|(name, block)| parse_interface(name, block)).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn parse_summary(router_v: &Value, neighbor_v: &Value, iface_v: &Value) -> Summary {
    let (router_id, areas) = parse_router(router_v);
    Summary {
        running: router_id.is_some(),
        router_id,
        areas,
        neighbors: parse_neighbors(neighbor_v),
        interfaces: parse_interfaces(iface_v),
    }
}

// ── handler ─────────────────────────────────────────────────────────────────

/// GET /api/ospf/summary — router-id, areas, neighbors, interfaces.
pub async fn summary() -> Result<Json<Summary>> {
    let router = run_vtysh("show ip ospf json").await?;
    let neighbors = run_vtysh("show ip ospf neighbor json").await?;
    let interfaces = run_vtysh("show ip ospf interface json").await?;
    Ok(Json(parse_summary(&router, &neighbors, &interfaces)))
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_router_and_areas() {
        let v = json!({
            "routerId": "10.0.0.1",
            "areas": {
                "0.0.0.0": {
                    "backbone": true,
                    "areaIfTotalCounter": 2,
                    "areaIfActiveCounter": 2,
                    "nbrFullAdjacentCounter": 1
                }
            }
        });
        let (rid, areas) = parse_router(&v);
        assert_eq!(rid.as_deref(), Some("10.0.0.1"));
        assert_eq!(areas.len(), 1);
        assert_eq!(areas[0].area, "0.0.0.0");
        assert!(areas[0].backbone);
        assert_eq!(areas[0].neighbors_full, Some(1));
    }

    #[test]
    fn parses_neighbors_keyed_by_router_id() {
        let v = json!({
            "neighbors": {
                "10.0.0.2": [
                    {
                        "priority": 1,
                        "nbrState": "Full/DR",
                        "upTimeInMsec": 62000u64,
                        "routerDeadIntervalTimerDueMsec": 39000,
                        "ifaceAddress": "10.1.1.2",
                        "ifaceName": "eth1:10.1.1.1"
                    }
                ],
                "10.0.0.3": [
                    { "priority": 1, "nbrState": "Init", "ifaceName": "eth2:10.2.2.1" }
                ]
            }
        });
        let ns = parse_neighbors(&v);
        assert_eq!(ns.len(), 2);
        let full = ns.iter().find(|n| n.neighbor_id == "10.0.0.2").unwrap();
        assert!(full.is_up);
        assert_eq!(full.uptime_secs, Some(62));
        assert_eq!(full.dead_time_secs, Some(39));
        assert_eq!(full.address.as_deref(), Some("10.1.1.2"));
        let init = ns.iter().find(|n| n.neighbor_id == "10.0.0.3").unwrap();
        assert!(!init.is_up);
    }

    #[test]
    fn parses_interfaces() {
        let v = json!({
            "interfaces": {
                "eth1": {
                    "area": "0.0.0.0",
                    "state": "DR",
                    "cost": 10,
                    "networkType": "BROADCAST",
                    "timerMsecs": 10000,
                    "timerDeadMsecs": 40000,
                    "nbrCount": 1
                }
            }
        });
        let ifs = parse_interfaces(&v);
        assert_eq!(ifs.len(), 1);
        assert_eq!(ifs[0].name, "eth1");
        assert_eq!(ifs[0].area.as_deref(), Some("0.0.0.0"));
        assert_eq!(ifs[0].cost, Some(10));
        assert_eq!(ifs[0].hello_secs, Some(10));
        assert_eq!(ifs[0].dead_secs, Some(40));
    }

    #[test]
    fn empty_when_not_running() {
        let s = parse_summary(&json!({}), &json!({}), &json!({}));
        assert!(!s.running);
        assert!(s.router_id.is_none());
        assert!(s.neighbors.is_empty());
        assert!(s.areas.is_empty());
    }
}
