//! Daemon orchestration (Linux only).
//!
//! Wires the collectors onto one tokio runtime, all sharing:
//!   * a single SQLite connection (std Mutex; locks are held only for the
//!     duration of a write, never across `.await`), and
//!   * an IP→MAC map the neighbor/lease collectors keep current so the
//!     conntrack accountant can attribute flows to devices.
//!
//! Collector loops are independent and best-effort: a tool that's missing or a
//! poll that fails is logged and retried next tick — one failing signal never
//! takes the daemon (or the other signals) down.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::config::Config;
use crate::conntrack::{self, Accountant};
use crate::mark;
use crate::db::{self, Sighting};
use crate::fingerprint::{self, Signals};
use crate::{leases, neigh};

/// Shared daemon state.
struct Shared {
    cfg: Config,
    /// The one DB connection. rusqlite is sync; every use is a short critical
    /// section with no `.await` inside.
    db: Mutex<Connection>,
    /// IP → MAC, kept current by the neighbor + lease collectors; the conntrack
    /// accountant resolves flow endpoints through it.
    ip_map: Mutex<HashMap<String, String>>,
    /// Byte-accounting state shared by the snapshot poll and destroy stream.
    accountant: Mutex<Accountant>,
    /// How to read an application id out of a flow's ct mark. Read once from
    /// App Control's published catalog at startup — qfappd rewrites that file
    /// only on its own restart, and a layout change needs both daemons
    /// restarted anyway (the old marks are already on live flows).
    mark_layout: mark::MarkLayout,
    /// Liveness/health for status.json.
    health: Health,
}

#[derive(Default)]
struct Health {
    neigh_ok: AtomicBool,
    lease_ok: AtomicBool,
    conntrack_ok: AtomicBool,
    last_neigh: AtomicU64,
    last_lease: AtomicU64,
    last_usage: AtomicU64,
    /// Set once we've logged about conntrack byte accounting being off (and
    /// re-enabled, or failed to), so that message appears only once per run.
    acct_off_warned: AtomicBool,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Privileged pre-start step: ensure the persistent store directory exists,
/// mount-aware and group-writable, before the sandboxed daemon starts.
///
/// The unit runs this via `ExecStartPre=+…` — the `+` runs it as root *outside*
/// the ProtectSystem=strict namespace. That matters because systemd only sets up
/// the `ReadWritePaths=-/config/quartzfire` writable bind for the main process
/// when the directory already exists at namespace construction. On a fresh
/// install it does not, so `/config` is read-only inside the daemon's namespace
/// and its own `create_dir_all` fails with EROFS — the daemon then exits before
/// signalling READY and the unit restart-loops. Creating the dir here (root,
/// after the /config mount lands) closes that gap; the same fix the WebUI
/// backend gets from ordering after the IPS boot unit, kept self-contained.
pub fn init_store(cfg: &Config) -> anyhow::Result<()> {
    use anyhow::Context;

    let Some(dir) = cfg.db_path.parent() else {
        return Ok(());
    };
    // Land the dir on the persistent volume, not the soon-to-be-shadowed root fs.
    wait_for_config_mount(&cfg.db_path);
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;

    // Group `quartzfire` + setgid (2775) so the DB and its WAL sidecars the
    // daemon later creates inside inherit the group the WebUI backend reads them
    // by. Best-effort — a dev box without the group just leaves it root-owned.
    if let Some(gid) = group_gid("quartzfire") {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(cpath) = std::ffi::CString::new(dir.as_os_str().to_string_lossy().as_bytes()) {
            unsafe {
                libc::chown(cpath.as_ptr(), 0, gid);
            }
        }
        if let Ok(meta) = std::fs::metadata(dir) {
            let mut perm = meta.permissions();
            perm.set_mode(0o2775);
            let _ = std::fs::set_permissions(dir, perm);
        }
    }
    tracing::info!("store directory ready at {}", dir.display());
    Ok(())
}

pub fn run(cfg: Config) -> anyhow::Result<()> {
    // Load the OUI database once (best-effort — absent = unknown vendors).
    fingerprint::init_oui(&cfg.oui_file);

    // /config mounts late on VyOS (vyos-router is Type=simple, so an `After=`
    // ordering does not wait for the bind mount). Opening the DB before that
    // would create it on the root fs, where the later mount would shadow it and
    // silently lose every write. Poll for the mount first (bounded), like the
    // other QuartzFire helpers.
    wait_for_config_mount(&cfg.db_path);

    let conn = db::open(&cfg.db_path, true)?;
    // Make the DB reachable by the WebUI backend (DynamicUser, member of the
    // `quartzfire` group): group-readable/writable so it can read the inventory
    // and write description edits. Best-effort — a dev box without the group is
    // fine.
    set_group_access(&cfg.db_path);
    tracing::info!("device inventory open at {}", cfg.db_path.display());

    let mark_layout = mark::load_layout(&cfg.appcontrol_catalog_file);

    let shared = Arc::new(Shared {
        cfg,
        db: Mutex::new(conn),
        ip_map: Mutex::new(HashMap::new()),
        accountant: Mutex::new(Accountant::new()),
        mark_layout,
        health: Health::default(),
    });

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;

    rt.block_on(async_main(shared))
}

async fn async_main(shared: Arc<Shared>) -> anyhow::Result<()> {
    use tokio::signal::unix::{signal, SignalKind};

    let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Ready]);
    spawn_watchdog();

    let shutdown = Arc::new(AtomicBool::new(false));

    let tasks = vec![
        tokio::spawn(neigh_loop(shared.clone())),
        tokio::spawn(lease_loop(shared.clone())),
        tokio::spawn(conntrack_snapshot_loop(shared.clone())),
        tokio::spawn(conntrack_destroy_loop(shared.clone())),
        tokio::spawn(maintenance_loop(shared.clone())),
    ];

    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = sigterm.recv() => tracing::info!("SIGTERM received"),
        _ = sigint.recv() => tracing::info!("SIGINT received"),
    }
    let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Stopping]);
    shutdown.store(true, Ordering::SeqCst);
    for t in tasks {
        t.abort();
    }
    tracing::info!("qfdevd stopped");
    Ok(())
}

fn spawn_watchdog() {
    let mut usec = 0u64;
    if sd_notify::watchdog_enabled(false, &mut usec) && usec > 0 {
        let interval = Duration::from_micros(usec / 2);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            loop {
                tick.tick().await;
                let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Watchdog]);
            }
        });
    }
}

// ── neighbor collector ──────────────────────────────────────────────────────

async fn neigh_loop(shared: Arc<Shared>) {
    let mut tick = tokio::time::interval(Duration::from_secs(shared.cfg.neigh_interval_secs.max(5)));
    loop {
        tick.tick().await;
        match neigh::collect().await {
            Ok(neighbors) => {
                shared.health.neigh_ok.store(true, Ordering::Relaxed);
                shared.health.last_neigh.store(now_secs() as u64, Ordering::Relaxed);
                apply_neighbors(&shared, neighbors);
            }
            Err(e) => {
                shared.health.neigh_ok.store(false, Ordering::Relaxed);
                tracing::warn!("neighbor poll failed: {e}");
            }
        }
    }
}

fn apply_neighbors(shared: &Shared, neighbors: Vec<neigh::Neighbor>) {
    let now = now_secs();
    let mut macs_touched: Vec<String> = Vec::new();
    {
        let conn = shared.db.lock().unwrap();
        let mut ip_map = shared.ip_map.lock().unwrap();
        for n in &neighbors {
            if !shared.cfg.is_lan_interface(&n.dev) {
                continue;
            }
            let vendor = fingerprint::vendor(&n.mac);
            let online = matches!(n.state.as_str(), "REACHABLE" | "DELAY" | "PROBE");
            // Split the neighbor IP by family so an IPv6 link-local never
            // overwrites the client's IPv4 (the WebUI's IPv4 column).
            let (current_ip, current_ipv6) = if is_ipv4(&n.ip) {
                (Some(n.ip.clone()), None)
            } else {
                (None, Some(n.ip.clone()))
            };
            let sighting = Sighting {
                mac: n.mac.clone(),
                seen_at: now,
                current_ip,
                current_ipv6,
                vendor,
                interface: Some(n.dev.clone()),
                vlan: vlan_of(&n.dev),
                neigh_state: Some(n.state.clone()),
                online: Some(online),
                ..Default::default()
            };
            if let Err(e) = db::upsert_sighting(&conn, &sighting) {
                tracing::warn!("neigh upsert {}: {e}", n.mac);
                continue;
            }
            ip_map.insert(n.ip.clone(), n.mac.clone());
            macs_touched.push(n.mac.clone());
        }
        // Flip stale/old devices offline on the same rule the WebUI applies.
        if let Err(e) = db::refresh_online(&conn, now, shared.cfg.online_timeout_secs as i64) {
            tracing::warn!("refresh_online: {e}");
        }
    }
    for mac in macs_touched {
        fingerprint_device(shared, &mac);
    }
}

// ── DHCP lease collector ────────────────────────────────────────────────────

async fn lease_loop(shared: Arc<Shared>) {
    let mut tick = tokio::time::interval(Duration::from_secs(shared.cfg.lease_interval_secs.max(5)));
    // The Kea config lives next to nothing we configured; derive its path from
    // the lease file's directory conventions but allow the well-known runtime
    // path too.
    let kea_config = std::path::PathBuf::from("/run/kea/kea-dhcp4.conf");
    loop {
        tick.tick().await;
        let statics = leases::read_reservation_macs(&kea_config);
        match leases::collect(&shared.cfg.kea_lease_file, &statics) {
            Ok(leases) => {
                shared.health.lease_ok.store(true, Ordering::Relaxed);
                shared.health.last_lease.store(now_secs() as u64, Ordering::Relaxed);
                apply_leases(&shared, leases);
            }
            Err(e) => {
                shared.health.lease_ok.store(false, Ordering::Relaxed);
                tracing::warn!("lease poll failed: {e}");
            }
        }
    }
}

fn apply_leases(shared: &Shared, leases: Vec<leases::Lease>) {
    let now = now_secs();
    let mut macs: Vec<String> = Vec::new();
    {
        let conn = shared.db.lock().unwrap();
        let mut ip_map = shared.ip_map.lock().unwrap();
        for l in &leases {
            let sighting = Sighting {
                mac: l.mac.clone(),
                // A lease read is not proof the device is up; keep last_seen as
                // the max of what we know (upsert uses MAX), but don't bump it
                // to "now" purely because a lease exists. Use the lease's own
                // freshness would be ideal; `now` is acceptable since a lease
                // in the active table was renewed recently.
                seen_at: now,
                current_ip: Some(l.ip.clone()),
                hostname: l.hostname.clone(),
                vendor: fingerprint::vendor(&l.mac),
                dhcp_static: Some(l.is_static),
                lease_expiry: Some(l.expire),
                ..Default::default()
            };
            if let Err(e) = db::upsert_sighting(&conn, &sighting) {
                tracing::warn!("lease upsert {}: {e}", l.mac);
                continue;
            }
            ip_map.insert(l.ip.clone(), l.mac.clone());
            macs.push(l.mac.clone());
        }
    }
    for mac in macs {
        fingerprint_device(shared, &mac);
    }
}

/// Recompute and store a device's fingerprint from its current hostname+vendor.
/// Deterministic and idempotent, so it's safe to run after every sighting.
fn fingerprint_device(shared: &Shared, mac: &str) {
    let conn = shared.db.lock().unwrap();
    let (hostname, vendor) = match db::identity(&conn, mac) {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!("identity {mac}: {e}");
            return;
        }
    };
    let fp = fingerprint::enrich(
        fingerprint::classify(&Signals {
            vendor: vendor.as_deref(),
            hostname: hostname.as_deref(),
            ..Default::default()
        }),
        mac,
    );
    if let Err(e) = db::set_fingerprint(&conn, mac, fp.client_type.as_deref(), fp.os_guess.as_deref()) {
        tracing::debug!("set_fingerprint {mac}: {e}");
    }
}

// ── conntrack usage collectors ──────────────────────────────────────────────

/// The kernel sysctl gating conntrack byte accounting. With this at 0, conntrack
/// tracks flows but records no `bytes=`, so per-device usage can never be
/// attributed and every Usage figure stays empty.
const CONNTRACK_ACCT_SYSCTL: &str = "/proc/sys/net/netfilter/nf_conntrack_acct";

/// Ensure conntrack byte accounting is on. `Ok(true)` = we just turned it on,
/// `Ok(false)` = it was already on, `Err` = it couldn't be read/written (the
/// sandbox must allow writing [`CONNTRACK_ACCT_SYSCTL`] — see the unit's
/// ReadWritePaths).
fn enable_conntrack_acct() -> std::io::Result<bool> {
    if std::fs::read_to_string(CONNTRACK_ACCT_SYSCTL)?.trim() == "1" {
        return Ok(false);
    }
    std::fs::write(CONNTRACK_ACCT_SYSCTL, b"1\n")?;
    Ok(true)
}

/// Periodic snapshot: credits growth on long-lived flows that never tear down
/// inside a window.
async fn conntrack_snapshot_loop(shared: Arc<Shared>) {
    let mut tick = tokio::time::interval(Duration::from_secs(shared.cfg.conntrack_snapshot_secs.max(5)));
    loop {
        tick.tick().await;

        // Re-assert byte accounting every tick. Our unit sets it at ExecStartPre,
        // but vyos-router is Type=simple: it reports "started" immediately and
        // then keeps applying config (reloading nf_conntrack / rewriting conntrack
        // sysctls) in the background, racing past our one-shot and zeroing the
        // value — which silently empties all usage. Continuously enforcing it
        // recovers accounting within one snapshot interval of any such reset.
        match enable_conntrack_acct() {
            Ok(true) => {
                if !shared.health.acct_off_warned.swap(true, Ordering::Relaxed) {
                    tracing::info!("nf_conntrack_acct was disabled; re-enabled it for usage accounting");
                }
            }
            Ok(false) => {}
            Err(e) => {
                if !shared.health.acct_off_warned.swap(true, Ordering::Relaxed) {
                    tracing::warn!(
                        "nf_conntrack_acct is disabled and could not be re-enabled ({e}); \
                         per-device usage will stay empty"
                    );
                }
            }
        }

        let out = Command::new("conntrack").args(["-L", "--output", "extended"]).output().await;
        let text = match out {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
            Ok(o) => {
                shared.health.conntrack_ok.store(false, Ordering::Relaxed);
                tracing::warn!("conntrack -L exited {}: {}", o.status, String::from_utf8_lossy(&o.stderr).trim());
                continue;
            }
            Err(e) => {
                shared.health.conntrack_ok.store(false, Ordering::Relaxed);
                tracing::warn!("conntrack -L failed to run: {e}");
                continue;
            }
        };
        shared.health.conntrack_ok.store(true, Ordering::Relaxed);

        let ip_snapshot = shared.ip_map.lock().unwrap().clone();
        let resolve = |ip: &str| ip_snapshot.get(ip).cloned();

        let bucket = db::bucket_of(now_secs());
        let record_flows = shared.cfg.flow_retention_secs > 0;
        let mut live_keys = std::collections::HashSet::new();
        let mut deltas: Vec<conntrack::Delta> = Vec::new();
        // Per-service-tuple raw deltas (+ connections begun) for the same pass,
        // batched so the DB sees one upsert per tuple, not one per line.
        let mut flow_aggs: HashMap<(String, String, String, u16), (u64, u64, u64)> = HashMap::new();
        {
            let mut acct = shared.accountant.lock().unwrap();
            for line in text.lines() {
                if let Some(flow) = conntrack::parse_line(line) {
                    live_keys.insert(flow.key.clone());
                    let Some(raw) = acct.observe_raw(&flow, false) else { continue };
                    // Device attribution and per-flow recording both come from
                    // the ONE raw delta, so they can never disagree about how
                    // many bytes this observation added.
                    if let Some(d) = conntrack::orient(&flow, raw, &resolve) {
                        deltas.push(d);
                    }
                    if record_flows {
                        let slot = flow_aggs
                            .entry((flow.proto.clone(), flow.orig_src.clone(), flow.orig_dst.clone(), flow.dport))
                            .or_default();
                        slot.0 += raw.d_orig;
                        slot.1 += raw.d_reply;
                        slot.2 += raw.new_flow as u64;
                    }
                }
            }
            // Drop accounting slots for flows gone since last snapshot (their
            // final bytes, if any, arrive via the destroy stream). Bounds the
            // map when the destroy stream is unavailable.
            acct.retain_keys(&live_keys);
            // This pass has now baselined every flow that was already open when
            // we started, so growth from here on is real and creditable. Must
            // happen after the loop: priming first would credit those flows'
            // entire history to this bucket.
            if !acct.is_primed() {
                acct.mark_primed();
                tracing::info!(
                    "conntrack accounting baselined against {} open flow(s); counting usage from now",
                    live_keys.len()
                );
                continue;
            }
        }
        commit_deltas(&shared, bucket, &deltas);
        commit_flows(&shared, bucket, &flow_aggs);
    }
}

/// Destroy-event stream: credits the final bytes of short flows that a snapshot
/// would miss (start and end between polls). Mirrors ips.rs's journalctl feed —
/// a long-lived child whose stdout we read line by line.
async fn conntrack_destroy_loop(shared: Arc<Shared>) {
    loop {
        let child = Command::new("conntrack")
            .args(["-E", "-e", "DESTROY", "--output", "extended", "--buffer-size", "1048576"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("conntrack -E unavailable ({e}); usage relies on snapshots only");
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
        };
        let Some(stdout) = child.stdout.take() else {
            tokio::time::sleep(Duration::from_secs(30)).await;
            continue;
        };
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let Some(flow) = conntrack::parse_line(&line) else { continue };
                    let ip_snapshot = shared.ip_map.lock().unwrap().clone();
                    let resolve = |ip: &str| ip_snapshot.get(ip).cloned();
                    let raw = {
                        let mut acct = shared.accountant.lock().unwrap();
                        acct.observe_raw(&flow, true)
                    };
                    let Some(raw) = raw else { continue };
                    let bucket = db::bucket_of(now_secs());
                    if let Some(d) = conntrack::orient(&flow, raw, &resolve) {
                        commit_deltas(&shared, bucket, std::slice::from_ref(&d));
                    }
                    if shared.cfg.flow_retention_secs > 0 {
                        let conn = shared.db.lock().unwrap();
                        if let Err(e) = db::add_flow_usage(
                            &conn, bucket, &flow.proto, &flow.orig_src, &flow.orig_dst, flow.dport,
                            raw.d_orig, raw.d_reply, raw.new_flow as u64,
                        ) {
                            tracing::warn!("add_flow_usage {}->{}: {e}", flow.orig_src, flow.orig_dst);
                        }
                    }
                }
                Ok(None) => break, // stream ended; respawn
                Err(e) => {
                    tracing::warn!("conntrack -E read error: {e}");
                    break;
                }
            }
        }
        // conntrack exited (or errored) — pause briefly and respawn.
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Fold a batch of device deltas into their usage buckets.
///
/// Every delta lands in the per-device total; a delta whose flow App Control has
/// classified *also* lands in that device's per-application bucket. The two are
/// written from one observation, so the per-app mix is always a subset of the
/// device's total for the same window rather than a second, disagreeing count.
fn commit_deltas(shared: &Shared, bucket: i64, deltas: &[conntrack::Delta]) {
    if deltas.is_empty() {
        return;
    }
    let app_bucket = db::app_bucket_of(bucket);
    let conn = shared.db.lock().unwrap();
    for d in deltas {
        if let Err(e) = db::add_usage(&conn, &d.mac, bucket, d.bytes_in, d.bytes_out) {
            tracing::warn!("add_usage {}: {e}", d.mac);
        }
        // Unclassified flows (App Control off, or a verdict not reached yet)
        // contribute to the device total but name no application.
        if let Some(app_id) = shared.mark_layout.app_id(d.mark) {
            if let Err(e) = db::add_app_usage(&conn, &d.mac, app_bucket, app_id, d.bytes_in, d.bytes_out) {
                tracing::warn!("add_app_usage {} app {app_id}: {e}", d.mac);
            }
        }
    }
    shared.health.last_usage.store(now_secs() as u64, Ordering::Relaxed);
}

/// Fold a snapshot pass's per-service-tuple raw deltas into flow buckets.
fn commit_flows(shared: &Shared, bucket: i64, aggs: &HashMap<(String, String, String, u16), (u64, u64, u64)>) {
    if aggs.is_empty() {
        return;
    }
    let conn = shared.db.lock().unwrap();
    for ((proto, src, dst, dport), (d_orig, d_reply, conns)) in aggs {
        if let Err(e) = db::add_flow_usage(&conn, bucket, proto, src, dst, *dport, *d_orig, *d_reply, *conns) {
            tracing::warn!("add_flow_usage {src}->{dst}: {e}");
        }
    }
}

// ── maintenance + status ────────────────────────────────────────────────────

async fn maintenance_loop(shared: Arc<Shared>) {
    // Write status shortly after boot, then prune + status on the long cycle.
    write_status(&shared);
    let mut status_tick = tokio::time::interval(Duration::from_secs(15));
    let mut prune_tick = tokio::time::interval(Duration::from_secs(shared.cfg.maintenance_interval_secs.max(60)));
    // interval fires immediately on first poll — swallow that so prune doesn't
    // run before any data exists.
    prune_tick.tick().await;
    loop {
        tokio::select! {
            _ = status_tick.tick() => write_status(&shared),
            _ = prune_tick.tick() => {
                let now = now_secs();
                let (usage_days, device_days) = (shared.cfg.usage_retention_days as i64, shared.cfg.device_retention_days as i64);
                let conn = shared.db.lock().unwrap();
                match db::prune(&conn, now, usage_days, device_days) {
                    Ok((b, d)) if b > 0 || d > 0 => tracing::info!("pruned {b} usage buckets, {d} devices"),
                    Ok(_) => {}
                    Err(e) => tracing::warn!("prune failed: {e}"),
                }
                if shared.cfg.flow_retention_secs > 0 {
                    match db::prune_flows(&conn, now, shared.cfg.flow_retention_secs as i64) {
                        Ok(n) if n > 0 => tracing::debug!("pruned {n} flow buckets"),
                        Ok(_) => {}
                        Err(e) => tracing::warn!("flow prune failed: {e}"),
                    }
                }
            }
        }
    }
}

#[derive(Serialize)]
struct StatusJson {
    qfdevd_version: &'static str,
    updated: i64,
    device_count: i64,
    neigh_ok: bool,
    lease_ok: bool,
    conntrack_ok: bool,
    last_neigh: u64,
    last_lease: u64,
    last_usage: u64,
}

/// Write the runtime status snapshot for the unprivileged WebUI backend
/// (atomic temp + rename, same discipline as the other daemons).
fn write_status(shared: &Shared) {
    let path = &shared.cfg.status_path;
    if path.as_os_str().is_empty() {
        return;
    }
    let device_count = {
        let conn = shared.db.lock().unwrap();
        db::device_count(&conn).unwrap_or(0)
    };
    let status = StatusJson {
        qfdevd_version: env!("CARGO_PKG_VERSION"),
        updated: now_secs(),
        device_count,
        neigh_ok: shared.health.neigh_ok.load(Ordering::Relaxed),
        lease_ok: shared.health.lease_ok.load(Ordering::Relaxed),
        conntrack_ok: shared.health.conntrack_ok.load(Ordering::Relaxed),
        last_neigh: shared.health.last_neigh.load(Ordering::Relaxed),
        last_lease: shared.health.last_lease.load(Ordering::Relaxed),
        last_usage: shared.health.last_usage.load(Ordering::Relaxed),
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(&status) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// Best-effort chgrp `quartzfire` + 0660 on the DB (and its WAL sidecars) so
/// the DynamicUser WebUI backend — a member of that group — can open it.
fn set_group_access(db_path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let Some(gid) = group_gid("quartzfire") else {
        return;
    };
    for suffix in ["", "-wal", "-shm"] {
        let p = if suffix.is_empty() {
            db_path.to_path_buf()
        } else {
            let mut s = db_path.as_os_str().to_owned();
            s.push(suffix);
            std::path::PathBuf::from(s)
        };
        // chown -1:gid (keep owner) via libc; std has no chgrp.
        if let Ok(cpath) = std::ffi::CString::new(p.as_os_str().to_string_lossy().as_bytes()) {
            unsafe {
                libc::chown(cpath.as_ptr(), u32::MAX, gid);
            }
        }
        if let Ok(meta) = std::fs::metadata(&p) {
            let mut perm = meta.permissions();
            perm.set_mode(0o660);
            let _ = std::fs::set_permissions(&p, perm);
        }
    }
    // The directory must be group-traversable/writable for WAL sidecar creation.
    if let Some(dir) = db_path.parent() {
        if let Ok(cpath) = std::ffi::CString::new(dir.as_os_str().to_string_lossy().as_bytes()) {
            unsafe {
                libc::chown(cpath.as_ptr(), u32::MAX, gid);
            }
        }
    }
}

/// Block until `/config` is mounted, so a DB path under it lands on the
/// persistent volume and not the soon-to-be-shadowed root fs. No-op when the DB
/// isn't under /config (dev boxes). Bounded to ~120s, then proceeds best-effort.
fn wait_for_config_mount(db_path: &std::path::Path) {
    if !db_path.starts_with("/config") {
        return;
    }
    // Detect the mount via /proc/self/mountinfo, NOT by comparing st_dev with
    // the root. On VyOS `/config` is an overlay bind of /opt/vyatta/etc/config
    // that shares the root filesystem's device id (verified on installed boxes:
    // `stat` reports the same device for `/` and `/config`), so a st_dev diff
    // never trips. The old heuristic therefore looped the full 120s every boot —
    // longer than systemd's default start timeout — and the unit restart-looped,
    // never opening the DB.
    for waited in 0..120 {
        if is_mountpoint("/config") {
            if waited > 0 {
                tracing::info!("/config mounted after {waited}s");
            }
            return;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    tracing::warn!("/config not detected as a mount after 120s; proceeding anyway");
}

/// True if `path` is an active mount point (appears as the mount-point field of
/// a line in /proc/self/mountinfo). Works for bind/overlay mounts that share the
/// parent filesystem's device id, which a st_dev comparison cannot detect.
fn is_mountpoint(path: &str) -> bool {
    let Ok(mounts) = std::fs::read_to_string("/proc/self/mountinfo") else {
        return false;
    };
    // mountinfo fields are space-separated; the 5th (index 4) is the mount
    // point. The kernel octal-escapes whitespace in the path, but /config has
    // none, so a direct compare is correct here.
    mounts
        .lines()
        .filter_map(|line| line.split(' ').nth(4))
        .any(|mp| mp == path)
}

fn group_gid(name: &str) -> Option<u32> {
    let cname = std::ffi::CString::new(name).ok()?;
    let grp = unsafe { libc::getgrnam(cname.as_ptr()) };
    if grp.is_null() {
        None
    } else {
        Some(unsafe { (*grp).gr_gid })
    }
}

/// A VLAN sub-interface name ("eth1.20") carries the VLAN id after the dot.
fn vlan_of(iface: &str) -> Option<String> {
    iface.split_once('.').map(|(_, vid)| vid.to_string())
}

/// True when `ip` parses as an IPv4 address (so IPv6 neighbors are routed to
/// `current_ipv6` instead of the IPv4 column).
fn is_ipv4(ip: &str) -> bool {
    ip.parse::<std::net::Ipv4Addr>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vlan_extraction() {
        assert_eq!(vlan_of("eth1.20").as_deref(), Some("20"));
        assert_eq!(vlan_of("eth1"), None);
        assert_eq!(vlan_of("bond0.100").as_deref(), Some("100"));
    }

    #[test]
    fn mountpoint_detects_root_not_bogus() {
        // `/` is always a mount point on Linux; a made-up path never is. Guards
        // the /proc/self/mountinfo field parsing that gates the DB open.
        assert!(is_mountpoint("/"));
        assert!(!is_mountpoint("/nonexistent-qfdevd-test-path"));
    }
}
