//! Runtime configuration, loaded from `/etc/qfdevd/qfdevd.toml`.
//!
//! Same contract as the other QuartzFire daemons: an absent file falls back to
//! the built-in defaults (useful for `cargo run` on a dev box), and every field
//! has a `default` so a partial file only overrides what it names.

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Shared device inventory (SQLite, WAL). Lives under `/config` so it
    /// survives image-based upgrades; the WebUI backend opens the same file
    /// read/write (it owns description edits) via its `quartzfire` group
    /// membership, so we create it group-writable.
    pub db_path: PathBuf,

    /// Runtime status snapshot for the unprivileged WebUI backend (collector
    /// health, last poll times, row counts). On tmpfs — recreated every boot.
    pub status_path: PathBuf,

    /// How often to poll the neighbor table (`ip -j neigh show`). The spec's
    /// 15–30s window; drives online/offline transitions.
    pub neigh_interval_secs: u64,

    /// How often to read Kea leases (IP/MAC/hostname/expiry).
    pub lease_interval_secs: u64,

    /// How often to snapshot `conntrack -L` for long-lived-flow byte deltas.
    /// Short-lived flows are accounted from DESTROY events instead, so this can
    /// be relaxed without hurting iperf-style accuracy.
    pub conntrack_snapshot_secs: u64,

    /// A device counts as Online if its neighbor entry is REACHABLE/DELAY/PROBE
    /// or it has passed traffic (last_seen) within this many seconds.
    pub online_timeout_secs: u64,

    /// How often to roll the prune + status pass.
    pub maintenance_interval_secs: u64,

    /// Drop usage buckets older than this many days.
    pub usage_retention_days: u64,

    /// Keep per-flow (service tuple) byte buckets this many seconds — the
    /// WebUI's Traffic Flow page reads them for its live Sankey, so minutes to
    /// an hour is the useful range; they are far higher cardinality than the
    /// per-device buckets. 0 disables per-flow recording entirely.
    pub flow_retention_secs: u64,

    /// Drop devices not seen for this many days (0 disables device pruning).
    pub device_retention_days: u64,

    /// Kea DHCPv4 memfile lease CSV (the fallback the spec calls for; the
    /// control socket path below is preferred when present).
    pub kea_lease_file: PathBuf,

    /// Kea DHCPv4 control socket (`lease4-get-all`). Empty = use the CSV only.
    pub kea_control_socket: PathBuf,

    /// IEEE OUI registry (from the `ieee-data` Debian package) for MAC vendor
    /// lookup. Empty or absent = vendors show as unknown.
    pub oui_file: PathBuf,

    /// App Control's published catalog. We read the ct-mark bit layout from it
    /// so per-application usage decodes APP_ID the way qfappd encoded it.
    /// Absent (App Control not installed) = no per-app attribution.
    pub appcontrol_catalog_file: PathBuf,

    /// LAN interface prefixes the collectors trust. A neighbor/flow on an
    /// interface whose name starts with one of these is treated as a client;
    /// empty = trust every non-loopback interface. Keeps WAN peers and the
    /// upstream gateway out of the client list.
    pub lan_interface_prefixes: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            db_path: PathBuf::from("/config/quartzfire/devices.db"),
            status_path: PathBuf::from("/run/qfdevd/status.json"),
            neigh_interval_secs: 20,
            lease_interval_secs: 30,
            conntrack_snapshot_secs: 30,
            online_timeout_secs: 300,
            maintenance_interval_secs: 3600,
            usage_retention_days: 30,
            flow_retention_secs: 3_600,
            device_retention_days: 90,
            kea_lease_file: PathBuf::from("/config/dhcp/dhcpv4-leases.csv"),
            kea_control_socket: PathBuf::from("/run/kea/kea4-ctrl-socket"),
            oui_file: PathBuf::from("/usr/share/ieee-data/oui.txt"),
            appcontrol_catalog_file: PathBuf::from("/run/qfappd/catalog.json"),
            lan_interface_prefixes: Vec::new(),
        }
    }
}

impl Config {
    /// Load config from `path`, falling back to defaults if the file is absent.
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(toml::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::warn!("config {} not found, using defaults", path.display());
                Ok(Self::default())
            }
            Err(e) => Err(anyhow::anyhow!("reading config {}: {e}", path.display())),
        }
    }

    /// Whether `iface` is a LAN-side (client) interface under this config.
    /// An empty prefix list trusts every interface except loopback.
    pub fn is_lan_interface(&self, iface: &str) -> bool {
        if iface.is_empty() || iface == "lo" {
            return false;
        }
        if self.lan_interface_prefixes.is_empty() {
            return true;
        }
        self.lan_interface_prefixes
            .iter()
            .any(|p| !p.is_empty() && iface.starts_with(p.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_config_is_defaults() {
        let cfg: Config = toml::from_str("").unwrap();
        assert_eq!(cfg.online_timeout_secs, 300);
        assert_eq!(cfg.db_path, PathBuf::from("/config/quartzfire/devices.db"));
    }

    #[test]
    fn partial_config_overrides_only_named_fields() {
        let cfg: Config = toml::from_str("online_timeout_secs = 60\n").unwrap();
        assert_eq!(cfg.online_timeout_secs, 60);
        // Untouched field keeps its default.
        assert_eq!(cfg.neigh_interval_secs, 20);
    }

    #[test]
    fn lan_interface_filter() {
        let mut cfg = Config::default();
        assert!(cfg.is_lan_interface("eth1"));
        assert!(!cfg.is_lan_interface("lo"));
        assert!(!cfg.is_lan_interface(""));
        cfg.lan_interface_prefixes = vec!["eth1".into(), "br".into()];
        assert!(cfg.is_lan_interface("eth1"));
        assert!(cfg.is_lan_interface("br0"));
        assert!(!cfg.is_lan_interface("eth0"));
        assert!(!cfg.is_lan_interface("pppoe0"));
    }
}
