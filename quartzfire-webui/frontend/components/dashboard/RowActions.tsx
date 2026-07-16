"use client";

import { useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";

/// Per-row edit/delete for the config tables. Delete asks for inline
/// confirmation before applying.
export function RowActions({
  label,
  onEdit,
  onDelete,
}: {
  /** Accessible name of the row, e.g. `alias LAN-NET` or `rule 20`. */
  label: string;
  onEdit: () => void;
  onDelete: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  return (
    <div className="inline-flex items-center gap-1 justify-end">
      {confirming ? (
        <>
          <button
            type="button"
            title="Confirm delete"
            aria-label="Confirm delete"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              try {
                await onDelete();
              } finally {
                setWorking(false);
                setConfirming(false);
              }
            }}
            className="grid place-items-center w-7 h-7 rounded-md border-0 cursor-pointer disabled:opacity-60"
            style={{ background: "var(--qz-danger)", color: "white" }}
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            title="Cancel"
            aria-label="Cancel"
            onClick={() => setConfirming(false)}
            className="grid place-items-center w-7 h-7 rounded-md cursor-pointer text-[var(--qz-fg-3)] hover:text-[var(--qz-fg-1)]"
            style={{ background: "transparent", border: "1px solid var(--qz-border)" }}
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            title={`Edit ${label}`}
            aria-label="Edit"
            onClick={onEdit}
            className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-accent)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            title={`Delete ${label}`}
            aria-label="Delete"
            onClick={() => setConfirming(true)}
            className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
          >
            <Trash2 size={14} />
          </button>
        </>
      )}
    </div>
  );
}
