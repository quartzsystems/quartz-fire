//! Live IS-IS status (Routing → IS-IS → Status tab).
//!
//! The config side (`protocols isis`) is edited through the VyOS API proxy +
//! commit guard in the frontend (`lib/isis.ts`). This module is the operational
//! read side — the local NET/area identity and the adjacency table — which no
//! config read can answer.
//!
//!   * GET /api/isis/summary — area/NET identity + neighbor adjacencies
//!
//! Sourced from FRR's `isisd` via `vtysh` JSON (`show isis summary` /
//! `show isis neighbor`). FRR's IS-IS JSON is nested (areas → circuits →
//! interface) and its key names use hyphens and have drifted across releases,
//! so every field is extracted with a small list of candidate keys and left
//! optional — a missing field renders as "—". Strictly read-only.

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
        // Some counters/levels surface as numbers; accept those too.
        if let Some(n) = v.get(k).and_then(Value::as_u64) {
            return Some(n.to_string());
        }
    }
    None
}

// ── models ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, PartialEq)]
pub struct IsisArea {
    /// Area tag (the `protocols isis` instance name in VyOS is always `default`,
    /// but FRR still reports a per-area tag).
    area: Option<String>,
    net: Option<String>,
    system_id: Option<String>,
    is_type: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct IsisNeighbor {
    /// The adjacency's dynamic hostname or system-id.
    system_id: Option<String>,
    interface: Option<String>,
    /// `level-1`, `level-2`, or `level-1-2`.
    level: Option<String>,
    /// `Up`, `Init`, `Down`, …
    state: Option<String>,
    is_up: bool,
    /// Seconds until the adjacency holdtime expires (as reported).
    expires: Option<String>,
    snpa: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Summary {
    /// True when isisd reports at least one area (the process is running).
    running: bool,
    areas: Vec<IsisArea>,
    neighbors: Vec<IsisNeighbor>,
}

// ── parsers ─────────────────────────────────────────────────────────────────

fn parse_area(v: &Value) -> IsisArea {
    IsisArea {
        area: str_any(v, &["area", "areaTag", "name"]),
        net: str_any(v, &["net"]),
        system_id: str_any(v, &["system-id", "systemId"]),
        is_type: str_any(v, &["is-type", "isType", "type"]),
    }
}

/// `show isis summary json` → `{"areas":[{area, net, system-id, is-type, …}]}`.
fn parse_summary_areas(v: &Value) -> Vec<IsisArea> {
    v.get("areas")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(parse_area).collect())
        .unwrap_or_default()
}

/// One circuit entry under an area. The adjacency details live either directly
/// on the circuit or nested under an `interface` object, depending on release.
fn parse_circuit(area_tag: Option<&str>, v: &Value) -> IsisNeighbor {
    let iface = v.get("interface").filter(|i| i.is_object());
    // Prefer the nested `interface` object, then fall back to the circuit level.
    // (The circuit carries a numeric `circuit` index that must not be mistaken
    // for a field value, so it is never in the candidate key lists.)
    let pick = |keys: &[&str]| iface.and_then(|i| str_any(i, keys)).or_else(|| str_any(v, keys));

    let state = pick(&["state", "adjState"]);
    let is_up = state.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("Up"));
    let _ = area_tag; // area is reported by the summary endpoint; kept for future grouping
    IsisNeighbor {
        // `adj` (the adjacency's hostname/system-id) lives at the circuit level,
        // so check the circuit first for it specifically.
        system_id: str_any(v, &["adj"]).or_else(|| pick(&["system-id", "systemId", "sysid"])),
        interface: pick(&["name", "interface", "ifName"]),
        level: pick(&["level", "adjLevel"]),
        state,
        is_up,
        expires: pick(&["expires-in", "expiresIn", "holdtime", "lastUpTime"]),
        snpa: pick(&["snpa"]),
    }
}

/// `show isis neighbor json` → `{"areas":[{area, circuits:[…]}]}`. A router with
/// no adjacencies reports areas with empty circuit lists (or no areas at all).
fn parse_neighbors(v: &Value) -> Vec<IsisNeighbor> {
    let mut out = Vec::new();
    if let Some(areas) = v.get("areas").and_then(Value::as_array) {
        for area in areas {
            let tag = area.get("area").and_then(Value::as_str);
            if let Some(circuits) = area.get("circuits").and_then(Value::as_array) {
                out.extend(circuits.iter().map(|c| parse_circuit(tag, c)));
            }
        }
    }
    out.sort_by(|a, b| a.interface.cmp(&b.interface).then(a.system_id.cmp(&b.system_id)));
    out
}

fn parse_summary(summary_v: &Value, neighbor_v: &Value) -> Summary {
    let areas = parse_summary_areas(summary_v);
    Summary {
        running: !areas.is_empty(),
        areas,
        neighbors: parse_neighbors(neighbor_v),
    }
}

// ── handler ─────────────────────────────────────────────────────────────────

/// GET /api/isis/summary — area/NET identity + neighbor adjacencies.
pub async fn summary() -> Result<Json<Summary>> {
    let summary = run_vtysh("show isis summary json").await?;
    let neighbors = run_vtysh("show isis neighbor json").await?;
    Ok(Json(parse_summary(&summary, &neighbors)))
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_summary_areas() {
        let v = json!({
            "vrf": "default",
            "areas": [
                {
                    "area": "default",
                    "net": "49.0001.1921.6800.1002.00",
                    "system-id": "1921.6800.1002",
                    "is-type": "level-1-2"
                }
            ]
        });
        let areas = parse_summary_areas(&v);
        assert_eq!(areas.len(), 1);
        assert_eq!(areas[0].net.as_deref(), Some("49.0001.1921.6800.1002.00"));
        assert_eq!(areas[0].system_id.as_deref(), Some("1921.6800.1002"));
        assert_eq!(areas[0].is_type.as_deref(), Some("level-1-2"));
    }

    #[test]
    fn parses_nested_circuit_neighbors() {
        let v = json!({
            "areas": [
                {
                    "area": "default",
                    "circuits": [
                        {
                            "circuit": 0,
                            "adj": "r2",
                            "interface": {
                                "name": "eth1",
                                "state": "Up",
                                "level": "2",
                                "expires-in": "27s",
                                "snpa": "2020.2020.2020"
                            }
                        }
                    ]
                }
            ]
        });
        let ns = parse_neighbors(&v);
        assert_eq!(ns.len(), 1);
        assert_eq!(ns[0].system_id.as_deref(), Some("r2"));
        assert_eq!(ns[0].interface.as_deref(), Some("eth1"));
        assert_eq!(ns[0].level.as_deref(), Some("2"));
        assert!(ns[0].is_up);
        assert_eq!(ns[0].snpa.as_deref(), Some("2020.2020.2020"));
    }

    #[test]
    fn parses_flat_circuit_neighbors() {
        // Older/alternate shape: adjacency fields directly on the circuit.
        let v = json!({
            "areas": [
                {
                    "circuits": [
                        { "adj": "r3", "interface": "eth2", "state": "Init", "level": "1" }
                    ]
                }
            ]
        });
        let ns = parse_neighbors(&v);
        assert_eq!(ns.len(), 1);
        assert_eq!(ns[0].interface.as_deref(), Some("eth2"));
        assert!(!ns[0].is_up);
    }

    #[test]
    fn not_running_when_empty() {
        let s = parse_summary(&json!({}), &json!({}));
        assert!(!s.running);
        assert!(s.areas.is_empty());
        assert!(s.neighbors.is_empty());
    }
}
