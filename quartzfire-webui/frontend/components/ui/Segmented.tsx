"use client";

interface SegmentedItem {
  value: string;
  label: string;
}

/// Exclusive choice presented as a Clarity button group (outline buttons, the
/// active segment filled). Used in toolbars (All / Allowed / Blocked) and in
/// form modals for 2–4-way choices (Allow / Deny / Reject).
export function Segmented({
  items,
  value,
  onChange,
}: {
  items: SegmentedItem[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="btn-group">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          className={`btn btn-sm${value === it.value ? " active" : ""}`}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
