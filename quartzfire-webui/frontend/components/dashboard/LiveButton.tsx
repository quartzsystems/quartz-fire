"use client";

import { Icon } from "@/components/ui/Icon";

/// "Live" toggle used by polling tiles to freeze their data for inspection.
/// Clarity: a small primary button while live, neutral while paused.
export function LiveButton({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`btn btn-sm ${paused ? "btn-neutral" : "btn-primary"}`}
      title={paused ? "Resume live updates" : "Pause"}
    >
      <Icon shape={paused ? "pause" : "sync"} size={12} />
      {paused ? "Paused" : "Live"}
    </button>
  );
}
