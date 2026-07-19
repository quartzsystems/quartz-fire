use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::PathBuf;

/// Runtime configuration, loaded from `/etc/quartzfire/webui.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Address the axum server binds to. nginx reverse-proxies to this.
    #[serde(default = "default_listen")]
    pub listen: String,

    /// Base URL of the local VyOS HTTP API (`vyos-http-api-tools`).
    #[serde(default = "default_vyos_api_url")]
    pub vyos_api_url: String,

    /// File containing the VyOS API key. Kept out of the config so it can be
    /// managed / permissioned separately (mode 0600, root-only).
    #[serde(default = "default_key_file")]
    pub vyos_api_key_file: PathBuf,

    /// Directory holding the exported Next.js frontend.
    #[serde(default = "default_www_root")]
    pub www_root: PathBuf,

    /// File holding the JWT session-signing secret. Generated on first start
    /// if absent; the systemd unit's `StateDirectory=` makes it writable.
    #[serde(default = "default_jwt_secret_file")]
    pub jwt_secret_file: PathBuf,

    /// Mark the session cookie `Secure` (HTTPS-only). True in production —
    /// nginx always terminates TLS; set false only for plain-HTTP local dev.
    #[serde(default = "default_cookie_secure")]
    pub cookie_secure: bool,

    /// Session (JWT + cookie) lifetime in hours.
    #[serde(default = "default_session_hours")]
    pub session_hours: u64,

    /// Desired IPS state, applied by the root `ips-apply` helper. Lives under
    /// `/config` so it survives image upgrades. The webui unit grants write
    /// access via `ReadWritePaths=`; the helper's boot run creates the
    /// directory group-writable.
    #[serde(default = "default_ips_settings_file")]
    pub ips_settings_file: PathBuf,

    /// The helper's last apply report (read-only for us).
    #[serde(default = "default_ips_status_file")]
    pub ips_status_file: PathBuf,

    /// Directory the commit-confirm guard stages config files in (snapshot
    /// reverts, restores, rollbacks). Must be writable by us AND readable by
    /// the root VyOS API process (`config-file load` takes a path) — the
    /// shared `/config/quartzfire` dir fits; `PrivateTmp` rules out /tmp.
    #[serde(default = "default_guard_dir")]
    pub guard_dir: PathBuf,

    /// Persistent EVE alert log Suricata writes (read-only for us) — where
    /// alerts live across reboots; backs /api/ips/alerts/history.
    #[serde(default = "default_ips_alerts_file")]
    pub ips_alerts_file: PathBuf,

    /// Desired Application Control state, applied by the root `qfappd-apply`
    /// helper. Lives under `/config` so it survives image upgrades (same
    /// contract as the IPS settings file).
    #[serde(default = "default_appcontrol_settings_file")]
    pub appcontrol_settings_file: PathBuf,

    /// qfappd's runtime status snapshot (read-only for us): policy generation,
    /// last error, per-queue counters, classification stats.
    #[serde(default = "default_appcontrol_status_file")]
    pub appcontrol_status_file: PathBuf,

    /// qfappd's nDPI application catalog, written at daemon startup (read-only
    /// for us) — backs the Actions editor's category/app tree.
    #[serde(default = "default_appcontrol_catalog_file")]
    pub appcontrol_catalog_file: PathBuf,

    /// qfappd's persistent decision-event log (read-only for us) — backs
    /// /api/appcontrol/alerts/history across reboots.
    #[serde(default = "default_appcontrol_events_file")]
    pub appcontrol_events_file: PathBuf,

    /// qfappd-apply's last-run report (read-only for us). Validation happens
    /// before the policy reaches qfappd, so a refused desired state is only
    /// visible here — qfappd's own status shows no error for it.
    #[serde(default = "default_appcontrol_apply_file")]
    pub appcontrol_apply_file: PathBuf,

    /// Geolocation status report (read-only for us), merged by the root
    /// geoip-apply/geoip-update helpers: database version, last update,
    /// signature status, apply result, per-set entry counts, policy errors.
    #[serde(default = "default_geoip_status_file")]
    pub geoip_status_file: PathBuf,

    /// Per-action geolocation hit counters (read-only), dumped by the
    /// quartzfire-geoip-counters timer while the qz_geo table is loaded.
    #[serde(default = "default_geoip_counters_file")]
    pub geoip_counters_file: PathBuf,

    /// Selectable country list dumped from the libloc database (read-only);
    /// absent until the first successful database download.
    #[serde(default = "default_geoip_countries_file")]
    pub geoip_countries_file: PathBuf,

    /// Active-connections-by-country sample (read-only), dumped by the
    /// quartzfire-geoip-traffic timer; feeds the Geolocation Map globe.
    #[serde(default = "default_geoip_traffic_file")]
    pub geoip_traffic_file: PathBuf,

    /// "Update now" trigger file watched by quartzfire-geoip-update-request
    /// .path. Lives under /config/quartzfire (writable for us) like the other
    /// desired-state files.
    #[serde(default = "default_geoip_update_request_file")]
    pub geoip_update_request_file: PathBuf,

    /// The unprivileged IP → country lookup helper (quartzfire-geoip).
    #[serde(default = "default_geoip_lookup_helper")]
    pub geoip_lookup_helper: PathBuf,

    /// SSL-inspection status report (read-only for us), written by the root
    /// qzssl helpers: squid/bump/icap/certgen state, ICAP health, CA metadata,
    /// last apply result. Never contains key material.
    #[serde(default = "default_ssl_status_file")]
    pub ssl_status_file: PathBuf,

    /// Public inspection-CA metadata (`ca-info.json`, read-only) — subject,
    /// SHA-256 fingerprint, validity, serial. No private key.
    #[serde(default = "default_ssl_ca_info_file")]
    pub ssl_ca_info_file: PathBuf,

    /// The PUBLIC inspection CA in PEM (`ca.crt`) and DER (`ca.der`) for client
    /// download. Never point these at ca.key.
    #[serde(default = "default_ssl_ca_crt")]
    pub ssl_ca_crt: PathBuf,
    #[serde(default = "default_ssl_ca_der")]
    pub ssl_ca_der: PathBuf,

    /// "Regenerate CA" trigger file watched by quartzfire-ssl-caregen.path.
    /// Lives under /config/quartzfire (writable for us).
    #[serde(default = "default_ssl_regen_request_file")]
    pub ssl_regen_request_file: PathBuf,

    // ── Content Filtering (quartzfire-content-filtering, qfcf helpers) ──────
    /// e2guardian/ICAP/updater state (read-only), written by root qfcf helpers.
    #[serde(default = "default_cf_status_file")]
    pub cf_status_file: PathBuf,
    /// Blocklist-update trigger file watched by quartzfire-cf-update-request.path
    /// (under /config/quartzfire, writable for us).
    #[serde(default = "default_cf_update_request_file")]
    pub cf_update_request_file: PathBuf,
    /// JSON access-log feed (read-only) written by qfcf-logfeed.
    #[serde(default = "default_cf_log_file")]
    pub cf_log_file: PathBuf,
    /// qfcf helper symlinks used by the status/test/categories endpoints.
    #[serde(default = "default_cf_status_helper")]
    pub cf_status_helper: PathBuf,
    #[serde(default = "default_cf_categories_helper")]
    pub cf_categories_helper: PathBuf,
    #[serde(default = "default_cf_testurl_helper")]
    pub cf_testurl_helper: PathBuf,

    // ── Device Monitoring (qfdevd) ──────────────────────────────────────────
    /// Shared device inventory (SQLite, WAL) qfdevd maintains and we read for
    /// Monitoring → Devices. Under /config so it survives image upgrades; the
    /// backend reaches it via the `quartzfire` group (qfdevd makes the file
    /// group-writable) and writes only the user-assigned `description`.
    #[serde(default = "default_devices_db_file")]
    pub devices_db_file: PathBuf,

    /// qfdevd's runtime status snapshot (read-only for us): collector health,
    /// last poll times, device count. Null-tolerant — absent until qfdevd runs.
    #[serde(default = "default_qfdevd_status_file")]
    pub qfdevd_status_file: PathBuf,

    /// A device is Online if its neighbor entry is REACHABLE/DELAY/PROBE or it
    /// passed traffic within this many seconds. Recomputed at query time so the
    /// list is fresh regardless of qfdevd's last online sweep.
    #[serde(default = "default_devices_online_timeout_secs")]
    pub devices_online_timeout_secs: u64,

    /// "Factory reset" trigger file watched by quartzfire-factory-reset.path.
    /// Lives under /config/quartzfire (writable for us) like the other
    /// desired-state files. The backend only writes it; the root
    /// quartzfire-factory-reset helper overwrites /config/config.boot with the
    /// flavor default and reboots. We can't touch /config/config.boot or
    /// reboot ourselves (DynamicUser), so this is the seam.
    #[serde(default = "default_factory_reset_request_file")]
    pub factory_reset_request_file: PathBuf,

    /// Per-user dashboard tile layouts (a WebUI preference), keyed by username.
    /// Lives under /config so a saved layout survives image upgrades, and is
    /// writable for us via the unit's ReadWritePaths — same contract as the
    /// other desired-state files. Not part of VyOS config: it is UI state, not
    /// device config, so it never touches the config tree or its backups.
    #[serde(default = "default_dashboard_layouts_file")]
    pub dashboard_layouts_file: PathBuf,
}

fn default_listen() -> String {
    // Loopback-only; nginx reverse-proxies to this. Deliberately NOT 8443 —
    // that is e2guardian's stock `transparenthttpsport`, and a stock-config
    // e2guardian (Content Filtering) would steal the port and crash-loop the
    // backend. Kept clear of e2guardian (8080/8443), Squid (3128/9), ICAP (1344).
    "127.0.0.1:8181".to_string()
}
fn default_vyos_api_url() -> String {
    // The VyOS HTTPS API serves TLS itself; QuartzFire pins it to loopback on
    // a dedicated port (register-api-key injects `service https listen-address
    // 127.0.0.1` + `port 4443`) so nginx keeps sole ownership of :443. reqwest
    // is configured to accept the self-signed cert on localhost.
    "https://127.0.0.1:4443".to_string()
}
fn default_key_file() -> PathBuf {
    PathBuf::from("/etc/quartzfire/vyos-api.key")
}
fn default_www_root() -> PathBuf {
    PathBuf::from("/usr/share/quartzfire-webui/www")
}
fn default_jwt_secret_file() -> PathBuf {
    PathBuf::from("/var/lib/quartzfire-webui/jwt.secret")
}
fn default_cookie_secure() -> bool {
    true
}
fn default_ips_settings_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/ips.json")
}
fn default_ips_status_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-ips/status.json")
}
fn default_ips_alerts_file() -> PathBuf {
    PathBuf::from("/var/log/quartzfire/ips-alerts.json")
}
fn default_appcontrol_settings_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/appcontrol.json")
}
fn default_appcontrol_status_file() -> PathBuf {
    PathBuf::from("/run/qfappd/status.json")
}
fn default_appcontrol_catalog_file() -> PathBuf {
    PathBuf::from("/run/qfappd/catalog.json")
}
fn default_appcontrol_events_file() -> PathBuf {
    PathBuf::from("/var/log/qfappd/events.json")
}
fn default_appcontrol_apply_file() -> PathBuf {
    PathBuf::from("/run/qfappd/apply.json")
}
fn default_geoip_status_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-geoip/status.json")
}
fn default_geoip_counters_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-geoip/counters.json")
}
fn default_geoip_countries_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-geoip/countries.json")
}
fn default_geoip_traffic_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-geoip/traffic.json")
}
fn default_geoip_update_request_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/geoip-update-request")
}
fn default_geoip_lookup_helper() -> PathBuf {
    PathBuf::from("/usr/libexec/quartzfire/geoip-lookup")
}
fn default_ssl_status_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-ssl/status.json")
}
fn default_ssl_ca_info_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-ssl/ca-info.json")
}
fn default_ssl_ca_crt() -> PathBuf {
    PathBuf::from("/config/quartzfire/ssl-inspection/ca.crt")
}
fn default_ssl_ca_der() -> PathBuf {
    PathBuf::from("/config/quartzfire/ssl-inspection/ca.der")
}
fn default_ssl_regen_request_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/ssl-regen-request")
}
fn default_cf_status_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-content-filtering/status.json")
}
fn default_cf_update_request_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/content-filtering-update-request")
}
fn default_cf_log_file() -> PathBuf {
    PathBuf::from("/var/log/quartzfire/content-filtering.json")
}
fn default_cf_status_helper() -> PathBuf {
    PathBuf::from("/usr/libexec/quartzfire/qfcf-status")
}
fn default_cf_categories_helper() -> PathBuf {
    PathBuf::from("/usr/libexec/quartzfire/qfcf-categories")
}
fn default_cf_testurl_helper() -> PathBuf {
    PathBuf::from("/usr/libexec/quartzfire/qfcf-testurl")
}
fn default_dashboard_layouts_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/dashboards.json")
}
fn default_factory_reset_request_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/factory-reset-request")
}
fn default_devices_db_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/devices.db")
}
fn default_qfdevd_status_file() -> PathBuf {
    PathBuf::from("/run/qfdevd/status.json")
}
fn default_devices_online_timeout_secs() -> u64 {
    300
}
fn default_guard_dir() -> PathBuf {
    PathBuf::from("/config/quartzfire")
}
fn default_session_hours() -> u64 {
    24
}
impl Config {
    /// Load config from `path`, falling back to built-in defaults if the file
    /// is absent (useful for local `cargo run`).
    pub fn load(path: &str) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                toml::from_str(&text).with_context(|| format!("parsing config {path}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::warn!("config {path} not found, using defaults");
                Ok(toml::from_str("").unwrap())
            }
            Err(e) => Err(e).with_context(|| format!("reading config {path}")),
        }
    }

    /// Read the VyOS API key from `vyos_api_key_file`, trimming whitespace.
    /// Returns an empty string if the file is missing (dev mode / API disabled).
    pub fn read_api_key(&self) -> String {
        std::fs::read_to_string(&self.vyos_api_key_file)
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The backend listen port must not collide with any local daemon that
    /// might squat it and crash-loop the backend. Regression guard for the
    /// 2026-07-13 outage where e2guardian's stock `transparenthttpsport = 8443`
    /// stole the port. Keep clear of e2guardian (8080/8443), Squid (3128/9),
    /// ICAP (1344).
    #[test]
    fn default_listen_avoids_colliding_ports() {
        let listen = default_listen();
        for banned in ["8443", "8080", "3128", "3129", "1344"] {
            assert!(
                !listen.ends_with(&format!(":{banned}")),
                "backend listen {listen} collides with a known local daemon port :{banned}"
            );
        }
    }

    /// An empty config file must fall back to the built-in defaults (used by
    /// `Config::load` when the file is absent), and that fallback must carry the
    /// non-colliding listen port.
    #[test]
    fn empty_config_uses_noncolliding_default_listen() {
        let cfg: Config = toml::from_str("").unwrap();
        assert_eq!(cfg.listen, "127.0.0.1:8181");
    }
}
