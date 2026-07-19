"use client";

// Monitoring → Logs — one unified, time-sorted pane over every traffic/security
// event surface on the box:
//
//   * Firewall traffic  (SSE /api/monitor/firewall-log)
//   * Content Filtering (poll /content-filtering/logs — no stream)
//   * IPS alerts        (SSE /api/ips/alerts)
//   * App Control       (SSE /api/appcontrol/alerts)
//   * Geolocation       (SSE /api/geolocation/alerts)
//
// Each source keeps its native transport; everything is normalized to a
// UnifiedEvent (lib/unified-logs) and merged into one buffer, newest first,
// deduped by key across reconnect backfills and CF polls. This is the place to
// see SSL-intercepted HTTPS (via Content Filtering) alongside the firewall view
// it no longer appears in.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eraser, Pause, Play, RotateCw, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ColumnsMenu, useColumnVisibility } from "@/components/dashboard/ColumnsMenu";
import { useColumnResize } from "@/components/dashboard/ColumnResize";
import { Segmented } from "@/components/ui/Segmented";
import { emptyFirewallConfig, fetchFirewall, FirewallConfig } from "@/lib/firewall";
import { fetchCfLogs } from "@/lib/content-filtering";
import { fetchIpsAlertHistory } from "@/lib/ips";
import { fetchAcAlertHistory } from "@/lib/appcontrol";
import { fetchGeoAlertHistory } from "@/lib/geolocation";
import {
  FirewallLogEntry,
  normalizeAc,
  normalizeCf,
  normalizeFirewall,
  normalizeGeo,
  normalizeIps,
  SOURCE_META,
  UnifiedAction,
  UnifiedEvent,
  UnifiedSource,
} from "@/lib/unified-logs";
import type { IpsAlert } from "@/lib/ips";
import type { AcEvent } from "@/lib/appcontrol";
import type { GeoEvent } from "@/lib/geolocation";

const MAX_ROWS = 1000;
const CF_POLL_MS = 5000;
const FLUSH_MS = 90;
const ALL_SOURCES: UnifiedSource[] = ["firewall", "content-filtering", "ips", "appcontrol", "geo"];

const dash = <span className="text-[var(--qz-fg-4)]">—</span>;

function SourcePill({ source }: { source: UnifiedSource }) {
  const m = SOURCE_META[source];
  return <span className={`badge ${m.badge}`}>{m.label}</span>;
}

function ActionPill({ action }: { action: UnifiedAction }) {
  if (action === "allowed") return <span className="badge badge-ok">Allowed</span>;
  if (action === "blocked") return <span className="badge badge-crit">Blocked</span>;
  return <span className="badge badge-warn">Alert</span>;
}

const time = (ts: number) =>
  ts ? new Date(ts).toLocaleTimeString(undefined, { hour12: false }) : "—";

// Column definitions for the (hand-rolled, streaming) table. Interfaces get
// their own In-If / Out-If columns so the row reads as a flow: arrived on In-If
// from src → left on Out-If to dst. Every column is toggleable via ColumnsMenu.
interface LogCol {
  key: string;
  header: string;
  width?: number;
  className?: string;
  ellipsis?: boolean;
  cell: (r: UnifiedEvent) => React.ReactNode;
  title?: (r: UnifiedEvent) => string | undefined;
}

const LOG_COLUMNS: LogCol[] = [
  { key: "time", header: "Time", width: 90, className: "mono text-[var(--qz-fg-3)]", cell: (r) => time(r.ts) },
  { key: "source", header: "Source", width: 84, cell: (r) => <SourcePill source={r.source} /> },
  { key: "action", header: "Action", width: 88, cell: (r) => <ActionPill action={r.action} /> },
  { key: "event", header: "Event", ellipsis: true, cell: (r) => r.summary, title: (r) => r.summary },
  { key: "ifin", header: "In If", width: 96, className: "mono text-[12px]", ellipsis: true, cell: (r) => r.ifIn ?? dash, title: (r) => r.ifIn },
  { key: "src", header: "From", width: 128, className: "mono text-[12px]", ellipsis: true, cell: (r) => r.src ?? dash },
  { key: "spt", header: "Src Port", width: 62, className: "mono text-[12px]", cell: (r) => (r.spt != null ? r.spt : dash) },
  { key: "ifout", header: "Out If", width: 96, className: "mono text-[12px]", ellipsis: true, cell: (r) => r.ifOut ?? dash, title: (r) => r.ifOut },
  { key: "dst", header: "To", width: 128, className: "mono text-[12px]", ellipsis: true, cell: (r) => r.dst ?? dash },
  { key: "dpt", header: "Dst Port", width: 62, className: "mono text-[12px]", cell: (r) => (r.dpt != null ? r.dpt : dash) },
  { key: "proto", header: "Proto", width: 56, className: "mono text-[12px]", cell: (r) => r.proto ?? "—" },
  { key: "detail", header: "Detail", width: 170, className: "text-[12px] text-[var(--qz-fg-3)]", ellipsis: true, cell: (r) => r.detail ?? dash, title: (r) => r.detail ?? "" },
];

export default function UnifiedLogsPage() {
  // ── firewall config (for rule names) ────────────────────────────────────────
  const [config, setConfig] = useState<FirewallConfig>(emptyFirewallConfig);
  const ruleNamesRef = useRef<Map<string, string | null>>(new Map());

  const loadConfig = useCallback(async () => {
    try {
      const fw = await fetchFirewall();
      setConfig(fw);
      ruleNamesRef.current = new Map(fw.rules.map((r) => [`${r.chain}:${r.rule}`, r.name]));
      // Re-resolve firewall rule labels for rows already in the buffer. A row's
      // summary is frozen when its SSE frame arrives (normalizeFirewall), so a
      // line backfilled before this map loaded — or before a renumber — is
      // captioned "Rule N" and would stay that way. Rebuild those summaries from
      // the fresh map so the correct rule name (e.g. "Allow Any-Internal to WAN"
      // rather than "Rule 20") appears once it's known and after every refresh.
      let changed = false;
      for (const r of rowsRef.current) {
        if (!r.fwRuleKey) continue;
        const rule = Number(r.fwRuleKey.slice(r.fwRuleKey.indexOf(":") + 1));
        const next = ruleNamesRef.current.get(r.fwRuleKey) ?? `Rule ${rule}`;
        if (next !== r.summary) {
          r.summary = next;
          changed = true;
        }
      }
      // A new array reference re-renders the table; while paused, the eventual
      // resume flush emits the corrected set, so skip the mid-pause churn.
      if (changed && !pausedRef.current) setRows([...rowsRef.current]);
    } catch {
      /* rule names degrade to "Rule N"; the streams still work */
    }
  }, []);

  useEffect(() => {
    loadConfig();
    const refetch = () => !document.hidden && loadConfig();
    const t = setInterval(refetch, 30_000);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [loadConfig]);

  const ruleLabel = useCallback((chain: string, rule: number | null) => {
    if (rule === null) return "Default action";
    return ruleNamesRef.current.get(`${chain}:${rule}`) ?? `Rule ${rule}`;
  }, []);

  // ── merged buffer ───────────────────────────────────────────────────────────
  const rowsRef = useRef<UnifiedEvent[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const dirtyRef = useRef(false);
  const nextId = useRef(0);
  const pausedRef = useRef(false);
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [rows, setRows] = useState<UnifiedEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [stream, setStream] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [streamGen, setStreamGen] = useState(0);

  const flush = useCallback(() => {
    if (!dirtyRef.current || pausedRef.current) return;
    dirtyRef.current = false;
    rowsRef.current.sort((a, b) => b.ts - a.ts);
    if (rowsRef.current.length > MAX_ROWS) {
      rowsRef.current = rowsRef.current.slice(0, MAX_ROWS);
      seenRef.current = new Set(rowsRef.current.map((r) => r.key));
    }
    setRows([...rowsRef.current]);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (throttleRef.current) return;
    flush();
    throttleRef.current = setTimeout(() => {
      throttleRef.current = null;
      flush();
    }, FLUSH_MS);
  }, [flush]);

  // Add a normalized (id-less) row; dedupe on key. Returns whether it was new.
  const add = useCallback((raw: Omit<UnifiedEvent, "id">) => {
    if (seenRef.current.has(raw.key)) return;
    seenRef.current.add(raw.key);
    rowsRef.current.push({ ...raw, id: nextId.current++ });
    dirtyRef.current = true;
  }, []);

  // ── live streams (SSE) + Content Filtering poll ─────────────────────────────
  useEffect(() => {
    const firewall = new EventSource("/api/monitor/firewall-log");
    firewall.onopen = () => setStream("live");
    firewall.onerror = () => setStream("reconnecting"); // EventSource self-retries
    firewall.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as FirewallLogEntry;
        add(normalizeFirewall(e, ruleLabel(e.chain, e.rule)));
        scheduleFlush();
      } catch {
        /* tolerate a malformed frame */
      }
    };

    const mk = <T,>(url: string, norm: (e: T) => Omit<UnifiedEvent, "id">) => {
      const es = new EventSource(url);
      es.onmessage = (ev) => {
        try {
          add(norm(JSON.parse(ev.data) as T));
          scheduleFlush();
        } catch {
          /* ignore */
        }
      };
      return es;
    };
    const ips = mk<IpsAlert>("/api/ips/alerts", normalizeIps);
    const app = mk<AcEvent>("/api/appcontrol/alerts", normalizeAc);
    const geo = mk<GeoEvent>("/api/geolocation/alerts", normalizeGeo);

    let active = true;
    const pollCf = async () => {
      try {
        const entries = await fetchCfLogs({ limit: 200 });
        if (!active) return;
        for (const e of entries) add(normalizeCf(e));
        scheduleFlush();
      } catch {
        /* CF backend may be absent; skip this tick */
      }
    };
    pollCf();
    const cfTimer = setInterval(pollCf, CF_POLL_MS);

    // Backfill recent history for the alert sources. Their SSE streams only
    // carry events from now on, so a block that fired before this page opened
    // (or between reconnects) would otherwise never show — even though it is
    // recorded on each feature's own Alerts tab. Deduped by key against the
    // live streams, so overlapping events collapse to one row.
    const backfill = async () => {
      const [ips, app, geo] = await Promise.allSettled([
        fetchIpsAlertHistory(),
        fetchAcAlertHistory(),
        fetchGeoAlertHistory(),
      ]);
      if (!active) return;
      if (ips.status === "fulfilled") for (const e of ips.value) add(normalizeIps(e));
      if (app.status === "fulfilled") for (const e of app.value) add(normalizeAc(e));
      if (geo.status === "fulfilled") for (const e of geo.value) add(normalizeGeo(e));
      scheduleFlush();
    };
    backfill();

    return () => {
      active = false;
      firewall.close();
      ips.close();
      app.close();
      geo.close();
      clearInterval(cfTimer);
      if (throttleRef.current) {
        clearTimeout(throttleRef.current);
        throttleRef.current = null;
      }
    };
  }, [streamGen, add, scheduleFlush, ruleLabel]);

  const togglePause = () => {
    setPaused((p) => {
      const next = !p;
      pausedRef.current = next;
      if (!next) {
        // Resuming — sort, cap, and render everything collected while paused.
        dirtyRef.current = true;
        flush();
      }
      return next;
    });
  };

  const clear = () => {
    rowsRef.current = [];
    seenRef.current = new Set();
    dirtyRef.current = false;
    setRows([]);
  };

  const refresh = () => {
    clear();
    setStream("connecting");
    setStreamGen((g) => g + 1);
    loadConfig();
  };

  // ── filters ─────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<"all" | UnifiedAction>("all");
  const [sources, setSources] = useState<Set<UnifiedSource>>(new Set(ALL_SOURCES));

  const toggleSource = (s: UnifiedSource) =>
    setSources((prev) => {
      const next = new Set(prev);
      // Never let the last source be turned off — an empty view is just confusing.
      if (next.has(s)) {
        if (next.size > 1) next.delete(s);
      } else next.add(s);
      return next;
    });

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (!sources.has(r.source)) return false;
      if (actionFilter !== "all" && r.action !== actionFilter) return false;
      if (!q) return true;
      const hay = [
        SOURCE_META[r.source].label, r.summary, r.src, r.spt, r.dst, r.dpt, r.proto, r.ifIn, r.ifOut, r.detail, r.action,
      ]
        .filter((v) => v != null && v !== "")
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, sources, actionFilter, q]);

  const counts = useMemo(() => {
    const c = { firewall: 0, "content-filtering": 0, ips: 0, appcontrol: 0, geo: 0 } as Record<UnifiedSource, number>;
    for (const r of rows) c[r.source]++;
    return c;
  }, [rows]);

  const vis = useColumnVisibility("logs", LOG_COLUMNS);
  const cols = LOG_COLUMNS.filter((c) => vis.isVisible(c.key));
  const resize = useColumnResize("logs", cols.map((c) => ({ key: c.key, width: c.width })));

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Logs
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Every traffic and security event in one live, time-sorted pane — firewall, content filtering, and IPS / App Control / Geolocation alerts
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        <div className="flex flex-col gap-3">
          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--qz-fg-4)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter logs…"
                className="rounded-md pl-8 pr-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[240px]"
                style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "var(--qz-accent)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "var(--qz-border)")}
              />
            </div>

            <Segmented
              items={[
                { value: "all", label: "All" },
                { value: "allowed", label: "Allowed" },
                { value: "blocked", label: "Blocked" },
              ]}
              value={actionFilter}
              onChange={(v) => setActionFilter(v as typeof actionFilter)}
            />

            <div className="ml-auto flex items-center gap-3">
              <ColumnsMenu vis={vis} />
              <Button kind="secondary" size="sm" icon={RotateCw} onClick={refresh}>
                Refresh
              </Button>
              <Button kind="secondary" size="sm" icon={paused ? Play : Pause} onClick={togglePause}>
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button kind="secondary" size="sm" icon={Eraser} onClick={clear}>
                Clear
              </Button>
              <span className="inline-flex items-center gap-[6px] text-[12px] text-[var(--qz-fg-4)]">
                <span
                  className="inline-block w-[7px] h-[7px] rounded-full"
                  style={{
                    background: paused
                      ? "var(--qz-fg-4)"
                      : stream === "live"
                        ? "var(--qz-success)"
                        : "var(--qz-warn)",
                  }}
                />
                {paused ? "Paused" : stream === "live" ? "Live" : stream === "connecting" ? "Connecting…" : "Reconnecting…"}
                {" · "}
                {visible.length} {visible.length === 1 ? "entry" : "entries"}
              </span>
            </div>
          </div>

          {/* Source toggles */}
          <div className="flex items-center gap-2 flex-wrap">
            {ALL_SOURCES.map((s) => {
              const on = sources.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSource(s)}
                  className="inline-flex items-center gap-[6px] px-[10px] py-[5px] rounded-md text-[12px] font-medium border cursor-pointer transition-colors"
                  style={{
                    background: on ? "var(--qz-accent-soft)" : "transparent",
                    borderColor: on ? "color-mix(in oklab, var(--qz-accent) 30%, transparent)" : "var(--qz-border)",
                    color: on ? "var(--qz-fg-1)" : "var(--qz-fg-4)",
                  }}
                  title={on ? "Hide this source" : "Show this source"}
                >
                  <SourcePill source={s} />
                  <span className="text-[var(--qz-fg-4)]">{counts[s]}</span>
                </button>
              );
            })}
          </div>

          {/* Table */}
          <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
            <table ref={resize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: resize.tableLayout }}>
              <colgroup>
                {cols.map((c) => (
                  <col key={c.key} style={{ width: resize.colWidth(c.key) }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {cols.map((c, i) => (
                    <th key={c.key} {...resize.thProps(i)}>
                      {c.header}
                      {resize.handle(i)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={cols.length} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                      {rows.length === 0
                        ? "Waiting for events… (firewall traffic needs per-rule logging enabled; the security sources need their features on)"
                        : "No entries match the filter."}
                    </td>
                  </tr>
                ) : (
                  visible.map((r) => (
                    <tr key={r.id} style={{ cursor: "default" }}>
                      {cols.map((c) => (
                        <td
                          key={c.key}
                          className={c.className}
                          style={c.ellipsis ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : undefined}
                          title={c.title?.(r)}
                        >
                          {c.cell(r)}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
            The newest {MAX_ROWS} events are kept. Firewall traffic streams live; Content Filtering is polled every {CF_POLL_MS / 1000}s.
            SSL-intercepted HTTPS appears under Content Filtering, not Firewall.
          </p>
        </div>
      </div>
    </div>
  );
}
