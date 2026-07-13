//! Tail e2guardian's quoted-CSV access log (logfileformat=2) and emit JSON
//! lines to /var/log/quartzfire/content-filtering.json — the same shape the
//! QuartzFire dashboard/SIEM pipeline consumes for Suricata EVE.
//!
//! e2guardian format-2 columns (0-based), proven against 5.3.5:
//!   0 ts "YYYY.MM.DD HH:MM:SS"   1 user   2 client_ip   3 url
//!   4 reason "*DENIED* …"/"*EXCEPTION* …"   5 method   …   9 naughtyness
//!   10 http_code   …   13 filter-group name   …
//!
//! Poll-based follow (no inotify dependency), tolerant of logrotate
//! copytruncate (file shrinks → re-seek to 0). Runs as a long-lived systemd
//! service (Restart=always).

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::Path;
use std::thread;
use std::time::Duration;

use serde_json::json;

use crate::render::ACCESS_LOG;

pub const JSON_LOG: &str = "/var/log/quartzfire/content-filtering.json";

/// Follow the access log forever, transforming each new line to JSON. Returns
/// only on unrecoverable error (systemd restarts us).
pub fn run() -> i32 {
    let src = Path::new(ACCESS_LOG);
    // Wait for the access log to exist (e2guardian may not have started yet).
    let mut reader = loop {
        if let Ok(f) = File::open(src) {
            let mut r = BufReader::new(f);
            // Start at end — we only forward NEW entries.
            let _ = r.seek(SeekFrom::End(0));
            break r;
        }
        thread::sleep(Duration::from_secs(2));
    };

    let mut last_len = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    let mut line = String::new();
    loop {
        // Detect truncation/rotation: if the file shrank, re-open from the top.
        if let Ok(len) = fs::metadata(src).map(|m| m.len()) {
            if len < last_len {
                if let Ok(f) = File::open(src) {
                    reader = BufReader::new(f);
                }
                last_len = 0;
            }
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                // EOF — wait for more.
                thread::sleep(Duration::from_millis(500));
            }
            Ok(n) => {
                last_len += n as u64;
                if let Some(obj) = transform(line.trim_end()) {
                    append_json(&obj);
                }
            }
            Err(_) => thread::sleep(Duration::from_millis(500)),
        }
    }
}

fn append_json(obj: &serde_json::Value) {
    if let Some(parent) = Path::new(JSON_LOG).parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(JSON_LOG) {
        let _ = writeln!(f, "{obj}");
    }
}

/// Split one e2guardian format-2 CSV line into fields (quotes stripped).
fn parse_csv(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_q && chars.peek() == Some(&'"') {
                    cur.push('"'); // escaped quote
                    chars.next();
                } else {
                    in_q = !in_q;
                }
            }
            ',' if !in_q => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

/// e2guardian ts "2026.07.12 21:36:30" → ISO-ish "2026-07-12T21:36:30".
fn iso_ts(raw: &str) -> String {
    match raw.split_once(' ') {
        Some((d, t)) => format!("{}T{}", d.replace('.', "-"), t),
        None => raw.to_string(),
    }
}

/// Derive the action + category from e2guardian's reason field.
fn classify(reason: &str) -> (&'static str, Option<String>) {
    let r = reason.trim();
    if r.starts_with("*DENIED*") || r.contains("*DENIED*") {
        // "*DENIED* Blocked site: evil.test" / "… in banned category: adult"
        let category = r
            .rsplit_once("category:")
            .map(|(_, c)| c.trim().to_string())
            .or_else(|| r.rsplit_once("Blocked ").map(|(_, c)| c.trim().to_string()));
        ("blocked", category)
    } else if r.contains("*EXCEPTION*") {
        ("allowed", None)
    } else if r.contains("*SCANNED*") || r.contains("*INFECTED*") {
        ("scanned", None)
    } else {
        ("allowed", None)
    }
}

/// Transform one access-log line to the dashboard JSON object, or None if it
/// isn't a parseable entry.
pub fn transform(line: &str) -> Option<serde_json::Value> {
    if line.is_empty() {
        return None;
    }
    let f = parse_csv(line);
    if f.len() < 6 {
        return None;
    }
    let get = |i: usize| f.get(i).map(|s| s.as_str()).unwrap_or("-");
    let dash_to_null = |s: &str| if s == "-" || s.is_empty() { None } else { Some(s.to_string()) };

    let (action, category) = classify(get(4));
    let naughtyness: i64 = get(9).parse().unwrap_or(0);

    Some(json!({
        "ts": iso_ts(get(0)),
        "client_ip": get(2),
        "user": dash_to_null(get(1)),
        "group": dash_to_null(get(13)),
        "url": get(3),
        "action": action,
        "category": category,
        "reason": dash_to_null(get(4)),
        "http_status": get(10).parse::<i64>().ok(),
        "method": dash_to_null(get(5)),
        "naughtyness": naughtyness,
        "engine": "content-filtering",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DENIED: &str = r#""2026.07.12 21:36:30","-","10.0.20.5","http://evil.test/path?y=1","*DENIED* Blocked site: evil.test","GET","0","0","-","1","403","-","10.0.20.5","staff","-","-","-","-","-""#;

    #[test]
    fn parses_denied_line() {
        let v = transform(DENIED).unwrap();
        assert_eq!(v["ts"], "2026-07-12T21:36:30");
        assert_eq!(v["client_ip"], "10.0.20.5");
        assert_eq!(v["url"], "http://evil.test/path?y=1");
        assert_eq!(v["action"], "blocked");
        assert_eq!(v["group"], "staff");
        assert_eq!(v["http_status"], 403);
        assert_eq!(v["method"], "GET");
        assert_eq!(v["engine"], "content-filtering");
    }

    #[test]
    fn category_extracted() {
        let line = r#""2026.07.12 21:00:00","-","10.0.0.9","http://x.test/","*DENIED* Blocked in banned category: adult","GET","0","0","-","0","403","-","10.0.0.9","kids","-""#;
        let v = transform(line).unwrap();
        assert_eq!(v["action"], "blocked");
        assert_eq!(v["category"], "adult");
    }

    #[test]
    fn csv_handles_quoted_commas() {
        let fields = parse_csv(r#""a","b, still b","c""#);
        assert_eq!(fields, vec!["a", "b, still b", "c"]);
    }

    #[test]
    fn non_csv_ignored() {
        assert!(transform("").is_none());
        assert!(transform("garbage").is_none());
    }
}
