//! Enrollment client tests against a mock EnrollmentService speaking the
//! real wire protocol over real TLS (in-crate like quartzfire-geoip's
//! pipeline_tests — the crate is a binary, so `tests/` can't import it).
//!
//! Covered: the happy path on both trust paths (WebPKI-style root-store
//! validation vs token CA-fingerprint pinning), rejection when the chain
//! matches neither, expired-token and bad-signature error mapping, and
//! server-side verification of the nonce signature + CSR the client sends.
#![cfg(test)]

use std::sync::Arc;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rustls::pki_types::PrivateKeyDer;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::server::Connected;
use tonic::{Request, Response, Status};

use crate::deviceid;
use crate::enroll::{self, EnrollRequest};
use crate::identity::{HostFacts, IdentityStore, KeyBackend};
use crate::proto::enrollment::enrollment_service_server::{
    EnrollmentService, EnrollmentServiceServer,
};
use crate::proto::enrollment::{
    BeginEnrollmentRequest, BeginEnrollmentResponse, CompleteEnrollmentRequest,
    CompleteEnrollmentResponse,
};
use crate::state::TrustPath;
use crate::token;

const NONCE: &[u8] = b"mock-nonce-0123456789";
const SESSION: &str = "sess-1";
const SECRET: &str = "s3cr3tS3cr3t";

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Normal,
    ExpiredToken,
    RejectSignature,
}

struct MockCa {
    ca_cert: rcgen::Certificate,
    ca_key: rcgen::KeyPair,
}

struct MockService {
    mode: Mode,
    ca: Arc<MockCa>,
    assigned_gateway: String,
}

#[tonic::async_trait]
impl EnrollmentService for MockService {
    async fn begin_enrollment(
        &self,
        req: Request<BeginEnrollmentRequest>,
    ) -> Result<Response<BeginEnrollmentResponse>, Status> {
        let req = req.into_inner();
        if self.mode == Mode::ExpiredToken {
            return Err(Status::permission_denied("enrollment token expired"));
        }
        if req.token_id != "tok_1" {
            return Err(Status::not_found("unknown token id"));
        }
        if req.device_pubkey.len() != 32 {
            return Err(Status::invalid_argument("pubkey must be 32 bytes"));
        }
        Ok(Response::new(BeginEnrollmentResponse {
            nonce: NONCE.to_vec(),
            enrollment_session_id: SESSION.to_string(),
        }))
    }

    async fn complete_enrollment(
        &self,
        req: Request<CompleteEnrollmentRequest>,
    ) -> Result<Response<CompleteEnrollmentResponse>, Status> {
        let req = req.into_inner();
        if self.mode == Mode::RejectSignature {
            return Err(Status::invalid_argument("nonce signature verification failed"));
        }
        if req.enrollment_session_id != SESSION {
            return Err(Status::invalid_argument("unknown session"));
        }
        if req.token_secret != SECRET {
            return Err(Status::permission_denied("bad token secret"));
        }

        // Verify the CSR carries an Ed25519 key and that the claimed device
        // id + nonce signature check out against it — the same checks the
        // real controller performs.
        use x509_parser::prelude::FromDer as _;
        let (_, csr) =
            x509_parser::certification_request::X509CertificationRequest::from_der(&req.csr_der)
                .map_err(|e| Status::invalid_argument(format!("bad CSR: {e}")))?;
        csr.verify_signature()
            .map_err(|e| Status::invalid_argument(format!("CSR self-signature invalid: {e}")))?;
        let spki = &csr.certification_request_info.subject_pki;
        let pubkey_raw: [u8; 32] = spki
            .subject_public_key
            .data
            .as_ref()
            .try_into()
            .map_err(|_| Status::invalid_argument("CSR key is not raw 32-byte Ed25519"))?;
        if deviceid::derive_device_id(&pubkey_raw) != req.device_id {
            return Err(Status::invalid_argument("device_id does not match CSR pubkey"));
        }
        let cn = csr
            .certification_request_info
            .subject
            .iter_common_name()
            .next()
            .and_then(|cn| cn.as_str().ok())
            .unwrap_or_default();
        if cn != req.device_id {
            return Err(Status::invalid_argument("CSR CN must be the device id"));
        }
        let vk = VerifyingKey::from_bytes(&pubkey_raw)
            .map_err(|e| Status::invalid_argument(format!("bad pubkey: {e}")))?;
        let sig: Signature = Signature::from_slice(&req.nonce_signature)
            .map_err(|e| Status::invalid_argument(format!("bad signature shape: {e}")))?;
        vk.verify(NONCE, &sig)
            .map_err(|_| Status::invalid_argument("nonce signature verification failed"))?;

        // Issue a client cert from the CSR, CA-signed, 90-day lifetime.
        let csr_params = rcgen::CertificateSigningRequestParams::from_der(
            &req.csr_der.clone().into(),
        )
        .map_err(|e| Status::internal(format!("rcgen CSR parse: {e}")))?;
        let issued = csr_params
            .signed_by(&self.ca.ca_cert, &self.ca.ca_key)
            .map_err(|e| Status::internal(format!("issue cert: {e}")))?;

        Ok(Response::new(CompleteEnrollmentResponse {
            client_cert_der: issued.der().to_vec(),
            ca_chain_der: vec![self.ca.ca_cert.der().to_vec()],
            assigned_gateway: self.assigned_gateway.clone(),
            org_id: "org_test".to_string(),
        }))
    }
}

/// Newtype so a plain tokio-rustls stream satisfies tonic's `Connected`
/// bound (tonic only implements it for its own TLS types).
struct TestIo(tokio_rustls::server::TlsStream<tokio::net::TcpStream>);

impl Connected for TestIo {
    type ConnectInfo = ();
    fn connect_info(&self) {}
}

impl tokio::io::AsyncRead for TestIo {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for TestIo {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

struct MockServer {
    port: u16,
    ca_der: Vec<u8>,
    ca_pem: String,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

/// Start a TLS EnrollmentService on 127.0.0.1: CA → server cert for
/// "localhost". Returns the CA (trust material for the tests) and the port.
async fn start_mock(mode: Mode, assigned_gateway: &str) -> MockServer {
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "QuartzCommand Mock CA");
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();

    let server_key = rcgen::KeyPair::generate().unwrap();
    let server_params =
        rcgen::CertificateParams::new(vec!["localhost".to_string()]).unwrap();
    let server_cert = server_params.signed_by(&server_key, &ca_cert, &ca_key).unwrap();

    let mut tls = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![server_cert.der().clone(), ca_cert.der().clone()],
            PrivateKeyDer::try_from(server_key.serialize_der()).unwrap(),
        )
        .unwrap();
    tls.alpn_protocols = vec![b"h2".to_vec()];
    let acceptor = TlsAcceptor::from(Arc::new(tls));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let ca_der = ca_cert.der().to_vec();
    let ca_pem = ca_cert.pem();
    let ca = Arc::new(MockCa { ca_cert, ca_key });

    let (conn_tx, conn_rx) = mpsc::channel::<Result<TestIo, std::io::Error>>(4);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { break };
            let acceptor = acceptor.clone();
            let tx = conn_tx.clone();
            tokio::spawn(async move {
                if let Ok(stream) = acceptor.accept(tcp).await {
                    let _ = tx.send(Ok(TestIo(stream))).await;
                }
            });
        }
    });

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let service = MockService { mode, ca, assigned_gateway: to_owned(assigned_gateway) };
    tokio::spawn(async move {
        let _ = tonic::transport::Server::builder()
            .add_service(EnrollmentServiceServer::new(service))
            .serve_with_incoming_shutdown(ReceiverStream::new(conn_rx), async {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    MockServer { port, ca_der, ca_pem, _shutdown: shutdown_tx }
}

fn to_owned(s: &str) -> String {
    s.to_string()
}

fn make_token(port: u16, fingerprint: [u8; 32]) -> token::EnrollToken {
    let fp_hex: String = fingerprint.iter().map(|b| format!("{b:02x}")).collect();
    token::parse(&format!("QC1|localhost:{port}|org_test|tok_1.{SECRET}|sha256:{fp_hex}"))
        .unwrap()
}

fn test_identity() -> (tempfile::TempDir, crate::identity::Identity) {
    let dir = tempfile::tempdir().unwrap();
    let store = IdentityStore::new(dir.path().join("identity"));
    let id = store.load_or_generate(&HostFacts::default()).unwrap();
    (dir, id)
}

fn req<'a>(
    tok: &'a token::EnrollToken,
    extra_ca_pem: Option<String>,
) -> EnrollRequest<'a> {
    EnrollRequest {
        token: tok,
        hostname: "test-host".into(),
        qf_version: "test".into(),
        extra_ca_pem,
        test_roots_only: true,
    }
}

#[tokio::test]
async fn happy_path_via_pinned_ca() {
    let server = start_mock(Mode::Normal, "assigned.example.net:7443").await;
    let (_d, identity) = test_identity();
    // Empty root store + the CA's real fingerprint → the pinning path.
    let tok = make_token(server.port, crate::tls::sha256_fingerprint(&server.ca_der));

    let out = enroll::enroll(&identity.key, req(&tok, None)).await.unwrap();
    assert_eq!(out.org_id, "org_test");
    assert_eq!(out.trust_path, TrustPath::PinnedCa);
    assert_eq!(out.pinned_ca_der.as_deref(), Some(server.ca_der.as_slice()));
    assert_eq!(out.assigned_gateway.as_deref(), Some("assigned.example.net:7443"));
    assert_eq!(out.device_id, deviceid::derive_device_id(&identity.key.public_key_raw()));
    assert_eq!(out.ca_chain_der, vec![server.ca_der.clone()]);
    // Issued cert parses and the renewal point is inside the validity window.
    let (nb, na) = enroll::cert_validity(&out.client_cert_der).unwrap();
    assert!(nb < na);
    assert!(out.renew_after_unix > nb && out.renew_after_unix < na);
}

#[tokio::test]
async fn happy_path_via_root_store() {
    let server = start_mock(Mode::Normal, "").await;
    let (_d, identity) = test_identity();
    // CA in the (test) root store + a WRONG fingerprint → must validate via
    // the root store (the WebPKI path), never the pin.
    let tok = make_token(server.port, [0u8; 32]);

    let out = enroll::enroll(&identity.key, req(&tok, Some(server.ca_pem.clone())))
        .await
        .unwrap();
    assert_eq!(out.trust_path, TrustPath::WebPki);
    assert!(out.pinned_ca_der.is_none());
    // Empty assigned gateway from the server → fall back to the token's.
    assert_eq!(out.assigned_gateway, None);
}

#[tokio::test]
async fn rejects_chain_matching_neither() {
    let server = start_mock(Mode::Normal, "").await;
    let (_d, identity) = test_identity();
    // Empty root store AND a wrong fingerprint → hard reject before any RPC.
    let tok = make_token(server.port, [0u8; 32]);

    let err = enroll::enroll(&identity.key, req(&tok, None)).await.unwrap_err();
    let text = format!("{err:#}");
    assert!(
        text.contains("matches neither WebPKI nor the token's CA fingerprint"),
        "unexpected error: {text}"
    );
}

#[tokio::test]
async fn expired_token_maps_to_actionable_error() {
    let server = start_mock(Mode::ExpiredToken, "").await;
    let (_d, identity) = test_identity();
    let tok = make_token(server.port, crate::tls::sha256_fingerprint(&server.ca_der));

    let err = enroll::enroll(&identity.key, req(&tok, None)).await.unwrap_err();
    let text = format!("{err:#}");
    assert!(
        text.contains("expired, revoked, or already used"),
        "unexpected error: {text}"
    );
}

#[tokio::test]
async fn rejected_signature_maps_to_actionable_error() {
    let server = start_mock(Mode::RejectSignature, "").await;
    let (_d, identity) = test_identity();
    let tok = make_token(server.port, crate::tls::sha256_fingerprint(&server.ca_der));

    let err = enroll::enroll(&identity.key, req(&tok, None)).await.unwrap_err();
    let text = format!("{err:#}");
    assert!(
        text.contains("key-possession signature"),
        "unexpected error: {text}"
    );
    assert!(text.contains("qf identity regenerate"), "unexpected error: {text}");
}
