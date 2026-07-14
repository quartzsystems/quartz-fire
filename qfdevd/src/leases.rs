//! Kea DHCPv4 lease collector.
//!
//! VyOS 1.5 runs Kea. The authoritative read is the control socket
//! (`lease4-get-all`), but the memfile lease CSV is always present and needs no
//! socket permissions, so it is the default source (the spec's fallback, made
//! primary here for robustness on the sandboxed daemon). We also read the Kea
//! config's `reservations` so a client on a fixed-address reservation is
//! reported as Static rather than a dynamic lease.

use std::collections::{HashMap, HashSet};
use std::path::Path;

/// One active DHCP lease.
#[derive(Debug, Clone, PartialEq)]
pub struct Lease {
    pub ip: String,
    pub mac: String,
    pub hostname: Option<String>,
    /// Lease expiry (unix seconds).
    pub expire: i64,
    /// True when the address is a fixed reservation (looked up separately).
    pub is_static: bool,
}

/// Parse the Kea memfile lease CSV. The file is append-only: a MAC/-address can
/// appear multiple times as the lease is renewed, so we keep the row with the
/// newest `expire` per address, and drop expired (state != 0) or released rows.
///
/// Header (Kea 2.x memfile):
///   address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,
///   fqdn_rev,hostname,state,user_context,pool_id
pub fn parse_csv(text: &str, statics: &HashSet<String>) -> Vec<Lease> {
    let mut cols: HashMap<&str, usize> = HashMap::new();
    let mut latest: HashMap<String, Lease> = HashMap::new();

    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(',').collect();
        if i == 0 && line.starts_with("address") {
            for (idx, name) in fields.iter().enumerate() {
                cols.insert(name.trim(), idx);
            }
            continue;
        }
        // Without a header we can't trust positions; require one.
        if cols.is_empty() {
            continue;
        }
        let get = |key: &str| -> Option<&str> { cols.get(key).and_then(|&idx| fields.get(idx)).copied() };

        let ip = match get("address") {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => continue,
        };
        let mac = match get("hwaddr") {
            Some(v) if !v.is_empty() => v.to_ascii_lowercase(),
            _ => continue,
        };
        let expire = get("expire").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        // Kea lease states: 0 default (active), 1 declined, 2 expired-reclaimed.
        // Only active leases represent a currently-assigned address.
        let state = get("state").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        if state != 0 {
            latest.remove(&ip);
            continue;
        }
        let hostname = get("hostname").map(str::trim).filter(|h| !h.is_empty()).map(str::to_string);
        let is_static = statics.contains(&mac);

        let lease = Lease { ip: ip.clone(), mac, hostname, expire, is_static };
        match latest.get(&ip) {
            Some(prev) if prev.expire >= expire => {}
            _ => {
                latest.insert(ip, lease);
            }
        }
    }
    latest.into_values().collect()
}

/// Extract the set of MAC addresses that hold a fixed-address reservation from
/// a Kea DHCPv4 config JSON (`hw-address` under any subnet's `reservations`).
/// Best-effort: a malformed/absent config just yields an empty set (all leases
/// then read as dynamic).
pub fn parse_reservation_macs(config_json: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(config_json) else {
        return out;
    };
    // Reservations live under Dhcp4.subnet4[].reservations[] and, in newer
    // layouts, Dhcp4.shared-networks[].subnet4[].reservations[]. Walk the whole
    // tree for any object carrying "hw-address" — simplest robust approach.
    collect_hw_addresses(&v, &mut out);
    out
}

fn collect_hw_addresses(v: &serde_json::Value, out: &mut HashSet<String>) {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(hw)) = map.get("hw-address") {
                if !hw.is_empty() {
                    out.insert(hw.to_ascii_lowercase());
                }
            }
            for child in map.values() {
                collect_hw_addresses(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                collect_hw_addresses(child, out);
            }
        }
        _ => {}
    }
}

/// Read reservation MACs from the Kea config file, if present.
pub fn read_reservation_macs(path: &Path) -> HashSet<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_reservation_macs(&text),
        Err(_) => HashSet::new(),
    }
}

/// Read + parse the memfile lease CSV (Linux path; pure parser is `parse_csv`).
pub fn collect(lease_file: &Path, statics: &HashSet<String>) -> anyhow::Result<Vec<Lease>> {
    match std::fs::read_to_string(lease_file) {
        Ok(text) => Ok(parse_csv(&text, statics)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(anyhow::anyhow!("reading {}: {e}", lease_file.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,fqdn_rev,hostname,state,user_context,pool_id";

    #[test]
    fn keeps_newest_active_lease_per_address() {
        let csv = format!(
            "{HEADER}\n\
             10.0.0.5,aa:bb:cc:dd:ee:ff,,3600,1000,1,0,0,laptop,0,,0\n\
             10.0.0.5,aa:bb:cc:dd:ee:ff,,3600,2000,1,0,0,laptop,0,,0\n\
             10.0.0.6,11:22:33:44:55:66,,3600,1500,1,0,0,printer,0,,0\n"
        );
        let mut leases = parse_csv(&csv, &HashSet::new());
        leases.sort_by(|a, b| a.ip.cmp(&b.ip));
        assert_eq!(leases.len(), 2);
        assert_eq!(leases[0].ip, "10.0.0.5");
        assert_eq!(leases[0].expire, 2000); // renewed lease wins
        assert_eq!(leases[0].hostname.as_deref(), Some("laptop"));
        assert!(!leases[0].is_static);
    }

    #[test]
    fn drops_reclaimed_and_marks_static() {
        let csv = format!(
            "{HEADER}\n\
             10.0.0.5,aa:bb:cc:dd:ee:ff,,3600,2000,1,0,0,laptop,0,,0\n\
             10.0.0.7,de:ad:be:ef:00:01,,3600,900,1,0,0,,2,,0\n"
        );
        let statics: HashSet<String> = ["aa:bb:cc:dd:ee:ff".to_string()].into_iter().collect();
        let leases = parse_csv(&csv, &statics);
        assert_eq!(leases.len(), 1); // reclaimed (state 2) dropped
        assert_eq!(leases[0].ip, "10.0.0.5");
        assert!(leases[0].is_static); // in the reservation set
    }

    #[test]
    fn reservation_macs_from_config() {
        let cfg = r#"{"Dhcp4":{"subnet4":[{"subnet":"10.0.0.0/24","reservations":[
            {"hw-address":"AA:BB:CC:DD:EE:FF","ip-address":"10.0.0.50","hostname":"nas"}
        ]}],"shared-networks":[{"subnet4":[{"reservations":[
            {"hw-address":"11:22:33:44:55:66","ip-address":"10.0.1.10"}
        ]}]}]}}"#;
        let macs = parse_reservation_macs(cfg);
        assert!(macs.contains("aa:bb:cc:dd:ee:ff"));
        assert!(macs.contains("11:22:33:44:55:66"));
        assert_eq!(macs.len(), 2);
    }

    #[test]
    fn missing_header_is_ignored() {
        // No header → we can't trust column positions, so nothing is parsed.
        let csv = "10.0.0.5,aa:bb:cc:dd:ee:ff,,3600,2000,1,0,0,laptop,0,,0\n";
        assert!(parse_csv(csv, &HashSet::new()).is_empty());
    }
}
