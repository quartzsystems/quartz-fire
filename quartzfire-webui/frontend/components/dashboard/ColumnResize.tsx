"use client";

// Draggable column widths for the hand-rolled qz-tables that don't use
// DataTable (log/monitor panes, feature policy tables). Same model as
// DataTable's built-in resize: dragging a header boundary transfers width
// between the two adjacent columns so the table never overflows. The table
// keeps its natural layout until the first drag (or until saved widths
// exist), at which point every column is measured and the table switches to
// fixed layout. Widths persist per table under `qz-colw:<storageKey>`.
//
// Wiring:
//   const resize = useColumnResize("my-table", cols.map((c) => ({ key: c.key, width: c.width })));
//   <table ref={resize.tableRef} className="qz-table"
//          style={{ width: "100%", tableLayout: resize.tableLayout }}>
//     <colgroup>{cols.map((c) => <col key={c.key} style={{ width: resize.colWidth(c.key) }} />)}</colgroup>
//     ... <th {...resize.thProps(i)}>{c.header}{resize.handle(i)}</th> ...
//
// Fixed-width extra columns (checkbox / actions) are not managed: give their
// <col>/<th> an explicit width and leave them out of the columns array.

import { useEffect, useMemo, useRef, useState } from "react";

const MIN_COL = 60;
const FALLBACK_COL = 120;

export interface ResizableColumn {
  key: string;
  /** Default width (px) used until the user resizes. */
  width?: number;
  /** Smallest width (px) the column may be resized to. Defaults to 60. */
  minWidth?: number;
}

export function useColumnResize(
  storageKey: string,
  columns: ResizableColumn[],
  opts?: {
    /** Table already uses tableLayout: fixed — keep it fixed before any resize. */
    fixed?: boolean;
  },
) {
  const persistKey = `qz-colw:${storageKey}`;

  // Stored widths are only usable if they cover every column present at mount;
  // a column added since they were saved would fall back to its default width
  // and overflow the fixed layout.
  const stored = useMemo<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(persistKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, number>;
      return columns.every((c) => typeof parsed[c.key] === "number") ? parsed : {};
    } catch {
      return {};
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- validate against the mount-time column set only
  }, [persistKey]);

  const [widths, setWidths] = useState<Record<string, number>>(stored);
  const [seeded, setSeeded] = useState(Object.keys(stored).length > 0);
  const tableRef = useRef<HTMLTableElement>(null);

  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);

  useEffect(() => {
    if (!seeded || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(persistKey, JSON.stringify(widths));
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [persistKey, widths, seeded]);

  // Before seeding, columns render at their declared (or natural) width; a
  // column shown after seeding (e.g. via a Columns menu) has no stored width.
  const colWidth = (key: string) =>
    widths[key] ?? byKey.get(key)?.width ?? (seeded ? FALLBACK_COL : undefined);

  // ── drag (transfers width to the right-hand neighbour) ────────────────────────
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<{
    leftKey: string;
    rightKey: string;
    startX: number;
    startLeft: number;
    startRight: number;
    leftMin: number;
    rightMin: number;
  } | null>(null);

  const onResizeDown = (e: React.MouseEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const left = columns[index];
    const right = columns[index + 1];
    if (!left || !right) return;
    const table = tableRef.current;
    if (!table) return;

    // First drag: lock every managed column at its rendered width so the
    // switch to fixed layout doesn't move anything.
    const measured: Record<string, number> = {};
    table.querySelectorAll<HTMLElement>("thead th[data-col-key]").forEach((th) => {
      measured[th.dataset.colKey!] = Math.round(th.getBoundingClientRect().width);
    });
    const start = { ...measured, ...widths };
    if (!seeded) {
      setWidths(start);
      setSeeded(true);
    }

    resizeRef.current = {
      leftKey: left.key,
      rightKey: right.key,
      startX: e.clientX,
      startLeft: start[left.key] ?? FALLBACK_COL,
      startRight: start[right.key] ?? FALLBACK_COL,
      leftMin: left.minWidth ?? MIN_COL,
      rightMin: right.minWidth ?? MIN_COL,
    };
    setResizing(true);
  };

  useEffect(() => {
    if (!resizing) return;
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [resizing]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      let delta = e.clientX - r.startX;
      delta = Math.max(delta, -(r.startLeft - r.leftMin));
      delta = Math.min(delta, r.startRight - r.rightMin);
      setWidths((w) => ({ ...w, [r.leftKey]: r.startLeft + delta, [r.rightKey]: r.startRight - delta }));
    };
    const up = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      setResizing(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  /** Spread onto the i-th managed <th> (tags it for measurement). */
  const thProps = (index: number) => ({ "data-col-key": columns[index]?.key });

  /** Drop inside the i-th managed <th>; null on the last one (no right neighbour). */
  const handle = (index: number): React.ReactNode =>
    index < columns.length - 1 ? (
      <span
        className={
          "qz-col-resize" +
          (resizing && resizeRef.current?.leftKey === columns[index].key ? " active" : "")
        }
        onMouseDown={(e) => onResizeDown(e, index)}
        onClick={(e) => e.stopPropagation()}
        onDragStart={(e) => e.preventDefault()}
        aria-hidden
      />
    ) : null;

  return {
    tableRef,
    tableLayout: (seeded || opts?.fixed ? "fixed" : "auto") as "fixed" | "auto",
    colWidth,
    thProps,
    handle,
    resizing,
  };
}
