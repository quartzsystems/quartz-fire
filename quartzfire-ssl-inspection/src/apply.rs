//! Orchestration: turn the desired model into a live Squid ssl_bump setup —
//! the CA, the certgen DB, the drop-in fragment, and the qz_ssl nftables
//! steering — then report health to status.json for the WebUI.
//!
//! Callers (see commands.rs):
//!   * the conf-mode owner's apply stage (fresh session config, synchronous —
//!     failures are reported on the commit);
//!   * `qzssl-apply` standalone (boot resync + the /run/nftables.conf path unit
//!     re-run, so the redirect survives VyOS firewall commits);
//!   * `qzssl-status` (probe only, no changes).
//!
//! File contract (also in docs/design.md):
//!   /etc/squid/conf.d/quartzfire-ssl-inspection.conf  the rendered fragment
//!   /config/quartzfire/ssl-inspection/{ca.crt,ca.key,ca.der,no-inspect.txt}
//!   /run/quartzfire-ssl/desired.json   committed model (standalone resync src)
//!   /run/quartzfire-ssl/status.json    squid/icap/ca/apply status for the WebUI
//!   /run/quartzfire-ssl/ca-info.json   public CA metadata (no key), for the WebUI
//!   /run/quartzfire-ssl/active         marker: inspection is loaded

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::Write as _;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ca;
use crate::capcheck::{self, Caps};
use crate::config::{self, ConfigRead};
use crate::matchrepl::rule_match_expr;
use crate::model::Model;
use crate::render;

pub const RUN_DIR: &str = "/run/quartzfire-ssl";
pub const SQUID_FRAGMENT: &str = "/etc/squid/conf.d/quartzfire-ssl-inspection.conf";
pub const NO_INSPECT_FILE: &str = "/config/quartzfire/ssl-inspection/no-inspect.txt";
pub const SECURITY_FILE_CERTGEN: &str = "/usr/lib/squid/security_file_certgen";
pub const SSL_DB_DIR: &str = "/var/lib/squid/ssl_db";

pub fn status_file() -> PathBuf {
    Path::new(RUN_DIR).join("status.json")
}
pub fn ca_info_file() -> PathBuf {
    Path::new(RUN_DIR).join("ca-info.json")
}
pub fn desired_file() -> PathBuf {
    Path::new(RUN_DIR).join("desired.json")
}
pub fn active_mark() -> PathBuf {
    Path::new(RUN_DIR).join("active")
}

#[derive(Debug)]
pub struct ApplyError(pub String);
impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ApplyError {}

pub struct Report {
    pub ok: bool,
    pub error: Option<String>,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Atomic write (temp + rename): readers/watchers never see a half document.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), ApplyError> {
    let dir = path
        .parent()
        .ok_or_else(|| ApplyError(format!("{} has no parent directory", path.display())))?;
    fs::create_dir_all(dir).map_err(|e| ApplyError(format!("creating {}: {e}", dir.display())))?;
    let tmp = path.with_extension("qz-tmp");
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| ApplyError(format!("writing {}: {e}", tmp.display())))?;
        f.write_all(text.as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(|e| ApplyError(format!("writing {}: {e}", tmp.display())))?;
    }
    fs::rename(&tmp, path).map_err(|e| ApplyError(format!("activating {}: {e}", path.display())))
}

/// Merge top-level sections into status.json.
pub fn update_status(patch: Value) {
    let mut status: Value = fs::read_to_string(status_file())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    if let (Some(obj), Some(patch_obj)) = (status.as_object_mut(), patch.as_object()) {
        for (key, value) in patch_obj {
            obj.insert(key.clone(), value.clone());
        }
    }
    let _ = write_atomic(&status_file(), &serde_json::to_string_pretty(&status).unwrap());
}

// ── match resolution ──────────────────────────────────────────────────────────

/// A policy whose firewall rule is gone or uses a construct that cannot be
/// replicated into the prerouting redirect (e.g. outbound-interface). Surfaced
/// in status.json; at commit time any such problem aborts the commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Problem {
    pub policy: u32,
    pub error: String,
}

/// Everything the renderer needs beyond the model: each enabled policy's
/// replicated rule match (keyed by rule number; None = unresolved/skipped), the
/// problems to surface, and the effective CA-download interface scope. Snapshotted
/// into desired.json so the resync path can re-apply even mid-firewall-commit.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Resolved {
    #[serde(default)]
    pub matches: BTreeMap<u32, Option<String>>,
    #[serde(default)]
    pub problems: Vec<Problem>,
    #[serde(default)]
    pub ca_scope: Vec<String>,
}

/// The interface names a rule's inbound-interface node resolves to (literal
/// name, or an interface-group's members) — used only to derive a default
/// CA-download scope from the bound rules.
fn inbound_ifaces(cfg: &crate::matchrepl::RuleCfg, groups: &crate::matchrepl::Groups) -> Vec<String> {
    let Some(spec) = &cfg.inbound_interface else { return Vec::new() };
    if let Some(name) = &spec.name {
        return vec![name.clone()];
    }
    if let Some(g) = &spec.group {
        return groups
            .get("interface-group")
            .and_then(|m| m.get(g))
            .and_then(|m| m.get("interface"))
            .cloned()
            .unwrap_or_default();
    }
    Vec::new()
}

/// Resolve every enabled policy's replicated firewall-rule match.
///
/// `conf`: a live config view (session at commit, active at resync) — resolves
/// fresh. `snapshot`: the previous desired.json Resolved, used when no config
/// view is available (a path-unit run racing a commit). A None match means the
/// renderer skips that policy; the problem is surfaced either way.
pub fn resolve(
    model: &Model,
    conf: Option<&dyn ConfigRead>,
    snapshot: Option<&Resolved>,
) -> Resolved {
    let Some(conf) = conf else {
        // No config view: reuse the last snapshot verbatim, or (first boot with
        // nothing committed) leave everything unresolved.
        if let Some(snap) = snapshot {
            return snap.clone();
        }
        let problems = model
            .policies
            .iter()
            .filter(|p| p.enabled)
            .map(|p| Problem { policy: p.rule, error: "no configuration view available".into() })
            .collect();
        return Resolved { matches: BTreeMap::new(), problems, ca_scope: Vec::new() };
    };

    let groups = config::read_groups(conf);
    let mut matches = BTreeMap::new();
    let mut problems = Vec::new();
    let mut derived_ifaces: BTreeSet<String> = BTreeSet::new();
    for policy in &model.policies {
        if !policy.enabled {
            continue;
        }
        match config::read_rule_cfg(conf, &policy.ruleset, policy.rule) {
            None => {
                matches.insert(policy.rule, None);
                problems.push(Problem {
                    policy: policy.rule,
                    error: format!(
                        "target firewall ipv4 {} filter rule {} does not exist",
                        policy.ruleset, policy.rule
                    ),
                });
            }
            Some(cfg) => match rule_match_expr(&cfg, &groups) {
                Ok(expr) => {
                    derived_ifaces.extend(inbound_ifaces(&cfg, &groups));
                    matches.insert(policy.rule, Some(expr));
                }
                Err(e) => {
                    matches.insert(policy.rule, None);
                    problems.push(Problem { policy: policy.rule, error: e.0 });
                }
            },
        }
    }

    // CA-download scope: the explicit list wins; otherwise default to the
    // inbound interfaces of the bound rules (the LANs inspection runs on).
    let ca_scope = if model.ca_download_interfaces.is_empty() {
        derived_ifaces.into_iter().collect()
    } else {
        model.ca_download_interfaces.clone()
    };
    Resolved { matches, problems, ca_scope }
}

// ── desired-state snapshot ────────────────────────────────────────────────────

pub fn save_desired(model: &Model, resolved: &Resolved) -> Result<(), ApplyError> {
    let body = json!({ "generated_at": now(), "model": model, "resolved": resolved });
    write_atomic(&desired_file(), &serde_json::to_string_pretty(&body).unwrap())
}

pub fn load_desired() -> Result<Option<(Model, Resolved)>, ApplyError> {
    match fs::read_to_string(desired_file()) {
        Ok(text) => {
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| ApplyError(format!("corrupt {}: {e}", desired_file().display())))?;
            let model = serde_json::from_value(v.get("model").cloned().unwrap_or(Value::Null))
                .map_err(|e| ApplyError(format!("corrupt model in desired.json: {e}")))?;
            // `resolved` is absent in snapshots written before per-rule policies;
            // default to empty so an old snapshot still loads (renders no redirect).
            let resolved = serde_json::from_value(v.get("resolved").cloned().unwrap_or(Value::Null))
                .unwrap_or_default();
            Ok(Some((model, resolved)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ApplyError(format!("reading {}: {e}", desired_file().display()))),
    }
}

// ── probes ────────────────────────────────────────────────────────────────────

fn squid_running() -> bool {
    Command::new("systemctl")
        .args(["is-active", "--quiet", "squid"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The certgen DB is initialized once; index.txt is the marker security_file_certgen writes.
fn certgen_db_ready() -> bool {
    Path::new(SSL_DB_DIR).join("index.txt").exists()
}

/// Best-effort primary IPv4 of an interface — the address clients on that LAN
/// actually reach the plain-HTTP CA-download page (:4126) on. Used only to fill
/// the WebUI's install hint; None when the interface has no IPv4 (e.g. DHCP not
/// up yet) or `ip` is unavailable.
fn iface_ipv4(name: &str) -> Option<String> {
    let out = Command::new("ip")
        .args(["-o", "-4", "addr", "show", "dev", name])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // "2: eth1    inet 10.160.0.1/24 brd ... scope global eth1"
    for line in text.lines() {
        let mut it = line.split_whitespace();
        while let Some(tok) = it.next() {
            if tok == "inet" {
                if let Some(cidr) = it.next() {
                    return Some(cidr.split('/').next().unwrap_or(cidr).to_string());
                }
            }
        }
    }
    None
}

/// One-shot TCP reachability probe with a short timeout.
fn tcp_reachable(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    match addr.to_socket_addrs() {
        Ok(mut addrs) => addrs.any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(800)).is_ok()),
        Err(_) => false,
    }
}

// ── system actions ────────────────────────────────────────────────────────────

/// Initialize the certificate-generation DB once (idempotent).
fn ensure_certgen_db() -> Result<(), ApplyError> {
    if certgen_db_ready() {
        return Ok(());
    }
    // security_file_certgen -c creates the ssl_db directory itself, but NOT its
    // parent, and it refuses to run if the target directory already exists. On
    // a real box /var/lib/squid is often absent (the Debian squid cache lives
    // under /var/spool/squid, not here) and a previous half-init can leave a
    // partial ssl_db with no index.txt — either one makes `-c` fail with the
    // opaque error the operator saw. Create the parent and clear any partial
    // store first, exactly as the proven container smoke test does.
    if let Some(parent) = Path::new(SSL_DB_DIR).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApplyError(format!("creating {}: {e}", parent.display())))?;
    }
    if Path::new(SSL_DB_DIR).exists() {
        let _ = fs::remove_dir_all(SSL_DB_DIR);
    }
    // security_file_certgen -c creates the DB; -M 8MB caps the on-disk store.
    let out = Command::new(SECURITY_FILE_CERTGEN)
        .args(["-c", "-s", SSL_DB_DIR, "-M", "8MB"])
        .output()
        .map_err(|e| ApplyError(format!("running security_file_certgen: {e}")))?;
    if !out.status.success() {
        // Surface the helper's own stderr — the bare "…-c failed" that shipped
        // before gave the operator nothing to act on.
        let detail = String::from_utf8_lossy(&out.stderr);
        let detail = detail.trim();
        return Err(ApplyError(if detail.is_empty() {
            "security_file_certgen -c failed".to_string()
        } else {
            format!("security_file_certgen -c failed: {detail}")
        }));
    }
    // The store must be owned by the squid runtime user.
    let _ = Command::new("chown").args(["-R", "proxy:proxy", SSL_DB_DIR]).status();
    Ok(())
}

/// `squid -k parse` validates the config without touching the running service.
fn squid_config_valid() -> Result<(), ApplyError> {
    let out = Command::new("squid").args(["-k", "parse"]).output();
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(ApplyError(format!(
            "squid rejected the generated config: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ))),
        Err(e) => Err(ApplyError(format!("cannot run squid to validate config: {e}"))),
    }
}

/// Reconfigure a running Squid, or start it if it is not running.
fn reload_squid() -> Result<(), ApplyError> {
    if squid_running() {
        let s = Command::new("squid").args(["-k", "reconfigure"]).status();
        if matches!(s, Ok(st) if st.success()) {
            return Ok(());
        }
        // Fall through to a full restart if reconfigure fails.
    }
    let s = Command::new("systemctl")
        .args(["restart", "squid"])
        .status()
        .map_err(|e| ApplyError(format!("restarting squid: {e}")))?;
    if s.success() {
        Ok(())
    } else {
        Err(ApplyError("systemctl restart squid failed".to_string()))
    }
}

/// Start or stop the CA-distribution listener. It is NOT enabled at boot — we
/// own its lifecycle here so that when inspection is disabled (or was never
/// configured) the plain-HTTP :4126 port is simply not bound anywhere. When
/// enabled, the qz_ssl input guard (loaded before this) restricts it to the
/// trusted interfaces.
fn set_cadist(on: bool) {
    let verb = if on { "enable" } else { "disable" };
    let _ = Command::new("systemctl")
        .args([verb, "--now", "quartzfire-ssl-cadist.service"])
        .status();
}

/// Load (or, when disabled, delete) the qz_ssl nftables table via `nft -f -`.
fn load_nft(ruleset: &str) -> Result<(), ApplyError> {
    let mut child = Command::new("nft")
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ApplyError(format!("spawning nft: {e}")))?;
    child
        .stdin
        .take()
        .ok_or_else(|| ApplyError("nft stdin unavailable".to_string()))?
        .write_all(ruleset.as_bytes())
        .map_err(|e| ApplyError(format!("writing nft ruleset: {e}")))?;
    let out = child
        .wait_with_output()
        .map_err(|e| ApplyError(format!("waiting on nft: {e}")))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(ApplyError(format!(
            "nft rejected the qz_ssl ruleset: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

// ── apply ─────────────────────────────────────────────────────────────────────

/// Bring the system in line with `model` + its `resolved` matches. `caps` is the
/// live squid probe (None off-device). Writes status.json regardless of outcome.
pub fn apply_model(model: &Model, resolved: &Resolved, caps: Option<Caps>) -> Report {
    let result = apply_inner(model, resolved, caps);
    let (ok, error) = match &result {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e.0.clone())),
    };
    if ok && model.enabled {
        let _ = write_atomic(&active_mark(), "1\n");
    } else if !model.enabled {
        let _ = fs::remove_file(active_mark());
    }
    write_status(model, resolved, caps, ok, error.clone());
    Report { ok, error }
}

fn apply_inner(model: &Model, resolved: &Resolved, caps: Option<Caps>) -> Result<(), ApplyError> {
    if !model.enabled {
        // Teardown: neutralize the fragment and drop the steering table. Squid
        // keeps running (it may serve nothing, harmless); we just stop bumping.
        write_atomic(Path::new(SQUID_FRAGMENT), &render::squid_fragment(model))?;
        let _ = reload_squid();
        load_nft(&render::nft_ruleset(model, &resolved.matches, &resolved.ca_scope))?;
        // Close the plain-HTTP CA page — nothing to distribute when off.
        set_cadist(false);
        return Ok(());
    }

    // A build without bump support cannot inspect — refuse loudly (verify()
    // catches this at commit; this guards the standalone/boot path too).
    if matches!(caps, Some(c) if !c.bump) {
        return Err(ApplyError(
            "the installed Squid lacks OpenSSL ssl_bump support (install squid-openssl)".to_string(),
        ));
    }

    // CA (idempotent on first enable; Regenerate goes through `qzssl-ca`).
    ca::generate(false).map_err(|e| ApplyError(format!("CA: {e}")))?;
    ensure_certgen_db()?;

    write_atomic(Path::new(NO_INSPECT_FILE), &render::no_inspect_file(model))?;
    write_atomic(Path::new(SQUID_FRAGMENT), &render::squid_fragment(model))?;

    squid_config_valid()?;
    reload_squid()?;
    // Load the steering + CA-page guard BEFORE starting cadist, so :4126 is
    // firewalled to the trusted scope the moment it binds.
    load_nft(&render::nft_ruleset(model, &resolved.matches, &resolved.ca_scope))?;
    set_cadist(true);
    Ok(())
}

/// Compose and write status.json + ca-info.json for the WebUI.
pub fn write_status(
    model: &Model,
    resolved: &Resolved,
    caps: Option<Caps>,
    apply_ok: bool,
    apply_err: Option<String>,
) {
    let ca_info = ca::inspect().unwrap_or_default();
    let _ = write_atomic(&ca_info_file(), &serde_json::to_string_pretty(&ca_info).unwrap());

    let icap = match &model.content_filter {
        Some(cf) => json!({
            "configured": true,
            "endpoint": format!("{}:{}", cf.icap_host, cf.icap_port),
            "fail_mode": cf.fail_mode,
            "reachable": tcp_reachable(&cf.icap_host, cf.icap_port),
        }),
        None => json!({ "configured": false }),
    };

    // Per-policy view for the WebUI: rule, action, and whether its match
    // resolved (None ⇒ the accompanying problem explains why it isn't enforced).
    let policies: Vec<Value> = model
        .policies
        .iter()
        .map(|p| {
            let resolved_ok = matches!(resolved.matches.get(&p.rule), Some(Some(_)));
            json!({
                "rule": p.rule,
                "ruleset": p.ruleset,
                "action": p.action,
                "enabled": p.enabled,
                "resolved": resolved_ok,
            })
        })
        .collect();

    let status = json!({
        "enabled": model.enabled,
        "squid": {
            "running": squid_running(),
            "bump_capable": caps.map(|c| c.bump),
            "icap_capable": caps.map(|c| c.icap),
        },
        "certgen_db_ready": certgen_db_ready(),
        "intercept_port": model.intercept_port,
        "policies": policies,
        "problems": resolved.problems,
        "default_action": model.default_action,
        "no_inspect_count": render::no_inspect_list(model).len(),
        "upstream_invalid": model.upstream_invalid,
        "icap": icap,
        "ca": ca_info,
        "ca_download": {
            "port": 4126u16,
            "interfaces": &resolved.ca_scope,
            // Resolved LAN IPs of the CA-download interfaces, so the WebUI can
            // show the address clients actually reach :4126 on (not the admin's
            // management IP).
            "addresses": resolved.ca_scope.iter().filter_map(|i| iface_ipv4(i)).collect::<Vec<_>>(),
        },
        "apply": { "time": now(), "ok": apply_ok, "error": apply_err },
    });
    let _ = write_atomic(&status_file(), &serde_json::to_string_pretty(&status).unwrap());
}

/// Finalize a CA (re)generation: a fresh root invalidates every mimicked leaf
/// cached in the certgen DB, so clear and re-init it, reload Squid, and refresh
/// status/ca-info from the committed model. Best-effort — a regenerate should
/// never hard-fail just because Squid is not currently running.
pub fn post_ca_change() {
    let _ = fs::remove_dir_all(SSL_DB_DIR);
    let _ = ensure_certgen_db();
    let _ = reload_squid();
    refresh_status();
}

/// Probe-only status refresh (qzssl-status), from the committed snapshot.
pub fn refresh_status() -> i32 {
    let (model, resolved) = load_desired().ok().flatten().unwrap_or_default();
    let caps = capcheck::probe();
    // Preserve the last apply result if present; this path only re-probes health.
    let last = fs::read_to_string(status_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let (ok, err) = last
        .as_ref()
        .and_then(|v| v.get("apply"))
        .map(|a| {
            (
                a.get("ok").and_then(|b| b.as_bool()).unwrap_or(false),
                a.get("error").and_then(|e| e.as_str()).map(String::from),
            )
        })
        .unwrap_or((false, None));
    write_status(&model, &resolved, caps, ok, err);
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigRead;
    use crate::model::Policy;

    #[test]
    fn desired_roundtrip_shape() {
        // save_desired/load_desired agree on the model + resolved fields.
        let m = Model {
            enabled: true,
            policies: vec![Policy { rule: 20, ruleset: "forward".into(), action: "inspect".into(), enabled: true }],
            ..Model::default()
        };
        let resolved = Resolved {
            matches: [(20u32, Some("iifname \"eth1\"".to_string()))].into_iter().collect(),
            ca_scope: vec!["eth1".into()],
            ..Default::default()
        };
        let body = json!({ "generated_at": now(), "model": &m, "resolved": &resolved });
        let text = serde_json::to_string(&body).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        let back: Model = serde_json::from_value(v.get("model").cloned().unwrap()).unwrap();
        let back_r: Resolved = serde_json::from_value(v.get("resolved").cloned().unwrap()).unwrap();
        assert!(back.enabled);
        assert_eq!(back.policies[0].rule, 20);
        assert_eq!(back_r.ca_scope, vec!["eth1"]);
        assert_eq!(back_r.matches.get(&20).unwrap().as_deref(), Some("iifname \"eth1\""));
    }

    /// Minimal in-memory config fake for resolve() (mirrors config.rs's fake).
    #[derive(Default)]
    struct Fake {
        present: std::collections::BTreeSet<String>,
        values: BTreeMap<String, String>,
    }
    impl Fake {
        fn key(p: &[&str]) -> String { p.join(" ") }
        fn set(&mut self, p: &[&str]) {
            for i in 1..=p.len() { self.present.insert(Self::key(&p[..i])); }
        }
        fn value(&mut self, p: &[&str], v: &str) { self.set(p); self.values.insert(Self::key(p), v.into()); }
    }
    impl ConfigRead for Fake {
        fn exists(&self, p: &[&str]) -> bool { self.present.contains(&Self::key(p)) }
        fn list_nodes(&self, _p: &[&str]) -> Vec<String> { Vec::new() }
        fn return_value(&self, p: &[&str]) -> Option<String> { self.values.get(&Self::key(p)).cloned() }
        fn return_values(&self, _p: &[&str]) -> Vec<String> { Vec::new() }
    }

    fn model_with(policies: Vec<Policy>) -> Model {
        Model { enabled: true, policies, ..Model::default() }
    }

    #[test]
    fn resolve_replicates_and_derives_ca_scope() {
        let mut f = Fake::default();
        let base = &["firewall", "ipv4", "forward", "filter", "rule", "20"];
        f.set(base);
        f.value(&["firewall", "ipv4", "forward", "filter", "rule", "20", "inbound-interface", "name"], "eth1");
        let m = model_with(vec![Policy { rule: 20, ruleset: "forward".into(), action: "inspect".into(), enabled: true }]);
        let r = resolve(&m, Some(&f), None);
        assert_eq!(r.matches.get(&20).unwrap().as_deref(), Some("iifname \"eth1\""));
        assert!(r.problems.is_empty());
        // CA scope defaults to the rule's inbound interface.
        assert_eq!(r.ca_scope, vec!["eth1"]);
    }

    #[test]
    fn resolve_flags_outbound_interface_rule() {
        let mut f = Fake::default();
        let base = &["firewall", "ipv4", "forward", "filter", "rule", "20"];
        f.set(base);
        f.value(&["firewall", "ipv4", "forward", "filter", "rule", "20", "outbound-interface", "name"], "eth0");
        let m = model_with(vec![Policy { rule: 20, ruleset: "forward".into(), action: "inspect".into(), enabled: true }]);
        let r = resolve(&m, Some(&f), None);
        assert!(matches!(r.matches.get(&20), Some(None)));
        assert!(r.problems.iter().any(|p| p.policy == 20 && p.error.contains("outbound-interface")));
    }

    #[test]
    fn resolve_flags_missing_rule() {
        let m = model_with(vec![Policy { rule: 99, ruleset: "forward".into(), action: "inspect".into(), enabled: true }]);
        let r = resolve(&m, Some(&Fake::default()), None);
        assert!(r.problems.iter().any(|p| p.policy == 99 && p.error.contains("does not exist")));
    }
}
