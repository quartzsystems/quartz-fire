//! The normalized `service content-filtering` model + commit-time validation.
//!
//! Mirrors the shape of quartzfire-ssl-inspection's model.rs. All e2guardian
//! version-specific facts baked into render.rs were proven against stock
//! Debian 12 e2guardian 5.3.5 in tests/e2guardian-icap (see that README) — do
//! not "simplify" them away without re-running that harness.

use serde::{Deserialize, Serialize};

/// One filter group → one `e2guardianfN.conf`. Clients are mapped to a group by
/// source CIDR (authplugin ip + ipgroups); unmatched clients fall to the
/// default group (`defaulticapfiltergroup`, always group 1).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FilterGroup {
    /// CLI name (the tag). Also the e2guardian `groupname`.
    pub name: String,
    pub description: Option<String>,
    /// Source CIDRs mapped to this group in the ipgroups file.
    pub source_address: Vec<String>,
    /// Deny-all except the allow lists (e2guardian `**` banned-all token).
    pub blanket_block: bool,
    /// UT1 category names to block (each → banned domains + urls lists).
    pub categories: Vec<String>,
    /// Custom deny domains (block the site and its subdomains).
    pub block_domains: Vec<String>,
    /// Custom allow / bypass domains (exception list overrides a category block).
    pub allow_domains: Vec<String>,
    /// Banned URL regexes.
    pub block_url_regex: Vec<String>,
    /// Enable weighted-phrase content scanning.
    pub phrase_filtering: bool,
    /// Phrase score threshold (50-500, default 150).
    pub naughtyness_limit: u32,
    /// Rewrite Google/Bing/DDG/YouTube to their safe-search variants.
    pub safe_search: bool,
    pub block_file_extensions: Vec<String>,
    pub block_mime_types: Vec<String>,
}

impl FilterGroup {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            naughtyness_limit: DEFAULT_NAUGHTYNESS,
            ..Default::default()
        }
    }
}

pub const DEFAULT_NAUGHTYNESS: u32 = 150;
pub const DEFAULT_LISTEN_PORT: u16 = 1344;
pub const DEFAULT_UPDATE_INTERVAL_HOURS: u32 = 24;
/// UT1 (Université Toulouse) blocklist tarball — the offline-shippable default.
pub const DEFAULT_BLOCKLIST_SOURCE: &str =
    "https://dsi.ut-capitole.fr/blacklists/download/blacklists.tar.gz";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Blocklists {
    pub sources: Vec<String>,
    pub auto_update: bool,
    pub update_interval_hours: u32,
}

impl Default for Blocklists {
    fn default() -> Self {
        Self {
            sources: vec![DEFAULT_BLOCKLIST_SOURCE.to_string()],
            auto_update: false,
            update_interval_hours: DEFAULT_UPDATE_INTERVAL_HOURS,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BlockPage {
    pub message: Option<String>,
    pub contact: Option<String>,
}

/// Access-log verbosity. Maps to e2guardian `loglevel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogLevel {
    None,
    BlockedOnly,
    All,
}

impl LogLevel {
    /// e2guardian loglevel: 0 none, 1 denied-only, 3 all requests.
    pub fn e2g_loglevel(self) -> u8 {
        match self {
            LogLevel::None => 0,
            LogLevel::BlockedOnly => 1,
            LogLevel::All => 3,
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "none" => Some(LogLevel::None),
            "blocked-only" => Some(LogLevel::BlockedOnly),
            "all" => Some(LogLevel::All),
            _ => None,
        }
    }
}

impl Default for LogLevel {
    fn default() -> Self {
        LogLevel::BlockedOnly
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Model {
    pub enabled: bool,
    pub listen_port: u16,
    pub groups: Vec<FilterGroup>,
    pub blocklists: Blocklists,
    pub block_page: BlockPage,
    pub log_level: LogLevel,
    /// Cross-read from `service quartzfire ssl-inspection enable`. Content
    /// Filtering has a HARD dependency on SSL inspection: without the bump,
    /// Squid never has plaintext to hand to the ICAP engine. Commit is refused
    /// when this is false (see validate()).
    pub ssl_inspection_enabled: bool,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            enabled: false,
            listen_port: DEFAULT_LISTEN_PORT,
            groups: Vec::new(),
            blocklists: Blocklists::default(),
            block_page: BlockPage::default(),
            log_level: LogLevel::default(),
            ssl_inspection_enabled: false,
        }
    }
}

impl Model {
    /// Group index as e2guardian filter number (1-based). Group 1 is the
    /// default/unmatched group (`defaulticapfiltergroup`).
    pub fn group_number(&self, idx: usize) -> usize {
        idx + 1
    }
    pub fn filtergroups(&self) -> usize {
        self.groups.len().max(1)
    }
}

/// Commit-time validation. Any returned string aborts the commit (printed to
/// stderr by the conf-mode owner). Ordered most-fundamental first.
pub fn validate(model: &Model) -> Vec<String> {
    let mut problems = Vec::new();
    if !model.enabled {
        return problems; // A disabled/absent feature never blocks a commit.
    }

    // Hard dependency: SSL inspection must be enabled — Content Filtering has no
    // plaintext to inspect otherwise. Refuse with a clear, actionable error.
    if !model.ssl_inspection_enabled {
        problems.push(
            "content-filtering: requires SSL inspection to be enabled \
             (`set service quartzfire ssl-inspection enable`) — the ICAP engine \
             filters the plaintext Squid produces by bumping TLS. Enable SSL \
             inspection first, or disable content-filtering."
                .to_string(),
        );
    }

    if model.groups.is_empty() {
        problems.push(
            "content-filtering: at least one filter-group must be defined".to_string(),
        );
    }

    let mut seen = std::collections::BTreeSet::new();
    for g in &model.groups {
        if !seen.insert(g.name.clone()) {
            problems.push(format!("content-filtering: duplicate filter-group '{}'", g.name));
        }
        if !(50..=500).contains(&g.naughtyness_limit) {
            problems.push(format!(
                "content-filtering: filter-group '{}' naughtyness-limit {} out of range (50-500)",
                g.name, g.naughtyness_limit
            ));
        }
        for cidr in &g.source_address {
            if !is_cidr(cidr) {
                problems.push(format!(
                    "content-filtering: filter-group '{}' source-address '{}' is not a valid CIDR",
                    g.name, cidr
                ));
            }
        }
        for re in &g.block_url_regex {
            if let Err(e) = validate_regex(re) {
                problems.push(format!(
                    "content-filtering: filter-group '{}' block-url-regex '{}': {}",
                    g.name, re, e
                ));
            }
        }
    }

    // Overlapping source CIDRs across groups make client→group mapping
    // ambiguous (first match wins in e2guardian's ipgroups). Warn as an error so
    // the operator resolves it explicitly.
    for (a, b, cidr) in overlapping_sources(&model.groups) {
        problems.push(format!(
            "content-filtering: source-address {} appears in both filter-group '{}' and '{}' \
             — client→group mapping would be ambiguous",
            cidr, a, b
        ));
    }

    problems
}

/// Minimal CIDR check (IPv4/IPv6 `addr/len`) without pulling a dependency. Full
/// address validity is enforced by VyOS's own leaf-node syntax; this catches
/// gross mistakes reaching the model.
fn is_cidr(s: &str) -> bool {
    let Some((addr, len)) = s.split_once('/') else {
        return false;
    };
    let Ok(len) = len.parse::<u32>() else {
        return false;
    };
    if addr.contains(':') {
        len <= 128 && addr.parse::<std::net::Ipv6Addr>().is_ok()
    } else {
        len <= 32 && addr.parse::<std::net::Ipv4Addr>().is_ok()
    }
}

/// Exact-duplicate source CIDR detection across groups (the common, checkable
/// case of ambiguous mapping; subnet-containment is left to the operator).
fn overlapping_sources(groups: &[FilterGroup]) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for i in 0..groups.len() {
        for j in (i + 1)..groups.len() {
            for c in &groups[i].source_address {
                if groups[j].source_address.iter().any(|x| x == c) {
                    out.push((groups[i].name.clone(), groups[j].name.clone(), c.clone()));
                }
            }
        }
    }
    out
}

/// Validate a POSIX-ish regex the way e2guardian will read it. We can't link
/// e2guardian's PCRE here, so reject the mistakes that actually break list
/// parsing: unbalanced parentheses/brackets and a trailing escape.
fn validate_regex(re: &str) -> Result<(), String> {
    let mut paren = 0i32;
    let mut bracket = false;
    let mut chars = re.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if chars.next().is_none() {
                    return Err("dangling backslash".into());
                }
            }
            '[' if !bracket => bracket = true,
            ']' if bracket => bracket = false,
            '(' if !bracket => paren += 1,
            ')' if !bracket => {
                paren -= 1;
                if paren < 0 {
                    return Err("unbalanced ')'".into());
                }
            }
            _ => {}
        }
    }
    if paren != 0 {
        return Err("unbalanced '('".into());
    }
    if bracket {
        return Err("unbalanced '['".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled_min() -> Model {
        Model {
            enabled: true,
            ssl_inspection_enabled: true,
            groups: vec![FilterGroup::new("default")],
            ..Default::default()
        }
    }

    #[test]
    fn disabled_never_blocks_commit() {
        let m = Model::default();
        assert!(validate(&m).is_empty());
    }

    #[test]
    fn requires_ssl_inspection() {
        let mut m = enabled_min();
        m.ssl_inspection_enabled = false;
        let p = validate(&m);
        assert!(p.iter().any(|s| s.contains("requires SSL inspection")));
    }

    #[test]
    fn needs_a_group() {
        let mut m = enabled_min();
        m.groups.clear();
        assert!(validate(&m).iter().any(|s| s.contains("at least one filter-group")));
    }

    #[test]
    fn naughtyness_range_enforced() {
        let mut m = enabled_min();
        m.groups[0].naughtyness_limit = 10;
        assert!(validate(&m).iter().any(|s| s.contains("naughtyness-limit")));
        m.groups[0].naughtyness_limit = 150;
        assert!(!validate(&m).iter().any(|s| s.contains("naughtyness-limit")));
    }

    #[test]
    fn bad_cidr_rejected() {
        let mut m = enabled_min();
        m.groups[0].source_address = vec!["10.0.0.0/8".into(), "not-a-cidr".into()];
        assert!(validate(&m).iter().any(|s| s.contains("not a valid CIDR")));
    }

    #[test]
    fn overlapping_source_rejected() {
        let mut m = enabled_min();
        m.groups.push(FilterGroup::new("staff"));
        m.groups[0].source_address = vec!["10.0.0.0/24".into()];
        m.groups[1].source_address = vec!["10.0.0.0/24".into()];
        assert!(validate(&m).iter().any(|s| s.contains("ambiguous")));
    }

    #[test]
    fn bad_regex_rejected() {
        let mut m = enabled_min();
        m.groups[0].block_url_regex = vec!["good.*".into(), "bad(".into()];
        assert!(validate(&m).iter().any(|s| s.contains("block-url-regex")));
    }

    #[test]
    fn loglevel_mapping() {
        assert_eq!(LogLevel::None.e2g_loglevel(), 0);
        assert_eq!(LogLevel::BlockedOnly.e2g_loglevel(), 1);
        assert_eq!(LogLevel::All.e2g_loglevel(), 3);
        assert_eq!(LogLevel::parse("all"), Some(LogLevel::All));
        assert_eq!(LogLevel::parse("bogus"), None);
    }
}
