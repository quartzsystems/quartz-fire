//! Decoding the App Control application id out of a flow's conntrack mark.
//!
//! qfappd classifies a flow, writes a verdict into the conntrack mark, and
//! offloads the flow to nftables. The mark carries the nDPI protocol id, which
//! means the `conntrack -L` snapshot we already read for byte accounting also
//! tells us *which application* those bytes belong to — no extra plumbing, and
//! the bytes and the attribution come from the same observation.
//!
//! The bit layout is qfappd's to define (it's configurable via `[mark]` in
//! qfappd.toml), so we don't hardcode it: qfappd publishes the layout in force
//! alongside its catalog and we read it from there. Assuming the defaults on a
//! box whose layout was customized would silently attribute bytes to whatever
//! application the misread bits happened to name — worse than not reporting.
//! When the file is absent (App Control not installed, or not started yet) we
//! fall back to the documented defaults; nothing is marked in that case, so the
//! fallback only ever decodes zeroes.

use serde::Deserialize;
use std::path::Path;

/// qfappd's ct-mark bit layout, as published in its catalog.
///
/// Mirrors `qfappd_core::ctmark::Layout`. Deliberately a copy rather than a
/// dependency on that crate: qfdevd and qfappd are separately built and shipped
/// packages, and this is a published runtime contract (a JSON file), not a
/// compile-time one. `validate` re-checks the invariants qfappd's constructor
/// enforces, since a file on disk carries no such guarantee.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct MarkLayout {
    pub classified_bit: u8,
    pub block_bit: u8,
    pub app_shift: u8,
    pub app_bits: u8,
    pub action_shift: u8,
    pub action_bits: u8,
}

/// The layout documented in qfappd's ctmark module, used when qfappd hasn't
/// published one.
pub const DEFAULT: MarkLayout = MarkLayout {
    classified_bit: 31,
    block_bit: 30,
    app_shift: 19,
    app_bits: 11,
    action_shift: 16,
    action_bits: 3,
};

impl Default for MarkLayout {
    fn default() -> Self {
        DEFAULT
    }
}

impl MarkLayout {
    /// Reject a layout whose fields fall off the end of the mark or overlap.
    /// A bad layout would decode garbage app ids, so callers fall back to
    /// `DEFAULT` rather than trust it.
    pub fn validate(&self) -> bool {
        if self.classified_bit > 31 || self.block_bit > 31 {
            return false;
        }
        for (shift, bits) in [(self.app_shift, self.app_bits), (self.action_shift, self.action_bits)] {
            if bits == 0 || u32::from(shift) + u32::from(bits) > 32 {
                return false;
            }
        }
        // Fields must not overlap: the union must have as many bits as claimed.
        let expected = 2 + u32::from(self.app_bits) + u32::from(self.action_bits);
        expected == self.mask().count_ones()
    }

    fn mask(&self) -> u32 {
        (1u32 << self.classified_bit)
            | (1u32 << self.block_bit)
            | (Self::field_mask(self.app_bits) << self.app_shift)
            | (Self::field_mask(self.action_bits) << self.action_shift)
    }

    fn field_mask(bits: u8) -> u32 {
        if bits >= 32 {
            u32::MAX
        } else {
            (1u32 << bits) - 1
        }
    }

    /// The application id a flow's mark names, or None when the flow carries no
    /// final verdict.
    ///
    /// An unclassified flow's APP_ID bits are meaningless, so the CLASSIFIED bit
    /// gates the read: without it we'd attribute every unmarked flow on the box
    /// (all of it, when App Control is off) to whichever app id 0 happens to be.
    /// App id 0 means "classified, but unknown protocol" and is a real answer we
    /// keep.
    pub fn app_id(&self, mark: u32) -> Option<u16> {
        if mark & (1u32 << self.classified_bit) == 0 {
            return None;
        }
        Some(((mark >> self.app_shift) & Self::field_mask(self.app_bits)) as u16)
    }
}

/// Read the layout qfappd published in its catalog, falling back to `DEFAULT`
/// when it's missing, unreadable, or fails validation. Never fails: per-app
/// attribution is a nice-to-have on top of byte accounting, and must not stop
/// qfdevd from starting.
pub fn load_layout(path: &Path) -> MarkLayout {
    let Ok(text) = std::fs::read_to_string(path) else {
        tracing::debug!("no App Control catalog at {}; per-app usage uses the default mark layout", path.display());
        return DEFAULT;
    };
    #[derive(Deserialize)]
    struct CatalogHead {
        mark_layout: Option<MarkLayout>,
    }
    match serde_json::from_str::<CatalogHead>(&text) {
        Ok(CatalogHead { mark_layout: Some(l) }) if l.validate() => {
            tracing::info!("using App Control ct-mark layout from {}", path.display());
            l
        }
        Ok(CatalogHead { mark_layout: Some(_) }) => {
            tracing::warn!(
                "App Control published an invalid ct-mark layout in {}; \
                 falling back to the default layout for per-app usage",
                path.display()
            );
            DEFAULT
        }
        Ok(_) => DEFAULT, // catalog from an older qfappd that doesn't publish it
        Err(e) => {
            tracing::warn!("could not parse {} ({e}); using the default ct-mark layout", path.display());
            DEFAULT
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a mark the way qfappd would, under the default layout.
    fn mark(classified: bool, app_id: u16) -> u32 {
        let mut m = u32::from(app_id) << DEFAULT.app_shift;
        if classified {
            m |= 1 << DEFAULT.classified_bit;
        }
        m
    }

    #[test]
    fn default_layout_is_valid() {
        assert!(DEFAULT.validate());
    }

    #[test]
    fn decodes_app_id_from_a_classified_mark() {
        assert_eq!(DEFAULT.app_id(mark(true, 91)), Some(91));
        assert_eq!(DEFAULT.app_id(mark(true, 244)), Some(244));
        // 11 bits, so the largest id the field can hold round-trips.
        assert_eq!(DEFAULT.app_id(mark(true, 2047)), Some(2047));
    }

    #[test]
    fn unclassified_flow_has_no_app() {
        assert_eq!(DEFAULT.app_id(mark(false, 91)), None);
        assert_eq!(DEFAULT.app_id(0), None);
    }

    #[test]
    fn classified_unknown_protocol_is_app_zero_not_none() {
        // Distinct from "no verdict": qfappd looked and found nothing known.
        assert_eq!(DEFAULT.app_id(mark(true, 0)), Some(0));
    }

    #[test]
    fn foreign_bits_do_not_leak_into_the_app_id() {
        // Bits 15-0 belong to other QuartzFire subsystems, and BLOCK/ACTION sit
        // between APP_ID and them.
        let m = mark(true, 91) | 0xFFFF | (1 << DEFAULT.block_bit) | (0b111 << DEFAULT.action_shift);
        assert_eq!(DEFAULT.app_id(m), Some(91));
    }

    #[test]
    fn overlapping_layout_is_rejected() {
        let bad = MarkLayout { app_shift: 30, ..DEFAULT }; // collides with block_bit
        assert!(!bad.validate());
    }

    #[test]
    fn field_running_off_the_end_is_rejected() {
        assert!(!MarkLayout { app_shift: 30, app_bits: 11, ..DEFAULT }.validate());
        assert!(!MarkLayout { app_bits: 0, ..DEFAULT }.validate());
    }

    #[test]
    fn missing_catalog_falls_back_to_default() {
        assert_eq!(load_layout(Path::new("/nonexistent/catalog.json")), DEFAULT);
    }

    #[test]
    fn reads_a_published_layout() {
        let dir = std::env::temp_dir().join(format!("qfdevd-mark-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("catalog.json");
        // A non-default layout, to prove we actually read the file.
        std::fs::write(
            &p,
            r#"{"ndpi_version":"4.8.0","num_protocols":2,
                "mark_layout":{"classified_bit":15,"block_bit":14,
                               "app_shift":3,"app_bits":11,
                               "action_shift":0,"action_bits":3},
                "applications":[]}"#,
        )
        .unwrap();
        let l = load_layout(&p);
        assert_eq!(l.classified_bit, 15);
        assert_eq!(l.app_shift, 3);
        // And it decodes against that layout, not the default.
        assert_eq!(l.app_id((91 << 3) | (1 << 15)), Some(91));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn older_catalog_without_a_layout_falls_back() {
        let dir = std::env::temp_dir().join(format!("qfdevd-mark-old-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("catalog.json");
        std::fs::write(&p, r#"{"ndpi_version":"4.8.0","num_protocols":0,"applications":[]}"#).unwrap();
        assert_eq!(load_layout(&p), DEFAULT);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn invalid_published_layout_falls_back() {
        let dir = std::env::temp_dir().join(format!("qfdevd-mark-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("catalog.json");
        std::fs::write(
            &p,
            r#"{"ndpi_version":"x","num_protocols":0,
                "mark_layout":{"classified_bit":31,"block_bit":31,
                               "app_shift":19,"app_bits":11,
                               "action_shift":16,"action_bits":3},
                "applications":[]}"#,
        )
        .unwrap();
        assert_eq!(load_layout(&p), DEFAULT);
        std::fs::remove_dir_all(&dir).ok();
    }
}
