"use client";

/// "Live" toggle used by polling tiles to freeze their data for inspection.
/// DC anatomy: a small primary button while live, plain outline while paused,
/// text only ("Live" / "Paused").
export function LiveButton({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`btn btn-sm${paused ? "" : " btn-primary"}`}
      title={paused ? "Resume live updates" : "Pause"}
    >
      {paused ? "Paused" : "Live"}
    </button>
  );
}
