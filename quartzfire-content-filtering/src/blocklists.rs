//! UT1 (Université Toulouse) blocklist updater. Download → extract → verify →
//! atomic swap → reload. A failure at any step leaves the previous lists in
//! place (never a half-populated tree), per the acceptance criteria.

use std::fs;
use std::path::Path;
use std::process::Command;

use serde_json::json;

use crate::apply::{self, ApplyError};
use crate::render;

const STAGING: &str = "/var/lib/quartzfire/content-filtering/.staging";
const TARBALL: &str = "/var/lib/quartzfire/content-filtering/.download.tar.gz";
/// A sane floor: the real UT1 set has hundreds of categories. Refuse to swap in
/// a tree that is implausibly small (truncated download / wrong tarball).
const MIN_CATEGORIES: usize = 10;

fn err<T>(msg: impl Into<String>) -> Result<T, ApplyError> {
    Err(ApplyError(msg.into()))
}

/// Run one update cycle from the first configured source. Returns the number of
/// categories installed on success.
pub fn update(sources: &[String]) -> Result<usize, ApplyError> {
    let source = sources
        .first()
        .cloned()
        .unwrap_or_else(|| crate::model::DEFAULT_BLOCKLIST_SOURCE.to_string());

    apply::update_status(json!({ "blocklist_update": { "state": "running", "started": apply::now(), "source": source } }));

    let result = (|| -> Result<usize, ApplyError> {
        fs::create_dir_all(render::BLACKLIST_DIR)
            .map_err(|e| ApplyError(format!("creating blacklist dir: {e}")))?;
        // 1. Download.
        download(&source)?;
        // 2. Extract to a clean staging dir.
        let _ = fs::remove_dir_all(STAGING);
        fs::create_dir_all(STAGING).map_err(|e| ApplyError(format!("creating staging: {e}")))?;
        extract(TARBALL, STAGING)?;
        // 3. Locate the category root (UT1 tars everything under blacklists/).
        let root = locate_category_root(STAGING)?;
        // 4. Verify sanity before we touch the live tree.
        let count = verify(&root)?;
        // 5. Atomic swap: rename live → .old, staged → live, drop .old.
        swap_into_place(&root)?;
        // 6. Re-render the group configs so category `…list=` directives that
        //    were skipped at commit time (empty/missing files) are now added —
        //    the freshly-installed UT1 lists exist. apply::render_files filters
        //    against the new files. Best-effort: don't fail the update if a
        //    re-render hiccups (the swap already succeeded).
        if let Ok(Some(model)) = apply::load_desired() {
            let _ = apply::render_files(&model);
        }
        // 7. Reload e2guardian so it re-reads the lists (no dropped traffic).
        reload_e2guardian();
        Ok(count)
    })();

    match &result {
        Ok(count) => apply::update_status(json!({
            "blocklist_update": {
                "state": "ok", "finished": apply::now(), "source": source,
                "categories": count,
            }
        })),
        Err(e) => apply::update_status(json!({
            "blocklist_update": { "state": "failed", "finished": apply::now(), "error": e.to_string() }
        })),
    }
    // Best-effort cleanup; never masks the real result.
    let _ = fs::remove_file(TARBALL);
    let _ = fs::remove_dir_all(STAGING);
    result
}

fn download(source: &str) -> Result<(), ApplyError> {
    let _ = fs::remove_file(TARBALL);
    // curl is in the VyOS base; -f fails on HTTP errors so we don't extract an
    // error page, -L follows redirects, --retry rides out transient blips.
    let status = Command::new("curl")
        .args(["-fSL", "--retry", "3", "--connect-timeout", "20", "-o", TARBALL, source])
        .status()
        .map_err(|e| ApplyError(format!("running curl: {e}")))?;
    if !status.success() {
        return err(format!("download failed from {source} (curl exit {})", status.code().unwrap_or(-1)));
    }
    Ok(())
}

fn extract(tarball: &str, dest: &str) -> Result<(), ApplyError> {
    let status = Command::new("tar")
        .args(["-xzf", tarball, "-C", dest])
        .status()
        .map_err(|e| ApplyError(format!("running tar: {e}")))?;
    if !status.success() {
        return err("extraction failed (corrupt tarball?)");
    }
    Ok(())
}

/// UT1 packs categories under a top-level `blacklists/` dir; some mirrors omit
/// it. Return whichever dir directly contains category subdirs.
fn locate_category_root(staging: &str) -> Result<String, ApplyError> {
    let nested = format!("{staging}/blacklists");
    if Path::new(&nested).is_dir() {
        return Ok(nested);
    }
    Ok(staging.to_string())
}

/// A category dir is valid if it holds a `domains` file. Require a plausible
/// minimum so a truncated/wrong archive never replaces good lists.
fn verify(root: &str) -> Result<usize, ApplyError> {
    let rd = fs::read_dir(root).map_err(|e| ApplyError(format!("reading {root}: {e}")))?;
    let mut count = 0;
    for e in rd.flatten() {
        if e.path().is_dir() && e.path().join("domains").exists() {
            count += 1;
        }
    }
    if count < MIN_CATEGORIES {
        return err(format!(
            "extracted tree has only {count} categories (< {MIN_CATEGORIES}); refusing to swap — keeping existing lists"
        ));
    }
    Ok(count)
}

/// Swap the verified staged tree into BLACKLIST_DIR atomically at the directory
/// level: move each staged category dir over the live one via rename. We move
/// the whole verified root into place, keeping the old tree until the new one is
/// committed, so a crash mid-swap can't leave a partial live tree.
fn swap_into_place(root: &str) -> Result<(), ApplyError> {
    let live = render::BLACKLIST_DIR;
    let old = format!("{live}.old");
    let _ = fs::remove_dir_all(&old);
    // Move current live aside (if present), stage new into place, drop old.
    if Path::new(live).exists() {
        fs::rename(live, &old).map_err(|e| ApplyError(format!("archiving old lists: {e}")))?;
    }
    match fs::rename(root, live) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&old);
            Ok(())
        }
        Err(e) => {
            // Roll back: restore the old tree so we never leave lists missing.
            if Path::new(&old).exists() {
                let _ = fs::rename(&old, live);
            }
            err(format!("activating new lists: {e}"))
        }
    }
}

/// Reload lists without dropping the ICAP listener. e2guardian's gentle reload
/// is `-g`; under systemd that is the unit's ExecReload, so reload-or-restart is
/// the right lever. Best-effort — a reload hiccup does not undo a good swap.
fn reload_e2guardian() {
    let _ = Command::new("systemctl")
        .args(["reload-or-restart", apply::E2G_UNIT])
        .status();
}
