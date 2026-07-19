//! Daemon orchestration (Linux only): identity assurance, the host
//! fingerprint gate, and the control-channel task.
//!
//! The daemon is deliberately restart-cheap and stateless: the conf-mode
//! owner snapshots settings and `systemctl try-restart`s it on every
//! `system quartz-command` commit, and enrollment/identity changes land the
//! same way. Everything durable lives under /config/quartzfire/qfagent/.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;

use crate::control::{ControlChannel, StatusCell};
use crate::identity::{HostFacts, IdentityStore};
use crate::state::{self, ControlState, EnrollmentState, StatusDoc};

pub fn run() -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
    rt.block_on(run_async())
}

async fn run_async() -> Result<()> {
    tracing::info!("qfagent {} starting", crate::VERSION);

    // /config is a late bind mount on VyOS (vyos-router is Type=simple —
    // `After=` cannot wait for it), so poll like qfdevd does. On a dev box
    // /config may simply be a directory; absence after the bound wait is
    // fatal only when we actually need to persist something.
    for _ in 0..120 {
        if std::path::Path::new("/config").is_dir() {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let store = IdentityStore::new(state::identity_dir());
    let current_host = HostFacts::read_system();

    if crate::identity::tpm_present() {
        tracing::info!(
            "TPM detected (/dev/tpmrm0): TPM-backed device identity is not yet implemented — \
             using the file-based identity (see identity::TpmKeyBackend)"
        );
    }

    // First start (or post-regenerate): create the identity.
    let identity = store.load_or_generate(&current_host)?;
    let device_id = identity.key.device_id();
    let st = EnrollmentState::load(&state::state_file())?;

    let mismatches = HostFacts::mismatches(&identity.recorded_host, &current_host);
    let host_mismatch = !mismatches.is_empty();

    let status = StatusCell::new(
        StatusDoc {
            time_unix: state::now_unix(),
            enrolled: st.enrolled,
            device_id: Some(device_id.clone()),
            org_id: st.org_id.clone(),
            gateway: st.control_gateway(),
            trust_path: st.trust_path,
            cert_not_after_unix: st.cert_not_after_unix,
            renew_after_unix: st.renew_after_unix,
            cert_renewal_alarm: false,
            control: if host_mismatch {
                ControlState::HostMismatch
            } else if st.enrolled {
                ControlState::Connecting
            } else {
                ControlState::Unenrolled
            },
            control_since_unix: None,
            last_error: None,
            flags: if host_mismatch {
                vec!["identity/host mismatch — run 'qf identity regenerate'".to_string()]
            } else {
                Vec::new()
            },
        },
        state::status_file(),
    );
    status.update(|_| {}).await; // initial write

    #[cfg(target_os = "linux")]
    let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Ready]);

    if host_mismatch {
        // Clone protection: same key on different hardware — refuse to talk
        // to the controller at all. Loud, and surfaced in status for the
        // CLI/WebUI.
        tracing::error!(
            "device identity was created on a different host ({}) — this looks like a cloned \
             image. REFUSING to open the control channel. Run 'qf identity regenerate' to \
             create a fresh identity for this machine (templates: use 'qf prepare-template' \
             before cloning).",
            mismatches.join("; ")
        );
        park(status).await;
        return Ok(());
    }

    if !st.enrolled {
        tracing::info!(
            %device_id,
            "not enrolled — set system quartz-command enroll-token <token> and commit to enroll"
        );
        park(status).await;
        return Ok(());
    }

    tracing::info!(%device_id, gateway = ?st.control_gateway(), "enrolled — starting control channel");
    let control = ControlChannel { store, status: status.clone() };
    tokio::select! {
        res = control.run(&identity, st) => {
            if let Err(e) = res {
                tracing::error!("control channel stopped: {e:#}");
                status.update(|d| {
                    d.control = ControlState::Backoff;
                    d.last_error = Some(format!("{e:#}"));
                }).await;
                park(status).await;
            }
        }
        _ = shutdown_signal() => {
            tracing::info!("shutting down");
        }
    }
    Ok(())
}

/// Idle keeping status.json fresh until terminated (unenrolled /
/// host-mismatch / unrecoverable states — a commit or lifecycle command
/// restarts the unit to pick up changes).
async fn park(status: Arc<StatusCell>) {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(30)) => {
                status.update(|_| {}).await;
            }
            _ = shutdown_signal() => return,
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
