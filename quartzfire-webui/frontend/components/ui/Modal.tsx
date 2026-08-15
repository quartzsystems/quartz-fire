"use client";

import { useEffect } from "react";
import { Icon } from "@/components/ui/Icon";

/// Clarity modal. Clicking the backdrop or pressing Escape closes it.
/// Children render inside the padded dialog body; compose with ModalHeader
/// and (optionally) ModalFooter.
export function ModalShell({
  onClose,
  maxWidth = 520,
  children,
}: {
  onClose: () => void;
  maxWidth?: number;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal" onClick={onClose}>
        <div className="modal-dialog" style={{ width: maxWidth }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-content">
            {/* Composed anatomy: header/footer render inside one scrolling body,
                with paddings matching the DS .modal-header/.modal-body/.modal-footer
                stack (top 20, sides 24, 16 under the title, 20 at the bottom). */}
            <div className="modal-body" style={{ padding: "20px 24px" }}>
              {children}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function ModalHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  /** One-line context under the title; pass a mono span for technical values. */
  subtitle?: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between mb-4">
      <div>
        <h3 className="modal-title">{title}</h3>
        {subtitle && (
          <p className="clr-secondary" style={{ marginTop: 3 }}>
            {subtitle}
          </p>
        )}
      </div>
      <button type="button" className="close" aria-label="Close" onClick={onClose}>
        <Icon shape="times" size={18} />
      </button>
    </div>
  );
}

/// Right-aligned action row for the bottom of a modal (primary action last).
/// DS .modal-footer anatomy, minus its side padding (the body already pads).
export function ModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="modal-footer" style={{ padding: 0, marginTop: 16 }}>
      {children}
    </div>
  );
}
