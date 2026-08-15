"use client";

import type React from "react";

export interface TabItem {
  value: string;
  label: string;
  /** Optional trailing count, rendered NAT44-style next to the label. */
  count?: number;
}

/// Clarity tab bar (clr-tabs-list) — the page-level navigation used across the
/// console (NAT44, Intrusion Prevention, Application Control, Geolocation…).
/// `trailing` renders at the right edge of the bar (e.g. an enforcing/health
/// pill) without breaking the full-width underline.
export function Tabs({
  items,
  value,
  onChange,
  trailing,
  className = "",
}: {
  items: TabItem[];
  value: string;
  onChange: (v: string) => void;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`clr-tabs-list ${className}`.trim()} style={{ alignItems: "center" }}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          className="clr-tab-link"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
        >
          {it.label}
          {it.count !== undefined && (
            <span
              style={{
                fontFamily: "var(--qz-font-mono)",
                fontSize: 11,
                color: "var(--cds-alias-typography-color-200)",
              }}
            >
              {it.count}
            </span>
          )}
        </button>
      ))}
      {trailing !== undefined && (
        <div className="ml-auto flex items-center gap-2" style={{ paddingBottom: 2 }}>
          {trailing}
        </div>
      )}
    </div>
  );
}
