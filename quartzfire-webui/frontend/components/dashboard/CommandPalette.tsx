"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { NAV_SECTIONS } from "@/components/clarity/nav-model";

interface PaletteAction {
  id: string;
  section: string;
  label: string;
  kbd: string;
  href?: string;
}

// "Go to" actions derived from the shell's navigation model: every top-level
// section (with its G-key hint) followed by each of its child pages.
const ACTIONS: PaletteAction[] = NAV_SECTIONS.flatMap((s) => {
  const entries: PaletteAction[] = [
    { id: `nav-${s.id}`, section: "Go to", label: s.label, kbd: s.kbd ?? "", href: s.href },
  ];
  for (const p of s.children ?? []) {
    if (p.href === s.href) continue; // section row already points there
    entries.push({
      id: `nav-${p.id}`,
      section: "Go to",
      label: `${s.label} › ${p.label}`,
      kbd: "",
      href: p.href,
    });
  }
  return entries;
});

export function CommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else setQ("");
  }, [open]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  if (!open) return null;

  const filtered = ACTIONS.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));

  const grouped = filtered.reduce<Record<string, PaletteAction[]>>((acc, a) => {
    (acc[a.section] = acc[a.section] || []).push(a);
    return acc;
  }, {});

  return (
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div
          className="flex items-center gap-[10px]"
          style={{ padding: "14px 18px", borderBottom: "1px solid var(--cds-alias-object-border-subtle)" }}
        >
          <Icon shape="search" size={16} style={{ color: "var(--cds-alias-typography-color-300)" }} />
          <input
            ref={inputRef}
            placeholder="Jump to a section…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="flex-1 bg-transparent border-0 outline-none"
            style={{ color: "var(--cds-alias-typography-color-450)", fontSize: 14 }}
          />
          <span
            style={{
              fontFamily: "var(--qz-font-mono)",
              fontSize: 10,
              color: "var(--cds-alias-typography-color-200)",
            }}
          >
            esc
          </span>
        </div>

        <div className="p-2 max-h-[50vh] overflow-auto">
          {Object.entries(grouped).map(([section, items]) => (
            <div key={section}>
              <div
                className="clr-smallcaption"
                style={{
                  fontFamily: "var(--qz-font-mono)",
                  padding: "8px 10px 2px",
                }}
              >
                {section}
              </div>
              {items.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="dropdown-item"
                  style={{ height: 34 }}
                  onClick={() => {
                    if (a.href) onNavigate(a.href);
                    onClose();
                  }}
                >
                  <Icon
                    shape="arrow"
                    dir="right"
                    size={14}
                    style={{ color: "var(--cds-alias-typography-color-200)" }}
                  />
                  <span className="flex-1 text-left">{a.label}</span>
                  {a.kbd && (
                    <span
                      style={{
                        fontFamily: "var(--qz-font-mono)",
                        fontSize: 10,
                        color: "var(--cds-alias-typography-color-200)",
                        border: "1px solid var(--cds-alias-object-border-color)",
                        borderRadius: 3,
                        padding: "1px 5px",
                      }}
                    >
                      {a.kbd}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="p-5" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-300)" }}>
              No matches.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
