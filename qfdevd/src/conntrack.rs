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
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Flow {
    /// Stable per-entry key: conntrack `id=` when present, else the 5-tuple.
    pub key: String,
    pub orig_src: String,
    pub orig_dst: String,
    /// Bytes in the original direction (client → peer).
    pub orig_bytes: u64,
    /// Bytes in the reply direction (peer → client). 0 for unreplied flows.
    pub reply_bytes: u64,
    /// The flow's conntrack mark. App Control encodes its verdict here, so this
    /// is what lets us say which application a byte delta belongs to. Left raw:
    /// decoding needs the published bit layout, which is the daemon's business,
    /// not the parser's. 0 when absent (no `mark=` token).
    pub mark: u32,
    /// Protocol name as conntrack prints it ("tcp"/"udp"/"icmp"/…); empty when
    /// the line carried none.
    pub proto: String,
    /// Original-direction destination port (the service port). 0 when absent
    /// (ICMP, or an unparseable value).
    pub dport: u16,
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
    let mut mark = None;
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
                // conntrack prints the mark in decimal. A DESTROY event carries
                // the mark the flow died with, which is the one App Control set.
                "mark" => mark = v.parse::<u32>().ok(),
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

    Some(Flow {
        key,
        orig_src,
        orig_dst,
        orig_bytes,
        reply_bytes,
        mark: mark.unwrap_or(0),
        proto: proto.unwrap_or_default(),
        dport: dport.and_then(|p| p.parse().ok()).unwrap_or(0),
    })
}

/// Bytes already credited for a flow, so repeated observations only add the
/// delta. Kept in the flow's own orientation (orig/reply), not the device's.
#[derive(Debug, Clone, Copy, Default)]
struct Counted {
    orig: u64,
    reply: u64,
}

/// Direction-neutral byte growth for one flow since it was last observed —
/// the input both to device attribution (`orient`) and to per-flow recording.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RawDelta {
    /// New bytes in the original direction (orig src → orig dst).
    pub d_orig: u64,
    /// New bytes in the reply direction.
    pub d_reply: u64,
    /// True when this observation began a new conntrack entry: the first
    /// sighting of the key, or a tuple reuse (counters went backwards). The
    /// connection-count ("hits") signal — each conntrack entry trips it once.
    pub new_flow: bool,
}

/// A per-device byte delta ready to fold into a usage bucket.
#[derive(Debug, Clone, PartialEq)]
pub struct Delta {
    pub mac: String,
    pub bytes_in: u64,
    pub bytes_out: u64,
    /// The observed flow's conntrack mark, carried through so the caller can
    /// attribute these bytes to an application. Taken from the same observation
    /// that produced the delta, so a flow classified mid-life attributes each
    /// delta to whatever it was known to be at the time — not retroactively.
    pub mark: u32,
}

/// Attribute a raw delta to a known device, orienting it as the device's
/// up/download. Originator known → the device uploads in the orig direction;
/// responder known → swap. None when neither endpoint is a tracked device
/// (e.g. router-to-WAN) — those bytes still exist for per-flow recording,
/// they just belong to no client.
pub fn orient<F>(flow: &Flow, raw: RawDelta, resolve: F) -> Option<Delta>
where
    F: Fn(&str) -> Option<String>,
{
    let (mac, bytes_out, bytes_in) = if let Some(mac) = resolve(&flow.orig_src) {
        (mac, raw.d_orig, raw.d_reply)
    } else if let Some(mac) = resolve(&flow.orig_dst) {
        (mac, raw.d_reply, raw.d_orig)
    } else {
        return None;
    };
    if bytes_in == 0 && bytes_out == 0 {
        return None;
    }
    Some(Delta { mac, bytes_in, bytes_out, mark: flow.mark })
}

/// The accounting map shared by the snapshot poll and the destroy stream.
/// Resolve IP→MAC via the caller-supplied closure (backed by the neigh/lease
/// tables); flows whose LAN endpoint isn't a known device are dropped.
#[derive(Default)]
pub struct Accountant {
    counted: HashMap<String, Counted>,
    /// False until the first snapshot has recorded a baseline for every flow
    /// already open when we started. See `mark_primed`.
    primed: bool,
}

impl Accountant {
    pub fn new() -> Self {
        Self::default()
    }

    /// True once the startup baseline is in place and deltas are being credited.
    pub fn is_primed(&self) -> bool {
        self.primed
    }

    /// Start crediting deltas. Call after the first snapshot has observed every
    /// open flow.
    ///
    /// Until this is called, observations only record where each flow's counters
    /// stood and credit nothing. Without that baseline the first snapshot sees
    /// `prev = 0` for flows that have been open for hours and credits their
    /// whole accumulated total to the *current* 5-minute bucket — a restart of
    /// this daemon would drop gigabytes into one bucket and draw a huge fake
    /// throughput spike (a long download read as ~85 Mbps for five minutes).
    /// Those bytes belong to buckets we no longer have, so the only honest
    /// treatment is to ignore them and count growth from here. The cost is the
    /// in-flight bytes of one snapshot interval at startup.
    pub fn mark_primed(&mut self) {
        self.primed = true;
    }

    /// Observe a flow and return its direction-neutral byte growth since the
    /// last observation, if any. Tracked for *every* flow — device attribution
    /// is a separate, later concern (`orient`) so per-flow recording also sees
    /// router-to-WAN and other untracked-endpoint traffic. `remove` finalizes a
    /// destroyed flow (drop its accounting slot so the map doesn't grow without
    /// bound).
    pub fn observe_raw(&mut self, flow: &Flow, remove: bool) -> Option<RawDelta> {
        let prev_slot = self.counted.get(&flow.key).copied();
        let prev = prev_slot.unwrap_or_default();
        // Counters going backwards = tuple reused by a new flow → credit from 0.
        let reset = flow.orig_bytes < prev.orig || flow.reply_bytes < prev.reply;
        let base_orig = if flow.orig_bytes < prev.orig { 0 } else { prev.orig };
        let base_reply = if flow.reply_bytes < prev.reply { 0 } else { prev.reply };
        let d_orig = flow.orig_bytes.saturating_sub(base_orig);
        let d_reply = flow.reply_bytes.saturating_sub(base_reply);
        // A connection is counted exactly once — at its first sighting (no
        // prior slot) or when a reused tuple restarts its counters.
        let new_flow = prev_slot.is_none() || reset;

        if remove {
            self.counted.remove(&flow.key);
        } else {
            self.counted
                .insert(flow.key.clone(), Counted { orig: flow.orig_bytes, reply: flow.reply_bytes });
        }

        // Pre-baseline: the slot above is all we wanted. Anything this flow has
        // already moved predates us and can't be placed in a bucket honestly.
        if !self.primed {
            return None;
        }

        // A zero-byte observation still matters when it BEGINS a connection —
        // dropping it would lose the hit count for e.g. blocked-after-SYN flows.
        if d_orig == 0 && d_reply == 0 && !new_flow {
            return None;
        }
        Some(RawDelta { d_orig, d_reply, new_flow })
    }

    /// Observe a flow and return the device delta to credit, if any. `resolve`
    /// maps an IP to a known device MAC. Thin composition of `observe_raw` +
    /// `orient`, kept for callers that only care about device usage.
    pub fn observe<F>(&mut self, flow: &Flow, remove: bool, resolve: F) -> Option<Delta>
    where
        F: Fn(&str) -> Option<String>,
    {
        let raw = self.observe_raw(flow, remove)?;
        orient(flow, raw, resolve)
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

    /// An accountant in its steady state — i.e. past the startup baseline, which
    /// is what every test below except the priming ones cares about.
    fn primed() -> Accountant {
        let mut a = Accountant::new();
        a.mark_primed();
        a
    }

    fn flow(key: &str, orig_src: &str, orig_bytes: u64, reply_bytes: u64) -> Flow {
        Flow {
            key: key.into(),
            orig_src: orig_src.into(),
            orig_dst: "1.2.3.4".into(),
            orig_bytes,
            reply_bytes,
            ..Default::default()
        }
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
        // The service tuple pieces per-flow recording keys by. dport is the
        // ORIGINAL direction's port (443), not the reply's ephemeral one.
        assert_eq!(f.proto, "tcp");
        assert_eq!(f.dport, 443);
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
    fn parses_the_ct_mark() {
        let line = "tcp 6 431999 ESTABLISHED src=10.0.0.5 dst=1.2.3.4 sport=51000 dport=443 \
                    packets=10 bytes=1000 src=1.2.3.4 dst=10.0.0.5 sport=443 dport=51000 \
                    packets=8 bytes=8000 [ASSURED] mark=2195193856 use=1";
        // (1<<31) | (91<<19): CLASSIFIED + app_id 91 under qfappd's default
        // layout. Note it exceeds i32::MAX — the mark is unsigned, and parsing it
        // as signed would fail exactly on the classified flows we care about.
        assert_eq!(parse_line(line).unwrap().mark, 2_195_193_856);
    }

    #[test]
    fn absent_mark_reads_as_zero() {
        let line = "tcp 6 431999 ESTABLISHED src=10.0.0.5 dst=1.2.3.4 sport=51000 dport=443 \
                    packets=10 bytes=1000 src=1.2.3.4 dst=10.0.0.5 sport=443 dport=51000 packets=8 bytes=8000";
        assert_eq!(parse_line(line).unwrap().mark, 0);
    }

    #[test]
    fn delta_carries_the_observed_mark() {
        // The mark is what lets the caller attribute these bytes to an app, so
        // it has to survive the trip through the accountant.
        let mut acct = primed();
        let f = Flow { mark: 2_195_193_856, ..flow("42", "10.0.0.5", 1_000, 8_000) };
        let d = acct.observe(&f, false, resolver(&[("10.0.0.5", "aa")])).unwrap();
        assert_eq!(d.mark, 2_195_193_856);
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
        let mut acct = primed();
        let f = flow("42", "10.0.0.5", 1000, 8000);
        let d = acct.observe(&f, true, resolver(&[("10.0.0.5", "aa")])).unwrap();
        assert_eq!(d, Delta { mac: "aa".into(), bytes_in: 8000, bytes_out: 1000, mark: 0 });
        assert_eq!(acct.len(), 0); // finalized + removed
    }

    #[test]
    fn snapshot_deltas_do_not_double_count_then_destroy_finalizes() {
        let mut acct = primed();
        let r = resolver(&[("10.0.0.5", "aa")]);
        // First snapshot: 1000/8000 → credited in full.
        let f1 = flow("42", "10.0.0.5", 1000, 8000);
        assert_eq!(acct.observe(&f1, false, &r).unwrap(), Delta { mac: "aa".into(), bytes_in: 8000, bytes_out: 1000, mark: 0 });
        // Second snapshot: grew to 1500/9000 → only the +500/+1000 delta.
        let f2 = Flow { orig_bytes: 1500, reply_bytes: 9000, ..f1.clone() };
        assert_eq!(acct.observe(&f2, false, &r).unwrap(), Delta { mac: "aa".into(), bytes_in: 1000, bytes_out: 500, mark: 0 });
        // DESTROY at 1500/9000 → nothing left to credit, slot removed.
        let f3 = Flow { orig_bytes: 1500, reply_bytes: 9000, ..f1.clone() };
        assert!(acct.observe(&f3, true, &r).is_none());
        assert_eq!(acct.len(), 0);
    }

    #[test]
    fn responder_side_swaps_direction() {
        // Remote initiates to a LAN server: orig_dst is our device.
        let mut acct = primed();
        let f = Flow {
            key: "7".into(),
            orig_src: "1.2.3.4".into(),
            orig_dst: "10.0.0.9".into(),
            orig_bytes: 500,
            reply_bytes: 4000,
            ..Default::default()
        };
        let d = acct.observe(&f, true, resolver(&[("10.0.0.9", "bb")])).unwrap();
        // Device received orig_bytes (download) and sent reply_bytes (upload).
        assert_eq!(d, Delta { mac: "bb".into(), bytes_in: 500, bytes_out: 4000, mark: 0 });
    }

    #[test]
    fn tuple_reuse_resets_counting() {
        let mut acct = primed();
        let r = resolver(&[("10.0.0.5", "aa")]);
        let key = "tcp|10.0.0.5:5|1.2.3.4:6";
        let f1 = flow(key, "10.0.0.5", 9000, 100);
        acct.observe(&f1, false, &r);
        // New flow reuses the tuple; counters restart low → credit from zero.
        let f2 = flow(key, "10.0.0.5", 200, 5);
        let d = acct.observe(&f2, false, &r).unwrap();
        assert_eq!(d, Delta { mac: "aa".into(), bytes_in: 5, bytes_out: 200, mark: 0 });
    }

    #[test]
    fn raw_deltas_flow_for_untracked_endpoints() {
        // Per-flow recording must see router-to-WAN traffic that device
        // accounting drops: observe_raw credits growth regardless of whether
        // any endpoint resolves to a device.
        let mut acct = primed();
        let f = Flow {
            key: "9".into(),
            orig_src: "192.0.2.1".into(),
            orig_dst: "5.6.7.8".into(),
            orig_bytes: 100,
            reply_bytes: 900,
            ..Default::default()
        };
        let first = acct.observe_raw(&f, false).unwrap();
        assert_eq!(first, RawDelta { d_orig: 100, d_reply: 900, new_flow: true });
        // …and orientation still finds no device to credit.
        assert!(orient(&f, first, |_| None).is_none());
        // Growth on the next snapshot is delta-only, and not a new connection.
        let f2 = Flow { orig_bytes: 150, reply_bytes: 1000, ..f.clone() };
        assert_eq!(
            acct.observe_raw(&f2, false).unwrap(),
            RawDelta { d_orig: 50, d_reply: 100, new_flow: false },
        );
    }

    #[test]
    fn new_flow_counts_each_connection_exactly_once() {
        let mut acct = primed();
        // First sighting → new.
        let f = flow("42", "10.0.0.5", 100, 200);
        assert!(acct.observe_raw(&f, false).unwrap().new_flow);
        // Same connection growing → not new; its DESTROY → not new either.
        let f2 = Flow { orig_bytes: 150, reply_bytes: 300, ..f.clone() };
        assert!(!acct.observe_raw(&f2, false).unwrap().new_flow);
        let f3 = Flow { orig_bytes: 200, reply_bytes: 400, ..f.clone() };
        assert!(!acct.observe_raw(&f3, true).unwrap().new_flow);
        // A short flow only ever seen at DESTROY → one new connection.
        let short = flow("77", "10.0.0.5", 60, 0);
        assert!(acct.observe_raw(&short, true).unwrap().new_flow);
        // Tuple reuse (counters restart) → the reused tuple is a new connection.
        let key = "tcp|10.0.0.5:5|1.2.3.4:6";
        acct.observe_raw(&flow(key, "10.0.0.5", 9000, 100), false);
        assert!(acct.observe_raw(&flow(key, "10.0.0.5", 20, 5), false).unwrap().new_flow);
        // A zero-byte observation that BEGINS a connection still reports, so
        // the hit is countable even when no payload ever moved.
        let empty = flow("88", "10.0.0.5", 0, 0);
        let d = acct.observe_raw(&empty, true).unwrap();
        assert!(d.new_flow);
        assert_eq!((d.d_orig, d.d_reply), (0, 0));
        // …but a zero-byte NON-new observation stays silent as before.
        acct.observe_raw(&flow("99", "10.0.0.5", 10, 10), false);
        assert!(acct.observe_raw(&flow("99", "10.0.0.5", 10, 10), false).is_none());
    }

    #[test]
    fn observe_and_observe_raw_share_one_ledger() {
        // A single observation must not be creditable twice: whichever entry
        // point sees the flow advances the same per-flow baseline.
        let mut acct = primed();
        let r = resolver(&[("10.0.0.5", "aa")]);
        let f = flow("42", "10.0.0.5", 1000, 8000);
        assert!(acct.observe_raw(&f, false).is_some());
        // The same totals through observe() yield nothing new.
        assert!(acct.observe(&f, false, &r).is_none());
    }

    #[test]
    fn startup_baseline_does_not_credit_pre_existing_flow_history() {
        // The regression: a flow that has been open for hours (4 GB down) is
        // seen by our very first snapshot. Un-primed, `prev` is 0 and the whole
        // 4 GB lands in the current 5-minute bucket as a fake spike.
        let mut acct = Accountant::new();
        let r = resolver(&[("10.0.0.5", "aa")]);
        let old = flow("42", "10.0.0.5", 1_000, 4_000_000_000);
        assert!(acct.observe(&old, false, &r).is_none(), "pre-baseline history must not be credited");

        acct.mark_primed();

        // Only what the flow moves *after* the baseline is real.
        let grown = flow("42", "10.0.0.5", 1_200, 4_000_050_000);
        assert_eq!(
            acct.observe(&grown, false, &r).unwrap(),
            Delta { mac: "aa".into(), bytes_in: 50_000, bytes_out: 200, mark: 0 },
        );
    }

    #[test]
    fn destroy_before_baseline_credits_nothing() {
        // The destroy stream races the first snapshot. A long-lived flow tearing
        // down in that gap is pre-existing too, so it must not be credited.
        let mut acct = Accountant::new();
        let r = resolver(&[("10.0.0.5", "aa")]);
        let old = flow("42", "10.0.0.5", 1_000, 4_000_000_000);
        assert!(acct.observe(&old, true, &r).is_none());
        assert_eq!(acct.len(), 0); // and the slot is still cleaned up
    }

    #[test]
    fn short_flow_after_baseline_is_still_credited_in_full() {
        // Guards the flip side: once primed, an unseen flow is genuinely new
        // (it began after the last snapshot), so its total *is* recent traffic.
        let mut acct = primed();
        let f = flow("99", "10.0.0.5", 1_000, 8_000);
        assert_eq!(
            acct.observe(&f, true, resolver(&[("10.0.0.5", "aa")])).unwrap(),
            Delta { mac: "aa".into(), bytes_in: 8_000, bytes_out: 1_000, mark: 0 },
        );
    }

    #[test]
    fn priming_is_sticky() {
        let mut acct = Accountant::new();
        assert!(!acct.is_primed());
        acct.mark_primed();
        assert!(acct.is_primed());
        acct.mark_primed();
        assert!(acct.is_primed());
    }

    #[test]
    fn unknown_endpoints_dropped_but_slot_cleared() {
        let mut acct = primed();
        let f = Flow {
            key: "9".into(),
            orig_src: "1.2.3.4".into(),
            orig_dst: "5.6.7.8".into(),
            orig_bytes: 1,
            reply_bytes: 1,
            ..Default::default()
        };
        assert!(acct.observe(&f, true, resolver(&[])).is_none());
        assert_eq!(acct.len(), 0);
        let _ = HashSet::<String>::new();
    }
}
