//! qfcf — QuartzFire Content Filtering multi-call binary.
//!
//! Installed once at /usr/libexec/quartzfire/qfcf with symlinks providing the
//! stable entry-point names every other component references (systemd units,
//! the WebUI backend, the conf-mode owner). Same argv[0]-dispatch scheme as
//! quartzfire-ssl-inspection's qzssl and quartzfire-geoip's qzgeo:
//!
//!   qfcf-apply                    → apply      (standalone resync / boot / path)
//!   qfcf-update                   → update     (UT1 blocklist updater; timer)
//!   qfcf-status                   → status     (e2guardian/ICAP health → status.json)
//!   qfcf-testurl                  → test-url   (WebUI "Test URL" widget)
//!   qfcf-categories               → categories (installed UT1 categories JSON)
//!   service_content_filtering.py  → commit     (conf-mode owner; the .py suffix
//!                                   is required by vyos-configd's script-path
//!                                   regex and stripped by file_stem)
//!
//! Invoked as plain `qfcf`, the first argument selects the same operations.

mod apply;
mod blocklists;
mod commands;
mod config;
mod logfeed;
mod model;
mod render;

fn dispatch(op: &str, rest: &[String]) -> Option<i32> {
    Some(match op {
        "commit" | "service_content_filtering" => commands::commit(),
        "apply" | "qfcf-apply" => commands::standalone_apply(),
        "update" | "qfcf-update" => commands::update(),
        "status" | "qfcf-status" => commands::status(),
        "test-url" | "qfcf-testurl" => commands::test_url(rest),
        "categories" | "qfcf-categories" => commands::categories(),
        "logfeed" | "qfcf-logfeed" => logfeed::run(),
        "logs" => commands::logs(rest),
        "render" => commands::render(rest),
        _ => return None,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let argv0 = std::path::Path::new(args.first().map(String::as_str).unwrap_or(""))
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if let Some(code) = dispatch(&argv0, &args[1..]) {
        std::process::exit(code);
    }

    if let Some(op) = args.get(1) {
        if let Some(code) = dispatch(op, &args[2..]) {
            std::process::exit(code);
        }
    }
    eprintln!(
        "usage: qfcf <commit|apply|update|status|test-url <url> [group]|categories|\
         logfeed|logs [--limit N] [--group G] [--action A]>"
    );
    std::process::exit(2);
}
