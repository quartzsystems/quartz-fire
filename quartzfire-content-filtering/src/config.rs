//! Read the `service content-filtering` model out of the VyOS config via
//! `cli-shell-api` — the same primitive verbs quartzfire-ssl-inspection and
//! quartzfire-geoip use, so this compiled binary can be the conf-mode owner
//! without depending on vyos-1x's XML reference cache (which knows nothing about
//! nodes this package adds).

use std::process::Command;

use crate::model::{
    BlockPage, Blocklists, FilterGroup, LogLevel, Model, DEFAULT_GROUP_NAME, DEFAULT_NAUGHTYNESS,
};

pub const BASE: [&str; 2] = ["service", "content-filtering"];
/// SSL inspection's enable node — the hard dependency we cross-read.
pub const SSL_ENABLE: [&str; 4] = ["service", "quartzfire", "ssl-inspection", "enable"];

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

/// cli-shell-api list output: whitespace-separated single-quoted tokens.
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

/// The `service content-filtering` subtree as a normalized model.
pub fn read_service(conf: &dyn ConfigRead) -> Model {
    let mut model = Model::default();
    // Cross-read the hard dependency regardless of whether our own tree exists,
    // so validate() can produce a precise error.
    model.ssl_inspection_enabled = conf.exists(&SSL_ENABLE);

    if !conf.exists(&BASE) {
        return model;
    }
    model.enabled = conf.exists(&join(&BASE, &["enable"]));
    if let Some(p) =
        conf.return_value(&join(&BASE, &["listen-port"])).and_then(|v| v.parse().ok())
    {
        model.listen_port = p;
    }

    for name in conf.list_nodes(&join(&BASE, &["filter-group"])) {
        let gp: Vec<&str> = vec!["service", "content-filtering", "filter-group", &name];
        let mut g = FilterGroup::new(&name);
        g.description = conf.return_value(&join(&gp, &["description"]));
        g.source_address = conf.return_values(&join(&gp, &["source-address"]));
        g.blanket_block = conf.exists(&join(&gp, &["blanket-block"]));
        g.categories = conf.return_values(&join(&gp, &["category"]));
        g.block_domains = conf.return_values(&join(&gp, &["block-domain"]));
        g.allow_domains = conf.return_values(&join(&gp, &["allow-domain"]));
        g.block_url_regex = conf.return_values(&join(&gp, &["block-url-regex"]));
        g.phrase_filtering = conf.exists(&join(&gp, &["phrase-filtering"]));
        g.naughtyness_limit = conf
            .return_value(&join(&gp, &["naughtyness-limit"]))
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_NAUGHTYNESS);
        g.safe_search = conf.exists(&join(&gp, &["safe-search"]));
        g.block_file_extensions = conf.return_values(&join(&gp, &["block-file-extension"]));
        g.block_mime_types = conf.return_values(&join(&gp, &["block-mime-type"]));
        model.groups.push(g);
    }
    // Deterministic order: config-listing order is already sorted by tag name.
    // Group 1 (index 0) is the default/unmatched group.
    //
    // Guarantee a default group even when the operator has defined none: without
    // one, render_group would index an empty groups vec (panic) and validate()
    // would refuse the commit. "Global" is the default/unmatched group (group 1)
    // and applies to every client; with no categories it blocks nothing, so
    // Content Filtering can be enabled out of the box and tightened later. It is
    // implicit — editing it in the WebUI materializes it as explicit config.
    if model.groups.is_empty() {
        model.groups.push(FilterGroup::new(DEFAULT_GROUP_NAME));
    }

    if conf.exists(&join(&BASE, &["blocklists"])) {
        let bp = join(&BASE, &["blocklists"]);
        let mut bl = Blocklists::default();
        let sources = conf.return_values(&join(&bp, &["source"]));
        if !sources.is_empty() {
            bl.sources = sources;
        }
        bl.auto_update = conf.exists(&join(&bp, &["auto-update"]));
        if let Some(h) =
            conf.return_value(&join(&bp, &["update-interval"])).and_then(|v| v.parse().ok())
        {
            bl.update_interval_hours = h;
        }
        model.blocklists = bl;
    }

    if conf.exists(&join(&BASE, &["block-page"])) {
        model.block_page = BlockPage {
            message: conf.return_value(&join(&BASE, &["block-page", "message"])),
            contact: conf.return_value(&join(&BASE, &["block-page", "contact"])),
        };
    }

    if let Some(l) = conf
        .return_value(&join(&BASE, &["log", "level"]))
        .and_then(|v| LogLevel::parse(&v))
    {
        model.log_level = l;
    }

    model
}

/// Full path to our valueless `enable` node — used to detect the off→on
/// transition (session has it, active config did not).
pub fn join_enable() -> Vec<&'static str> {
    join(&BASE, &["enable"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    #[derive(Default)]
    struct Fake {
        present: BTreeSet<String>,
        values: BTreeMap<String, String>,
        multi: BTreeMap<String, Vec<String>>,
        children: BTreeMap<String, Vec<String>>,
    }
    impl Fake {
        fn key(path: &[&str]) -> String {
            path.join(" ")
        }
        fn set(&mut self, path: &[&str]) {
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
    fn absent_tree_is_disabled_but_reads_ssl_dep() {
        let mut f = Fake::default();
        f.set(&SSL_ENABLE);
        let m = read_service(&f);
        assert!(!m.enabled);
        assert!(m.ssl_inspection_enabled);
        assert_eq!(m.listen_port, 1344);
    }

    #[test]
    fn synthesizes_default_global_group_when_none_defined() {
        // Tree present + enabled but zero filter-group nodes: read_service must
        // inject the implicit "Global" default group so validate()/render()
        // (which index groups[0]) have a group to work with and enabling the
        // feature does not fail on "at least one filter-group must be defined".
        let mut f = Fake::default();
        f.set(&["service", "content-filtering", "enable"]);
        let m = read_service(&f);
        assert_eq!(m.groups.len(), 1);
        assert_eq!(m.groups[0].name, DEFAULT_GROUP_NAME);
        assert!(m.groups[0].source_address.is_empty()); // default/unmatched group
        assert!(crate::model::validate(&m).iter().all(|s| !s.contains("at least one filter-group")));
    }

    #[test]
    fn reads_full_model() {
        let mut f = Fake::default();
        f.set(&["service", "content-filtering", "enable"]);
        f.value(&["service", "content-filtering", "listen-port"], "1345");
        f.child(&["service", "content-filtering", "filter-group"], "default");
        f.values_of(&["service", "content-filtering", "filter-group", "default", "category"], &["adult", "malware"]);
        f.child(&["service", "content-filtering", "filter-group"], "kids");
        f.values_of(&["service", "content-filtering", "filter-group", "kids", "source-address"], &["10.0.30.0/24"]);
        f.set(&["service", "content-filtering", "filter-group", "kids", "safe-search"]);
        f.set(&["service", "content-filtering", "filter-group", "kids", "phrase-filtering"]);
        f.value(&["service", "content-filtering", "filter-group", "kids", "naughtyness-limit"], "100");
        f.value(&["service", "content-filtering", "block-page", "message"], "Nope");
        f.value(&["service", "content-filtering", "log", "level"], "all");

        let m = read_service(&f);
        assert!(m.enabled);
        assert_eq!(m.listen_port, 1345);
        assert_eq!(m.groups.len(), 2);
        let def = m.groups.iter().find(|g| g.name == "default").unwrap();
        assert_eq!(def.categories, vec!["adult", "malware"]);
        let kids = m.groups.iter().find(|g| g.name == "kids").unwrap();
        assert_eq!(kids.source_address, vec!["10.0.30.0/24"]);
        assert!(kids.safe_search);
        assert!(kids.phrase_filtering);
        assert_eq!(kids.naughtyness_limit, 100);
        assert_eq!(m.block_page.message.as_deref(), Some("Nope"));
        assert_eq!(m.log_level, LogLevel::All);
    }

    #[test]
    fn blocklists_defaults_and_overrides() {
        let mut f = Fake::default();
        f.set(&["service", "content-filtering", "blocklists"]);
        f.set(&["service", "content-filtering", "blocklists", "auto-update"]);
        f.value(&["service", "content-filtering", "blocklists", "update-interval"], "12");
        let m = read_service(&f);
        assert!(m.blocklists.auto_update);
        assert_eq!(m.blocklists.update_interval_hours, 12);
        // Default source retained when none specified.
        assert_eq!(m.blocklists.sources.len(), 1);
    }
}
