//! Neighbor-table collector: `ip -j neigh show`.
//!
//! The neighbor (ARP/NDP) table is the primary liveness signal. Its state
//! machine drives online/offline: REACHABLE/DELAY/PROBE mean the kernel has
//! confirmed the L2 neighbor recently; STALE/FAILED mean it hasn't. We record
//! the state verbatim and let the freshness rule (db::refresh_online) decide.

use serde::Deserialize;

/// One usable neighbor entry (those without a link-layer address — INCOMPLETE,
/// FAILED with no MAC — are dropped by the parser).
#[derive(Debug, Clone, PartialEq)]
pub struct Neighbor {
    pub ip: String,
    pub mac: String,
    pub dev: String,
    pub state: String,
}

/// Raw `ip -j neigh` record. `state` is a JSON array (usually one element).
#[derive(Debug, Deserialize)]
struct RawNeigh {
    dst: Option<String>,
    dev: Option<String>,
    lladdr: Option<String>,
    #[serde(default)]
    state: Vec<String>,
}

/// Parse `ip -j neigh show` JSON into usable neighbors. Skips entries with no
/// MAC (nothing to key a device on) and normalizes the MAC to lowercase.
pub fn parse(json: &str) -> anyhow::Result<Vec<Neighbor>> {
    let raw: Vec<RawNeigh> = serde_json::from_str(json)?;
    Ok(raw
        .into_iter()
        .filter_map(|r| {
            let mac = r.lladdr?;
            let ip = r.dst?;
            if mac.is_empty() || ip.is_empty() {
                return None;
            }
            Some(Neighbor {
                ip,
                mac: mac.to_ascii_lowercase(),
                dev: r.dev.unwrap_or_default(),
                // No state element => treat as NONE (offline-ish); the kernel
                // occasionally reports permanent entries with an empty array.
                state: r.state.first().cloned().unwrap_or_else(|| "NONE".into()),
            })
        })
        .collect())
}

/// Run `ip -j neigh show` and parse it (Linux only).
#[cfg(target_os = "linux")]
pub async fn collect() -> anyhow::Result<Vec<Neighbor>> {
    let out = tokio::process::Command::new("ip")
        .args(["-j", "neigh", "show"])
        .output()
        .await?;
    if !out.status.success() {
        anyhow::bail!(
            "ip neigh exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_filters() {
        let json = r#"[
            {"dst":"10.0.0.5","dev":"eth1","lladdr":"AA:BB:CC:DD:EE:FF","state":["REACHABLE"]},
            {"dst":"10.0.0.6","dev":"eth1","state":["FAILED"]},
            {"dst":"10.0.0.7","dev":"eth1","lladdr":"11:22:33:44:55:66","state":["STALE"]},
            {"dst":"fe80::1","dev":"eth1","lladdr":"aa:aa:aa:aa:aa:aa","state":[]}
        ]"#;
        let n = parse(json).unwrap();
        assert_eq!(n.len(), 3); // the MAC-less FAILED entry is dropped
        assert_eq!(n[0], Neighbor { ip: "10.0.0.5".into(), mac: "aa:bb:cc:dd:ee:ff".into(), dev: "eth1".into(), state: "REACHABLE".into() });
        assert_eq!(n[2].state, "NONE"); // empty state array
    }

    #[test]
    fn empty_table() {
        assert!(parse("[]").unwrap().is_empty());
    }
}
