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
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between mb-5">
      <div>
        <h3 className="clr-section" style={{ color: "var(--cds-alias-typography-color-450)" }}>
          {title}
        </h3>
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
export function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2 mt-6">{children}</div>;
}
