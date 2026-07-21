//! System-image installs: browser uploads and the `/image` op interception.
//!
//! `add system image <url>` normally makes the DEVICE fetch the ISO. The upload
//! endpoints (`upload`/`cleanup`) let the browser stream one to the device
//! instead. The file is staged in `guard_dir` (`/config/quartzfire`) — the one
//! path both this sandboxed backend (writer) and the root VyOS API (reader; the
//! image add op takes a local path as its url) can reach; `PrivateTmp` rules out
//! /tmp, and the image partition is where the unpacked image lands anyway. The
//! frontend uploads, points the regular image-add op at the returned path, then
//! DELETEs the staging file — which is also safe to call at any time.
//!
//! The `op`/`status` endpoints intercept the VyOS-style `/image` op so `op: add`
//! (whether from the local WebUI or Quartz Command's one-click updater) runs the
//! download → optional SHA-256 verify → install in the background and returns at
//! once, since a multi-hundred-MB ISO outlasts the cloud proxy's ~120 s and
//! qfagent's 110 s request timeouts. All other ops pass straight through to the
//! VyOS API unchanged. See the "background image install" section below.

use axum::{
    body::Body,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_stream::StreamExt;

use crate::error::{AppError, Result};
use crate::AppState;

const UPLOAD_NAME: &str = "upload.iso";
/// Where a cloud-initiated `op: add` stages the ISO it downloads. Kept distinct
/// from the browser upload name so a URL install and a browser upload can't
/// clobber each other's staging file mid-flight.
const DOWNLOAD_NAME: &str = "image-download.iso";
/// Hard cap — QuartzFire ISOs run ~500 MB; anything past this is not one.
const MAX_ISO_BYTES: u64 = 4 * 1024 * 1024 * 1024;

fn upload_path(state: &AppState) -> std::path::PathBuf {
    state.config.guard_dir.join(UPLOAD_NAME)
}

/// POST /api/image/upload — stream the request body to the staging file.
/// Returns `{path, bytes}`; the client then runs the regular image-add op
/// against `path`.
pub async fn upload(State(state): State<Arc<AppState>>, body: Body) -> Result<Json<serde_json::Value>> {
    let path = upload_path(&state);
    // The staging dir is provisioned root:quartzfire mode 2775 by the service's
    // ExecStartPre= (running as root before this sandboxed process starts), so
    // we don't create it here — doing so as the backend user would stamp it
    // with the wrong ownership and make later writes fail. A create error below
    // therefore means a genuine provisioning problem, not a first-run race.
    //
    // Unlink any stale staging file first. `File::create` opens O_TRUNC, which
    // needs write permission on the *existing* file; a leftover owned by another
    // uid (e.g. root, the pre-static-user DynamicUser build, or a partial from
    // an interrupted upload) would otherwise make every retry EACCES forever.
    // We hold write on the directory (group quartzfire, mode 2775), so unlink
    // succeeds regardless of the file's owner, and the create then makes a fresh
    // file owned by this service user.
    let _ = tokio::fs::remove_file(&path).await;
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| {
        AppError::Internal(anyhow::anyhow!("creating {}: {e}", path.display()))
    })?;

    let mut stream = body.into_data_stream();
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&path).await;
                return Err(AppError::BadRequest(format!("upload interrupted: {e}")));
            }
        };
        written += chunk.len() as u64;
        if written > MAX_ISO_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(AppError::BadRequest(
                "the uploaded file is larger than any system image (4 GB cap)".into(),
            ));
        }
        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(AppError::Internal(anyhow::anyhow!(
                "writing {}: {e} — is the config partition out of space?",
                path.display()
            )));
        }
    }
    file.flush().await.ok();
    file.sync_all().await.ok();

    if written == 0 {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(AppError::BadRequest("the uploaded file is empty".into()));
    }
    Ok(Json(json!({ "path": path.to_string_lossy(), "bytes": written })))
}

/// DELETE /api/image/upload — remove the staging file (idempotent).
pub async fn cleanup(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    let _ = tokio::fs::remove_file(upload_path(&state)).await;
    Ok(Json(json!({ "ok": true })))
}

// ══ background image install (`op: add`) ═══════════════════════════════════════
//
// The cloud console (Quartz Command) drives firmware updates by POSTing the
// VyOS-style `/image` op — `{op:"add", url, sha256?}` — down qfagent's control
// stream, which replays it against this backend. That call can't block: qfagent's
// local client and the cloud proxy both give up around 110–120 s, but downloading
// a multi-hundred-MB ISO takes longer. So `op: add` kicks the work into a
// background task and returns `{status:"started"}` immediately; the console polls
// `/api/image/status` for progress and the final result. Every other op (delete,
// …) falls straight through to the VyOS API, exactly as the proxy did before.

/// One phase of a background install. `Done`/`Failed` are terminal; anything
/// else means a job is still in flight (and blocks a second one from starting).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Accepted, task spawned, nothing downloaded yet.
    Starting,
    Downloading,
    Verifying,
    /// Running `add system image` — the device is unpacking the ISO.
    Installing,
    Done,
    Failed,
}

impl Phase {
    fn is_running(self) -> bool {
        !matches!(self, Phase::Done | Phase::Failed)
    }
}

/// Live state of the current (or most recent) background install, surfaced by
/// `/api/image/status`. There is at most one at a time.
#[derive(Debug, Clone, Serialize)]
pub struct ImageJob {
    pub id: String,
    pub phase: Phase,
    /// Bytes fetched so far (download phase); 0 for a local-path install.
    pub downloaded_bytes: u64,
    /// Total size from the download's Content-Length, when the server sends one.
    pub total_bytes: Option<u64>,
    /// The image name the new ISO is expected to install as, for display.
    pub image_name: Option<String>,
    /// Human-readable failure reason (only when `phase == Failed`).
    pub error: Option<String>,
    pub started_unix: u64,
    pub finished_unix: Option<u64>,
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A job id unique even for two installs started in the same second (subsecond
/// nanos disambiguate a quick retry after a failed job).
fn new_job_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("img-{nanos}")
}

/// Envelope matching the VyOS HTTP API so the browser's `vyosApi`/`opApi` and the
/// cloud both parse it uniformly.
fn ok_json(data: Value) -> Response {
    (StatusCode::OK, Json(json!({ "success": true, "data": data }))).into_response()
}
fn err_json(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "success": false, "error": msg.into() }))).into_response()
}

/// Pull the operation object out of an incoming `/image` request. The wire form
/// is the VyOS API's `data=<json>` (application/x-www-form-urlencoded), which is
/// what both the browser proxy client and the cloud send; fall back to a raw
/// JSON body for leniency.
fn parse_op(body: &[u8]) -> Option<Value> {
    // `data=<url-encoded json>` — find the field and percent/plus-decode it.
    let s = std::str::from_utf8(body).ok()?;
    for pair in s.split('&') {
        if let Some(raw) = pair.strip_prefix("data=") {
            let decoded = form_urldecode(raw);
            if let Ok(v) = serde_json::from_str::<Value>(&decoded) {
                return Some(v);
            }
        }
    }
    serde_json::from_slice::<Value>(body).ok()
}

/// Minimal application/x-www-form-urlencoded value decoding (`+` → space,
/// `%XX` → byte). Enough for the JSON `data` field VyOS clients send.
fn form_urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A well-formed bare SHA-256 hex digest, normalized to lowercase. `None` when
/// the caller passed something that is not 64 hex characters.
fn normalize_sha256(s: &str) -> Option<String> {
    let t = s.trim();
    if t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(t.to_ascii_lowercase())
    } else {
        None
    }
}

/// Predict the image name the installer derives from an ISO URL/path — the last
/// path segment (sans query) minus the `-<arch>.iso` suffix. Mirrors the
/// frontend's `imageNameFromIsoName`; used only for status display.
fn image_name_from_url(url: &str) -> Option<String> {
    let base = url.split('?').next().unwrap_or(url);
    let name = base.rsplit(['/', '\\']).next().unwrap_or(base);
    let lower = name.to_ascii_lowercase();
    for arch in ["amd64", "arm64", "i386", "armhf"] {
        let suffix = format!("-{arch}.iso");
        if lower.ends_with(&suffix) {
            return Some(name[..name.len() - suffix.len()].to_string());
        }
    }
    None
}

/// POST /api/image — intercept the VyOS `/image` op. `op: add` runs in the
/// background (see module docs); every other op is forwarded to the VyOS API
/// unchanged, preserving the previous proxy behaviour (delete, etc.).
pub async fn op(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, MAX_ISO_BYTES as usize).await {
        Ok(b) => b.to_vec(),
        Err(e) => return err_json(StatusCode::BAD_REQUEST, format!("reading request body: {e}")),
    };

    let parsed = parse_op(&bytes);
    let is_add = parsed
        .as_ref()
        .and_then(|v| v.get("op"))
        .and_then(Value::as_str)
        == Some("add");

    if !is_add {
        // Not an add — hand it back to the VyOS API exactly as the proxy would.
        let forwarded = Request::from_parts(parts, Body::from(bytes));
        return crate::proxy::handler(State(state), forwarded).await;
    }

    let data = parsed.unwrap_or_default();
    let url = match data.get("url").and_then(Value::as_str) {
        Some(u) if !u.trim().is_empty() => u.trim().to_string(),
        _ => return err_json(StatusCode::BAD_REQUEST, "the image add op requires a \"url\""),
    };

    // Optional integrity check. Present-but-malformed is a hard error (the
    // caller meant to verify); absent behaves exactly as before.
    let sha256 = match data.get("sha256") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => match normalize_sha256(s) {
            Some(h) => Some(h),
            None => {
                return err_json(
                    StatusCode::BAD_REQUEST,
                    "\"sha256\" must be a bare 64-character hex SHA-256 digest",
                )
            }
        },
        Some(_) => {
            return err_json(StatusCode::BAD_REQUEST, "\"sha256\" must be a hex string")
        }
    };

    let id = new_job_id();
    let image_name = image_name_from_url(&url);

    // Claim the single job slot. Refuse to start a second install over one still
    // in flight — two `add system image` runs would race on the image partition.
    {
        let mut slot = state.image_job.lock().unwrap();
        if let Some(existing) = slot.as_ref() {
            if existing.phase.is_running() {
                return err_json(
                    StatusCode::CONFLICT,
                    "an image install is already in progress — wait for it to finish",
                );
            }
        }
        *slot = Some(ImageJob {
            id: id.clone(),
            phase: Phase::Starting,
            downloaded_bytes: 0,
            total_bytes: None,
            image_name: image_name.clone(),
            error: None,
            started_unix: now_unix(),
            finished_unix: None,
        });
    }

    let task_state = state.clone();
    let task_url = url.clone();
    tokio::spawn(async move {
        run_install(task_state, task_url, sha256).await;
    });

    ok_json(json!({
        "status": "started",
        "job_id": id,
        "image_name": image_name,
    }))
}

/// GET /api/image/status — the current (or most recent) install job, or
/// `{job: null}` when none has run this boot. The console polls this to learn
/// when a backgrounded `op: add` has finished, and whether it succeeded.
pub async fn status(State(state): State<Arc<AppState>>) -> Response {
    let job = state.image_job.lock().unwrap().clone();
    (StatusCode::OK, Json(json!({ "job": job }))).into_response()
}

/// Mutate the current job in place (no-op if it was cleared/replaced).
fn update_job(state: &Arc<AppState>, f: impl FnOnce(&mut ImageJob)) {
    if let Some(job) = state.image_job.lock().unwrap().as_mut() {
        f(job);
    }
}

fn fail_job(state: &Arc<AppState>, msg: impl Into<String>) {
    let msg = msg.into();
    tracing::warn!("image install failed: {msg}");
    update_job(state, |j| {
        j.phase = Phase::Failed;
        j.error = Some(msg);
        j.finished_unix = Some(now_unix());
    });
}

/// The background worker: (download →) optional SHA-256 verify → `add system
/// image <local path>`. Any error is recorded on the job for the poller.
async fn run_install(state: Arc<AppState>, url: String, sha256: Option<String>) {
    // A URL is fetched by us; anything else is treated as an on-device path (a
    // browser upload staged by `image::upload`, whose url is a local path).
    let is_remote = url.starts_with("http://") || url.starts_with("https://");
    let download_path = state.config.guard_dir.join(DOWNLOAD_NAME);

    let local_path: PathBuf = if is_remote {
        update_job(&state, |j| j.phase = Phase::Downloading);
        // reqwest follows HTTPS redirects by default, so a GitHub release-asset
        // URL that 302s to the signed object-store URL resolves transparently —
        // and by downloading ourselves we hand `add system image` a local file,
        // sidestepping any redirect handling in the VyOS op entirely.
        if let Err(e) = download(&state, &url, &download_path).await {
            let _ = tokio::fs::remove_file(&download_path).await;
            fail_job(&state, e);
            return;
        }
        download_path.clone()
    } else {
        PathBuf::from(&url)
    };

    if let Some(want) = sha256 {
        update_job(&state, |j| j.phase = Phase::Verifying);
        match sha256_file(&local_path).await {
            Ok(got) if got == want => {}
            Ok(got) => {
                if is_remote {
                    let _ = tokio::fs::remove_file(&download_path).await;
                }
                fail_job(
                    &state,
                    format!("SHA-256 mismatch — expected {want}, got {got}. The download is corrupt or the wrong file; nothing was installed."),
                );
                return;
            }
            Err(e) => {
                if is_remote {
                    let _ = tokio::fs::remove_file(&download_path).await;
                }
                fail_job(&state, format!("could not read the downloaded image to verify it: {e}"));
                return;
            }
        }
    }

    update_job(&state, |j| j.phase = Phase::Installing);
    let result = crate::vyos::api_request(
        &state,
        "image",
        &json!({ "op": "add", "url": local_path.to_string_lossy() }),
    )
    .await;

    // Our downloaded ISO is dead weight once installed (or on failure) — the
    // image partition already holds the unpacked copy. A staged browser upload
    // is left for the frontend's own cleanup call.
    if is_remote {
        let _ = tokio::fs::remove_file(&download_path).await;
    }

    match result {
        Ok(_) => update_job(&state, |j| {
            j.phase = Phase::Done;
            j.finished_unix = Some(now_unix());
        }),
        Err(e) => fail_job(&state, translate_image_add_error(&e.to_string())),
    }
}

/// Stream a remote ISO to `dest`, enforcing the 4 GB ceiling and recording
/// progress on the job as it goes. Errors are human-readable strings.
async fn download(state: &Arc<AppState>, url: &str, dest: &Path) -> std::result::Result<(), String> {
    // NOT `state.http`: that client accepts invalid certs for the loopback
    // self-signed VyOS API. A firmware download comes over the public internet,
    // so it must validate TLS normally. Redirects are followed by default —
    // GitHub asset URLs 302 to a signed object-store URL (task item 4).
    // No overall timeout (a large ISO legitimately takes minutes), but a
    // per-read timeout so a stalled connection fails the job instead of hanging
    // an install forever.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("building the download client: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not reach the image URL: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "the image URL returned HTTP {} — check the release asset exists and is public",
            resp.status().as_u16()
        ));
    }
    let total = resp.content_length();
    update_job(state, |j| j.total_bytes = total);

    let _ = tokio::fs::remove_file(dest).await;
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("creating {}: {e}", dest.display()))?;

    let mut stream = resp.bytes_stream();
    let mut written: u64 = 0;
    let mut last_reported: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        written += chunk.len() as u64;
        if written > MAX_ISO_BYTES {
            return Err("the download is larger than any system image (4 GB cap)".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("writing {}: {e} — is the config partition out of space?", dest.display()))?;
        // Throttle status writes to ~4 MB steps so a fast download doesn't churn
        // the lock the poller shares.
        if written - last_reported >= 4 * 1024 * 1024 {
            last_reported = written;
            update_job(state, |j| j.downloaded_bytes = written);
        }
    }
    file.flush().await.ok();
    file.sync_all().await.ok();
    update_job(state, |j| j.downloaded_bytes = written);

    if written == 0 {
        return Err("the image URL returned an empty file".into());
    }
    Ok(())
}

/// SHA-256 of a file on disk, lowercase hex. Read in 1 MiB chunks so a ~500 MB
/// ISO doesn't land in memory all at once.
async fn sha256_file(path: &Path) -> std::result::Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("opening {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// The installer names the new image after the version embedded in the ISO and
/// dies with a raw `[Errno 17] File exists: '.../boot/<name>/...'` when that name
/// is already on the image partition. Translate that into something actionable;
/// anything else passes through. (Same message the frontend produces for the
/// interactive path, so cloud- and locally-initiated installs read alike.)
fn translate_image_add_error(msg: &str) -> String {
    if let Some(start) = msg.find("/boot/") {
        let rest = &msg[start + "/boot/".len()..];
        if let Some(end) = rest.find('/') {
            let name = &rest[..end];
            if msg.contains("[Errno 17]") && !name.is_empty() {
                return format!(
                    "An image named \"{name}\" already exists on the firewall, and the installer can't \
                     overwrite it. If that's the running image, build the new ISO with a different \
                     version. If it's listed under System Images (and not running), delete it there and \
                     retry."
                );
            }
        }
    }
    msg.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_op_reads_form_encoded_data_field() {
        // `data=<url-encoded json>&key=<key>` — the shape browser + cloud send.
        let body = b"data=%7B%22op%22%3A%22add%22%2C%22url%22%3A%22https%3A%2F%2Fx%2Fa.iso%22%7D&key=abc";
        let v = parse_op(body).expect("should parse");
        assert_eq!(v.get("op").and_then(Value::as_str), Some("add"));
        assert_eq!(v.get("url").and_then(Value::as_str), Some("https://x/a.iso"));
    }

    #[test]
    fn parse_op_falls_back_to_raw_json_body() {
        let v = parse_op(br#"{"op":"delete","name":"quartzfire-0.4.6"}"#).expect("json body");
        assert_eq!(v.get("op").and_then(Value::as_str), Some("delete"));
    }

    #[test]
    fn parse_op_rejects_garbage() {
        assert!(parse_op(b"not a form or json").is_none());
    }

    #[test]
    fn normalize_sha256_accepts_and_lowercases_64_hex() {
        let upper = "A".repeat(64);
        assert_eq!(normalize_sha256(&upper), Some("a".repeat(64)));
        assert_eq!(normalize_sha256(&format!("  {} ", "0".repeat(64))), Some("0".repeat(64)));
    }

    #[test]
    fn normalize_sha256_rejects_wrong_length_or_nonhex() {
        assert_eq!(normalize_sha256(&"a".repeat(63)), None);
        assert_eq!(normalize_sha256(&"a".repeat(65)), None);
        assert_eq!(normalize_sha256(&format!("{}g", "a".repeat(63))), None);
        assert_eq!(normalize_sha256(""), None);
    }

    #[test]
    fn image_name_strips_arch_suffix_and_query() {
        assert_eq!(
            image_name_from_url("https://github.com/o/r/releases/download/v0.4.7/quartzfire-0.4.7-amd64.iso"),
            Some("quartzfire-0.4.7".to_string()),
        );
        assert_eq!(
            image_name_from_url("https://cdn.example/quartzfire-0.4.7-arm64.iso?token=xyz"),
            Some("quartzfire-0.4.7".to_string()),
        );
        // A staged local upload path resolves the same way.
        assert_eq!(
            image_name_from_url("/config/quartzfire/upload.iso"),
            None,
        );
    }

    #[test]
    fn phase_running_is_only_the_non_terminal_states() {
        assert!(Phase::Starting.is_running());
        assert!(Phase::Downloading.is_running());
        assert!(Phase::Installing.is_running());
        assert!(!Phase::Done.is_running());
        assert!(!Phase::Failed.is_running());
    }

    #[test]
    fn translate_maps_errno17_to_friendly_and_passes_others_through() {
        let raw = "[Errno 17] File exists: '/usr/lib/live/mount/persistence/boot/quartzfire-0.4.7/foo'";
        let out = translate_image_add_error(raw);
        assert!(out.contains("already exists"));
        assert!(out.contains("quartzfire-0.4.7"));
        assert_eq!(translate_image_add_error("some other error"), "some other error");
    }
}
