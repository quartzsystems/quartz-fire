//! Fingerprinting: MAC OUI vendor lookup + client-type/OS heuristics.
//!
//! Signals available today: the OUI vendor (from the IEEE registry) and the
//! DHCP hostname. They combine into a best-effort `client_type` / `os_guess`;
//! when nothing matches we return None and the UI shows "Unknown" gracefully.
//!
//! DHCP option 55 (parameter request list) and option 60 (vendor class) are the
//! strong fingerprint signals but aren't in the Kea memfile. `Signals` carries
//! optional slots for them so a future Kea hook (or a Zeek enrichment feed —
//! see the `enrich` stub) can supply them without reworking callers.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

/// The inputs we fingerprint from. Everything is optional; more signals =
/// higher-confidence guess.
#[derive(Debug, Default, Clone)]
pub struct Signals<'a> {
    pub vendor: Option<&'a str>,
    pub hostname: Option<&'a str>,
    /// DHCP option 60 vendor class identifier (future: Kea hook).
    pub dhcp_vendor_class: Option<&'a str>,
    /// DHCP option 55 parameter-request-list fingerprint (future: Kea hook).
    pub dhcp_param_list: Option<&'a str>,
}

/// A fingerprint result. Either field may be None.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Fingerprint {
    /// Device category, e.g. "Phone", "Computer", "Printer", "IoT", "TV".
    pub client_type: Option<String>,
    /// OS family, e.g. "iOS", "Android", "Windows", "macOS", "Linux".
    pub os_guess: Option<String>,
}

impl Fingerprint {
    fn empty() -> Self {
        Self::default()
    }
    pub fn is_empty(&self) -> bool {
        self.client_type.is_none() && self.os_guess.is_none()
    }
}

// ── OUI database ────────────────────────────────────────────────────────────

/// The parsed IEEE OUI table (first 3 MAC bytes, uppercase hex → vendor),
/// loaded once from the `ieee-data` file. An absent/unreadable file yields an
/// empty map, so vendor lookups simply return None.
static OUI: OnceLock<HashMap<[u8; 3], String>> = OnceLock::new();

/// Load the OUI database from `path` once (subsequent calls ignore `path`).
pub fn init_oui(path: &Path) {
    OUI.get_or_init(|| match std::fs::read_to_string(path) {
        Ok(text) => parse_oui(&text),
        Err(e) => {
            tracing::warn!("OUI database {} unavailable ({e}); vendors will be unknown", path.display());
            HashMap::new()
        }
    });
}

/// Parse the IEEE `oui.txt` "(hex)" lines:
///   `AC-DE-48   (hex)\t\tPRIVATE`
/// into a prefix → vendor map.
pub fn parse_oui(text: &str) -> HashMap<[u8; 3], String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        // Only the "(hex)" lines carry the dash-separated OUI + vendor name.
        let Some(hex_pos) = line.find("(hex)") else { continue };
        let prefix = line[..hex_pos].trim();
        let vendor = line[hex_pos + 5..].trim();
        if vendor.is_empty() {
            continue;
        }
        if let Some(bytes) = parse_oui_prefix(prefix) {
            map.entry(bytes).or_insert_with(|| vendor.to_string());
        }
    }
    map
}

/// "AC-DE-48" (or "ACDE48") → the first three MAC bytes.
fn parse_oui_prefix(s: &str) -> Option<[u8; 3]> {
    let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() < 6 {
        return None;
    }
    Some([
        u8::from_str_radix(&hex[0..2], 16).ok()?,
        u8::from_str_radix(&hex[2..4], 16).ok()?,
        u8::from_str_radix(&hex[4..6], 16).ok()?,
    ])
}

/// First three bytes of a MAC ("aa:bb:cc:dd:ee:ff") for OUI lookup.
fn mac_prefix(mac: &str) -> Option<[u8; 3]> {
    parse_oui_prefix(mac)
}

/// Vendor for a MAC via the loaded OUI table. None if not loaded or unknown, or
/// for locally-administered / random MACs (bit 1 of the first octet set), which
/// carry no meaningful OUI — modern phones randomize these per-SSID.
pub fn vendor(mac: &str) -> Option<String> {
    let prefix = mac_prefix(mac)?;
    if prefix[0] & 0x02 != 0 {
        return None; // locally administered (randomized) MAC
    }
    OUI.get()?.get(&prefix).cloned()
}

/// True for a locally-administered (randomized) MAC. Surfaced so the UI can
/// hint that the vendor is unavailable by design, not by a missing database.
pub fn is_randomized_mac(mac: &str) -> bool {
    mac_prefix(mac).map(|p| p[0] & 0x02 != 0).unwrap_or(false)
}

// ── heuristics ──────────────────────────────────────────────────────────────

/// Combine the available signals into a best-effort fingerprint. Pure and
/// order-independent; hostname patterns are checked before vendor so an
/// explicit "MacBook" beats a generic Apple vendor guess.
pub fn classify(sig: &Signals) -> Fingerprint {
    let host = sig.hostname.unwrap_or("").to_ascii_lowercase();
    let vendor = sig.vendor.unwrap_or("").to_ascii_lowercase();
    let vclass = sig.dhcp_vendor_class.unwrap_or("").to_ascii_lowercase();

    let mut fp = Fingerprint::empty();

    // Hostname is the most specific signal we have today.
    let host_rules: &[(&[&str], Option<&str>, Option<&str>)] = &[
        (&["iphone"], Some("Phone"), Some("iOS")),
        (&["ipad"], Some("Tablet"), Some("iPadOS")),
        (&["ipod"], Some("Media Player"), Some("iOS")),
        (&["macbook", "imac", "mac-mini", "macmini", "mac-pro"], Some("Computer"), Some("macOS")),
        (&["android", "pixel", "galaxy", "oneplus"], Some("Phone"), Some("Android")),
        (&["-pc", "desktop-", "win-", "windows"], Some("Computer"), Some("Windows")),
        (&["ubuntu", "debian", "fedora", "archlinux", "raspberrypi", "raspberry"], Some("Computer"), Some("Linux")),
        (&["appletv", "apple-tv"], Some("TV"), Some("tvOS")),
        (&["chromecast", "google-home", "nest"], Some("IoT"), None),
        (&["roku", "firetv", "fire-tv", "shield"], Some("TV"), None),
        (&["printer", "hp-", "epson", "brother", "canon"], Some("Printer"), None),
        (&["camera", "ipcam", "reolink", "hikvision", "dahua"], Some("Camera"), None),
        (&["switch", "nintendo"], Some("Game Console"), None),
        (&["playstation", "ps4", "ps5", "xbox"], Some("Game Console"), None),
    ];
    for (needles, ct, os) in host_rules {
        if needles.iter().any(|n| host.contains(n)) {
            fp.client_type = ct.map(str::to_string);
            fp.os_guess = os.map(str::to_string);
            break;
        }
    }

    // DHCP vendor class (option 60) — strong when present.
    if vclass.contains("msft") {
        fp.os_guess.get_or_insert_with(|| "Windows".into());
        fp.client_type.get_or_insert_with(|| "Computer".into());
    } else if vclass.contains("android") {
        fp.os_guess.get_or_insert_with(|| "Android".into());
        fp.client_type.get_or_insert_with(|| "Phone".into());
    }

    // Vendor fills whatever the hostname didn't establish.
    let vendor_rules: &[(&[&str], Option<&str>, Option<&str>)] = &[
        (&["apple"], Some("Computer"), None),
        (&["samsung"], Some("Phone"), None),
        (&["google"], Some("IoT"), None),
        (&["amazon"], Some("IoT"), None),
        (&["intel", "dell", "lenovo", "asustek", "micro-star", "hewlett", "hp inc"], Some("Computer"), None),
        (&["espressif", "raspberry", "texas instruments", "tuya"], Some("IoT"), None),
        (&["hikvision", "dahua", "axis comm", "reolink"], Some("Camera"), None),
        (&["brother", "seiko epson", "canon", "lexmark", "xerox"], Some("Printer"), None),
        (&["sony", "nintendo", "microsoft"], Some("Game Console"), None),
        (&["ubiquiti", "cisco", "tp-link", "netgear", "mikrotik", "aruba"], Some("Network"), None),
    ];
    for (needles, ct, os) in vendor_rules {
        if needles.iter().any(|n| vendor.contains(n)) {
            if fp.client_type.is_none() {
                fp.client_type = ct.map(str::to_string);
            }
            if fp.os_guess.is_none() {
                fp.os_guess = os.map(str::to_string);
            }
            break;
        }
    }

    fp
}

/// Enrichment seam for future Zeek-based fingerprinting. Intentionally a no-op:
/// the collection path is wired so a later feed can refine a device's
/// fingerprint, but no Zeek integration exists yet (per the spec — stub only).
pub fn enrich(base: Fingerprint, _mac: &str) -> Fingerprint {
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ieee_oui_lines() {
        let text = "\
OUI/MA-L                                                    Organization
company_id                                                  Organization
                                                            Address

AC-DE-48   (hex)\t\tPRIVATE
AC-DE-48   (base 16)\t\tPRIVATE
00-1A-11   (hex)\t\tGoogle, Inc.
";
        let map = parse_oui(text);
        assert_eq!(map.get(&[0xAC, 0xDE, 0x48]).map(String::as_str), Some("PRIVATE"));
        assert_eq!(map.get(&[0x00, 0x1A, 0x11]).map(String::as_str), Some("Google, Inc."));
    }

    #[test]
    fn randomized_macs_have_no_vendor() {
        // Bit 0x02 of the first octet set = locally administered.
        assert!(is_randomized_mac("aa:bb:cc:dd:ee:ff")); // 0xaa & 0x02 = 0x02
        assert!(!is_randomized_mac("ac:de:48:00:00:01")); // 0xac & 0x02 = 0
    }

    #[test]
    fn hostname_beats_vendor() {
        let fp = classify(&Signals { vendor: Some("Apple, Inc."), hostname: Some("Johns-iPhone"), ..Default::default() });
        assert_eq!(fp.client_type.as_deref(), Some("Phone"));
        assert_eq!(fp.os_guess.as_deref(), Some("iOS"));
    }

    #[test]
    fn vendor_fills_gaps() {
        let fp = classify(&Signals { vendor: Some("Seiko Epson Corporation"), hostname: None, ..Default::default() });
        assert_eq!(fp.client_type.as_deref(), Some("Printer"));
        assert!(fp.os_guess.is_none());
    }

    #[test]
    fn unknown_is_empty() {
        let fp = classify(&Signals::default());
        assert!(fp.is_empty());
    }

    #[test]
    fn dhcp_vendor_class_signal() {
        let fp = classify(&Signals { dhcp_vendor_class: Some("MSFT 5.0"), ..Default::default() });
        assert_eq!(fp.os_guess.as_deref(), Some("Windows"));
        assert_eq!(fp.client_type.as_deref(), Some("Computer"));
    }
}
