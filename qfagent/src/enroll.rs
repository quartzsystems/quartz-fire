//! The enrollment client: proves key possession to the QuartzCommand
//! EnrollmentService and receives the mTLS client certificate for the
//! control channel.
//!
//! Flow (see the enrollment.proto contract):
//! 1. TLS to the token's gateway (the token's gateway always overrides any
//!    configured one for enrollment) — WebPKI first, token CA-fingerprint
//!    pin as fallback (src/tls.rs).
//! 2. `BeginEnrollment(token_id, pubkey)` → nonce + session id.
//! 3. Sign the nonce, build a CSR (CN = device id, same Ed25519 key),
//!    `CompleteEnrollment(secret, device_id, signature, CSR, hostname,
//!    version)`.
//! 4. Return the issued cert + CA chain + assigned gateway; the caller
//!    persists them and scrubs the token.
//!
//! Every failure maps to an operator-actionable message — these strings
//! surface verbatim on the CLI commit and in the WebUI.

use anyhow::{Context, Result};
use rustls::RootCertStore;

use crate::identity::KeyBackend;
use crate::proto::enrollment::enrollment_service_client::EnrollmentServiceClient;
use crate::proto::enrollment::{BeginEnrollmentRequest, CompleteEnrollmentRequest};
use crate::state::TrustPath;
use crate::tls::{self, VerifiedVia};
use crate::token::EnrollToken;
use crate::deviceid;

pub struct EnrollRequest<'a> {
    pub token: &'a EnrollToken,
    pub hostname: String,
    pub qf_version: String,
    /// Extra PEM trust anchors for the WebPKI path (configured
    /// `ca-certificate`). Tests inject their mock CA here to exercise the
    /// WebPKI path; None + a matching fingerprint exercises the pinned path.
    pub extra_ca_pem: Option<String>,
    /// Replace the Mozilla root store entirely (tests only — a mock server
    /// can never present a WebPKI-valid chain).
    pub test_roots_only: bool,
}

#[derive(Debug)]
pub struct EnrollOutcome {
    pub device_id: String,
    pub org_id: String,
    pub client_cert_der: Vec<u8>,
    pub ca_chain_der: Vec<Vec<u8>>,
    /// Empty from the server means "keep using the token's gateway".
    pub assigned_gateway: Option<String>,
    pub trust_path: TrustPath,
    /// DER of the CA to pin for future connections (pinned path only).
    pub pinned_ca_der: Option<Vec<u8>>,
    pub cert_not_before_unix: i64,
    pub cert_not_after_unix: i64,
    /// 2/3 of the cert lifetime — the renewal point.
    pub renew_after_unix: i64,
}

/// Build the CSR: CN = device id, signed with the device key.
pub fn build_csr(key: &dyn KeyBackend, device_id: &str) -> Result<Vec<u8>> {
    let pkcs8 = key.pkcs8_der()?;
    let keypair = rcgen::KeyPair::try_from(pkcs8.as_slice()).context("load key for CSR")?;
    let mut params = rcgen::CertificateParams::default();
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, device_id);
    let csr = params.serialize_request(&keypair).context("sign CSR")?;
    Ok(csr.der().to_vec())
}

/// Compute the 2/3-of-lifetime renewal point from cert validity.
pub fn renew_after(not_before: i64, not_after: i64) -> i64 {
    not_before + (not_after - not_before) * 2 / 3
}

/// Parse validity (unix seconds) out of a DER certificate.
pub fn cert_validity(der: &[u8]) -> Result<(i64, i64)> {
    let (_, cert) = x509_parser::parse_x509_certificate(der)
        .map_err(|e| anyhow::anyhow!("issued certificate does not parse: {e}"))?;
    let v = cert.validity();
    Ok((v.not_before.timestamp(), v.not_after.timestamp()))
}

pub async fn enroll(key: &dyn KeyBackend, req: EnrollRequest<'_>) -> Result<EnrollOutcome> {
    let token = req.token;
    let device_id = deviceid::derive_device_id(&key.public_key_raw());

    // Trust store for the handshake: WebPKI roots (+ extras), or extras only
    // under test_roots_only. The token's CA fingerprint rides along as the
    // pinning fallback.
    let extra: Vec<&str> = req.extra_ca_pem.as_deref().into_iter().collect();
    let roots: RootCertStore = if req.test_roots_only {
        let mut r = RootCertStore::empty();
        for pem_text in &extra {
            for der in rustls_pemfile::certs(&mut pem_text.as_bytes()) {
                r.add(der.context("parse test root")?).context("add test root")?;
            }
        }
        r
    } else {
        tls::web_roots(&extra)?
    };
    let (tls_config, outcome) = tls::client_config(roots, Some(token.ca_fingerprint), None)?;

    let channel = tls::grpc_channel(
        &token.gateway_host,
        token.gateway_port,
        tls_config,
        std::time::Duration::from_secs(15),
    )
    .await
    .map_err(|e| map_connect_error(e, token))?;

    let trust = outcome
        .lock()
        .unwrap()
        .clone()
        .context("TLS handshake completed without recording a trust path (bug)")?;
    let (trust_path, pinned_ca_der) = match &trust {
        VerifiedVia::WebPki => {
            tracing::info!(gateway = %token.gateway(), "gateway TLS validated via WebPKI");
            (TrustPath::WebPki, None)
        }
        VerifiedVia::Pinned(der) => {
            tracing::info!(
                gateway = %token.gateway(),
                "gateway TLS validated via the token's CA fingerprint — pinning this CA"
            );
            (TrustPath::PinnedCa, Some(der.clone()))
        }
    };

    let mut client = EnrollmentServiceClient::new(channel);

    let begin = client
        .begin_enrollment(BeginEnrollmentRequest {
            token_id: token.token_id.clone(),
            device_pubkey: key.public_key_raw().to_vec(),
        })
        .await
        .map_err(|s| map_grpc_error("BeginEnrollment", s))?
        .into_inner();
    if begin.nonce.is_empty() {
        anyhow::bail!("controller returned an empty enrollment nonce — controller bug or protocol mismatch");
    }

    let nonce_signature = key.sign(&begin.nonce);
    let csr_der = build_csr(key, &device_id)?;

    let done = client
        .complete_enrollment(CompleteEnrollmentRequest {
            enrollment_session_id: begin.enrollment_session_id,
            token_secret: token.secret.clone(),
            device_id: device_id.clone(),
            nonce_signature,
            csr_der,
            hostname: req.hostname,
            qf_version: req.qf_version,
        })
        .await
        .map_err(|s| map_grpc_error("CompleteEnrollment", s))?
        .into_inner();

    if done.client_cert_der.is_empty() {
        anyhow::bail!("controller returned no client certificate — controller bug or protocol mismatch");
    }
    let (not_before, not_after) = cert_validity(&done.client_cert_der)?;

    Ok(EnrollOutcome {
        device_id,
        org_id: done.org_id,
        client_cert_der: done.client_cert_der,
        ca_chain_der: done.ca_chain_der,
        assigned_gateway: Some(done.assigned_gateway).filter(|g| !g.is_empty()),
        trust_path,
        pinned_ca_der,
        cert_not_before_unix: not_before,
        cert_not_after_unix: not_after,
        renew_after_unix: renew_after(not_before, not_after),
    })
}

/// Turn transport/TLS failures into operator-actionable messages.
fn map_connect_error(e: anyhow::Error, token: &EnrollToken) -> anyhow::Error {
    let text = format!("{e:#}");
    let gateway = token.gateway();
    if text.contains("matches neither WebPKI nor the token's CA fingerprint") {
        return anyhow::anyhow!(
            "cannot trust {gateway}: {text}. If the controller's certificate was rotated, \
             issue a fresh enrollment token."
        );
    }
    if text.contains("Expired") || text.contains("NotValidYet") || text.contains("InvalidCertificate") {
        return anyhow::anyhow!(
            "TLS to {gateway} failed: {text}. If this mentions certificate validity, check \
             the device clock (see 'show system date') — a wrong clock makes valid \
             certificates look expired or not yet valid."
        );
    }
    if text.contains("dns error")
        || text.contains("failed to lookup")
        || text.contains("resolving gateway host")
    {
        return anyhow::anyhow!(
            "cannot resolve gateway host '{}' ({text}) — check DNS and the token's gateway segment",
            token.gateway_host
        );
    }
    if text.contains("refused") || text.contains("timed out") || text.contains("unreachable") {
        return anyhow::anyhow!(
            "cannot reach QuartzCommand gateway {gateway}: {text}. Check network/firewall \
             egress from this device."
        );
    }
    anyhow::anyhow!("connecting to QuartzCommand gateway {gateway} failed: {text}")
}

/// Turn gRPC status codes into operator-actionable messages.
fn map_grpc_error(rpc: &str, status: tonic::Status) -> anyhow::Error {
    use tonic::Code;
    let msg = status.message().to_string();
    match status.code() {
        Code::NotFound | Code::PermissionDenied | Code::Unauthenticated => anyhow::anyhow!(
            "the controller rejected the enrollment token ({rpc}: {msg}) — the token is \
             expired, revoked, or already used; issue a new one in QuartzCommand"
        ),
        Code::InvalidArgument if msg.to_lowercase().contains("signature") => anyhow::anyhow!(
            "the controller rejected the device's key-possession signature ({msg}) — the \
             device identity may be corrupt; run 'qf identity regenerate' and enroll again"
        ),
        Code::InvalidArgument => {
            anyhow::anyhow!("the controller rejected the enrollment request ({rpc}: {msg})")
        }
        Code::DeadlineExceeded | Code::Unavailable => anyhow::anyhow!(
            "the controller is unreachable mid-enrollment ({rpc}: {msg}) — try again; if \
             this persists, check the gateway address and network path"
        ),
        code => anyhow::anyhow!("enrollment failed ({rpc}: {code:?}: {msg})"),
    }
}
