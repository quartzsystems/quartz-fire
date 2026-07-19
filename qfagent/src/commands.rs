//! The qfagent entry points other than the daemon itself:
//!
//!   commit            — conf-mode owner of `system quartz-command`
//!   scrub             — post-commit one-shot: remove the consumed
//!                       enroll-token from config, persist gateway+port
//!   status            — merged status (op-mode `show quartz-command status`,
//!                       `qf status`)
//!   identity regenerate / prepare-template — lifecycle (op-mode `qf …`)

use std::io::Write as _;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result};

use crate::identity::{HostFacts, IdentityStore};
use crate::state::{
    self, bump_trigger, ConfigSnapshot, ControlState, EnrollmentState, StatusDoc, TrustPath,
};
use crate::vyoscfg::{self, CliShellApi, ConfigRead};
use crate::{enroll, VERSION};

fn log(msg: &str) {
    eprintln!("qfagent: {msg}");
}

// ── commit (conf-mode owner) ──────────────────────────────────────────────────

/// Conf-mode owner of `system quartz-command`, following the vyos-1x stages:
/// verify (any stderr + exit 1 ABORTS the commit), generate (the config
/// snapshot the daemon runs from), apply (enrollment, when an enroll-token
/// is being committed).
///
/// Enrollment runs synchronously inside the commit so every failure aborts
/// it with an actionable message ON the committing terminal/WebUI — and an
/// aborted commit means the bad token never even enters the active config.
/// On success the token IS in the active config, so the owner bumps the
/// scrub trigger: a root one-shot (path unit) then deletes `enroll-token`
/// and persists the token's gateway+port, in its own config session (a
/// commit cannot modify the very session it is validating — see scrub()).
///
/// Boot replay: config.boot may still carry an already-consumed token if the
/// box saved/rebooted before the scrub landed. The state file records the
/// SHA-256 of the last consumed token; a matching replay is a no-op that
/// just re-arms the scrub.
pub fn commit(decision_only: bool) -> i32 {
    let conf = CliShellApi::session();
    match commit_inner(&conf, decision_only) {
        Ok(code) => code,
        Err(e) => {
            log(&format!("{e:#}"));
            1
        }
    }
}

/// What commit_inner decided to do — separated for tests.
#[derive(Debug, PartialEq, Eq)]
pub enum CommitAction {
    /// No token in the session config: snapshot settings, restart daemon.
    SettingsOnly,
    /// Token already consumed (boot replay): re-arm the scrub only.
    AlreadyEnrolled,
    /// Fresh token: run enrollment.
    Enroll,
}

pub fn decide(
    cfg: &vyoscfg::QuartzCommandConfig,
    st: &EnrollmentState,
) -> Result<CommitAction> {
    let Some(parsed) = cfg.parse_token() else {
        return Ok(CommitAction::SettingsOnly);
    };
    let token = parsed.map_err(|e| anyhow::anyhow!("{e}"))?;
    if st.enrolled && st.last_token_sha256.as_deref() == Some(token.sha256_hex.as_str()) {
        return Ok(CommitAction::AlreadyEnrolled);
    }
    Ok(CommitAction::Enroll)
}

fn commit_inner(conf: &dyn ConfigRead, decision_only: bool) -> Result<i32> {
    let cfg = vyoscfg::read_config(conf);

    // verify ── resolve the PKI reference and parse the token BEFORE any
    // side effect; problems abort the commit.
    let ca_pem = match &cfg.ca_certificate {
        Some(name) => Some(vyoscfg::resolve_pki_certificate(conf, name).with_context(|| {
            format!(
                "ca-certificate '{name}' does not exist under 'pki certificate' — \
                 load it first (set pki certificate {name} certificate …)"
            )
        })?),
        None => None,
    };
    let st = EnrollmentState::load(&state::state_file())?;
    let action = decide(&cfg, &st)?;
    if decision_only {
        // Test hook (`qfagent commit --decide`): print the decision, do nothing.
        println!("{action:?}");
        return Ok(0);
    }

    // generate ── the settings snapshot the daemon reads (cli-shell-api is
    // unavailable to it early at boot).
    let snapshot = ConfigSnapshot {
        gateway: cfg.gateway.clone(),
        port: cfg.port,
        ca_certificate_pem: ca_pem.clone(),
        ca_certificate_name: cfg.ca_certificate.clone(),
    };
    snapshot.save(&state::config_snapshot_file())?;

    // apply ──
    match action {
        CommitAction::SettingsOnly => {
            restart_daemon();
            Ok(0)
        }
        CommitAction::AlreadyEnrolled => {
            log("enroll-token was already consumed by a previous enrollment — removing it from the config");
            bump_trigger(&state::scrub_request_file())?;
            restart_daemon();
            Ok(0)
        }
        CommitAction::Enroll => {
            let token = cfg.parse_token().expect("decide() saw a token")
                .expect("decide() validated the token");

            let host = HostFacts::read_system();
            let store = IdentityStore::new(state::identity_dir());
            let identity = store.load_or_generate(&host)?;
            let mismatches = HostFacts::mismatches(&identity.recorded_host, &host);
            if !mismatches.is_empty() {
                anyhow::bail!(
                    "device identity does not match this host ({}) — this looks like a cloned \
                     image; run 'qf identity regenerate' to create a fresh identity, then enroll again",
                    mismatches.join("; ")
                );
            }

            log(&format!(
                "enrolling with QuartzCommand at {} (org {})…",
                token.gateway(),
                token.org_id
            ));
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .context("start async runtime")?;
            let outcome = rt.block_on(async {
                tokio::time::timeout(
                    std::time::Duration::from_secs(90),
                    enroll::enroll(
                        &identity.key,
                        enroll::EnrollRequest {
                            token: &token,
                            hostname: read_hostname(),
                            qf_version: qf_version(),
                            extra_ca_pem: ca_pem,
                            test_roots_only: false,
                        },
                    ),
                )
                .await
                .map_err(|_| anyhow::anyhow!("enrollment timed out after 90 s — check the network path to {}", token.gateway()))?
            })?;

            store.save_certificates(
                &outcome.client_cert_der,
                &outcome.ca_chain_der,
                outcome.pinned_ca_der.as_deref(),
            )?;
            let new_state = EnrollmentState {
                enrolled: true,
                device_id: Some(outcome.device_id.clone()),
                org_id: Some(outcome.org_id.clone()),
                token_gateway: Some(token.gateway()),
                assigned_gateway: outcome.assigned_gateway.clone(),
                trust_path: Some(outcome.trust_path),
                last_token_sha256: Some(token.sha256_hex.clone()),
                enrolled_at_unix: Some(state::now_unix()),
                cert_not_before_unix: Some(outcome.cert_not_before_unix),
                cert_not_after_unix: Some(outcome.cert_not_after_unix),
                renew_after_unix: Some(outcome.renew_after_unix),
            };
            new_state.save(&state::state_file())?;

            bump_trigger(&state::scrub_request_file())?;
            restart_daemon();

            log(&format!(
                "enrolled as {} in org {} via {} (trust: {}); control gateway {}",
                outcome.device_id,
                outcome.org_id,
                token.gateway(),
                match outcome.trust_path {
                    TrustPath::WebPki => "WebPKI",
                    TrustPath::PinnedCa => "pinned CA (from token fingerprint)",
                },
                new_state.control_gateway().unwrap_or_default(),
            ));
            log("the enroll-token is being removed from the configuration automatically");
            Ok(0)
        }
    }
}

// ── scrub (post-commit token removal) ─────────────────────────────────────────

/// Runs as root from quartzfire-qfagent-scrub.service (path-unit triggered).
/// In its OWN config session: delete the consumed `enroll-token` from the
/// active config, persist the token's gateway + port, commit, save. Retries
/// while the triggering commit still holds the commit lock.
pub fn scrub() -> i32 {
    match scrub_inner() {
        Ok(()) => 0,
        Err(e) => {
            log(&format!("scrub failed: {e:#} — the enroll-token may still be in the \
                          config; run 'delete system quartz-command enroll-token' + commit manually"));
            1
        }
    }
}

fn scrub_inner() -> Result<()> {
    let active = CliShellApi::active();
    let cfg = vyoscfg::read_config(&active);
    let st = EnrollmentState::load(&state::state_file())?;

    let mut ops: Vec<Vec<String>> = Vec::new();
    if cfg.enroll_token_raw.is_some() {
        ops.push(vec!["delete".into(), "enroll-token".into()]);
    }
    if st.enrolled {
        if let Some(gw) = &st.token_gateway {
            if let Some((host, port)) = gw.rsplit_once(':') {
                if cfg.gateway.as_deref() != Some(host) {
                    ops.push(vec!["set".into(), "gateway".into(), host.to_string()]);
                }
                let active_port = cfg.port.to_string();
                if active_port != port {
                    ops.push(vec!["set".into(), "port".into(), port.to_string()]);
                }
            }
        }
    }
    if ops.is_empty() {
        log("scrub: nothing to do");
        return Ok(());
    }

    let mut script = String::from(
        "set -e\n\
         session_env=$(cli-shell-api getSessionEnv $$)\n\
         eval \"$session_env\"\n\
         cli-shell-api setupSession\n\
         trap 'cli-shell-api teardownSession >/dev/null 2>&1 || true' EXIT\n",
    );
    for op in &ops {
        let (verb, rest) = op.split_first().expect("nonempty op");
        script.push_str(&format!(
            "/opt/vyatta/sbin/my_{verb} system quartz-command{}\n",
            rest.iter().map(|a| format!(" '{}'", a.replace('\'', ""))).collect::<String>()
        ));
    }
    script.push_str("/opt/vyatta/sbin/my_commit\n");

    // The triggering commit may still hold the global commit lock — retry.
    let mut last_err = String::new();
    for attempt in 1..=12 {
        let out = Command::new("/bin/vbash").arg("-c").arg(&script).output();
        match out {
            Ok(o) if o.status.success() => {
                log(&format!("scrub: applied {} config change(s)", ops.len()));
                save_boot_config();
                return Ok(());
            }
            Ok(o) => {
                last_err = format!(
                    "{}{}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                )
                .trim()
                .to_string();
            }
            Err(e) => last_err = e.to_string(),
        }
        log(&format!("scrub attempt {attempt}/12 failed ({last_err}); retrying in 5 s"));
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
    anyhow::bail!("could not commit the scrub after 12 attempts: {last_err}")
}

/// Persist the running config to config.boot so the scrubbed (token-free)
/// config is what the box boots with. `show configuration` masks secrets, so
/// the supported programmatic save is vyos-1x's own save script.
fn save_boot_config() {
    let script = Path::new("/usr/libexec/vyos/vyos-save-config.py");
    if !script.exists() {
        log("warning: /usr/libexec/vyos/vyos-save-config.py not found — run 'save' manually so the scrubbed config persists");
        return;
    }
    match Command::new("python3").arg(script).output() {
        Ok(o) if o.status.success() => log("scrub: boot config saved"),
        Ok(o) => log(&format!(
            "warning: saving the boot config failed: {} — run 'save' manually",
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => log(&format!("warning: saving the boot config failed: {e} — run 'save' manually")),
    }
}

// ── status ────────────────────────────────────────────────────────────────────

/// Merge durable state with the daemon's live status.json (which may be
/// absent — daemon stopped — or stale).
pub fn status(json: bool) -> i32 {
    let st = EnrollmentState::load(&state::state_file()).unwrap_or_default();
    let live: Option<StatusDoc> = std::fs::read_to_string(state::status_file())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());

    if json {
        let doc = serde_json::json!({
            "state": st,
            "live": live,
        });
        println!("{}", serde_json::to_string_pretty(&doc).unwrap());
        return 0;
    }

    let none = "—".to_string();
    println!("QuartzCommand cloud management");
    println!("  Enrollment:      {}", if st.enrolled {
        format!("enrolled ({} in org {})",
            st.device_id.clone().unwrap_or_else(|| none.clone()),
            st.org_id.clone().unwrap_or_else(|| none.clone()))
    } else {
        "not enrolled (set system quartz-command enroll-token <token> to enroll)".to_string()
    });
    if let Some(id) = &st.device_id {
        println!("  Device ID:       {id}");
    }
    println!("  Gateway:         {}", st.control_gateway().unwrap_or_else(|| none.clone()));
    if let Some(tp) = st.trust_path {
        println!("  Trust:           {}", match tp {
            TrustPath::WebPki => "WebPKI",
            TrustPath::PinnedCa => "pinned CA (token fingerprint)",
        });
    }
    if let Some(exp) = st.cert_not_after_unix {
        let days = (exp - state::now_unix()) / 86_400;
        println!("  Certificate:     expires {} ({} days)", fmt_unix(exp), days);
        if let Some(renew) = st.renew_after_unix {
            println!("  Renew after:     {}", fmt_unix(renew));
        }
    }
    match &live {
        Some(doc) => {
            let control = match doc.control {
                ControlState::Unenrolled => "not started (unenrolled)".to_string(),
                ControlState::HostMismatch => "REFUSED — identity/host mismatch".to_string(),
                ControlState::Connecting => "connecting…".to_string(),
                ControlState::Connected => format!(
                    "connected{}",
                    doc.control_since_unix
                        .map(|t| format!(" since {}", fmt_unix(t)))
                        .unwrap_or_default()
                ),
                ControlState::Backoff => "reconnecting (backoff)".to_string(),
            };
            println!("  Control channel: {control}");
            if doc.cert_renewal_alarm {
                println!("  ALARM:           certificate expires in <7 days and renewal has not succeeded");
            }
            if let Some(err) = &doc.last_error {
                println!("  Last error:      {err}");
            }
            for flag in &doc.flags {
                println!("  Flag:            {flag}");
            }
        }
        None => println!("  Control channel: unknown (qfagent daemon not running?)"),
    }
    0
}

/// Unix seconds → "YYYY-MM-DD HH:MM UTC" (civil-from-days; avoids a chrono
/// dependency for one format).
fn fmt_unix(t: i64) -> String {
    let days = t.div_euclid(86_400);
    let secs = t.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02} {:02}:{:02} UTC", y, m, d, secs / 3600, (secs % 3600) / 60)
}

// ── lifecycle: qf identity regenerate / qf prepare-template ───────────────────

pub fn identity_regenerate(force: bool) -> i32 {
    if !running_as_root() {
        log("qf identity regenerate must run as root (sudo qf identity regenerate)");
        return 1;
    }
    if !force
        && !confirm(
            "This wipes the device identity and enrollment. The device leaves QuartzCommand \
             management until enrolled again with a fresh token. Continue? [yes/No] ",
        )
    {
        log("aborted");
        return 1;
    }
    match regenerate_inner() {
        Ok(new_id) => {
            println!("New device identity generated: {new_id}");
            println!("The device is now unenrolled. Configured gateway settings were kept.");
            println!("Enroll again with: set system quartz-command enroll-token <token> ; commit");
            0
        }
        Err(e) => {
            log(&format!("identity regenerate failed: {e:#}"));
            1
        }
    }
}

fn regenerate_inner() -> Result<String> {
    systemctl(&["stop", "qfagent.service"]);
    let store = IdentityStore::new(state::identity_dir());
    store.wipe()?;
    let _ = std::fs::remove_file(state::state_file());
    let _ = std::fs::remove_file(state::status_file());

    let host = HostFacts::read_system();
    let identity = store.load_or_generate(&host)?;
    let id = identity.key.device_id();
    systemctl(&["start", "qfagent.service"]);
    Ok(id)
}

pub fn prepare_template(yes: bool) -> i32 {
    if !running_as_root() {
        log("qf prepare-template must run as root (sudo qf prepare-template)");
        return 1;
    }
    if !yes
        && !confirm(
            "This wipes the device identity, enrollment state, AND the machine-id so this VM \
             can be used as a template. Do this only on a machine about to be templated. \
             Continue? [yes/No] ",
        )
    {
        log("aborted");
        return 1;
    }
    systemctl(&["stop", "qfagent.service"]);
    let mut removed: Vec<String> = Vec::new();

    let store = IdentityStore::new(state::identity_dir());
    match store.wipe() {
        Ok(paths) => removed.extend(paths.iter().map(|p| p.display().to_string())),
        Err(e) => log(&format!("warning: {e:#}")),
    }
    for f in [state::state_file(), state::status_file(), state::config_snapshot_file()] {
        if std::fs::remove_file(&f).is_ok() {
            removed.push(f.display().to_string());
        }
    }

    // machine-id: truncate (not delete) — systemd regenerates an empty
    // /etc/machine-id on the next boot (first-boot semantics), which is the
    // distro mechanism for template instantiation. The DBus copy must go or
    // dbus re-seeds the old id.
    match std::fs::write("/etc/machine-id", b"") {
        Ok(()) => removed.push("/etc/machine-id (truncated; regenerated on next boot)".into()),
        Err(e) => log(&format!("warning: could not truncate /etc/machine-id: {e}")),
    }
    if std::fs::remove_file("/var/lib/dbus/machine-id").is_ok() {
        removed.push("/var/lib/dbus/machine-id".into());
    }

    println!("Template preparation complete. Removed:");
    for r in &removed {
        println!("  - {r}");
    }
    println!("Shut the VM down now and take the template. Each clone generates a fresh");
    println!("machine-id on first boot and a fresh device identity on first qfagent start.");
    0
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn running_as_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid is always safe to call.
        unsafe { libc_geteuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "geteuid"]
    fn libc_geteuid() -> u32;
}

fn confirm(prompt: &str) -> bool {
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
}

fn systemctl(args: &[&str]) {
    // Absent/failing systemctl (image-build chroot, dev box) is non-fatal.
    match Command::new("systemctl").args(args).output() {
        Ok(o) if o.status.success() => {}
        Ok(o) => log(&format!(
            "systemctl {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => log(&format!("systemctl {} unavailable: {e}", args.join(" "))),
    }
}

fn restart_daemon() {
    systemctl(&["try-restart", "qfagent.service"]);
}

fn read_hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "quartzfire".to_string())
}

/// Firmware version string sent with enrollment (informational): the VyOS
/// image version when available, else the agent crate version.
fn qf_version() -> String {
    if let Ok(text) = std::fs::read_to_string("/usr/share/vyos/version.json") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(ver) = v.get("version").and_then(|x| x.as_str()) {
                return format!("QuartzFire {ver} (qfagent {VERSION})");
            }
        }
    }
    format!("qfagent {VERSION}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vyoscfg::testutil::FakeConfig;

    const FP: &str = "sha256:aa00000000000000000000000000000000000000000000000000000000000bb1";

    fn cfg_with_token(token: &str) -> vyoscfg::QuartzCommandConfig {
        let mut fake = FakeConfig::default();
        fake.node("system quartz-command");
        fake.set("system quartz-command enroll-token", token);
        vyoscfg::read_config(&fake)
    }

    /// Config-node commit semantics: what the owner does with the
    /// enroll-token in each state.
    #[test]
    fn commit_decision_matrix() {
        let no_token = vyoscfg::read_config(&FakeConfig::default());
        let st = EnrollmentState::default();
        assert_eq!(decide(&no_token, &st).unwrap(), CommitAction::SettingsOnly);

        // Fresh valid token, unenrolled → enroll.
        let token = format!("QC1|gw.example.com:443|org|id.secret|{FP}");
        let cfg = cfg_with_token(&token);
        assert_eq!(decide(&cfg, &st).unwrap(), CommitAction::Enroll);

        // Same token already consumed (config.boot replay) → scrub only.
        let consumed = crate::token::parse(&token).unwrap();
        let enrolled = EnrollmentState {
            enrolled: true,
            last_token_sha256: Some(consumed.sha256_hex),
            ..Default::default()
        };
        assert_eq!(decide(&cfg, &enrolled).unwrap(), CommitAction::AlreadyEnrolled);

        // A DIFFERENT token while enrolled → re-enroll.
        let other = cfg_with_token(&format!("QC1|gw2.example.com:443|org|id2.secret2|{FP}"));
        assert_eq!(decide(&other, &enrolled).unwrap(), CommitAction::Enroll);

        // Malformed token → commit-aborting error naming the segment.
        let bad = cfg_with_token("QC1|gw.example.com:443|org|nodot");
        let err = decide(&bad, &st).unwrap_err().to_string();
        assert!(err.contains("segment"), "error should name the bad segment: {err}");
    }

    #[test]
    fn fmt_unix_formats_utc() {
        assert_eq!(fmt_unix(0), "1970-01-01 00:00 UTC");
        // 2026-07-19 12:34:00 UTC == 1784464440 (verified independently).
        assert_eq!(fmt_unix(1_784_464_440), "2026-07-19 12:34 UTC");
    }
}
