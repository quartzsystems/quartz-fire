//! Read `system quartz-command` (and the PKI cert it may reference) out of
//! the VyOS config via `cli-shell-api` — the same primitives-only approach as
//! quartzfire-geoip (see its src/config.rs for the full rationale): vyos-1x
//! is a prebuilt .deb here, and its higher-level config dictionaries consult
//! an XML cache that knows nothing about out-of-tree nodes.

use std::process::Command;

use crate::state::ConfigSnapshot;
use crate::token::{self, EnrollToken, TokenError};

pub const BASE: [&str; 2] = ["system", "quartz-command"];

/// The primitive reads, implemented by [`CliShellApi`] on a device and by
/// test fakes.
pub trait ConfigRead {
    fn exists(&self, path: &[&str]) -> bool;
    fn return_value(&self, path: &[&str]) -> Option<String>;
    /// Child node names under a path (tag values / subnodes).
    fn list_nodes(&self, path: &[&str]) -> Vec<String>;
    /// Every value of a multi-value leaf.
    fn return_values(&self, path: &[&str]) -> Vec<String>;
}

pub struct CliShellApi {
    /// false = session view (conf-mode owner, inherits the commit env);
    /// true = active/running config.
    active: bool,
}

impl CliShellApi {
    pub fn session() -> Self {
        Self { active: false }
    }
    pub fn active() -> Self {
        Self { active: true }
    }

    fn run(&self, verb: &str, path: &[&str]) -> Option<String> {
        let output = Command::new("cli-shell-api").arg(verb).args(path).output().ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// cli-shell-api list output: whitespace-separated tokens, each single-quoted
/// ('eth0' 'eth1'); values may contain spaces inside the quotes. (Same parse
/// as quartzfire-geoip's config.rs.)
fn parse_quoted_list(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in text.chars() {
        match ch {
            '\'' => {
                if in_quotes {
                    out.push(std::mem::take(&mut current));
                }
                in_quotes = !in_quotes;
            }
            _ if in_quotes => current.push(ch),
            _ => {}
        }
    }
    out
}

impl ConfigRead for CliShellApi {
    fn exists(&self, path: &[&str]) -> bool {
        let verb = if self.active { "existsActive" } else { "exists" };
        self.run(verb, path).is_some()
    }

    fn return_value(&self, path: &[&str]) -> Option<String> {
        let verb = if self.active { "returnActiveValue" } else { "returnValue" };
        let value = self.run(verb, path)?.trim_end_matches('\n').to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    fn list_nodes(&self, path: &[&str]) -> Vec<String> {
        let verb = if self.active { "listActiveNodes" } else { "listNodes" };
        self.run(verb, path).map(|t| parse_quoted_list(&t)).unwrap_or_default()
    }

    fn return_values(&self, path: &[&str]) -> Vec<String> {
        let verb = if self.active { "returnActiveValues" } else { "returnValues" };
        self.run(verb, path).map(|t| parse_quoted_list(&t)).unwrap_or_default()
    }
}

/// The `system quartz-command` tree as read from a config view.
#[derive(Debug, Default)]
pub struct QuartzCommandConfig {
    pub present: bool,
    pub gateway: Option<String>,
    pub port: u16,
    pub ca_certificate: Option<String>,
    pub enroll_token_raw: Option<String>,
}

pub fn read_config(conf: &dyn ConfigRead) -> QuartzCommandConfig {
    let leaf = |name: &'static str| [BASE[0], BASE[1], name];
    QuartzCommandConfig {
        present: conf.exists(&BASE),
        gateway: conf.return_value(&leaf("gateway")),
        port: conf
            .return_value(&leaf("port"))
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(ConfigSnapshot::default_port()),
        ca_certificate: conf.return_value(&leaf("ca-certificate")),
        enroll_token_raw: conf.return_value(&leaf("enroll-token")),
    }
}

impl QuartzCommandConfig {
    pub fn parse_token(&self) -> Option<Result<EnrollToken, TokenError>> {
        self.enroll_token_raw.as_deref().map(token::parse)
    }
}

/// Resolve a VyOS PKI certificate (`pki certificate <name> certificate`,
/// stored as base64 DER — a PEM body without headers) into PEM text.
pub fn resolve_pki_certificate(conf: &dyn ConfigRead, name: &str) -> Option<String> {
    let body = conf.return_value(&["pki", "certificate", name, "certificate"])?;
    let mut pem_text = String::from("-----BEGIN CERTIFICATE-----\n");
    let compact: String = body.split_whitespace().collect();
    for chunk in compact.as_bytes().chunks(64) {
        pem_text.push_str(std::str::from_utf8(chunk).ok()?);
        pem_text.push('\n');
    }
    pem_text.push_str("-----END CERTIFICATE-----\n");
    Some(pem_text)
}

#[cfg(test)]
pub mod testutil {
    use super::ConfigRead;
    use std::collections::HashMap;

    /// Path → value fake ("a b c" keys).
    #[derive(Default)]
    pub struct FakeConfig {
        pub values: HashMap<String, String>,
        pub multi: HashMap<String, Vec<String>>,
        pub nodes: Vec<String>,
    }

    impl FakeConfig {
        pub fn set(&mut self, path: &str, value: &str) {
            self.values.insert(path.to_string(), value.to_string());
            self.nodes.push(path.to_string());
        }
        pub fn set_multi(&mut self, path: &str, values: &[&str]) {
            self.multi
                .insert(path.to_string(), values.iter().map(|v| v.to_string()).collect());
            self.nodes.push(path.to_string());
        }
        pub fn node(&mut self, path: &str) {
            self.nodes.push(path.to_string());
        }
    }

    impl ConfigRead for FakeConfig {
        fn exists(&self, path: &[&str]) -> bool {
            let key = path.join(" ");
            self.values.contains_key(&key)
                || self.nodes.iter().any(|n| n == &key || n.starts_with(&format!("{key} ")))
        }
        fn return_value(&self, path: &[&str]) -> Option<String> {
            self.values.get(&path.join(" ")).cloned()
        }
        fn list_nodes(&self, path: &[&str]) -> Vec<String> {
            let prefix = format!("{} ", path.join(" "));
            let mut out: Vec<String> = Vec::new();
            for key in self.nodes.iter() {
                let Some(rest) = key.strip_prefix(&prefix) else { continue };
                let Some(child) = rest.split_whitespace().next() else { continue };
                if !out.iter().any(|c| c == child) {
                    out.push(child.to_string());
                }
            }
            out
        }
        fn return_values(&self, path: &[&str]) -> Vec<String> {
            self.multi.get(&path.join(" ")).cloned().unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::FakeConfig;
    use super::*;

    #[test]
    fn reads_tree_with_defaults() {
        let mut fake = FakeConfig::default();
        fake.node("system quartz-command");
        fake.set("system quartz-command gateway", "qc.example.net");
        let cfg = read_config(&fake);
        assert!(cfg.present);
        assert_eq!(cfg.gateway.as_deref(), Some("qc.example.net"));
        assert_eq!(cfg.port, 443, "port defaults to 443");
        assert!(cfg.ca_certificate.is_none());
        assert!(cfg.enroll_token_raw.is_none());
    }

    #[test]
    fn absent_tree() {
        let cfg = read_config(&FakeConfig::default());
        assert!(!cfg.present);
    }

    #[test]
    fn quoted_list_parses() {
        assert_eq!(parse_quoted_list("'eth0' 'eth1'"), vec!["eth0", "eth1"]);
        assert_eq!(parse_quoted_list("'with space' 'b'"), vec!["with space", "b"]);
        assert_eq!(parse_quoted_list(""), Vec::<String>::new());
        assert_eq!(parse_quoted_list("'one'\n"), vec!["one"]);
    }

    #[test]
    fn fake_lists_children_and_multi_values() {
        let mut fake = FakeConfig::default();
        fake.set("firewall zone WAN description", "uplink");
        fake.set_multi("firewall zone WAN member interface", &["eth0", "eth3"]);
        fake.node("firewall zone LAN");
        let mut zones = fake.list_nodes(&["firewall", "zone"]);
        zones.sort();
        assert_eq!(zones, vec!["LAN", "WAN"]);
        assert_eq!(
            fake.return_values(&["firewall", "zone", "WAN", "member", "interface"]),
            vec!["eth0", "eth3"]
        );
        assert!(fake.return_values(&["firewall", "zone", "LAN", "member", "interface"]).is_empty());
    }

    #[test]
    fn pki_cert_resolves_to_pem() {
        let mut fake = FakeConfig::default();
        // Not a real cert — resolve_pki_certificate only re-wraps base64.
        fake.set("pki certificate qc-ca certificate", &"TUlJQ2FiY2Q=".repeat(20));
        let pem_text = resolve_pki_certificate(&fake, "qc-ca").unwrap();
        assert!(pem_text.starts_with("-----BEGIN CERTIFICATE-----\n"));
        assert!(pem_text.ends_with("-----END CERTIFICATE-----\n"));
        assert!(pem_text.lines().all(|l| l.len() <= 64));
        assert!(resolve_pki_certificate(&fake, "missing").is_none());
    }
}
