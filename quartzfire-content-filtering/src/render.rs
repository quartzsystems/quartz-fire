//! Pure renderers for the e2guardian ICAP-server configuration.
//!
//! Every e2guardian directive here was proven against stock Debian 12
//! e2guardian 5.3.5 in `../quartzfire-ssl-inspection/tests/e2guardian-icap`
//! (see that README). The load-bearing, non-obvious facts:
//!
//!   * `icapport = <n>` ENABLES ICAP server mode; `transparenthttpsport =`
//!     (empty) disables e2g's own TLS listener — Squid is the sole terminator.
//!   * v5 list format is `sitelist = 'name=banned,messageno=500,path=…'`, NOT
//!     the pre-v5 `bannedsitelist = '…'` (silently ignored by 5.3.5). Multiple
//!     `name=banned` / `name=exception` entries MERGE, so we layer QuartzFire
//!     lists over the UT1 lists without editing UT1 in place.
//!   * MIME = `mimelist name=bannedmime`, extensions = `fileextlist
//!     name=bannedextension`, URL regex = `regexpboollist name=banned`,
//!     safe-search = `regexpreplacelist name=change` (URL rewrite).
//!   * phrase lists keep the OLD path format (`weightedphraselist = '/path'`).
//!   * `reportinglevel = 3` serves the HTML block template inline; template
//!     placeholders are -URL- -CATEGORIES- -FILTERGROUP- -IP- -REASONGIVEN-.
//!
//! render produces strings + a list of files to write; all fs/systemd/squid
//! side effects live in apply.rs.

use crate::model::{LogLevel, Model};

pub const E2G_CONF: &str = "/etc/e2guardian/e2guardian.conf";
pub const E2G_ETC: &str = "/etc/e2guardian";
pub const QZ_LIST_DIR: &str = "/etc/e2guardian/lists/quartzfire";
pub const IPGROUPS_PATH: &str = "/etc/e2guardian/lists/authplugins/ipgroups";
pub const IP_AUTHPLUGIN: &str = "/etc/e2guardian/authplugins/ip.conf";
pub const SAFESEARCH_PATH: &str = "/etc/e2guardian/lists/quartzfire/safesearch-rewrite";
/// Where the blocklist updater lands the extracted UT1 category tree:
/// `<dir>/<category>/{domains,urls}`.
pub const BLACKLIST_DIR: &str = "/var/lib/quartzfire/content-filtering/blacklists";
pub const LANGUAGE: &str = "quartzfire";
pub const LANG_DIR: &str = "/usr/share/e2guardian/languages";
pub const BLOCK_TEMPLATE: &str = "/usr/share/e2guardian/languages/quartzfire/template.html";
pub const ACCESS_LOG: &str = "/var/log/e2guardian/access.log";

/// Markers bracketing the QuartzFire-generated directive block appended to each
/// e2guardianfN.conf; apply.rs strips anything between them before re-appending,
/// so re-commits are idempotent.
pub const BLOCK_BEGIN: &str = "# >>> QuartzFire content-filtering (generated) — do not edit";
pub const BLOCK_END: &str = "# <<< QuartzFire content-filtering";

/// A single file to write to disk (absolute path → contents).
#[derive(Debug, Clone, PartialEq)]
pub struct FileOut {
    pub path: String,
    pub contents: String,
}

/// An aggregated list: ONE e2guardian directive whose file `.Include`s all its
/// source files. e2guardian v5 does NOT reliably merge multiple same-`name`
/// list directives (proven in tests/render-filter — only one of several
/// `sitelist name=banned` lines loads), so every logical list QuartzFire builds
/// from multiple sources (categories + custom domains) MUST be a single
/// directive over one `.Include` aggregator. apply.rs writes the aggregator
/// with only the sources that exist and are non-empty, and drops the directive
/// if none remain (an empty/missing list file also breaks e2guardian).
#[derive(Debug, Clone, PartialEq)]
pub struct Aggregate {
    /// The directive line, with `{agg}` where the aggregator path goes, e.g.
    /// `sitelist = 'name=banned,messageno=500,path={agg}'`.
    pub directive_template: String,
    /// Absolute path of the aggregator file apply.rs writes.
    pub agg_path: String,
    /// Source files to `.Include` (categories are external/updater-populated).
    pub sources: Vec<String>,
}

/// Everything render produced for one filter group.
#[derive(Debug, Clone, PartialEq)]
pub struct GroupRender {
    pub number: usize,
    pub groupname: String,
    pub naughtyness: u32,
    pub phrase_filtering: bool,
    /// Comment/marker lines that head the group's directive block.
    pub header: String,
    /// Aggregated lists (one directive each). apply.rs builds the `.Include`
    /// files and emits each directive only if it has ≥1 present source.
    pub aggregates: Vec<Aggregate>,
    /// Custom source list files this group owns (block-domains, allow-domains,
    /// regexes, extensions, mimes, blanket-block, …). Written before the
    /// aggregators so the include-presence check sees them.
    pub files: Vec<FileOut>,
}

/// key=value overrides applied onto the pristine stock e2guardian.conf.
pub fn conf_overrides(model: &Model) -> Vec<(String, String)> {
    vec![
        ("filterip".into(), "127.0.0.1".into()),
        // Belt-and-braces intent to run in the FOREGROUND. NOTE: e2guardian 5.3.5
        // ignores this directive for backgrounding and daemonises anyway, so the
        // load-bearing control is the `-N` flag on the drop-in's ExecStart (see
        // systemd/e2guardian-quartzfire.conf). Kept here to document intent and in
        // case a future e2g honours it. The drop-in's Type=simple + -N is what
        // keeps `systemctl is-active` truthful and lets the apply's reload find a
        // live main process.
        ("nodaemon".into(), "on".into()),
        // Defining icapport enables ICAP SERVER mode.
        ("icapport".into(), model.listen_port.to_string()),
        // Disable e2g's own transparent-TLS listener — Squid owns TLS.
        ("transparenthttpsport".into(), String::new()),
        // A harmless loopback proxy listener; the ICAP path is the real one.
        ("filterports".into(), "8080".into()),
        ("defaulticapfiltergroup".into(), "1".into()),
        ("filtergroups".into(), model.filtergroups().to_string()),
        ("authplugin".into(), format!("'{IP_AUTHPLUGIN}'")),
        ("loglevel".into(), model.log_level.e2g_loglevel().to_string()),
        ("loglocation".into(), format!("'{ACCESS_LOG}'")),
        // Deterministic quoted-CSV access log so qfcf-logfeed can parse it into
        // JSON lines. Format 2 columns: ts,user,client_ip,url,reason,method,…,
        // http_code,…,group,… (see logfeed.rs). Do not change without updating
        // the parser.
        ("logfileformat".into(), "2".into()),
        ("logsyslog".into(), "off".into()),
        // Serve the QuartzFire HTML block template inline on a block.
        ("reportinglevel".into(), "3".into()),
        ("languagedir".into(), format!("'{LANG_DIR}'")),
        ("language".into(), format!("'{LANGUAGE}'")),
    ]
}

/// One `<cidr> = filterN` line per group source; unmatched clients fall to
/// `defaulticapfiltergroup` (group 1). First match wins, so validate() rejects
/// duplicate CIDRs across groups.
pub fn ipgroups(model: &Model) -> String {
    let mut s = String::from("# QuartzFire Content Filtering — client source-IP → filter group.\n");
    s.push_str("# Generated by qfcf; edit via the WebUI, not by hand.\n");
    for (idx, g) in model.groups.iter().enumerate() {
        let n = model.group_number(idx);
        if g.source_address.is_empty() {
            continue;
        }
        s.push_str(&format!("# filter{n} = {}\n", g.name));
        for cidr in &g.source_address {
            s.push_str(&format!("{cidr} = filter{n}\n"));
        }
    }
    s
}

fn list_file(header: &str, items: &[String]) -> String {
    let mut s = format!("# QuartzFire Content Filtering — {header}. Generated by qfcf.\n");
    for i in items {
        s.push_str(i);
        s.push('\n');
    }
    s
}

/// Render one filter group into aggregates (one directive each) + owned source
/// list files. Every logical list is ONE directive over an `.Include`
/// aggregator (see Aggregate) because e2guardian v5 does not merge duplicate
/// same-`name` directives.
pub fn render_group(model: &Model, idx: usize) -> GroupRender {
    let g = &model.groups[idx];
    let n = model.group_number(idx);
    let qz = QZ_LIST_DIR;
    let mut files = Vec::new();
    let mut aggregates = Vec::new();

    let mut header = String::new();
    header.push_str(BLOCK_BEGIN);
    header.push('\n');
    header.push_str(&format!("# filter group {n}: {}\n", g.name));
    if !g.categories.is_empty() {
        header.push_str(&format!("# categories: {}\n", g.categories.join(", ")));
    }

    // ── name=banned SITES: categories' domains + custom block-domains + blanket
    let mut banned_site_sources: Vec<String> = g
        .categories
        .iter()
        .map(|c| format!("{BLACKLIST_DIR}/{c}/domains"))
        .collect();
    if !g.block_domains.is_empty() {
        let p = format!("{qz}/f{n}-block-domains");
        files.push(FileOut { path: p.clone(), contents: list_file("custom blocked domains", &g.block_domains) });
        banned_site_sources.push(p);
    }
    if g.blanket_block {
        // e2guardian treats `**` in a banned sitelist as match-all.
        let p = format!("{qz}/f{n}-blanket");
        files.push(FileOut { path: p.clone(), contents: list_file("blanket block (deny-all)", &["**".to_string()]) });
        banned_site_sources.push(p);
    }
    aggregates.push(Aggregate {
        directive_template: "sitelist = 'name=banned,messageno=500,path={agg}'".into(),
        agg_path: format!("{qz}/f{n}-banned-sites"),
        sources: banned_site_sources,
    });

    // ── name=banned URLS: categories' urls
    aggregates.push(Aggregate {
        directive_template: "urllist = 'name=banned,messageno=501,path={agg}'".into(),
        agg_path: format!("{qz}/f{n}-banned-urls"),
        sources: g.categories.iter().map(|c| format!("{BLACKLIST_DIR}/{c}/urls")).collect(),
    });

    // ── name=banned URL REGEX: custom regexes (single source)
    if !g.block_url_regex.is_empty() {
        let p = format!("{qz}/f{n}-block-url-regex");
        files.push(FileOut { path: p.clone(), contents: list_file("custom blocked URL regexes", &g.block_url_regex) });
        aggregates.push(Aggregate {
            directive_template: "regexpboollist = 'name=banned,messageno=503,path={agg}'".into(),
            agg_path: format!("{qz}/f{n}-banned-regex"),
            sources: vec![p],
        });
    }
    // ── name=bannedextension: file extensions
    if !g.block_file_extensions.is_empty() {
        let p = format!("{qz}/f{n}-block-ext");
        files.push(FileOut { path: p.clone(), contents: list_file("blocked file extensions", &g.block_file_extensions) });
        aggregates.push(Aggregate {
            directive_template: "fileextlist = 'name=bannedextension,messageno=900,path={agg}'".into(),
            agg_path: format!("{qz}/f{n}-banned-ext"),
            sources: vec![p],
        });
    }
    // ── name=bannedmime: MIME types
    if !g.block_mime_types.is_empty() {
        let p = format!("{qz}/f{n}-block-mime");
        files.push(FileOut { path: p.clone(), contents: list_file("blocked MIME types", &g.block_mime_types) });
        aggregates.push(Aggregate {
            directive_template: "mimelist = 'name=bannedmime,messageno=800,path={agg}'".into(),
            agg_path: format!("{qz}/f{n}-banned-mime"),
            sources: vec![p],
        });
    }
    // ── name=exception SITES: allow/bypass domains — OVERRIDES a banned match
    if !g.allow_domains.is_empty() {
        let p = format!("{qz}/f{n}-allow-domains");
        files.push(FileOut { path: p.clone(), contents: list_file("allowed / bypass domains", &g.allow_domains) });
        aggregates.push(Aggregate {
            directive_template: "sitelist = 'name=exception,messageno=602,path={agg}'".into(),
            agg_path: format!("{qz}/f{n}-exception-sites"),
            sources: vec![p],
        });
    }
    // ── name=change: safe-search URL rewrites (shared list)
    if g.safe_search {
        aggregates.push(Aggregate {
            directive_template: "regexpreplacelist = 'name=change,path={agg}'".into(),
            agg_path: format!("{qz}/f{n}-safesearch"),
            sources: vec![SAFESEARCH_PATH.to_string()],
        });
    }

    // Phrase filtering is toggled via `weightedphrasemode` on the pristine stock
    // phrase lists (which MUST stay defined). apply.rs sets the mode +
    // naughtynesslimit; nothing is added here for it.

    GroupRender {
        number: n,
        groupname: g.name.clone(),
        naughtyness: g.naughtyness_limit,
        phrase_filtering: g.phrase_filtering,
        header,
        aggregates,
        files,
    }
}

/// The QuartzFire-branded block page. e2guardian substitutes -URL-, -CATEGORIES-,
/// -FILTERGROUP-, -IP-, -REASONGIVEN- at serve time (proven placeholder set).
/// The operator's message/contact are baked in from config.
pub fn block_template(model: &Model) -> String {
    let message = model
        .block_page
        .message
        .clone()
        .unwrap_or_else(|| "This site is blocked by QuartzFire Content Filtering.".into());
    let contact = model
        .block_page
        .contact
        .as_deref()
        .map(|c| format!("<p class=\"contact\">Need access? Contact {}.</p>", html_escape(c)))
        .unwrap_or_default();
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blocked — QuartzFire</title>
<style>
  body{{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e8ec;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}}
  .card{{max-width:34rem;padding:2.5rem;background:#171a21;border:1px solid #232833;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.4)}}
  h1{{margin:0 0 .5rem;font-size:1.4rem;color:#ff5c5c}}
  .msg{{color:#c3c8d1;margin:.25rem 0 1.25rem}}
  dl{{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;font-size:.92rem;margin:0}}
  dt{{color:#8b93a1}} dd{{margin:0;word-break:break-all}}
  .contact{{margin-top:1.25rem;color:#8b93a1;font-size:.9rem}}
</style>
</head>
<body>
<div class="card">
  <h1>Access blocked</h1>
  <p class="msg">{message}</p>
  <dl>
    <dt>URL</dt><dd>-URL-</dd>
    <dt>Category</dt><dd>-CATEGORIES-</dd>
    <dt>Reason</dt><dd>-REASONGIVEN-</dd>
    <dt>Filter group</dt><dd>-FILTERGROUP-</dd>
    <dt>Your IP</dt><dd>-IP-</dd>
  </dl>
  {contact}
</div>
</body>
</html>
"#,
        message = html_escape(&message),
        contact = contact,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The QuartzFire SafeSearch URL-rewrite list (static). Forces Google/Bing/DDG
/// SafeSearch and YouTube Restricted Mode by rewriting the query URL. e2guardian
/// `regexpreplacelist name=change` format: "regex"->"replacement".
pub fn safesearch_list() -> String {
    r#"# QuartzFire Content Filtering — SafeSearch URL rewrites (name=change).
# Format: "extended-regex"->"replacement". Forces strict/safe search modes.
# Google: append safe=active
"(^https?://(www\.)?google\.[a-z.]+/search\?)(.*)"->"\1safe=active&\3"
# Bing: append adlt=strict
"(^https?://(www\.)?bing\.com/search\?)(.*)"->"\1adlt=strict&\3"
# DuckDuckGo: append kp=1 (safe)
"(^https?://(www\.)?duckduckgo\.com/\?)(.*)"->"\1kp=1&\3"
# YouTube Restricted Mode is enforced by the YouTube edns/header method upstream;
# the search-page rewrite below covers the web search box.
"(^https?://(www\.)?youtube\.com/results\?)(.*)"->"\1&restrict=strict&\3"
"#
    .to_string()
}

/// The static list of file outputs that don't depend on per-group iteration
/// (ipgroups, block template, safe-search list). Group list files come from
/// render_group.
pub fn shared_files(model: &Model) -> Vec<FileOut> {
    vec![
        FileOut { path: IPGROUPS_PATH.into(), contents: ipgroups(model) },
        FileOut { path: BLOCK_TEMPLATE.into(), contents: block_template(model) },
        FileOut { path: SAFESEARCH_PATH.into(), contents: safesearch_list() },
    ]
}

/// Human-readable summary of what a log level maps to, for status.json / docs.
pub fn loglevel_label(l: LogLevel) -> &'static str {
    match l {
        LogLevel::None => "none",
        LogLevel::BlockedOnly => "blocked-only",
        LogLevel::All => "all",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FilterGroup;

    fn model_with(groups: Vec<FilterGroup>) -> Model {
        Model { enabled: true, ssl_inspection_enabled: true, groups, ..Default::default() }
    }

    /// Find the aggregate whose directive template contains `needle`.
    fn agg<'a>(r: &'a GroupRender, needle: &str) -> &'a Aggregate {
        r.aggregates
            .iter()
            .find(|a| a.directive_template.contains(needle))
            .unwrap_or_else(|| panic!("no aggregate matching {needle}"))
    }
    fn has_source(a: &Aggregate, needle: &str) -> bool {
        a.sources.iter().any(|s| s.contains(needle))
    }

    #[test]
    fn conf_enables_icap_and_disables_own_tls() {
        let m = model_with(vec![FilterGroup::new("default")]);
        let ov = conf_overrides(&m);
        let get = |k: &str| ov.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        assert_eq!(get("icapport"), Some("1344".into()));
        assert_eq!(get("transparenthttpsport"), Some(String::new()));
        assert_eq!(get("defaulticapfiltergroup"), Some("1".into()));
        assert_eq!(get("reportinglevel"), Some("3".into()));
        assert_eq!(get("filterip"), Some("127.0.0.1".into()));
    }

    #[test]
    fn category_uses_v5_single_aggregate_not_prev5() {
        let mut g = FilterGroup::new("default");
        g.categories = vec!["adult".into(), "malware".into()];
        let r = render_group(&model_with(vec![g]), 0);
        // ONE sitelist name=banned aggregate over an .Include file, NOT one
        // directive per category (v5 does not merge duplicate name= directives).
        let sites = agg(&r, "sitelist = 'name=banned,messageno=500");
        assert!(sites.directive_template.contains("path={agg}"));
        assert_eq!(r.aggregates.iter().filter(|a| a.directive_template.starts_with("sitelist = 'name=banned")).count(), 1);
        assert!(has_source(sites, "blacklists/adult/domains"));
        assert!(has_source(sites, "blacklists/malware/domains"));
        let urls = agg(&r, "urllist = 'name=banned,messageno=501");
        assert!(has_source(urls, "blacklists/adult/urls"));
        // The pre-v5 directive must NEVER appear (silently ignored by 5.3.5).
        assert!(!r.aggregates.iter().any(|a| a.directive_template.contains("bannedsitelist =")));
    }

    #[test]
    fn custom_block_and_allow_domains() {
        let mut g = FilterGroup::new("default");
        g.block_domains = vec!["bad.example".into()];
        g.allow_domains = vec!["good.example".into()];
        let r = render_group(&model_with(vec![g]), 0);
        // Custom block-domains fold into the banned-sites aggregate.
        assert!(has_source(agg(&r, "sitelist = 'name=banned"), "f1-block-domains"));
        assert!(has_source(agg(&r, "name=exception,messageno=602"), "f1-allow-domains"));
        assert!(r.files.iter().any(|f| f.path.ends_with("f1-block-domains") && f.contents.contains("bad.example")));
        assert!(r.files.iter().any(|f| f.path.ends_with("f1-allow-domains") && f.contents.contains("good.example")));
    }

    #[test]
    fn ext_mime_regex_directive_names() {
        let mut g = FilterGroup::new("default");
        g.block_file_extensions = vec![".exe".into()];
        g.block_mime_types = vec!["application/x-dosexec".into()];
        g.block_url_regex = vec!["ads?/track".into()];
        let r = render_group(&model_with(vec![g]), 0);
        assert!(has_source(agg(&r, "fileextlist = 'name=bannedextension,messageno=900"), "f1-block-ext"));
        assert!(has_source(agg(&r, "mimelist = 'name=bannedmime,messageno=800"), "f1-block-mime"));
        assert!(has_source(agg(&r, "regexpboollist = 'name=banned,messageno=503"), "f1-block-url-regex"));
    }

    #[test]
    fn blanket_block_folds_matchall_into_banned() {
        let mut g = FilterGroup::new("default");
        g.blanket_block = true;
        let r = render_group(&model_with(vec![g]), 0);
        assert!(r.files.iter().any(|f| f.path.ends_with("f1-blanket") && f.contents.contains("**")));
        assert!(has_source(agg(&r, "sitelist = 'name=banned"), "f1-blanket"));
    }

    #[test]
    fn safesearch_gated_and_phrase_flag_carried() {
        let mut g = FilterGroup::new("default");
        let off = render_group(&model_with(vec![g.clone()]), 0);
        assert!(!off.phrase_filtering);
        assert!(!off.aggregates.iter().any(|a| a.directive_template.contains("name=change")));
        g.phrase_filtering = true;
        g.safe_search = true;
        let on = render_group(&model_with(vec![g]), 0);
        assert!(on.phrase_filtering);
        assert!(has_source(agg(&on, "name=change"), "safesearch"));
    }

    #[test]
    fn ipgroups_maps_sources_and_skips_empty() {
        let mut a = FilterGroup::new("default");
        let mut b = FilterGroup::new("staff");
        b.source_address = vec!["10.0.20.0/24".into()];
        a.source_address = vec![]; // default group, no explicit source
        let s = ipgroups(&model_with(vec![a, b]));
        assert!(s.contains("10.0.20.0/24 = filter2"));
        assert!(!s.contains("filter1")); // group 1 has no source line
    }

    #[test]
    fn block_template_has_placeholders_and_message() {
        let mut m = model_with(vec![FilterGroup::new("default")]);
        m.block_page.message = Some("Blocked by policy".into());
        m.block_page.contact = Some("it@example.com".into());
        let t = block_template(&m);
        for ph in ["-URL-", "-CATEGORIES-", "-FILTERGROUP-", "-IP-", "-REASONGIVEN-"] {
            assert!(t.contains(ph), "missing placeholder {ph}");
        }
        assert!(t.contains("Blocked by policy"));
        assert!(t.contains("it@example.com"));
    }

    #[test]
    fn header_starts_with_begin_marker() {
        // apply.rs writes header … aggregates … BLOCK_END between the markers;
        // strip_qz_block relies on the header starting with BLOCK_BEGIN.
        let r = render_group(&model_with(vec![FilterGroup::new("default")]), 0);
        assert!(r.header.starts_with(BLOCK_BEGIN));
    }
}
