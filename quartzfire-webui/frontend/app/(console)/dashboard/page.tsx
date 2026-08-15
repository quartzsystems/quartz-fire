"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { DashboardGrid, TileInstance, findFreeCell, packTiles } from "@/components/dashboard/DashboardGrid";
import { TILE_REGISTRY, TILE_TYPES } from "@/components/dashboard/tiles";
import { apiFetch } from "@/lib/api";

// The layout is persisted server-side (per VyOS user) so it survives clearing
// browser site data or switching browsers. localStorage is kept only as an
// instant-paint cache for the current browser; the server is the source of
// truth and is reconciled on mount.
const STORAGE_KEY = "qz-dashboard";
const LAYOUT_PATH = "/dashboard/layout";

// Default layout straight from the DC reference (12-col grid):
// System Information 4 · Network Usage 8 / Interface Statistics 4 ·
// Top Applications 4 · IPS Alerts 4 / Top Blocked Countries 6 · map 6.
const DEFAULT_TILES: TileInstance[] = [
  { id: "system-info-1", type: "system-info", x: 0, y: 0, w: 4, h: 6 },
  { id: "network-speed-1", type: "network-speed", x: 4, y: 0, w: 8, h: 6 },
  { id: "interface-stats-1", type: "interface-stats", x: 0, y: 6, w: 4, h: 5 },
  { id: "top-applications-1", type: "top-applications", x: 4, y: 6, w: 4, h: 5 },
  { id: "ips-alerts-1", type: "ips-alerts", x: 8, y: 6, w: 4, h: 5 },
  { id: "top-blocked-countries-1", type: "top-blocked-countries", x: 0, y: 11, w: 6, h: 5 },
  { id: "geolocation-map-1", type: "geolocation-map", x: 6, y: 11, w: 6, h: 5 },
];

let idCounter = 0;
const newId = (type: string) => `${type}-${Date.now().toString(36)}-${idCounter++}`;

/// Drop tiles whose type no longer exists and migrate older order-based layouts
/// (no x/y) to explicit coordinates. Layouts saved on the old 4-column grid
/// (every tile within columns 0–4) are scaled ×3 onto the 12-column grid.
/// Returns null when nothing usable remains.
function normalize(raw: unknown): TileInstance[] | null {
  if (!Array.isArray(raw)) return null;
  let valid = (raw as TileInstance[]).filter((t) => t && TILE_REGISTRY[t.type]);
  if (!valid.length) return null;
  const placed = valid.filter((t) => t.x != null && t.w != null);
  if (placed.length && placed.every((t) => (t.x ?? 0) + (t.w ?? 1) <= 4)) {
    valid = valid.map((t) =>
      t.x == null ? t : { ...t, x: t.x * 3, w: Math.max(1, (t.w ?? 1) * 3) },
    );
  }
  const needsPack = valid.some((t) => t.x == null || t.y == null);
  return needsPack ? packTiles(valid) : valid;
}

function readLocal(): TileInstance[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    return null;
  }
}

export default function DashboardPage() {
  // Seed from the local cache for an instant first paint (no default-layout
  // flash), then reconcile with the server in the effect below.
  const [tiles, setTiles] = useState<TileInstance[]>(
    () => (typeof window === "undefined" ? DEFAULT_TILES : readLocal() ?? DEFAULT_TILES),
  );
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Load the durable layout from the server. If the server has none saved yet,
  // migrate any existing local layout up so it persists from here on.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let server: TileInstance[] | null;
      try {
        server = normalize(await apiFetch<unknown>(LAYOUT_PATH));
      } catch {
        return; // server unreachable / older build — keep the local-cache layout
      }
      if (cancelled) return;
      if (server) {
        setTiles(server);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(server));
        } catch {}
        return;
      }
      // Nothing server-side yet: one-time migration of a local layout. A user
      // who never customized keeps following the evolving default, so don't
      // persist the default itself.
      const local = readLocal();
      if (local) {
        setTiles(local);
        void apiFetch(LAYOUT_PATH, { method: "PUT", body: JSON.stringify(local) }).catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: TileInstance[]) => {
    setTiles(next);
    // Cache locally for instant paint, and persist to the server as the durable
    // source of truth (best-effort — a failed save keeps the in-memory layout).
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — keep in-memory layout */
    }
    void apiFetch(LAYOUT_PATH, { method: "PUT", body: JSON.stringify(next) }).catch(() => {});
  }, []);

  const addTile = (type: string) => {
    const def = TILE_REGISTRY[type];
    if (!def) return;
    const { x, y } = findFreeCell(tiles, def.defaultW, def.defaultH);
    update([...tiles, { id: newId(type), type, x, y, w: def.defaultW, h: def.defaultH }]);
    setPickerOpen(false);
  };

  const removeTile = (id: string) => update(tiles.filter((t) => t.id !== id));

  // Close the picker on an outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  return (
    <div>
      <div className="flex items-start gap-2 mb-4">
        <div className="mr-auto">
          <h2 className="m-0">Dashboard</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            What this firewall is passing, blocking, and running — right now.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {editing && (
            <div className="clr-dropdown" ref={pickerRef}>
              <button type="button" className="btn" onClick={() => setPickerOpen((o) => !o)}>
                Add Component
              </button>
              {pickerOpen && (
                <div className="dropdown-menu right" style={{ minWidth: 240 }}>
                  {TILE_TYPES.map((def) => {
                    const added = tiles.some((t) => t.type === def.type);
                    return (
                      <button
                        key={def.type}
                        type="button"
                        className="dropdown-item"
                        disabled={added}
                        onClick={() => addTile(def.type)}
                      >
                        {def.title}
                        {added && (
                          <span
                            className="ml-auto text-[11px]"
                            style={{ color: "var(--cds-alias-typography-color-200)" }}
                          >
                            Added
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className={`btn${editing ? " btn-primary" : ""}`}
            onClick={() => {
              setEditing((e) => !e);
              setPickerOpen(false);
            }}
          >
            {editing ? "Done" : "Edit Dashboard"}
          </button>
        </div>
      </div>

      {editing && (
        <div className="alert alert-info alert-sm mb-4">
          <Icon shape="info-circle" size={14} className="alert-icon" />
          <span className="alert-text">
            Edit mode — drag a tile to any cell, resize from its corner, or remove it with ×. The
            layout is saved per user on the firewall itself.
          </span>
        </div>
      )}

      {tiles.length === 0 ? (
        <div className="text-[13px] text-[var(--cds-alias-typography-color-200)] py-10 text-center">
          No components. Click <span className="text-[var(--cds-alias-typography-color-400)]">Edit Dashboard</span> to add some.
        </div>
      ) : (
        <DashboardGrid tiles={tiles} editing={editing} onChange={update} onRemove={removeTile} />
      )}
    </div>
  );
}
