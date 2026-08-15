"use client";

import { useEffect } from "react";

/// Bottom-right notification pill (Clarity overlay surface, success left
/// border). Auto-dismisses; Dismiss closes it early.
export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3800);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="toast">
      <span style={{ flex: 1 }}>{message}</span>
      <button type="button" className="btn btn-sm btn-link-neutral" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
