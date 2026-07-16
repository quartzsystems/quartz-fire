"use client";

// Column show/hide control for the hand-rolled tables that don't use DataTable
// (the live log/monitor panes, whose streaming + custom toolbars make the full
// DataTable a poor fit). Same dropdown look as DataTable's Columns menu, plus a
// small hook that owns visibility state and persists it per table.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Columns3, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";

export interface ColumnSpec {
  key: string;
  /** Menu label. */
  header: string;
  /** Hidden by default until the user opts in. */
  defaultHidden?: boolean;
}

export interface ColumnVisibility {
  /** Is this column currently shown? */
  isVisible: (key: string) => boolean;
  /** Toggle one column (never hides the last remaining one). */
  toggle: (key: string) => void;
  /** Restore every column to its default visibility. */
  reset: () => void;
  /** Ordered [key, shown] for rendering the menu. */
  columns: ColumnSpec[];
  /** How many columns are currently shown. */
  visibleCount: number;
}

/// Visibility state for a fixed column set, persisted under `qz-cols:<storageKey>`.
export function useColumnVisibility(storageKey: string, columns: ColumnSpec[]): ColumnVisibility {
  const persistKey = `qz-cols:${storageKey}`;
  const defaultHidden = useMemo(
    () => columns.filter((c) => c.defaultHidden).map((c) => c.key),
    [columns],
  );

  const initial = useMemo<string[]>(() => {
    if (typeof window === "undefined") return defaultHidden;
    try {
      const raw = window.localStorage.getItem(persistKey);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        // Drop stale keys from older layouts so a removed column can't linger hidden.
        const known = new Set(columns.map((c) => c.key));
        return parsed.filter((k) => known.has(k));
      }
    } catch {
      /* ignore corrupt/absent storage */
    }
    return defaultHidden;
  }, [persistKey, columns, defaultHidden]);

  const [hidden, setHidden] = useState<Set<string>>(() => new Set(initial));

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(persistKey, JSON.stringify([...hidden]));
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [persistKey, hidden]);

  const visibleCount = columns.length - columns.filter((c) => hidden.has(c.key)).length;

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (visibleCount > 1) next.add(key); // keep at least one column
      return next;
    });

  return {
    isVisible: (key) => !hidden.has(key),
    toggle,
    reset: () => setHidden(new Set(defaultHidden)),
    columns,
    visibleCount,
  };
}

/// The dropdown button + checklist. Drop it into a table's toolbar.
export function ColumnsMenu({ vis }: { vis: ColumnVisibility }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button kind="secondary" size="sm" icon={Columns3} onClick={() => setOpen((o) => !o)}>
        Columns
      </Button>
      {open && (
        <div
          className="absolute right-0 mt-1 z-20 rounded-md py-1 min-w-[200px]"
          style={{
            background: "var(--qz-surface)",
            border: "1px solid var(--qz-border)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          <div className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--qz-fg-4)]">
            Show columns
          </div>
          {vis.columns.map((c) => {
            const visible = vis.isVisible(c.key);
            const lastVisible = visible && vis.visibleCount === 1;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => vis.toggle(c.key)}
                disabled={lastVisible}
                className="flex items-center gap-2 w-full px-3 py-[6px] text-[13px] text-left bg-transparent border-0 text-[var(--qz-fg-2)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span
                  className="grid place-items-center w-[15px] h-[15px] rounded-[4px] flex-shrink-0"
                  style={{
                    border: "1px solid var(--qz-border-strong)",
                    background: visible ? "var(--qz-accent)" : "var(--qz-input-bg)",
                  }}
                >
                  {visible && <Check size={11} style={{ color: "var(--qz-fg-on-accent)" }} />}
                </span>
                {c.header}
              </button>
            );
          })}
          <div className="my-1 mx-3 border-t" style={{ borderColor: "var(--qz-divider)" }} />
          <button
            type="button"
            onClick={() => {
              vis.reset();
              setOpen(false);
            }}
            className="flex items-center gap-2 w-full px-3 py-[6px] text-[13px] text-left bg-transparent border-0 text-[var(--qz-fg-3)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] hover:text-[var(--qz-fg-1)] transition-colors cursor-pointer"
          >
            <RotateCcw size={13} /> Reset layout
          </button>
        </div>
      )}
    </div>
  );
}
