"use client";

import { useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/Icon";
import { BootSaveState, getBootSaveState, retryBootSave, subscribeBootSave } from "@/lib/bootSave";

/// Global pill showing the state of the background boot-config save (commits
/// apply immediately; persistence runs behind the scenes — see lib/bootSave).
/// Hidden when idle; bottom-left so it never covers the toast (bottom-right).
export function SaveIndicator() {
  const state = useSyncExternalStore<BootSaveState>(
    subscribeBootSave,
    getBootSaveState,
    getBootSaveState,
  );

  if (state.status === "idle") return null;

  const base: React.CSSProperties = {
    position: "fixed",
    bottom: 18,
    left: 18,
    zIndex: 1060,
    background: "var(--cds-alias-object-overlay-background)",
    border: "1px solid var(--cds-alias-object-border-color-shade)",
    borderRadius: "var(--clr-base-border-radius-m)",
    padding: "10px 14px",
    boxShadow: "var(--cds-alias-object-shadow-200)",
    fontSize: 13,
    color: "var(--cds-alias-typography-color-450)",
  };

  if (state.status === "saving") {
    return (
      <div
        style={{ ...base, borderLeft: "3px solid var(--cds-alias-interaction-action)" }}
        className="flex items-center gap-2"
      >
        <span className="spinner spinner-sm" />
        Saving to boot config…
      </div>
    );
  }

  return (
    <div
      style={{ ...base, borderLeft: "3px solid var(--cds-alias-status-danger)" }}
      className="flex items-center gap-2"
    >
      <Icon shape="exclamation-triangle" size={14} style={{ color: "var(--cds-alias-status-danger)" }} />
      <span>{state.message}</span>
      <button type="button" className="btn btn-sm btn-neutral" style={{ marginLeft: 8 }} onClick={retryBootSave}>
        Retry
      </button>
    </div>
  );
}
