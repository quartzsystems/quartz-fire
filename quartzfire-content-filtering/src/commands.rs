//! qfcf entry points, one per symlink name (see main.rs):
//!
//!   commit      — conf-mode owner of `service content-filtering`
//!   apply       — standalone resync from the committed snapshot (path/boot unit)
//!   update      — run the UT1 blocklist updater
//!   status      — re-probe e2guardian / Squid-ICAP health → status.json
//!   test-url    — evaluate what a group would do with a URL (WebUI widget)
//!   categories  — enumerate installed UT1 categories with counts (JSON)

use serde_json::json;

use crate::apply;
use crate::blocklists;
use crate::config::{self, CliShellApi, ConfigRead};
use crate::model::{self, Model};
use crate::render;

fn log(msg: &str) {
    eprintln!("quartzfire-content-filtering: {msg}");
}

// ── commit (conf-mode owner) ──────────────────────────────────────────────────

/// Commit-time owner of `service content-filtering`. Read session config →
/// validate (any problem aborts the commit) → snapshot → apply. Apply failures
/// are warnings (config still commits, surfaced in status.json) so a transient
/// e2guardian/Squid hiccup is recoverable and commit-confirm can roll back.
pub fn commit() -> i32 {
    let conf = CliShellApi::session();
    let model = config::read_service(&conf);

    let problems = model::validate(&model);
    if !problems.is_empty() {
        eprintln!("{}", problems.join("\n"));
        return 1;
    }

    // Loud warning on the enable transition (session has enable, active did not):
    // enabling starts fail-closed ICAP filtering of all bumped HTTPS.
    if model.enabled && !CliShellApi::active().exists(&config::join_enable()) {
        eprintln!(
            "\n\
             ========================================================================\n\
             NOTICE: Content Filtering is being ENABLED. All bumped HTTPS is now\n\
             filtered by e2guardian over ICAP (fail-closed: if e2guardian is down,\n\
             affected traffic is blocked, not passed uninspected).\n\
             \n\
             Blocklists: run `... blocklists` + the updater, or ship the UT1 snapshot,\n\
             so category filtering has data. To roll back: `delete service\n\
             content-filtering` then commit.\n\
             ========================================================================\n"
        );
    }

    let report = apply::apply_model(&model);
    if !report.ok {
        eprintln!(
            "WARNING: content-filtering config committed but not fully applied: {}",
            report.error.unwrap_or_default()
        );
    }
    0
}

// ── apply (standalone resync) ─────────────────────────────────────────────────

/// Re-apply OUTSIDE a commit, from the last committed snapshot. No snapshot =
/// never committed this boot = nothing to do (NOT a teardown).
pub fn standalone_apply() -> i32 {
    match apply::load_desired() {
        Ok(Some(model)) => {
            let report = apply::apply_model(&model);
            if report.ok {
                log("applied");
                0
            } else {
                log(&format!("not applied: {}", report.error.unwrap_or_default()));
                1
            }
        }
        Ok(None) => {
            log("no committed content-filtering state yet — nothing to apply");
            0
        }
        Err(e) => {
            log(&e.0);
            1
        }
    }
}

// ── update (blocklist updater) ────────────────────────────────────────────────

pub fn update() -> i32 {
    // Prefer the committed snapshot's sources; fall back to the default UT1 URL.
    let sources = apply::load_desired()
        .ok()
        .flatten()
        .map(|m| m.blocklists.sources)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| vec![model::DEFAULT_BLOCKLIST_SOURCE.to_string()]);
    match blocklists::update(&sources) {
        Ok(n) => {
            println!("{}", json!({ "ok": true, "categories": n }));
            0
        }
        Err(e) => {
            log(&e.to_string());
            println!("{}", json!({ "ok": false, "error": e.to_string() }));
            1
        }
    }
}

// ── status ────────────────────────────────────────────────────────────────────

fn is_active(unit: &str) -> bool {
    std::process::Command::new("systemctl")
        .args(["is-active", "--quiet", unit])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_ok()
}

pub fn status() -> i32 {
    let model = apply::load_desired().ok().flatten().unwrap_or_default();
    let e2g_active = is_active(apply::E2G_UNIT);
    let icap_listening = port_open(model.listen_port);
    let cats = apply::installed_categories();
    apply::update_status(json!({
        "e2guardian_active": e2g_active,
        "icap_listening": icap_listening,
        "icap_port": model.listen_port,
        "installed_categories": cats.len(),
        "status_time": apply::now(),
    }));
    println!(
        "{}",
        json!({
            "e2guardian_active": e2g_active,
            "icap_listening": icap_listening,
            "installed_categories": cats.len(),
        })
    );
    0
}

// ── categories ────────────────────────────────────────────────────────────────

pub fn categories() -> i32 {
    let cats: Vec<_> = apply::installed_categories()
        .into_iter()
        .map(|(name, count)| json!({ "name": name, "entries": count }))
        .collect();
    println!("{}", json!({ "categories": cats }));
    0
}

// ── logs ──────────────────────────────────────────────────────────────────────

/// Return recent content-filter log entries from the JSON feed, newest first,
/// optionally filtered by group/action, capped at --limit (default 100). Backs
/// the WebUI Logs tab / API `logs` endpoint. Args: [--limit N] [--group G]
/// [--action A].
pub fn logs(args: &[String]) -> i32 {
    let mut limit = 100usize;
    let mut group: Option<String> = None;
    let mut action: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--limit" => limit = it.next().and_then(|v| v.parse().ok()).unwrap_or(limit),
            "--group" => group = it.next().cloned(),
            "--action" => action = it.next().cloned(),
            _ => {}
        }
    }
    let text = std::fs::read_to_string(crate::logfeed::JSON_LOG).unwrap_or_default();
    let mut entries: Vec<serde_json::Value> = text
        .lines()
        .rev() // newest first
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|e| group.as_deref().map_or(true, |g| e.get("group").and_then(|v| v.as_str()) == Some(g)))
        .filter(|e| action.as_deref().map_or(true, |a| e.get("action").and_then(|v| v.as_str()) == Some(a)))
        .take(limit)
        .collect();
    // Present chronologically within the newest-first window is a UI choice;
    // keep newest-first (already reversed).
    let _ = &mut entries;
    println!("{}", json!({ "entries": entries }));
    0
}

// ── render (offline debug / container test) ──────────────────────────────────

/// Render all e2guardian config files from a Model JSON file, WITHOUT touching
/// systemd/Squid or reading the VyOS config. Not wired to a symlink — used by
/// the render-filter container test to prove the generated config filters, and
/// handy for `qfcf render <model.json>` debugging. Arg: path to a Model JSON.
pub fn render(args: &[String]) -> i32 {
    let Some(path) = args.first() else {
        log("usage: qfcf render <model.json>");
        return 2;
    };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            log(&format!("reading {path}: {e}"));
            return 1;
        }
    };
    let model: Model = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            log(&format!("parsing {path}: {e}"));
            return 1;
        }
    };
    match apply::render_files(&model) {
        Ok(()) => {
            println!("rendered {} filter group(s)", model.groups.len());
            0
        }
        Err(e) => {
            log(&e.to_string());
            1
        }
    }
}

// ── test-url ──────────────────────────────────────────────────────────────────

/// Evaluate a URL against a filter group by consulting the effective lists
/// directly (e2guardian ships no offline test facility). Args: <url> [group].
/// Prints a JSON verdict for the WebUI "Test URL" widget.
pub fn test_url(args: &[String]) -> i32 {
    let Some(url) = args.first() else {
        log("usage: qfcf-testurl <url> [filter-group]");
        return 2;
    };
    let group = args.get(1).map(String::as_str);
    let model = apply::load_desired().ok().flatten().unwrap_or_default();
    let verdict = evaluate(&model, url, group);
    println!("{}", verdict);
    0
}

/// Host portion of a URL (scheme-optional), lowercased, no port.
fn host_of(url: &str) -> String {
    let s = url.split("://").nth(1).unwrap_or(url);
    let s = s.split('/').next().unwrap_or(s);
    let s = s.split(':').next().unwrap_or(s);
    s.trim().to_lowercase()
}

/// e2guardian site-list semantics: a listed domain matches itself and any
/// subdomain (dot-boundary), so `example.com` blocks `www.example.com`.
fn domain_matches(host: &str, listed: &str) -> bool {
    let listed = listed.trim().trim_start_matches('.').to_lowercase();
    host == listed || host.ends_with(&format!(".{listed}"))
}

fn read_list(path: &str) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|t| {
            t.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn evaluate(model: &Model, url: &str, group: Option<&str>) -> serde_json::Value {
    let host = host_of(url);
    // Resolve group: explicit name, else the default (group 1 / index 0).
    let g = match group {
        Some(name) => model.groups.iter().find(|g| g.name == name),
        None => model.groups.first(),
    };
    let Some(g) = g else {
        return json!({ "url": url, "host": host, "action": "allowed", "reason": "no filter group configured" });
    };

    // Exception (allow) overrides everything.
    if g.allow_domains.iter().any(|d| domain_matches(&host, d)) {
        return json!({ "url": url, "host": host, "group": g.name, "action": "allowed", "matched": "allow-domain" });
    }
    // Custom block domains.
    if g.block_domains.iter().any(|d| domain_matches(&host, d)) {
        return json!({ "url": url, "host": host, "group": g.name, "action": "blocked", "matched": "block-domain" });
    }
    // Category domain lists.
    for cat in &g.categories {
        let path = format!("{}/{}/domains", render::BLACKLIST_DIR, cat);
        if read_list(&path).iter().any(|d| domain_matches(&host, d)) {
            return json!({ "url": url, "host": host, "group": g.name, "action": "blocked", "matched": "category", "category": cat });
        }
    }
    if g.blanket_block {
        return json!({ "url": url, "host": host, "group": g.name, "action": "blocked", "matched": "blanket-block" });
    }
    json!({ "url": url, "host": host, "group": g.name, "action": "allowed", "reason": "no matching list" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FilterGroup;

    #[test]
    fn host_extraction() {
        assert_eq!(host_of("https://www.Example.com:443/x?y"), "www.example.com");
        assert_eq!(host_of("example.com"), "example.com");
    }

    #[test]
    fn domain_subdomain_match() {
        assert!(domain_matches("www.example.com", "example.com"));
        assert!(domain_matches("example.com", "example.com"));
        assert!(!domain_matches("notexample.com", "example.com"));
    }

    #[test]
    fn allow_overrides_block() {
        let mut g = FilterGroup::new("default");
        g.block_domains = vec!["example.com".into()];
        g.allow_domains = vec!["safe.example.com".into()];
        let m = Model { groups: vec![g], ..Default::default() };
        let v = evaluate(&m, "https://safe.example.com/", None);
        assert_eq!(v["action"], "allowed");
        let v2 = evaluate(&m, "https://ads.example.com/", None);
        assert_eq!(v2["action"], "blocked");
    }
}
