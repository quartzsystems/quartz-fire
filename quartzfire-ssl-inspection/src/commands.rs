//! The qzssl entry points, one per symlink name (see main.rs):
//!
//!   commit    — conf-mode owner of `service quartzfire ssl-inspection`
//!   apply     — standalone resync from the last committed snapshot
//!   ca        — generate | regenerate | info the inspection CA
//!   cadist    — the plain-HTTP CA distribution listener (:4126)
//!   capcheck  — squid -v build-capability probe → status.json
//!   status    — re-probe squid/ICAP health → status.json

use serde_json::json;

use crate::apply;
use crate::ca;
use crate::cadist;
use crate::capcheck;
use crate::config::{self, CliShellApi, ConfigRead};
use crate::model;

fn log(msg: &str) {
    eprintln!("quartzfire-ssl: {msg}");
}

// ── commit (conf-mode owner) ──────────────────────────────────────────────────

/// Commit-time owner of `service quartzfire ssl-inspection`. Stages follow the
/// vyos-1x convention: read the session config, verify (any problem → stderr +
/// exit 1 ABORTS the commit), snapshot the desired state, apply.
///
/// verify() is where a build lacking OpenSSL bump support (or ICAP, when a
/// content filter is configured) fails the commit LOUDLY. Runtime apply
/// failures (a transient squid reload, off-device) are warnings, not commit
/// aborts, so the config still commits and can be fixed / commit-confirm
/// rolled back — the error is surfaced in status.json.
pub fn commit() -> i32 {
    let conf = CliShellApi::session();
    let model = config::read_service(&conf);
    let caps = capcheck::probe();

    let problems = model::validate(&model, caps.map(|c| c.bump), caps.map(|c| c.icap));
    if !problems.is_empty() {
        eprintln!("{}", problems.join("\n"));
        return 1;
    }

    // Replicate each policy's firewall-rule match against the PROPOSED config.
    // A rule that EXISTS but uses a construct the prerouting redirect can't
    // honor (outbound-interface, FQDN group) is a hard error here — reject the
    // commit so inspection never silently misses the traffic it was scoped to.
    //
    // A policy whose firewall rule no longer exists (dangling) is NOT fatal:
    // the rule is gone, so there is no traffic to miss, and the Policies tab
    // only lists live rules — hard-failing would leave an orphaned policy that
    // is invisible in the UI yet blocks every future commit. Warn and skip it
    // (the renderer already drops it), matching geolocation's leniency.
    let resolved = apply::resolve(&model, Some(&conf), None);
    if model.enabled {
        let mut hard = false;
        for p in &resolved.problems {
            if p.dangling {
                eprintln!(
                    "WARNING: SSL inspection policy on firewall rule {} skipped: {}. \
                     Remove the stale policy with `delete service quartzfire ssl-inspection policy {}`.",
                    p.policy, p.error, p.policy
                );
            } else {
                eprintln!("SSL inspection on firewall rule {}: {}", p.policy, p.error);
                hard = true;
            }
        }
        if hard {
            return 1;
        }
    }

    // Loud warning on the enable transition (session has `enable`, the running
    // config did not): turning inspection on starts intercepting LAN HTTPS, and
    // every client that has not installed the QuartzFire CA will get
    // certificate errors and fail to load HTTPS sites. Distributing the CA is a
    // prerequisite, so make it impossible to miss on the commit output. This is
    // a WARNING, never a commit abort — the operator may be enabling precisely
    // because they have just rolled out the CA.
    if model.enabled && !CliShellApi::active().exists(&config::join_enable()) {
        eprintln!(
            "\n\
             ========================================================================\n\
             WARNING: SSL inspection is being ENABLED — LAN HTTPS will be intercepted.\n\
             \n\
             Every client whose HTTPS matches an inspection policy MUST trust the\n\
             QuartzFire inspection CA first, or HTTPS sites will fail with cert errors.\n\
             Distribute the CA (download from http://<box>:4126/ on a trusted\n\
             interface and install it as a trusted root) BEFORE relying on this.\n\
             \n\
             To roll back: `delete service quartzfire ssl-inspection` then commit.\n\
             ========================================================================\n"
        );
    }

    if let Err(e) = apply::save_desired(&model, &resolved) {
        eprintln!("{e}");
        return 1;
    }

    let report = apply::apply_model(&model, &resolved, caps);
    if !report.ok {
        eprintln!(
            "WARNING: SSL inspection config committed but not fully applied: {}",
            report.error.unwrap_or_default()
        );
    }
    0
}

// ── apply (standalone resync) ─────────────────────────────────────────────────

/// Re-apply OUTSIDE a commit, from the last committed snapshot. No snapshot =
/// SSL inspection has never been committed this boot = nothing to do
/// (deliberately NOT a teardown, so a path-unit run racing the boot commit
/// cannot yank the redirect the commit is about to install).
pub fn standalone_apply() -> i32 {
    let (mut model, snapshot) = match apply::load_desired() {
        Ok(Some(pair)) => pair,
        Ok(None) => {
            log("no committed SSL-inspection state yet — nothing to apply");
            return 0;
        }
        Err(e) => {
            log(&e.0);
            return 1;
        }
    };
    let caps = capcheck::probe();
    // Re-resolve against the RUNNING config so the redirect follows any edit to
    // a bound firewall rule (the reason this runs on /run/nftables.conf change);
    // fall back to the committed snapshot if the config view is unavailable.
    //
    // Content Filtering invokes qzssl-apply from INSIDE its own commit to
    // add/remove the Squid ICAP block. Mid-commit the active config does not yet
    // reflect `service content-filtering enable` (it lives only in the session
    // config), so reading active would drop the ICAP block that was just enabled.
    // qfcf sets QZSSL_CONFIG_SESSION=1 in that case; we inherit its config-session
    // environment, so the session view sees the proposed config. Post-commit path
    // and boot resyncs leave it unset and read the committed active config.
    let conf: CliShellApi = if std::env::var_os("QZSSL_CONFIG_SESSION").is_some() {
        CliShellApi::session()
    } else {
        CliShellApi::active()
    };
    // Refresh the ICAP seam from the ACTIVE config: Content Filtering
    // (`service content-filtering`) is committed independently and triggers this
    // resync via qzssl-apply to add/remove the Squid ICAP block. The SSL
    // snapshot may predate that change (enable OR disable), so always re-derive
    // content_filter from the running config. Keeps Squid ownership here.
    model.content_filter = config::read_content_filter(&conf);
    let resolved = apply::resolve(&model, Some(&conf), Some(&snapshot));
    // Persist the refreshed resolution so the next resync starts from it.
    let _ = apply::save_desired(&model, &resolved);
    let report = apply::apply_model(&model, &resolved, caps);
    if report.ok {
        log("applied");
        0
    } else {
        log(&format!("not applied: {}", report.error.unwrap_or_default()));
        1
    }
}

// ── ca (generate | regenerate | info) ─────────────────────────────────────────

/// CA lifecycle. `generate` is idempotent (no-op if a CA exists); `regenerate`
/// mints a fresh CA — WARN: every previously distributed copy becomes invalid
/// and clients must reinstall. `info` prints the public metadata as JSON.
pub fn ca(args: &[String]) -> i32 {
    let sub = args.first().map(String::as_str).unwrap_or("info");
    match sub {
        "generate" | "regenerate" => {
            let force = sub == "regenerate";
            match ca::generate(force) {
                Ok(info) => {
                    if force {
                        log("CA regenerated — all previously distributed CAs are now INVALID; \
                             clients must reinstall the new certificate");
                    }
                    // A new CA invalidates every mimicked leaf cached in the
                    // certgen DB; clear it and reload so Squid re-mints under
                    // the new root. Then refresh status/ca-info.
                    apply::post_ca_change();
                    println!("{}", serde_json::to_string_pretty(&info).unwrap());
                    0
                }
                Err(e) => {
                    log(&format!("CA {sub} failed: {e}"));
                    1
                }
            }
        }
        "info" => {
            let info = ca::inspect().unwrap_or_default();
            println!("{}", serde_json::to_string_pretty(&info).unwrap());
            0
        }
        other => {
            log(&format!("unknown ca subcommand \"{other}\" (use generate|regenerate|info)"));
            2
        }
    }
}

// ── cadist ────────────────────────────────────────────────────────────────────

pub fn cadist() -> i32 {
    cadist::serve()
}

// ── capcheck ──────────────────────────────────────────────────────────────────

/// Probe the Squid build and record the booleans in status.json. Prints the
/// result; a build lacking bump support is a non-zero exit so the ISO build
/// (scripts/check-squid-caps) can fail loudly.
pub fn capcheck() -> i32 {
    match capcheck::probe() {
        Some(c) => {
            println!("{}", json!({ "bump_capable": c.bump, "icap_capable": c.icap }));
            apply::update_status(json!({
                "squid": { "bump_capable": c.bump, "icap_capable": c.icap },
                "capcheck_time": apply::now(),
            }));
            if c.bump {
                0
            } else {
                log("Squid is built WITHOUT OpenSSL ssl_bump support — install squid-openssl");
                1
            }
        }
        None => {
            println!("{}", json!({ "bump_capable": null, "icap_capable": null }));
            log("could not run `squid -v` — is squid installed?");
            1
        }
    }
}

// ── status ────────────────────────────────────────────────────────────────────

pub fn status() -> i32 {
    apply::refresh_status()
}
