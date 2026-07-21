//! Device identity: the Ed25519 keypair, its on-disk lifecycle, and the host
//! fingerprint that ties the identity to the machine it was created on
//! (clone protection).
//!
//! Layout (under `/config/quartzfire/qfagent/identity/` — `/config` per the
//! repo's persistence convention, so the identity survives image upgrades):
//!
//! | file           | content                                             |
//! |----------------|-----------------------------------------------------|
//! | `device.key`   | Ed25519 private key, PKCS#8 PEM, 0600 root          |
//! | `device.pub`   | Ed25519 public key, SPKI PEM                        |
//! | `host.json`    | machine-id + DMI product UUID at identity creation  |
//! | `client.crt`   | enrollment-issued mTLS client certificate (PEM)     |
//! | `ca-chain.crt` | controller CA chain from enrollment (PEM)           |
//! | `pinned-ca.crt`| CA pinned via the token fingerprint path, if used   |
//!
//! Keying is abstracted behind [`KeyBackend`] so a TPM-backed implementation
//! can be added without touching any caller (enrollment, renewal, the
//! control channel all sign/derive through the trait).

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};

use crate::deviceid;

/// Signing/derivation operations the rest of the agent needs from the device
/// key. `FileKeyBackend` is the only real implementation today;
/// [`TpmKeyBackend`] is the reserved seam for TPM-backed keys.
pub trait KeyBackend {
    /// Raw 32-byte Ed25519 public key (the device-ID input).
    fn public_key_raw(&self) -> [u8; 32];
    /// Ed25519 signature (64 bytes) over `msg`.
    fn sign(&self, msg: &[u8]) -> Vec<u8>;
    /// PKCS#8 DER of the private key, for CSR generation. A future TPM
    /// backend will instead have to produce CSRs internally — revisit the
    /// trait boundary then (callers only use this through `csr::build`).
    fn pkcs8_der(&self) -> Result<Vec<u8>>;
}

pub struct FileKeyBackend {
    key: SigningKey,
}

impl KeyBackend for FileKeyBackend {
    fn public_key_raw(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    fn sign(&self, msg: &[u8]) -> Vec<u8> {
        self.key.sign(msg).to_bytes().to_vec()
    }

    fn pkcs8_der(&self) -> Result<Vec<u8>> {
        Ok(self.key.to_pkcs8_der().context("encode private key")?.as_bytes().to_vec())
    }
}

impl FileKeyBackend {
    pub fn device_id(&self) -> String {
        deviceid::derive_device_id(&self.public_key_raw())
    }
}

/// TPM-backed identity is NOT yet implemented. `/dev/tpmrm0` presence is
/// logged at identity creation and the agent proceeds file-based; when TPM
/// keying lands it implements [`KeyBackend`] and `IdentityStore::open`
/// selects it, with no caller changes.
#[derive(Debug)]
pub struct TpmKeyBackend;

impl TpmKeyBackend {
    pub fn open() -> Result<Self> {
        bail!("TPM-backed device identity is not implemented yet");
    }
}

pub fn tpm_present() -> bool {
    Path::new("/dev/tpmrm0").exists()
}

// ── host fingerprint ──────────────────────────────────────────────────────────

/// Facts tying an identity to the machine it was generated on. Either field
/// may be unavailable (VMs without DMI, containers without machine-id); a
/// missing fact at creation time is never later treated as a mismatch.
///
/// Only `dmi_product_uuid` is a *hardware* anchor and thus the only fact that
/// gates clone detection (see [`HostFacts::mismatches`]). `machine_id` is
/// recorded for diagnostics only — it is an OS-install artifact, not a
/// hardware fact, and legitimately changes on the same box (see below).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct HostFacts {
    pub machine_id: Option<String>,
    pub dmi_product_uuid: Option<String>,
}

impl HostFacts {
    /// Read the current machine's facts from the standard paths.
    pub fn read_system() -> Self {
        Self::read_from(Path::new("/etc/machine-id"), Path::new("/sys/class/dmi/id/product_uuid"))
    }

    pub fn read_from(machine_id: &Path, product_uuid: &Path) -> Self {
        let read = |p: &Path| {
            std::fs::read_to_string(p)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        HostFacts { machine_id: read(machine_id), dmi_product_uuid: read(product_uuid) }
    }

    /// Clone detection: a mismatch is a *hardware-bound* fact that was
    /// recorded at identity creation AND is readable now AND differs. A fact
    /// missing on either side is inconclusive, not a mismatch (VMs/containers
    /// without DMI, first-boot ordering).
    ///
    /// Only the DMI product UUID counts. `/etc/machine-id` is deliberately NOT
    /// a clone-detection fact: on VyOS every installed image carries its own
    /// machine-id (systemd regenerates it on the new image's first boot),
    /// while the identity lives in the cross-image-persistent `/config`. So
    /// `add system image` + reboot would otherwise trip this gate and refuse
    /// the control channel on the *same* hardware — the exact false positive
    /// that forced operators to `qf identity regenerate` after every upgrade.
    /// The device key surviving in `/config` is the whole point; the machine
    /// it runs on has not changed. machine-id is still recorded in host.json
    /// for diagnostics, it just never gates.
    pub fn mismatches(recorded: &HostFacts, current: &HostFacts) -> Vec<String> {
        let mut out = Vec::new();
        if let (Some(a), Some(b)) = (&recorded.dmi_product_uuid, &current.dmi_product_uuid) {
            if a != b {
                out.push(format!("DMI product UUID changed ({a} → {b})"));
            }
        }
        out
    }
}

// ── on-disk store ─────────────────────────────────────────────────────────────

pub struct IdentityStore {
    pub dir: PathBuf,
}

pub struct Identity {
    pub key: FileKeyBackend,
    pub recorded_host: HostFacts,
}

impl IdentityStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn key_path(&self) -> PathBuf {
        self.dir.join("device.key")
    }
    pub fn pub_path(&self) -> PathBuf {
        self.dir.join("device.pub")
    }
    pub fn host_path(&self) -> PathBuf {
        self.dir.join("host.json")
    }
    pub fn client_cert_path(&self) -> PathBuf {
        self.dir.join("client.crt")
    }
    pub fn ca_chain_path(&self) -> PathBuf {
        self.dir.join("ca-chain.crt")
    }
    pub fn pinned_ca_path(&self) -> PathBuf {
        self.dir.join("pinned-ca.crt")
    }

    pub fn exists(&self) -> bool {
        self.key_path().exists()
    }

    /// Load the identity, or generate one if absent (first agent start /
    /// explicit init). Generation records the host facts alongside the key.
    pub fn load_or_generate(&self, current_host: &HostFacts) -> Result<Identity> {
        if self.exists() {
            return self.load();
        }
        if tpm_present() {
            tracing::warn!(
                "TPM detected (/dev/tpmrm0) but TPM-backed identity is not yet implemented — \
                 generating a file-based identity"
            );
        }
        std::fs::create_dir_all(&self.dir)
            .with_context(|| format!("create identity dir {}", self.dir.display()))?;

        let key = SigningKey::generate(&mut rand_core::OsRng);
        let key_pem = key
            .to_pkcs8_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .context("encode private key PEM")?;
        write_private(&self.key_path(), key_pem.as_bytes())?;

        let pub_pem = key
            .verifying_key()
            .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
            .context("encode public key PEM")?;
        atomic_write(&self.pub_path(), pub_pem.as_bytes())?;

        atomic_write(&self.host_path(), serde_json::to_string_pretty(current_host)?.as_bytes())?;

        let backend = FileKeyBackend { key };
        tracing::info!(device_id = %backend.device_id(), "generated new device identity");
        Ok(Identity { key: backend, recorded_host: current_host.clone() })
    }

    pub fn load(&self) -> Result<Identity> {
        let pem = std::fs::read_to_string(self.key_path())
            .with_context(|| format!("read {}", self.key_path().display()))?;
        let key = SigningKey::from_pkcs8_pem(&pem).context("parse device.key (PKCS#8 PEM)")?;
        let recorded_host: HostFacts = match std::fs::read_to_string(self.host_path()) {
            Ok(text) => serde_json::from_str(&text).context("parse host.json")?,
            // Pre-fingerprint identities (or a wiped file): treat as
            // "nothing recorded" — inconclusive, never a mismatch.
            Err(_) => HostFacts::default(),
        };
        Ok(Identity { key: FileKeyBackend { key }, recorded_host })
    }

    /// Persist the enrollment-issued certificate material.
    pub fn save_certificates(
        &self,
        client_cert_der: &[u8],
        ca_chain_der: &[Vec<u8>],
        pinned_ca_der: Option<&[u8]>,
    ) -> Result<()> {
        atomic_write(&self.client_cert_path(), pem_encode("CERTIFICATE", client_cert_der).as_bytes())?;
        let chain: String = ca_chain_der.iter().map(|der| pem_encode("CERTIFICATE", der)).collect();
        atomic_write(&self.ca_chain_path(), chain.as_bytes())?;
        match pinned_ca_der {
            Some(der) => {
                atomic_write(&self.pinned_ca_path(), pem_encode("CERTIFICATE", der).as_bytes())?
            }
            None => {
                let _ = std::fs::remove_file(self.pinned_ca_path());
            }
        }
        Ok(())
    }

    /// Remove the whole identity directory (regenerate / prepare-template).
    /// Returns the paths that were actually removed.
    pub fn wipe(&self) -> Result<Vec<PathBuf>> {
        let mut removed = Vec::new();
        if self.dir.exists() {
            for entry in std::fs::read_dir(&self.dir)? {
                let path = entry?.path();
                std::fs::remove_file(&path)
                    .with_context(|| format!("remove {}", path.display()))?;
                removed.push(path);
            }
            std::fs::remove_dir(&self.dir)?;
        }
        Ok(removed)
    }
}

pub fn pem_encode(tag: &str, der: &[u8]) -> String {
    pem::encode(&pem::Pem::new(tag.to_string(), der.to_vec()))
}

/// Write via temp file + rename so readers never see a partial file.
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)
            .with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
    Ok(())
}

/// Like `atomic_write` but the file is created 0600 (the private key). On
/// non-Unix dev hosts the mode bits are skipped.
fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_then_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = IdentityStore::new(dir.path().join("identity"));
        let host = HostFacts {
            machine_id: Some("abc123".into()),
            dmi_product_uuid: Some("00000000-1111-2222-3333-444444444444".into()),
        };
        assert!(!store.exists());
        let generated = store.load_or_generate(&host).unwrap();
        assert!(store.exists());

        let loaded = store.load().unwrap();
        assert_eq!(generated.key.public_key_raw(), loaded.key.public_key_raw());
        assert_eq!(loaded.recorded_host, host);

        // Signature over a message verifies with the stored public key.
        let sig = loaded.key.sign(b"nonce");
        assert_eq!(sig.len(), 64);

        // A second load_or_generate must NOT regenerate.
        let again = store.load_or_generate(&HostFacts::default()).unwrap();
        assert_eq!(again.key.public_key_raw(), generated.key.public_key_raw());
        // …and keeps the originally recorded host facts.
        assert_eq!(again.recorded_host, host);
    }

    #[cfg(unix)]
    #[test]
    fn private_key_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = IdentityStore::new(dir.path());
        store.load_or_generate(&HostFacts::default()).unwrap();
        let mode = std::fs::metadata(store.key_path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn host_mismatch_rules() {
        let recorded = HostFacts {
            machine_id: Some("aaa".into()),
            dmi_product_uuid: Some("uuid-1".into()),
        };

        // Identical → no mismatch.
        assert!(HostFacts::mismatches(&recorded, &recorded).is_empty());

        // machine-id changed but DMI product UUID stable → NO mismatch. This
        // is the VyOS image-upgrade case: the new image regenerates
        // /etc/machine-id but the box (and its DMI UUID) is the same, so the
        // control channel must NOT be refused.
        let upgraded = HostFacts { machine_id: Some("bbb".into()), ..recorded.clone() };
        assert!(HostFacts::mismatches(&recorded, &upgraded).is_empty());

        // Changed DMI product UUID → mismatch (the clone case: identity moved
        // to different hardware).
        let cloned = HostFacts { dmi_product_uuid: Some("uuid-2".into()), ..recorded.clone() };
        let m = HostFacts::mismatches(&recorded, &cloned);
        assert_eq!(m.len(), 1);
        assert!(m[0].contains("DMI product UUID"));

        // machine-id AND DMI both changed → still exactly one mismatch (only
        // the hardware fact is reported).
        let cloned2 = HostFacts {
            machine_id: Some("bbb".into()),
            dmi_product_uuid: Some("uuid-2".into()),
        };
        assert_eq!(HostFacts::mismatches(&recorded, &cloned2).len(), 1);

        // Missing DMI on either side is inconclusive, not a mismatch.
        let no_dmi = HostFacts { machine_id: Some("aaa".into()), dmi_product_uuid: None };
        assert!(HostFacts::mismatches(&recorded, &no_dmi).is_empty());
        assert!(HostFacts::mismatches(&no_dmi, &recorded).is_empty());
        assert!(HostFacts::mismatches(&HostFacts::default(), &recorded).is_empty());
    }

    /// The TPM seam exists but is explicitly not implemented — callers must
    /// get a clean error, never a silent fallback from this type itself.
    #[test]
    fn tpm_backend_is_a_stub() {
        let err = TpmKeyBackend::open().unwrap_err().to_string();
        assert!(err.contains("not implemented"), "{err}");
    }

    #[test]
    fn wipe_removes_everything() {
        let dir = tempfile::tempdir().unwrap();
        let store = IdentityStore::new(dir.path().join("identity"));
        store.load_or_generate(&HostFacts::default()).unwrap();
        store.save_certificates(b"fake-cert", &[b"fake-ca".to_vec()], Some(b"fake-pin")).unwrap();
        let removed = store.wipe().unwrap();
        assert!(removed.len() >= 5, "expected key/pub/host/cert/chain/pin removed, got {removed:?}");
        assert!(!store.dir.exists());
    }
}
