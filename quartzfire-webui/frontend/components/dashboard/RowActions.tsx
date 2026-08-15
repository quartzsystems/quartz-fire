"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";

/// Per-row edit/delete for the config tables (Clarity pencil + trash icon
/// buttons). Delete confirms through the shared danger modal.
export function RowActions({
  label,
  onEdit,
  onDelete,
}: {
  /** Accessible name of the row, e.g. `alias LAN-NET` or `rule 20`. */
  label: string;
  onEdit: () => void;
  /** Omit for edit-only rows — no delete button is rendered. */
  onDelete?: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  return (
    <div className="inline-flex items-center gap-1 justify-end">
      <button
        type="button"
        title={`Edit ${label}`}
        aria-label="Edit"
        onClick={onEdit}
        className="btn btn-sm btn-link-neutral btn-icon"
      >
        <Icon shape="pencil" size={14} />
      </button>
      {onDelete && (
        <button
          type="button"
          title={`Delete ${label}`}
          aria-label="Delete"
          onClick={() => setConfirming(true)}
          className="btn btn-sm btn-link-neutral btn-icon"
        >
          <Icon shape="trash" size={14} />
        </button>
      )}

      {confirming && onDelete && (
        <ModalShell onClose={() => setConfirming(false)} maxWidth={420}>
          <ModalHeader title="Confirm Delete" onClose={() => setConfirming(false)} />
          <p style={{ fontSize: 14, color: "var(--cds-alias-typography-color-400)" }}>
            Delete {label}? This applies to the running configuration immediately.
          </p>
          <ModalFooter>
            <button type="button" className="btn btn-neutral" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={working}
              onClick={async () => {
                setWorking(true);
                try {
                  await onDelete?.();
                } finally {
                  setWorking(false);
                  setConfirming(false);
                }
              }}
            >
              {working ? "Deleting…" : "Delete"}
            </button>
          </ModalFooter>
        </ModalShell>
      )}
    </div>
  );
}
