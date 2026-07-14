//! Traffic accounting from conntrack byte counters.
//!
//! Requires `net.netfilter.nf_conntrack_acct=1` (a sysctl drop-in ships with
//! the package). Two feeds share one accounting map so bytes are never
//! double-counted:
//!
//!   * a periodic `conntrack -L` **snapshot** — catches long-lived flows that
//!     never tear down inside the window, and
//!   * a `conntrack -E -e DESTROY` **event stream** — catches short flows that
//!     start and finish between snapshots (e.g. a 10 s iperf3 run), which a
//!     snapshot poller alone would miss entirely.
//!
//! For each flow we remember the bytes already credited (`Counted`); every
//! observation credits only the positive delta since then. A new flow reusing
//! an old tuple shows counters going *down*, which we treat as a reset and
//! credit from zero. Attribution: the flow's originator (orig src) is the
//! client — its uploads are the orig direction, downloads the reply direction;
//! if instead the LAN device is the responder we swap the two.

use std::collections::HashMap;

/// A parsed conntrack flow line — just the fields accounting needs.
#[derive(Debug, Clone, PartialEq)]
pub struct Flow {
    /// Stable per-entry key: conntrack `id=` when present, else the 5-tuple.
    pub key: String,
    pub orig_src: String,
    pub orig_dst: String,
    /// Bytes in the original direction (client → peer).
    pub orig_bytes: u64,
    /// Bytes in the reply direction (peer → client). 0 for unreplied flows.
    pub reply_bytes: u64,
}

/// Parse one conntrack line (`-L` snapshot or `-E` event, `--output extended`).
/// Returns None for lines without byte counters (accounting off, or a NEW
/// event before any bytes flowed).
///
/// A typical line:
///   `tcp 6 431999 ESTABLISHED src=10.0.0.5 dst=1.2.3.4 sport=51000 dport=443
///    packets=10 bytes=1000 src=1.2.3.4 dst=10.0.0.5 sport=443 dport=51000
///    packets=8 bytes=8000 [ASSURED] mark=0 use=1`
/// Event lines are prefixed with e.g. `[DESTROY]`.
pub fn parse_line(line: &str) -> Option<Flow> {
    let mut orig_src = None;
    let mut orig_dst = None;
    let mut sport = None;
    let mut dport = None;
    let mut proto = None;
    let mut id = None;
    let mut byte_counters: Vec<u64> = Vec::with_capacity(2);

    for tok in line.split_whitespace() {
        if let Some((k, v)) = tok.split_once('=') {
            match k {
                // First occurrence is the original-direction tuple; the reply
                // tuple repeats src=/dst= later, so only the first wins.
                "src" => {
                    if orig_src.is_none() {
                        orig_src = Some(v.to_string());
                    }
                }
                "dst" => {
                    if orig_dst.is_none() {
                        orig_dst = Some(v.to_string());
                    }
                }
                "sport" => {
                    if sport.is_none() {
                        sport = Some(v.to_string());
                    }
                }
                "dport" => {
                    if dport.is_none() {
                        dport = Some(v.to_string());
                    }
                }
                "bytes" => {
                    if let Ok(n) = v.parse::<u64>() {
                        byte_counters.push(n);
                    }
                }
                "id" => id = Some(v.to_string()),
                _ => {}
            }
        } else if proto.is_none() && tok.chars().all(|c| c.is_ascii_alphabetic()) && !tok.starts_with('[') {
            // The leading protocol name ("tcp"/"udp"/…). Skip the `[DESTROY]`
            // marker and numeric protonum that follow.
            proto = Some(tok.to_string());
        }
    }

    let orig_src = orig_src?;
    let orig_dst = orig_dst?;
    // No byte counters at all → nothing to account (acct off, or NEW event).
    if byte_counters.is_empty() {
        return None;
    }
    let orig_bytes = byte_counters[0];
    let reply_bytes = byte_counters.get(1).copied().unwrap_or(0);

    let key = id.unwrap_or_else(|| {
        format!(
            "{}|{}:{}|{}:{}",
            proto.as_deref().unwrap_or("?"),
            orig_src,
            sport.as_deref().unwrap_or("0"),
            orig_dst,
            dport.as_deref().unwrap_or("0"),
        )
    });

    Some(Flow { key, orig_src, orig_dst, orig_bytes, reply_bytes })
}

/// Bytes already credited for a flow, so repeated observations only add the
/// delta.
#[derive(Debug, Clone, Copy, Default)]
struct Counted {
    out: u64,
    in_: u64,
}

/// A per-device byte delta ready to fold into a usage bucket.
#[derive(Debug, Clone, PartialEq)]
pub struct Delta {
    pub mac: String,
    pub bytes_in: u64,
    pub bytes_out: u64,
}

/// The accounting map shared by the snapshot poll and the destroy stream.
/// Resolve IP→MAC via the caller-supplied closure (backed by the neigh/lease
/// tables); flows whose LAN endpoint isn't a known device are dropped.
#[derive(Default)]
pub struct Accountant {
    counted: HashMap<String, Counted>,
}

impl Accountant {
    pub fn new() -> Self {
        Self::default()
    }

    /// Observe a flow and return the device delta to credit, if any. `resolve`
    /// maps an IP to a known device MAC. `remove` finalizes a destroyed flow
    /// (drop its accounting slot so the map doesn't grow without bound).
    pub fn observe<F>(&mut self, flow: &Flow, remove: bool, resolve: F) -> Option<Delta>
    where
        F: Fn(&str) -> Option<String>,
    {
        // Decide which endpoint is the LAN device and orient up/down.
        // Originator known → device uploads in the orig direction.
        // Responder known → device is the reply side; swap directions.
        let (mac, dev_out_total, dev_in_total) = if let Some(mac) = resolve(&flow.orig_src) {
            (mac, flow.orig_bytes, flow.reply_bytes)
        } else if let Some(mac) = resolve(&flow.orig_dst) {
            (mac, flow.reply_bytes, flow.orig_bytes)
        } else {
            // Neither endpoint is a tracked device (e.g. router-to-WAN). Still
            // clear the slot on destroy so it can't leak.
            if remove {
                self.counted.remove(&flow.key);
            }
            return None;
        };

        let prev = self.counted.get(&flow.key).copied().unwrap_or_default();
        // Counters going backwards = tuple reused by a new flow → credit from 0.
        let base_out = if dev_out_total < prev.out { 0 } else { prev.out };
        let base_in = if dev_in_total < prev.in_ { 0 } else { prev.in_ };
        let d_out = dev_out_total.saturating_sub(base_out);
        let d_in = dev_in_total.saturating_sub(base_in);

        if remove {
            self.counted.remove(&flow.key);
        } else {
            self.counted.insert(flow.key.clone(), Counted { out: dev_out_total, in_: dev_in_total });
        }

        if d_out == 0 && d_in == 0 {
            return None;
        }
        Some(Delta { mac, bytes_in: d_in, bytes_out: d_out })
    }

    /// Forget flows no longer present in a snapshot (they were destroyed
    /// between polls and, if we also run the destroy stream, already finalized).
    /// Bounds the map when the destroy stream is unavailable.
    pub fn retain_keys(&mut self, live: &std::collections::HashSet<String>) {
        self.counted.retain(|k, _| live.contains(k));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.counted.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn resolver<'a>(map: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |ip| map.iter().find(|(k, _)| *k == ip).map(|(_, v)| v.to_string())
    }

    #[test]
    fn parses_extended_line() {
        let line = "tcp 6 431999 ESTABLISHED src=10.0.0.5 dst=1.2.3.4 sport=51000 dport=443 \
                    packets=10 bytes=1000 src=1.2.3.4 dst=10.0.0.5 sport=443 dport=51000 \
                    packets=8 bytes=8000 [ASSURED] mark=0 use=1";
        let f = parse_line(line).unwrap();
        assert_eq!(f.orig_src, "10.0.0.5");
        assert_eq!(f.orig_dst, "1.2.3.4");
        assert_eq!(f.orig_bytes, 1000);
        assert_eq!(f.reply_bytes, 8000);
    }

    #[test]
    fn destroy_event_and_id_key() {
        let line = "[DESTROY] tcp 6 src=10.0.0.5 dst=1.2.3.4 sport=51000 dport=443 packets=10 \
                    bytes=1000 src=1.2.3.4 dst=10.0.0.5 sport=443 dport=51000 packets=8 bytes=8000 id=42";
        let f = parse_line(line).unwrap();
        assert_eq!(f.key, "42"); // id= wins over the tuple
        assert_eq!(f.orig_src, "10.0.0.5");
        assert_eq!(f.reply_bytes, 8000);
    }

    #[test]
    fn unreplied_flow_has_zero_reply() {
        let line = "udp 17 29 src=10.0.0.5 dst=8.8.8.8 sport=1 dport=53 packets=1 bytes=60 \
                    [UNREPLIED] src=8.8.8.8 dst=10.0.0.5 sport=53 dport=1 packets=0 bytes=0";
        let f = parse_line(line).unwrap();
        assert_eq!(f.orig_bytes, 60);
        assert_eq!(f.reply_bytes, 0);
    }

    #[test]
    fn no_counters_is_none() {
        // Accounting disabled → no bytes= tokens.
        let line = "tcp 6 120 SYN_SENT src=10.0.0.5 dst=1.2.3.4 sport=1 dport=2 [UNREPLIED] src=1.2.3.4 dst=10.0.0.5 sport=2 dport=1";
        assert!(parse_line(line).is_none());
    }

    #[test]
    fn short_flow_credited_from_destroy_only() {
        // A flow the snapshot never saw: its DESTROY credits the full total.
        let mut acct = Accountant::new();
        let flow = Flow { key: "42".into(), orig_src: "10.0.0.5".into(), orig_dst: "1.2.3.4".into(), orig_bytes: 1000, reply_bytes: 8000 };
        let d = acct.observe(&flow, true, resolver(&[("10.0.0.5", "aa")])).unwrap();
        assert_eq!(d, Delta { mac: "aa".into(), bytes_in: 8000, bytes_out: 1000 });
        assert_eq!(acct.len(), 0); // finalized + removed
    }

    #[test]
    fn snapshot_deltas_do_not_double_count_then_destroy_finalizes() {
        let mut acct = Accountant::new();
        let r = resolver(&[("10.0.0.5", "aa")]);
        // First snapshot: 1000/8000 → credited in full.
        let f1 = Flow { key: "42".into(), orig_src: "10.0.0.5".into(), orig_dst: "1.2.3.4".into(), orig_bytes: 1000, reply_bytes: 8000 };
        assert_eq!(acct.observe(&f1, false, &r).unwrap(), Delta { mac: "aa".into(), bytes_in: 8000, bytes_out: 1000 });
        // Second snapshot: grew to 1500/9000 → only the +500/+1000 delta.
        let f2 = Flow { key: "42".into(), orig_bytes: 1500, reply_bytes: 9000, ..f1.clone() };
        assert_eq!(acct.observe(&f2, false, &r).unwrap(), Delta { mac: "aa".into(), bytes_in: 1000, bytes_out: 500 });
        // DESTROY at 1500/9000 → nothing left to credit, slot removed.
        let f3 = Flow { key: "42".into(), orig_bytes: 1500, reply_bytes: 9000, ..f1.clone() };
        assert!(acct.observe(&f3, true, &r).is_none());
        assert_eq!(acct.len(), 0);
    }

    #[test]
    fn responder_side_swaps_direction() {
        // Remote initiates to a LAN server: orig_dst is our device.
        let mut acct = Accountant::new();
        let flow = Flow { key: "7".into(), orig_src: "1.2.3.4".into(), orig_dst: "10.0.0.9".into(), orig_bytes: 500, reply_bytes: 4000 };
        let d = acct.observe(&flow, true, resolver(&[("10.0.0.9", "bb")])).unwrap();
        // Device received orig_bytes (download) and sent reply_bytes (upload).
        assert_eq!(d, Delta { mac: "bb".into(), bytes_in: 500, bytes_out: 4000 });
    }

    #[test]
    fn tuple_reuse_resets_counting() {
        let mut acct = Accountant::new();
        let r = resolver(&[("10.0.0.5", "aa")]);
        let key = "tcp|10.0.0.5:5|1.2.3.4:6";
        let f1 = Flow { key: key.into(), orig_src: "10.0.0.5".into(), orig_dst: "1.2.3.4".into(), orig_bytes: 9000, reply_bytes: 100 };
        acct.observe(&f1, false, &r);
        // New flow reuses the tuple; counters restart low → credit from zero.
        let f2 = Flow { key: key.into(), orig_src: "10.0.0.5".into(), orig_dst: "1.2.3.4".into(), orig_bytes: 200, reply_bytes: 5 };
        let d = acct.observe(&f2, false, &r).unwrap();
        assert_eq!(d, Delta { mac: "aa".into(), bytes_in: 5, bytes_out: 200 });
    }

    #[test]
    fn unknown_endpoints_dropped_but_slot_cleared() {
        let mut acct = Accountant::new();
        let flow = Flow { key: "9".into(), orig_src: "1.2.3.4".into(), orig_dst: "5.6.7.8".into(), orig_bytes: 1, reply_bytes: 1 };
        assert!(acct.observe(&flow, true, resolver(&[])).is_none());
        assert_eq!(acct.len(), 0);
        let _ = HashSet::<String>::new();
    }
}
