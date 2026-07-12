//! Read the SSL-inspection model out of the VyOS config via `cli-shell-api` —
//! the same C++ tool the vyos-1x Python Config class wraps — so this compiled
//! binary can act as the `service quartzfire ssl-inspection` conf-mode owner.
//!
//! Two views: session (inside a commit, the proposed config) and active (the
//! running config, for the standalone resync). Only the primitive verbs are
//! used, deliberately — vyos-1x's higher-level config dictionaries consult its
//! XML reference cache, which knows nothing about nodes this package adds.
//! Identical machinery to quartzfire-geoip's config.rs.

use std::collections::BTreeMap;
use std::process::Command;

use crate::matchrepl::{Groups, IfaceSpec, RuleCfg, Side};
use crate::model::{ContentFilter, Model, Policy};

pub const BASE: [&str; 3] = ["service", "quartzfire", "ssl-inspection"];

const GROUP_TYPES: [&str; 5] = [
    "address-group",
    "network-group",
    "domain-group",
    "interface-group",
    "port-group",
];

fn group_leaves(gtype: &str) -> &'static [&'static str] {
    match gtype {
        "address-group" => &["address", "include"],
        "network-group" => &["network", "include"],
        "domain-group" => &["address", "include"],
        "interface-group" => &["interface"],
        "port-group" => &["port"],
        _ => &[],
    }
}

pub trait ConfigRead {
    fn exists(&self, path: &[&str]) -> bool;
    fn list_nodes(&self, path: &[&str]) -> Vec<String>;
    fn return_value(&self, path: &[&str]) -> Option<String>;
    fn return_values(&self, path: &[&str]) -> Vec<String>;
}

pub struct CliShellApi {
    active: bool,
}

impl CliShellApi {
    pub fn session() -> Self {
        Self { active: false }
    }
    /// The running-config view, used by the standalone resync to re-resolve each
    /// policy's firewall-rule match after a firewall commit (VyOS may edit the
    /// bound rule; the redirect must follow it).
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

/// cli-shell-api list output: whitespace-separated single-quoted tokens
/// ('eth0' 'eth1'); values may contain spaces inside the quotes.
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
    fn list_nodes(&self, path: &[&str]) -> Vec<String> {
        let verb = if self.active { "listActiveNodes" } else { "listNodes" };
        self.run(verb, path).map(|t| parse_quoted_list(&t)).unwrap_or_default()
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
    fn return_values(&self, path: &[&str]) -> Vec<String> {
        let verb = if self.active { "returnActiveValues" } else { "returnValues" };
        self.run(verb, path).map(|t| parse_quoted_list(&t)).unwrap_or_default()
    }
}

fn join<'a>(base: &[&'a str], rest: &[&'a str]) -> Vec<&'a str> {
    base.iter().chain(rest.iter()).copied().collect()
}

/// Full path to the valueless `enable` node — used by the commit owner to
/// detect the off→on transition (session has it, the active config did not).
pub fn join_enable() -> Vec<&'static str> {
    join(&BASE, &["enable"])
}

/// The `service quartzfire ssl-inspection` subtree as a normalized model.
pub fn read_service(conf: &dyn ConfigRead) -> Model {
    let mut model = Model::default();
    if !conf.exists(&BASE) {
        return model;
    }
    model.enabled = conf.exists(&join(&BASE, &["enable"]));
    if let Some(p) = conf.return_value(&join(&BASE, &["intercept-port"])).and_then(|v| v.parse().ok()) {
        model.intercept_port = p;
    }
    for num in conf.list_nodes(&join(&BASE, &["policy"])) {
        let p: Vec<&str> = vec!["service", "quartzfire", "ssl-inspection", "policy", &num];
        model.policies.push(Policy {
            rule: num.parse().unwrap_or(0),
            ruleset: conf
                .return_value(&join(&p, &["ruleset"]))
                .unwrap_or_else(|| "forward".into()),
            action: conf
                .return_value(&join(&p, &["action"]))
                .unwrap_or_else(|| "inspect".into()),
            enabled: !conf.exists(&join(&p, &["disable"])),
        });
    }
    model.policies.sort_by_key(|p| p.rule);
    if let Some(a) = conf.return_value(&join(&BASE, &["default-action"])) {
        model.default_action = a;
    }
    model.no_inspect = conf.return_values(&join(&BASE, &["no-inspect"]));
    model.default_exclusions = !conf.exists(&join(&BASE, &["disable-default-exclusions"]));
    if let Some(u) = conf.return_value(&join(&BASE, &["upstream-invalid"])) {
        model.upstream_invalid = u;
    }
    model.ca_download_interfaces =
        conf.return_values(&join(&BASE, &["ca-download", "interface"]));

    if conf.exists(&join(&BASE, &["content-filter"])) {
        let cf_base = join(&BASE, &["content-filter"]);
        let mut cf = ContentFilter::default();
        if let Some(h) = conf.return_value(&join(&cf_base, &["icap-host"])) {
            cf.icap_host = h;
        }
        if let Some(p) = conf.return_value(&join(&cf_base, &["icap-port"])).and_then(|v| v.parse().ok()) {
            cf.icap_port = p;
        }
        if let Some(s) = conf.return_value(&join(&cf_base, &["reqmod-service"])) {
            cf.reqmod_service = s;
        }
        if let Some(s) = conf.return_value(&join(&cf_base, &["respmod-service"])) {
            cf.respmod_service = s;
        }
        if let Some(f) = conf.return_value(&join(&cf_base, &["fail-mode"])) {
            cf.fail_mode = f;
        }
        model.content_filter = Some(cf);
    }

    model
}

/// The bits of one firewall rule the SSL match replication needs, or None when
/// the rule does not exist (a dangling policy). Identical to geoip's reader.
pub fn read_rule_cfg(conf: &dyn ConfigRead, ruleset: &str, rule: u32) -> Option<RuleCfg> {
    let rule_s = rule.to_string();
    let base: Vec<&str> = vec!["firewall", "ipv4", ruleset, "filter", "rule", &rule_s];
    if !conf.exists(&base) {
        return None;
    }

    let iface = |key: &str| -> Option<IfaceSpec> {
        if let Some(name) = conf.return_value(&join(&base, &[key, "name"])) {
            return Some(IfaceSpec { name: Some(name), group: None });
        }
        if let Some(group) = conf.return_value(&join(&base, &[key, "group"])) {
            return Some(IfaceSpec { name: None, group: Some(group) });
        }
        None
    };

    let side = |key: &str| -> Side {
        let mut out = Side {
            address: conf.return_value(&join(&base, &[key, "address"])),
            ..Default::default()
        };
        for gt in ["address-group", "network-group", "domain-group"] {
            if let Some(name) = conf.return_value(&join(&base, &[key, "group", gt])) {
                out.group_type = Some(gt.into());
                out.group_name = Some(name);
                break;
            }
        }
        out
    };

    let mut destination = side("destination");
    destination.port_group = conf.return_value(&join(&base, &["destination", "group", "port-group"]));

    Some(RuleCfg {
        inbound_interface: iface("inbound-interface"),
        outbound_interface: iface("outbound-interface"),
        source: side("source"),
        destination,
        protocol: conf.return_value(&join(&base, &["protocol"])),
    })
}

/// Every firewall group's members, for group-reference resolution.
pub fn read_groups(conf: &dyn ConfigRead) -> Groups {
    let mut groups = Groups::new();
    for gt in GROUP_TYPES {
        groups.insert(gt.to_string(), BTreeMap::new());
    }
    if !conf.exists(&["firewall", "group"]) {
        return groups;
    }
    for gt in GROUP_TYPES {
        if !conf.exists(&["firewall", "group", gt]) {
            continue;
        }
        for name in conf.list_nodes(&["firewall", "group", gt]) {
            let mut entry = BTreeMap::new();
            for leaf in group_leaves(gt) {
                entry.insert(
                    leaf.to_string(),
                    conf.return_values(&["firewall", "group", gt, &name, leaf]),
                );
            }
            groups.get_mut(gt).unwrap().insert(name, entry);
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// In-memory fake: a set of existing paths + single/multi values, keyed by
    /// the space-joined path. Mirrors the geoip test fake style.
    #[derive(Default)]
    struct Fake {
        present: BTreeSet<String>,
        values: std::collections::BTreeMap<String, String>,
        multi: std::collections::BTreeMap<String, Vec<String>>,
        children: std::collections::BTreeMap<String, Vec<String>>,
    }
    impl Fake {
        fn key(path: &[&str]) -> String {
            path.join(" ")
        }
        fn set(&mut self, path: &[&str]) {
            // Mark this path and all ancestors present.
            for i in 1..=path.len() {
                self.present.insert(Self::key(&path[..i]));
            }
        }
        fn value(&mut self, path: &[&str], v: &str) {
            self.set(path);
            self.values.insert(Self::key(path), v.to_string());
        }
        fn values_of(&mut self, path: &[&str], vs: &[&str]) {
            self.set(path);
            self.multi.insert(Self::key(path), vs.iter().map(|s| s.to_string()).collect());
        }
        /// Register `child` as a tag-node under `parent` (and mark it present).
        fn child(&mut self, parent: &[&str], child: &str) {
            self.set(parent);
            let mut full = parent.to_vec();
            full.push(child);
            self.set(&full);
            self.children.entry(Self::key(parent)).or_default().push(child.to_string());
        }
    }
    impl ConfigRead for Fake {
        fn exists(&self, path: &[&str]) -> bool {
            self.present.contains(&Self::key(path))
        }
        fn list_nodes(&self, path: &[&str]) -> Vec<String> {
            self.children.get(&Self::key(path)).cloned().unwrap_or_default()
        }
        fn return_value(&self, path: &[&str]) -> Option<String> {
            self.values.get(&Self::key(path)).cloned()
        }
        fn return_values(&self, path: &[&str]) -> Vec<String> {
            self.multi.get(&Self::key(path)).cloned().unwrap_or_default()
        }
    }

    #[test]
    fn absent_tree_is_disabled_default() {
        let m = read_service(&Fake::default());
        assert!(!m.enabled);
        assert_eq!(m.intercept_port, 3129);
        assert!(m.default_exclusions);
    }

    #[test]
    fn reads_full_model() {
        let mut f = Fake::default();
        f.set(&["service", "quartzfire", "ssl-inspection", "enable"]);
        f.value(&["service", "quartzfire", "ssl-inspection", "intercept-port"], "3130");
        f.child(&["service", "quartzfire", "ssl-inspection", "policy"], "20");
        f.value(&["service", "quartzfire", "ssl-inspection", "policy", "20", "action"], "inspect");
        f.child(&["service", "quartzfire", "ssl-inspection", "policy"], "30");
        f.value(&["service", "quartzfire", "ssl-inspection", "policy", "30", "action"], "splice");
        f.set(&["service", "quartzfire", "ssl-inspection", "policy", "30", "disable"]);
        f.value(&["service", "quartzfire", "ssl-inspection", "default-action"], "inspect");
        f.values_of(&["service", "quartzfire", "ssl-inspection", "no-inspect"], &["internal.example"]);
        f.value(&["service", "quartzfire", "ssl-inspection", "upstream-invalid"], "allow");
        f.set(&["service", "quartzfire", "ssl-inspection", "content-filter"]);
        f.value(&["service", "quartzfire", "ssl-inspection", "content-filter", "icap-host"], "10.0.0.9");
        f.value(&["service", "quartzfire", "ssl-inspection", "content-filter", "icap-port"], "1345");
        f.value(&["service", "quartzfire", "ssl-inspection", "content-filter", "fail-mode"], "open");

        let m = read_service(&f);
        assert!(m.enabled);
        assert_eq!(m.intercept_port, 3130);
        assert_eq!(m.policies.len(), 2);
        assert_eq!(m.policies[0].rule, 20);
        assert_eq!(m.policies[0].action, "inspect");
        assert!(m.policies[0].enabled);
        assert_eq!(m.policies[1].rule, 30);
        assert_eq!(m.policies[1].action, "splice");
        assert!(!m.policies[1].enabled); // has `disable`
        assert_eq!(m.no_inspect, vec!["internal.example"]);
        assert_eq!(m.upstream_invalid, "allow");
        let cf = m.content_filter.expect("content filter present");
        assert_eq!(cf.icap_host, "10.0.0.9");
        assert_eq!(cf.icap_port, 1345);
        assert_eq!(cf.fail_mode, "open");
    }

    #[test]
    fn disable_default_exclusions_flag() {
        let mut f = Fake::default();
        f.set(&["service", "quartzfire", "ssl-inspection", "enable"]);
        f.set(&["service", "quartzfire", "ssl-inspection", "disable-default-exclusions"]);
        let m = read_service(&f);
        assert!(!m.default_exclusions);
    }

    #[test]
    fn quoted_list_parses() {
        assert_eq!(parse_quoted_list("'eth0' 'eth1'"), vec!["eth0", "eth1"]);
        assert_eq!(parse_quoted_list("'with space' 'b'"), vec!["with space", "b"]);
        assert_eq!(parse_quoted_list(""), Vec::<String>::new());
    }

    #[test]
    fn reads_a_forward_filter_rule() {
        let mut f = Fake::default();
        let base = &["firewall", "ipv4", "forward", "filter", "rule", "20"];
        f.set(base);
        f.value(&["firewall", "ipv4", "forward", "filter", "rule", "20", "inbound-interface", "name"], "eth1");
        f.value(&["firewall", "ipv4", "forward", "filter", "rule", "20", "source", "address"], "10.0.0.0/8");
        f.value(&["firewall", "ipv4", "forward", "filter", "rule", "20", "protocol"], "tcp");
        let cfg = read_rule_cfg(&f, "forward", 20).expect("rule present");
        assert_eq!(cfg.inbound_interface.unwrap().name.unwrap(), "eth1");
        assert_eq!(cfg.source.address.unwrap(), "10.0.0.0/8");
        assert_eq!(cfg.protocol.unwrap(), "tcp");
        assert!(read_rule_cfg(&f, "forward", 99).is_none());
    }
}
