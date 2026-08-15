"use client";

/// Clarity toggle. Kept as a bare control (no label) — callers lay out their
/// own label text, matching the previous Switch API.
export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="clr-toggle-wrapper">
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
    </span>
  );
}
