//! The persistent control channel to the assigned QuartzCommand gateway,
//! plus certificate renewal.
//!
//! quartzcommand.device.v1 currently defines only RenewCertificate — there
//! is no command-stream RPC yet, and no server redirect message. So the
//! "channel" today is: establish the mTLS HTTP/2 connection eagerly, hold it
//! open with 25 s keepalive pings, and drive renewal over it; connect
//! failures back off exponentially with jitter (1 s → 5 min cap).
//!
//! TODO(quartzcommand.device.v1): when the device service grows a command
//! stream (and/or a redirect message), attach it inside `connected_wait()` —
//! the reconnect loop, backoff, TLS identity plumbing, and status reporting
//! are already in place; a redirect just replaces `gateway` and continues
//! the loop.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::sync::Mutex;

use crate::enroll;
use crate::identity::{Identity, IdentityStore};
use crate::proto::device::device_service_client::DeviceServiceClient;
use crate::proto::device::RenewCertificateRequest;
use crate::state::{self, ControlState, EnrollmentState, StatusDoc, TrustPath};

/// Shared, serialized view of the live status; every mutation is written
/// through to status.json.
pub struct StatusCell {
    doc: Mutex<StatusDoc>,
    path: std::path::PathBuf,
}

impl StatusCell {
    pub fn new(doc: StatusDoc, path: std::path::PathBuf) -> Arc<Self> {
        let cell = Arc::new(Self { doc: Mutex::new(doc), path });
        cell
    }

    pub async fn update(&self, f: impl FnOnce(&mut StatusDoc)) {
        let mut doc = self.doc.lock().await;
        f(&mut doc);
        doc.time_unix = state::now_unix();
        if let Err(e) = doc.write(&self.path) {
            tracing::warn!("writing {} failed: {e:#}", self.path.display());
        }
    }
}

/// Full jitter without a rand dependency: the subsecond clock is plenty for
/// decorrelating a fleet's reconnect storms.
fn jitter(max: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    Duration::from_millis(nanos % (max.as_millis().max(1) as u64))
}

pub struct ControlChannel {
    pub store: IdentityStore,
    pub status: Arc<StatusCell>,
}

impl ControlChannel {
    /// Reconnect-forever loop. Returns only on unrecoverable local state
    /// (missing cert files) — the daemon then parks in an error state.
    pub async fn run(&self, identity: &Identity, mut st: EnrollmentState) -> Result<()> {
        let mut backoff = Duration::from_secs(1);
        loop {
            let gateway = st
                .control_gateway()
                .context("enrolled but no gateway recorded — re-enroll")?;
            let (host, port) = split_gateway(&gateway)?;

            self.status
                .update(|d| {
                    d.control = ControlState::Connecting;
                    d.gateway = Some(gateway.clone());
                })
                .await;

            match self.connect(identity, &st, &host, port).await {
                Ok(channel) => {
                    tracing::info!(%gateway, "control channel established");
                    backoff = Duration::from_secs(1);
                    self.status
                        .update(|d| {
                            d.control = ControlState::Connected;
                            d.control_since_unix = Some(state::now_unix());
                            d.last_error = None;
                        })
                        .await;

                    // Hold the connection; wake for renewal. A renewal RPC
                    // failure is our liveness probe today (see module TODO).
                    match self.connected_wait(channel, identity, &mut st).await {
                        Ok(()) => continue, // renewed → reconnect with the new cert
                        Err(e) => {
                            tracing::warn!("control channel lost: {e:#}");
                            self.status
                                .update(|d| {
                                    d.control = ControlState::Backoff;
                                    d.control_since_unix = None;
                                    d.last_error = Some(format!("{e:#}"));
                                })
                                .await;
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(%gateway, "control channel connect failed: {e:#}");
                    self.status
                        .update(|d| {
                            d.control = ControlState::Backoff;
                            d.last_error = Some(format!("{e:#}"));
                        })
                        .await;
                }
            }

            let wait = backoff + jitter(backoff);
            tracing::debug!("reconnecting in {wait:?}");
            tokio::time::sleep(wait).await;
            backoff = (backoff * 2).min(Duration::from_secs(300));
        }
    }

    async fn connect(
        &self,
        _identity: &Identity,
        st: &EnrollmentState,
        host: &str,
        port: u16,
    ) -> Result<tonic::transport::Channel> {
        let client_cert = std::fs::read_to_string(self.store.client_cert_path())
            .context("read client.crt — re-enroll (qf identity regenerate, then a fresh token)")?;
        let key_pem = std::fs::read_to_string(self.store.key_path()).context("read device.key")?;
        let chain: Vec<CertificateDer<'static>> =
            rustls_pemfile::certs(&mut client_cert.as_bytes())
                .collect::<std::result::Result<_, _>>()
                .context("parse client.crt")?;
        let key: PrivateKeyDer<'static> =
            rustls_pemfile::private_key(&mut key_pem.as_bytes())
                .context("parse device.key")?
                .context("device.key holds no key")?;

        // Server trust: the CA pinned at enrollment (plus the issued chain),
        // or WebPKI when enrollment validated that way.
        let ca_chain = std::fs::read_to_string(self.store.ca_chain_path()).unwrap_or_default();
        let pinned = std::fs::read_to_string(self.store.pinned_ca_path()).ok();
        let roots = match st.trust_path {
            Some(TrustPath::PinnedCa) => {
                let mut pems: Vec<&str> = Vec::new();
                if let Some(p) = pinned.as_deref() {
                    pems.push(p);
                }
                pems.push(&ca_chain);
                crate::tls::pinned_roots(&pems)?
            }
            _ => crate::tls::web_roots(&[&ca_chain])?,
        };
        let (tls, _outcome) = crate::tls::client_config(roots, None, Some((chain, key)))?;
        crate::tls::grpc_channel(host, port, tls, Duration::from_secs(15)).await
    }

    /// Sleep until certificate renewal is due, run it, persist, and return
    /// Ok(()) so the caller reconnects with the fresh cert.
    async fn connected_wait(
        &self,
        channel: tonic::transport::Channel,
        identity: &Identity,
        st: &mut EnrollmentState,
    ) -> Result<()> {
        loop {
            let now = state::now_unix();
            let renew_at = st.renew_after_unix.unwrap_or(now);
            let alarm = st
                .cert_not_after_unix
                .is_some_and(|exp| exp - now < 7 * 86_400);
            self.status.update(|d| d.cert_renewal_alarm = alarm && now >= renew_at).await;

            if now < renew_at {
                // Re-evaluate at least hourly so the alarm flag stays fresh.
                let wait = ((renew_at - now).min(3600)).max(1) as u64;
                tokio::time::sleep(Duration::from_secs(wait)).await;
                continue;
            }

            tracing::info!("certificate renewal due — requesting a fresh certificate");
            let device_id = st.device_id.clone().context("no device id in state")?;
            let csr_der = enroll::build_csr(&identity.key, &device_id)?;
            let mut client = DeviceServiceClient::new(channel.clone());
            let resp = client
                .renew_certificate(RenewCertificateRequest { csr_der })
                .await
                .map_err(|s| {
                    anyhow::anyhow!("RenewCertificate failed ({:?}): {}", s.code(), s.message())
                })?
                .into_inner();
            if resp.client_cert_der.is_empty() {
                anyhow::bail!("controller returned an empty renewed certificate");
            }

            // Keep the existing pinned CA (trust anchor rotation is a
            // re-enrollment event, not a renewal one).
            let pinned = std::fs::read(self.store.pinned_ca_path()).ok();
            self.store.save_certificates(
                &resp.client_cert_der,
                &resp.ca_chain_der,
                pinned.as_deref().and_then(|p| {
                    // stored as PEM — re-extract the DER for save_certificates
                    rustls_pemfile::certs(&mut &p[..]).next().and_then(|c| c.ok()).map(|c| c.as_ref().to_vec())
                }).as_deref(),
            )?;

            let (not_before, not_after) = enroll::cert_validity(&resp.client_cert_der)?;
            st.cert_not_before_unix = Some(not_before);
            st.cert_not_after_unix = Some(if resp.not_after_unix > 0 { resp.not_after_unix } else { not_after });
            st.renew_after_unix = Some(if resp.renew_after_unix > 0 {
                resp.renew_after_unix
            } else {
                enroll::renew_after(not_before, not_after)
            });
            st.save(&state::state_file())?;
            self.status
                .update(|d| {
                    d.cert_not_after_unix = st.cert_not_after_unix;
                    d.renew_after_unix = st.renew_after_unix;
                    d.cert_renewal_alarm = false;
                })
                .await;
            tracing::info!(
                not_after = st.cert_not_after_unix,
                "certificate renewed — reconnecting with the new certificate"
            );
            return Ok(());
        }
    }
}

fn split_gateway(gateway: &str) -> Result<(String, u16)> {
    let (host_raw, port) = gateway
        .rsplit_once(':')
        .with_context(|| format!("gateway '{gateway}' is not host:port"))?;
    let host = host_raw
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host_raw);
    Ok((host.to_string(), port.parse().with_context(|| format!("bad port in '{gateway}'"))?))
}
