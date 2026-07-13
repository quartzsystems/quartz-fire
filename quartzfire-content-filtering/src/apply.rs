//! All fs / systemd / Squid side effects. render.rs stays pure; this module
//! turns a Model into a running e2guardian ICAP server and reconciles Squid.
//!
//! Config derivation follows the proven PoC (tests/e2guardian-icap): start from
//! a PRISTINE snapshot of the packaged stock e2guardian.conf / e2guardianf1.conf
//! (so every mandatory stock directive survives), apply our key=value overrides,
//! and append the QuartzFire directive block between idempotency markers. Never
//! hand-render the whole stock config (its mandatory-directive set is large and
//! version-specific).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::model::Model;
use crate::render;

pub const STATE_DIR: &str = "/run/quartzfire-content-filtering";
pub const STATUS_JSON: &str = "/run/quartzfire-content-filtering/status.json";
pub const DESIRED_JSON: &str = "/run/quartzfire-content-filtering/desired.json";
pub const PRISTINE_SUFFIX: &str = ".qz-pristine";
pub const QZSSL_APPLY: &str = "/usr/libexec/quartzfire/qzssl-apply";
pub const E2G_UNIT: &str = "e2guardian.service";
pub const LOG_DIR: &str = "/var/log/quartzfire";
/// Gate file for the e2guardian systemd drop-in's `ConditionPathExists`. Present
/// only while Content Filtering is enabled AND qfcf has rendered the ICAP config
/// (transparenthttpsport blanked). Under /run so it is cleared each boot: a
/// stock-config e2guardian therefore cannot start on its default 8443 listener
/// before qfcf re-renders. Must be created BEFORE `systemctl start`.
pub const E2G_READY_MARKER: &str = "/run/quartzfire-content-filtering/e2g-ready";

#[derive(Debug)]
pub struct ApplyError(pub String);
impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "quartzfire-content-filtering: {}", self.0)
    }
}
impl std::error::Error for ApplyError {}

fn err<T>(msg: impl Into<String>) -> Result<T, ApplyError> {
    Err(ApplyError(msg.into()))
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
        .ok_or_else(|| ApplyError(format!("{} has no parent", path.display())))?;
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

fn run(cmd: &str, args: &[&str]) -> Result<(), ApplyError> {
    let status = Command::new(cmd)
        .args(args)
        .status()
        .map_err(|e| ApplyError(format!("running {cmd}: {e}")))?;
    if status.success() {
        Ok(())
    } else {
        err(format!("{cmd} {} exited {}", args.join(" "), status.code().unwrap_or(-1)))
    }
}

/// Snapshot the packaged stock config once, so re-commits always derive from a
/// clean baseline instead of compounding edits. Mirrors the IPS
/// suricata.rules.qz-pristine pattern.
fn ensure_pristine(path: &str) -> Result<String, ApplyError> {
    let pristine = format!("{path}{PRISTINE_SUFFIX}");
    if !Path::new(&pristine).exists() {
        let stock = fs::read_to_string(path)
            .map_err(|e| ApplyError(format!("reading stock {path}: {e}")))?;
        write_atomic(Path::new(&pristine), &stock)?;
    }
    fs::read_to_string(&pristine).map_err(|e| ApplyError(format!("reading {pristine}: {e}")))
}

/// Apply `key = value` overrides onto a config body. Replaces the first
/// occurrence of each key (commented or not); appends if absent. Empty value
/// renders `key =` (used to DISABLE a directive, e.g. transparenthttpsport).
fn apply_overrides(body: &str, overrides: &[(String, String)]) -> String {
    let mut lines: Vec<String> = body.lines().map(str::to_string).collect();
    for (key, val) in overrides {
        let rendered = if val.is_empty() {
            format!("{key} =")
        } else {
            format!("{key} = {val}")
        };
        let mut replaced = false;
        for line in lines.iter_mut() {
            let trimmed = line.trim_start().trim_start_matches('#').trim_start();
            if trimmed
                .split(['=', ' '])
                .next()
                .map(|k| k == key)
                .unwrap_or(false)
            {
                *line = rendered.clone();
                replaced = true;
                break;
            }
        }
        if !replaced {
            lines.push(rendered);
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Strip any previously-appended QuartzFire directive block (between markers)
/// so re-commits are idempotent.
fn strip_qz_block(body: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in body.lines() {
        if line.starts_with(render::BLOCK_BEGIN) {
            skipping = true;
            continue;
        }
        if skipping {
            if line.starts_with(render::BLOCK_END) {
                skipping = false;
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// True if a list source file exists and is non-empty. e2guardian FAILS to load
/// a list whose file is empty or missing (proven in tests/render-filter), so
/// empty/absent sources are excluded from aggregators and directives.
fn file_has_content(p: &str) -> bool {
    fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false)
}

/// Build one aggregate into a directive line (or a skip comment). Writes the
/// `.Include` aggregator file containing only the present, non-empty sources.
/// Emits the directive only if ≥1 source survived; otherwise a skip comment
/// (categories may not be populated until the updater runs — the update
/// re-render then fills them in). e2guardian v5 needs ONE directive per
/// `name=` over a single `.Include` file (duplicate same-`name` directives do
/// not merge — proven in tests/render-filter).
fn build_aggregate(agg: &render::Aggregate) -> Result<String, ApplyError> {
    let present: Vec<&String> = agg.sources.iter().filter(|s| file_has_content(s)).collect();
    if present.is_empty() {
        return Ok(format!(
            "# (skipped — no populated sources) {}\n",
            agg.directive_template.replace("{agg}", &agg.agg_path)
        ));
    }
    let mut body = String::from("# QuartzFire aggregate list (.Include of live sources). Generated by qfcf.\n");
    for s in &present {
        body.push_str(&format!(".Include<{s}>\n"));
    }
    write_atomic(Path::new(&agg.agg_path), &body)?;
    Ok(format!("{}\n", agg.directive_template.replace("{agg}", &agg.agg_path)))
}

/// Build one e2guardianfN.conf from the f1 pristine baseline.
fn build_group_file(model: &Model, idx: usize, group_pristine: &str) -> Result<(), ApplyError> {
    let gr = render::render_group(model, idx);
    let path = format!("{}/e2guardianf{}.conf", render::E2G_ETC, gr.number);

    let mut body = strip_qz_block(group_pristine);
    // Phrase filtering toggles via weightedphrasemode (0 = off, 2 = on) on the
    // stock phrase lists, which MUST remain defined — commenting them out makes
    // e2guardian abort trying to open a bareword default (proven in
    // tests/render-filter). naughtynesslimit is the score threshold when on.
    let phrasemode = if gr.phrase_filtering { "2" } else { "0" };
    body = apply_overrides(
        &body,
        &[
            ("groupname".into(), format!("'{}'", gr.groupname)),
            ("naughtynesslimit".into(), gr.naughtyness.to_string()),
            ("weightedphrasemode".into(), phrasemode.into()),
        ],
    );
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push('\n');
    // Write the group's own source list files FIRST, so build_aggregate's
    // presence check sees them; category files (external, updater-populated) are
    // checked as-is.
    for f in &gr.files {
        write_atomic(Path::new(&f.path), &f.contents)?;
    }
    // Emit the marker-bracketed directive block: header, one directive per
    // aggregate (each backed by a freshly-written .Include file), footer.
    body.push_str(&gr.header);
    for agg in &gr.aggregates {
        body.push_str(&build_aggregate(agg)?);
    }
    body.push_str(render::BLOCK_END);
    body.push('\n');
    write_atomic(Path::new(&path), &body)?;
    Ok(())
}

/// Ensure the `quartzfire` language dir is a complete e2guardian language pack.
/// e2guardian requires several files (messages, template.html AND
/// neterr_template.html, fancydmtemplate.html, …) or it aborts at startup
/// ("Error reading default HTML and NetErr Template file"). Copy the whole stock
/// ukenglish pack as the baseline; the shared-files pass then overwrites
/// template.html with the QuartzFire-branded block page.
fn ensure_language_dir() -> Result<(), ApplyError> {
    let dir = format!("{}/{}", render::LANG_DIR, render::LANGUAGE);
    fs::create_dir_all(&dir).map_err(|e| ApplyError(format!("creating {dir}: {e}")))?;
    let stock = format!("{}/ukenglish", render::LANG_DIR);
    let entries = fs::read_dir(&stock)
        .map_err(|e| ApplyError(format!("reading stock language dir {stock}: {e}")))?;
    for entry in entries.flatten() {
        if !entry.path().is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let dest = format!("{dir}/{name}");
        // Copy each stock file if missing; the block template is refreshed every
        // apply by the shared-files pass, so skip it here.
        if name == "template.html" || Path::new(&dest).exists() {
            continue;
        }
        if let Ok(body) = fs::read(entry.path()) {
            fs::write(&dest, body).map_err(|e| ApplyError(format!("copying {name}: {e}")))?;
        }
    }
    Ok(())
}

/// Reconcile Squid with the SSL-inspection crate: qzssl-apply re-reads the VyOS
/// config (which cross-reads `service content-filtering enable`) and re-renders
/// the Squid drop-in with — or without — the ICAP block, then
/// `squid -k reconfigure`. This is the single seam that keeps Squid ownership in
/// the SSL crate (per the feature's architecture decision). Best-effort: a Squid
/// reconcile failure is surfaced in status.json, not a fatal apply error, so the
/// e2guardian side still converges and the operator can retry.
///
/// `in_commit` selects which config view qzssl reads. Post-commit resyncs (path
/// unit / boot) read the ACTIVE config, which already reflects the change. But
/// when we run inside CF's OWN commit, `service content-filtering enable` is only
/// in the SESSION (proposed) config — the active config still lacks it — so
/// qzssl's cross-read would return None and render Squid WITHOUT the ICAP block
/// (content filter silently not attached). qzssl-apply is a child of this commit
/// and inherits its config-session environment, so it can read the session view;
/// `QZSSL_CONFIG_SESSION=1` tells it to. See qzssl commands.rs::standalone_apply.
fn reconcile_squid(in_commit: bool) -> Result<(), ApplyError> {
    if !Path::new(QZSSL_APPLY).exists() {
        return err(format!(
            "{QZSSL_APPLY} not found — is quartzfire-ssl-inspection installed?"
        ));
    }
    let mut cmd = Command::new(QZSSL_APPLY);
    if in_commit {
        cmd.env("QZSSL_CONFIG_SESSION", "1");
    }
    let status = cmd
        .status()
        .map_err(|e| ApplyError(format!("running {QZSSL_APPLY}: {e}")))?;
    if status.success() {
        Ok(())
    } else {
        err(format!("{QZSSL_APPLY} exited {}", status.code().unwrap_or(-1)))
    }
}

/// Persist the desired Model so the standalone apply (path/boot unit) can
/// re-converge without a config session.
pub fn save_desired(model: &Model) -> Result<(), ApplyError> {
    let text = serde_json::to_string_pretty(model)
        .map_err(|e| ApplyError(format!("serializing model: {e}")))?;
    write_atomic(Path::new(DESIRED_JSON), &text)
}

pub fn load_desired() -> Result<Option<Model>, ApplyError> {
    match fs::read_to_string(DESIRED_JSON) {
        Ok(t) => serde_json::from_str(&t)
            .map(Some)
            .map_err(|e| ApplyError(format!("parsing {DESIRED_JSON}: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => err(format!("reading {DESIRED_JSON}: {e}")),
    }
}

#[derive(Debug)]
pub struct ApplyReport {
    pub ok: bool,
    pub error: Option<String>,
}

/// Converge the box to `model`. Enabled → render + start e2guardian + reconcile
/// Squid. Disabled → stop e2guardian + reconcile Squid (drops the ICAP block).
///
/// `in_commit` must be true only when called from the conf-mode commit owner (so
/// the Squid reconcile reads the SESSION config); false for standalone/boot
/// resyncs (which read the committed ACTIVE config). See reconcile_squid.
pub fn apply_model(model: &Model, in_commit: bool) -> ApplyReport {
    let res = if model.enabled {
        apply_enabled(model, in_commit)
    } else {
        apply_disabled(in_commit)
    };
    match res {
        Ok(()) => {
            update_status(json!({
                "enabled": model.enabled,
                "groups": model.groups.len(),
                "listen_port": model.listen_port,
                "log_level": render::loglevel_label(model.log_level),
                "applied_time": now(),
                "apply_ok": true,
                "apply_error": Value::Null,
            }));
            ApplyReport { ok: true, error: None }
        }
        Err(e) => {
            let msg = e.to_string();
            update_status(json!({
                "enabled": model.enabled,
                "applied_time": now(),
                "apply_ok": false,
                "apply_error": msg,
            }));
            ApplyReport { ok: false, error: Some(msg) }
        }
    }
}

fn apply_enabled(model: &Model, in_commit: bool) -> Result<(), ApplyError> {
    render_files(model)?;
    save_desired(model)?;

    // Drop the readiness marker BEFORE starting: the e2guardian drop-in gates
    // start on it (ConditionPathExists), and the config is now rendered with
    // transparenthttpsport blanked, so it is safe to bring the daemon up.
    write_atomic(Path::new(E2G_READY_MARKER), "")?;

    // Start/refresh e2guardian, then reconcile Squid so it gets the ICAP block.
    run("systemctl", &["enable", "--now", E2G_UNIT])?;
    // reload picks up list/group changes without dropping the ICAP listener.
    run("systemctl", &["reload-or-restart", E2G_UNIT])?;
    reconcile_squid(in_commit)?;
    Ok(())
}

/// Render ALL e2guardian config files from the model onto disk (main conf,
/// per-group confs, layered lists, ipgroups, block template, safe-search list).
/// Pure fs — no systemd, no Squid — so it is exercised end-to-end in the
/// container test (tests/render-filter) and reused by apply_enabled.
pub fn render_files(model: &Model) -> Result<(), ApplyError> {
    fs::create_dir_all(render::QZ_LIST_DIR)
        .map_err(|e| ApplyError(format!("creating {}: {e}", render::QZ_LIST_DIR)))?;
    fs::create_dir_all(render::BLACKLIST_DIR)
        .map_err(|e| ApplyError(format!("creating {}: {e}", render::BLACKLIST_DIR)))?;
    fs::create_dir_all(LOG_DIR).ok();

    // Main config: pristine baseline + our overrides.
    let pristine_conf = ensure_pristine(render::E2G_CONF)?;
    let conf = apply_overrides(&pristine_conf, &render::conf_overrides(model));
    write_atomic(Path::new(render::E2G_CONF), &conf)?;

    // Shared files (ipgroups, block template, safe-search list) FIRST — the
    // per-group safe-search aggregate .Includes the shared safe-search file, so
    // it must exist before build_aggregate's presence check runs.
    ensure_language_dir()?;
    for f in render::shared_files(model) {
        write_atomic(Path::new(&f.path), &f.contents)?;
    }

    // Per-group configs, all derived from the f1 pristine baseline.
    let group_pristine_path = format!("{}/e2guardianf1.conf", render::E2G_ETC);
    let group_pristine = ensure_pristine(&group_pristine_path)?;
    for idx in 0..model.groups.len() {
        build_group_file(model, idx, &group_pristine)?;
    }
    Ok(())
}

fn apply_disabled(in_commit: bool) -> Result<(), ApplyError> {
    // Drop the readiness marker first so the drop-in's ConditionPathExists will
    // refuse any future/racing start on stock config.
    let _ = fs::remove_file(E2G_READY_MARKER);
    // Stop e2guardian and remove it from boot; harmless if never started.
    let _ = run("systemctl", &["disable", "--now", E2G_UNIT]);
    // Reconcile Squid so the ICAP block is removed (traffic flows normally).
    let squid = reconcile_squid(in_commit);
    // Keep the desired snapshot reflecting the off state.
    save_desired(&Model::default()).ok();
    squid
}

// ── status.json (read by the WebUI backend) ──────────────────────────────────

pub fn update_status(patch: Value) {
    fs::create_dir_all(STATE_DIR).ok();
    let mut current: Value = fs::read_to_string(STATUS_JSON)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    if let (Some(obj), Some(p)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }
    if let Ok(text) = serde_json::to_string_pretty(&current) {
        let _ = write_atomic(Path::new(STATUS_JSON), &text);
    }
}

/// Discover installed UT1 categories = subdirs of the blacklist dir that carry a
/// `domains` file, with entry counts. Used by the API `categories` endpoint.
pub fn installed_categories() -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(render::BLACKLIST_DIR) else {
        return out;
    };
    for e in rd.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let domains = e.path().join("domains");
        if !domains.exists() {
            continue;
        }
        let count = fs::read_to_string(&domains)
            .map(|t| t.lines().filter(|l| !l.trim().is_empty()).count())
            .unwrap_or(0);
        if let Some(name) = e.file_name().to_str() {
            out.push((name.to_string(), count));
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_replaces_commented_and_appends_missing() {
        let body = "#icapport = 1344\nfilterip =\nloglevel = 3\n";
        let out = apply_overrides(
            body,
            &[
                ("icapport".into(), "1345".into()),
                ("filterip".into(), "127.0.0.1".into()),
                ("newkey".into(), "v".into()),
            ],
        );
        assert!(out.contains("icapport = 1345"));
        assert!(out.contains("filterip = 127.0.0.1"));
        assert!(out.contains("newkey = v"));
        assert!(!out.contains("#icapport"));
    }

    #[test]
    fn empty_value_disables_directive() {
        let out = apply_overrides("transparenthttpsport = 8443\n", &[("transparenthttpsport".into(), String::new())]);
        assert!(out.contains("transparenthttpsport =\n"));
        assert!(!out.contains("8443"));
    }

    /// The e2guardian readiness marker MUST live under /run (STATE_DIR), so it is
    /// cleared on every boot. A persistent marker would let a stock-config
    /// e2guardian pass the drop-in's ConditionPathExists and bind :8443 before
    /// qfcf re-renders — the boot race behind the 2026-07-13 WebUI outage.
    #[test]
    fn ready_marker_is_boot_cleared_under_run() {
        assert!(
            E2G_READY_MARKER.starts_with("/run/"),
            "marker {E2G_READY_MARKER} must be under /run so it clears each boot"
        );
        assert!(E2G_READY_MARKER.starts_with(STATE_DIR));
    }

    #[test]
    fn strip_qz_block_is_idempotent() {
        let body = format!(
            "keep = 1\n{}\ninjected = x\n{}\nkeep2 = 2\n",
            render::BLOCK_BEGIN,
            render::BLOCK_END
        );
        let stripped = strip_qz_block(&body);
        assert!(stripped.contains("keep = 1"));
        assert!(stripped.contains("keep2 = 2"));
        assert!(!stripped.contains("injected"));
        // Stripping twice is a no-op.
        assert_eq!(stripped, strip_qz_block(&stripped));
    }

    #[test]
    fn aggregate_includes_present_sources_and_skips_when_empty() {
        let dir = std::env::temp_dir().join(format!("qfcf-agg-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let full = dir.join("full");
        let empty = dir.join("empty");
        fs::write(&full, "example.com\n").unwrap();
        fs::write(&empty, "").unwrap();
        let agg_path = dir.join("agg").to_string_lossy().into_owned();

        // One present, one empty, one missing → directive kept, .Include only the present.
        let a = render::Aggregate {
            directive_template: "sitelist = 'name=banned,messageno=500,path={agg}'".into(),
            agg_path: agg_path.clone(),
            sources: vec![
                full.to_string_lossy().into_owned(),
                empty.to_string_lossy().into_owned(),
                dir.join("nope").to_string_lossy().into_owned(),
            ],
        };
        let line = build_aggregate(&a).unwrap();
        assert!(line.contains(&format!("path={agg_path}'")));
        let agg_body = fs::read_to_string(&agg_path).unwrap();
        assert!(agg_body.contains(&format!(".Include<{}>", full.display())));
        assert!(!agg_body.contains("empty"));
        assert!(!agg_body.contains("nope"));

        // No present sources → skip comment, no directive.
        let b = render::Aggregate {
            directive_template: "urllist = 'name=banned,messageno=501,path={agg}'".into(),
            agg_path: dir.join("agg2").to_string_lossy().into_owned(),
            sources: vec![empty.to_string_lossy().into_owned()],
        };
        let skipped = build_aggregate(&b).unwrap();
        assert!(skipped.starts_with("# (skipped"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn override_toggles_weightedphrasemode() {
        // Phrase off/on is a mode flip on the stock (still-defined) lists.
        let off = apply_overrides("weightedphrasemode = 2\n", &[("weightedphrasemode".into(), "0".into())]);
        assert!(off.contains("weightedphrasemode = 0"));
        let on = apply_overrides("#weightedphrasemode = 0\n", &[("weightedphrasemode".into(), "2".into())]);
        assert!(on.contains("weightedphrasemode = 2"));
    }
}

// Silence unused warning for PathBuf import on some cfgs.
#[allow(dead_code)]
fn _pathbuf_marker() -> PathBuf {
    PathBuf::new()
}
