"use client";

// Traffic Monitor — a live, WatchGuard-style view of traffic and the firewall
// rule (policy) each connection hit. The backend follows the kernel journal
// and streams parsed firewall log entries over SSE (/api/monitor/firewall-log);
// this page renders them and maps rule numbers back to the friendly rule names
// from the firewall config.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { ColumnsMenu, useColumnVisibility } from "@/components/dashboard/ColumnsMenu";
import { useColumnResize } from "@/components/dashboard/ColumnResize";
import { Segmented } from "@/components/ui/Segmented";
import {
  emptyFirewallConfig,
  enableTrafficLogging,
  fetchFirewall,
  FirewallConfig,
  isBaseChain,
  loggingStatus,
  pairForChain,
  RuleChain,
  ruleKey,
  rulesetName,
} from "@/lib/firewall";
import { useDashboard } from "@/lib/DashboardContext";

/// One SSE payload from the backend (see backend/src/monitor.rs LogEntry).
interface MonitorEntry {
  ts: number;
  family: string;
  chain: RuleChain;
  /** Rule number; null = the chain's default action fired. */
  rule: number | null;
  action: "accept" | "drop" | "reject";
  /** True when the rule queues matches to the IPS engine (Allow with IPS on). */
  ips: boolean;
  in?: string;
  out?: string;
  src?: string;
  dst?: string;
  proto?: string;
  spt?: number;
  dpt?: number;
  len?: number;
  icmp_type?: number;
}

/// Entry plus a client-side id for stable React keys.
type Row = MonitorEntry & { id: number };

const MAX_ROWS = 500;

/// Protocols with their own filter entry; everything else falls under Other.
const KNOWN_PROTOS = ["tcp", "udp", "icmp"];

function ActionPill({ action }: { action: Row["action"] }) {
  if (action === "accept") return <span className="badge badge-ok">Allow</span>;
  if (action === "drop") return <span className="badge badge-crit">Deny</span>;
  return <span className="badge badge-warn">Reject</span>;
}

const dash = <span className="text-[var(--cds-alias-typography-color-200)]">—</span>;

const time = (ts: number) =>
  ts ? new Date(ts).toLocaleTimeString(undefined, { hour12: false }) : "—";

// Toggleable columns for the streaming table. Layout + menu labels live here;
// the per-row content is rendered by monitorCell (it needs the live rule-name
// map, so it can't be a static value on the column).
interface MonCol {
  key: string;
  header: string;
  width?: number;
  className?: string;
  ellipsis?: boolean;
}

const MONITOR_COLUMNS: MonCol[] = [
  { key: "time", header: "Time", width: 90, className: "mono text-[var(--cds-alias-typography-color-300)]" },
  { key: "action", header: "Action", width: 100 },
  { key: "rule", header: "Rule", ellipsis: true },
  { key: "src", header: "Source", className: "mono", ellipsis: true },
  { key: "spt", header: "Src port", width: 70, className: "mono" },
  { key: "dst", header: "Destination", className: "mono", ellipsis: true },
  { key: "dpt", header: "Dst port", width: 70, className: "mono" },
  { key: "proto", header: "Protocol", width: 90, className: "mono" },
  { key: "iface", header: "Interface", width: 140, className: "mono text-[var(--cds-alias-typography-color-300)]" },
];

function monitorCell(
  key: string,
  r: Row,
  ruleLabel: (r: Row) => string,
  scopeLabel: (chain: RuleChain) => string,
): React.ReactNode {
  switch (key) {
    case "time":
      return time(r.ts);
    case "action":
      return (
        <span className="inline-flex items-center gap-[5px]">
          <ActionPill action={r.action} />
          {r.ips && (
            <span className="badge badge-warn" title="Inspected by the IPS engine">
              IPS
            </span>
          )}
        </span>
      );
    case "rule":
      return (
        <>
          <Link
            href="/firewall/rules"
            className="no-underline text-[var(--cds-alias-typography-color-450)] hover:text-[var(--cds-alias-interaction-action)]"
            title={
              r.rule === null
                ? `${scopeLabel(r.chain)} default action`
                : `${scopeLabel(r.chain)} rule ${r.rule}`
            }
          >
            {ruleLabel(r)}
          </Link>
          {r.chain !== "forward" && (
            <span className="text-[11px] text-[var(--cds-alias-typography-color-200)]"> · {scopeLabel(r.chain)}</span>
          )}
        </>
      );
    case "src":
      return r.src ?? dash;
    case "spt":
      return r.spt ?? dash;
    case "dst":
      return r.dst ?? dash;
    case "dpt":
      return r.dpt ?? dash;
    case "proto":
      return (
        <>
          {r.proto ?? "—"}
          {r.proto === "icmp" && r.icmp_type != null && (
            <span className="text-[var(--cds-alias-typography-color-200)]"> t{r.icmp_type}</span>
          )}
        </>
      );
    case "iface":
      return (
        <>
          {r.in ?? "—"}
          {r.out ? ` → ${r.out}` : ""}
        </>
      );
    default:
      return null;
  }
}

export default function TrafficMonitorPage() {
  const { setToast } = useDashboard();

  // ── firewall config (rule names + logging status) ───────────────────────────
  const [config, setConfig] = useState<FirewallConfig>(emptyFirewallConfig);
  const [configState, setConfigState] = useState<"loading" | "ready" | "error">("loading");
  const [enabling, setEnabling] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await fetchFirewall());
      setConfigState("ready");
    } catch {
      setConfigState("error"); // names/banner degrade; the stream still works
    }
  }, []);

  useEffect(() => {
    loadConfig();
    // Rule numbers change when rules are reordered, recreated, or deleted —
    // a mapping fetched only at mount would then caption new log lines with
    // the wrong rule name. Refresh it periodically and when the tab regains
    // focus. (Backfilled lines older than the last renumber can still carry
    // pre-renumber numbers; only live labels can be kept honest.)
    const refetch = () => {
      if (!document.hidden) loadConfig();
    };
    const timer = setInterval(refetch, 30_000);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [loadConfig]);

  const logging = useMemo(() => loggingStatus(config), [config]);
  // Keyed by UI rule: every copy of a zone rule shares its number, and ruleKey
  // maps them all to the same key — so a log line from any of a rule's pairs
  // resolves to the one rule that produced it.
  const ruleNames = useMemo(
    () => new Map(config.rules.map((r) => [ruleKey(r), r.name])),
    [config.rules],
  );

  const enableLogging = async () => {
    setEnabling(true);
    try {
      const n = await enableTrafficLogging(config);
      setToast(
        n === 0
          ? "Traffic logging is already fully enabled."
          : `Enabled traffic logging (${n} change${n === 1 ? "" : "s"}).`,
      );
      await loadConfig();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to enable traffic logging.");
    } finally {
      setEnabling(false);
    }
  };

  // ── live stream ─────────────────────────────────────────────────────────────
  // Entries accumulate in a ref (newest first) and render as soon as they
  // arrive: the first entry after a quiet spell flushes immediately, and a
  // burst then batches into one render per FLUSH_MS so a busy firewall doesn't
  // force a render per packet. Pausing stops the flush, not the collection —
  // resume shows what happened meanwhile.
  const rowsRef = useRef<Row[]>([]);
  const dirtyRef = useRef(false);
  const nextId = useRef(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [stream, setStream] = useState<"connecting" | "live" | "reconnecting">("connecting");
  // Bumped by the Refresh button to tear down and reopen the stream (a fresh
  // connection re-backfills from the journal).
  const [streamGen, setStreamGen] = useState(0);

  const FLUSH_MS = 75;

  useEffect(() => {
    const es = new EventSource("/api/monitor/firewall-log");
    es.onopen = () => setStream("live");
    es.onerror = () => setStream("reconnecting"); // EventSource retries itself
    let throttle: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (!dirtyRef.current || pausedRef.current) return;
      dirtyRef.current = false;
      setRows(rowsRef.current);
    };
    const scheduleFlush = () => {
      if (throttle) return; // burst in progress — the trailing flush covers it
      flush();
      throttle = setTimeout(() => {
        throttle = null;
        flush();
      }, FLUSH_MS);
    };
    es.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data) as MonitorEntry;
        rowsRef.current = [{ ...entry, id: nextId.current++ }, ...rowsRef.current].slice(0, MAX_ROWS);
        dirtyRef.current = true;
        scheduleFlush();
      } catch {
        // tolerate a malformed event rather than killing the stream
      }
    };
    return () => {
      if (throttle) clearTimeout(throttle);
      es.close();
    };
  }, [streamGen]);

  const togglePause = () => {
    setPaused((p) => {
      pausedRef.current = !p;
      if (p) setRows(rowsRef.current); // resuming — catch up immediately
      return !p;
    });
  };

  const clear = () => {
    rowsRef.current = [];
    dirtyRef.current = false;
    setRows([]);
  };

  /// Start over: drop the table, reconnect the stream (which re-backfills
  /// from the journal), and re-read rule names.
  const refresh = () => {
    clear();
    setStream("connecting");
    setStreamGen((g) => g + 1);
    loadConfig();
  };

  // ── filters ─────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<"all" | "accept" | "blocked">("all");
  const [protoFilter, setProtoFilter] = useState("all");
  const [ifaceFilter, setIfaceFilter] = useState("all");
  const [ruleFilter, setRuleFilter] = useState("all");

  const ruleLabel = useCallback(
    (r: Row): string => {
      if (r.rule === null) return "Default action";
      return ruleNames.get(ruleKey({ chain: r.chain, rule: r.rule })) ?? `Rule ${r.rule}`;
    },
    [ruleNames],
  );

  // Where a log line came from, in words — a zone rule's scope is a pair's
  // ruleset, whose raw name (QZ-Z-LAN-TO-WAN) isn't for reading.
  const scopeLabel = useCallback(
    (chain: RuleChain): string => {
      if (isBaseChain(chain)) return chain;
      const pair = pairForChain(config.zone_pairs, chain);
      if (!pair) return rulesetName(chain) ?? chain;
      const name = (n: string) => config.zones.find((z) => z.name === n)?.display ?? n;
      return `${name(pair.src)} → ${name(pair.dst)}`;
    },
    [config.zone_pairs, config.zones],
  );

  // Interfaces offered in the filter: whatever the entries have actually seen
  // (plus the current selection, so it can't silently vanish).
  const ifaceOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.in) seen.add(r.in);
      if (r.out) seen.add(r.out);
    }
    if (ifaceFilter !== "all") seen.add(ifaceFilter);
    return [...seen].sort();
  }, [rows, ifaceFilter]);

  const ruleOptions = useMemo(
    () =>
      config.rules.map((r) => ({
        value: ruleKey(r),
        label: r.name ?? `Rule ${r.rule}`,
      })),
    [config.rules],
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (actionFilter === "accept" && r.action !== "accept") return false;
      if (actionFilter === "blocked" && r.action === "accept") return false;
      if (protoFilter !== "all") {
        const p = r.proto ?? "";
        if (protoFilter === "other" ? KNOWN_PROTOS.includes(p) : p !== protoFilter) return false;
      }
      if (ifaceFilter !== "all" && r.in !== ifaceFilter && r.out !== ifaceFilter) return false;
      if (ruleFilter !== "all") {
        // Filtering by a zone rule matches traffic from every pair it spans,
        // because ruleKey is the same for all of them.
        if (
          ruleFilter === "default"
            ? r.rule !== null
            : r.rule === null || ruleKey({ chain: r.chain, rule: r.rule }) !== ruleFilter
        ) {
          return false;
        }
      }
      if (!q) return true;
      const hay = [ruleLabel(r), r.src, r.dst, r.spt, r.dpt, r.proto, r.in, r.out, r.chain, r.action]
        .filter((v) => v != null && v !== "")
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, q, actionFilter, protoFilter, ifaceFilter, ruleFilter, ruleLabel]);

  const vis = useColumnVisibility("firewall-monitor", MONITOR_COLUMNS);
  const cols = MONITOR_COLUMNS.filter((c) => vis.isVisible(c.key));
  const resize = useColumnResize("firewall-monitor", cols.map((c) => ({ key: c.key, width: c.width })));

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2>Traffic Monitor</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Live traffic and the firewall rule each connection hit — one entry per new connection, streamed from the
          kernel log.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {/* Logging setup banner */}
        {configState === "ready" && !logging.complete && (
          <div className="alert alert-warning alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">
              {logging.total_rules === 0 && logging.chains_without_default_log.length === 3
                ? "Traffic logging is off — nothing will appear here until it's enabled."
                : `Logging is only partially enabled (${logging.logged_rules} of ${logging.total_rules} rules) — some traffic won't appear here.`}
            </div>
            <div className="alert-actions">
              <Button kind="primary" size="sm" onClick={enableLogging} disabled={enabling}>
                {enabling ? "Enabling…" : "Enable Logging"}
              </Button>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter traffic…"
            className="clr-input"
            style={{ width: 240, maxWidth: 240 }}
          />

          <Segmented
            items={[
              { value: "all", label: "All" },
              { value: "accept", label: "Allowed" },
              { value: "blocked", label: "Blocked" },
            ]}
            value={actionFilter}
            onChange={(v) => setActionFilter(v as typeof actionFilter)}
          />

          <div className="clr-select-wrapper" style={{ width: "auto" }}>
            <select
              value={protoFilter}
              onChange={(e) => setProtoFilter(e.target.value)}
              title="Filter by protocol"
              className="clr-select"
              style={{ width: "auto", minWidth: 100 }}
            >
              <option value="all">All protocols</option>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="icmp">ICMP</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="clr-select-wrapper" style={{ width: "auto" }}>
            <select
              value={ifaceFilter}
              onChange={(e) => setIfaceFilter(e.target.value)}
              title="Filter by interface (matches either side)"
              className="clr-select"
              style={{ width: "auto", minWidth: 100 }}
            >
              <option value="all">All interfaces</option>
              {ifaceOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div className="clr-select-wrapper" style={{ width: "auto", maxWidth: 220 }}>
            <select
              value={ruleFilter}
              onChange={(e) => setRuleFilter(e.target.value)}
              title="Filter by the rule that fired"
              className="clr-select"
              style={{ width: "auto", minWidth: 100, maxWidth: 220 }}
            >
              <option value="all">All rules</option>
              <option value="default">Default action</option>
              {ruleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <ColumnsMenu vis={vis} />
            <Button kind="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button kind="outline" size="sm" onClick={togglePause}>
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button kind="outline" size="sm" onClick={clear}>
              Clear
            </Button>
            <span
              className="inline-flex items-center gap-[6px]"
              style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}
            >
              <span
                className="inline-block w-[7px] h-[7px] rounded-full"
                style={{
                  background: paused
                    ? "var(--cds-alias-typography-color-200)"
                    : stream === "live"
                      ? "var(--cds-alias-status-success)"
                      : "var(--cds-alias-status-warning)",
                }}
              />
              {paused ? "Paused" : stream === "live" ? "Live" : stream === "connecting" ? "Connecting…" : "Reconnecting…"}
              {" · "}
              {visible.length} {visible.length === 1 ? "entry" : "entries"}
            </span>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
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
                  <td
                    colSpan={cols.length}
                    className="text-center text-[var(--cds-alias-typography-color-200)]"
                    style={{ cursor: "default" }}
                  >
                    {rows.length === 0
                      ? "Waiting for traffic… (only logged rules and default-log traffic appear here)"
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
                      >
                        {monitorCell(c.key, r, ruleLabel, scopeLabel)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
          Entries stream from the firewall&apos;s kernel log; the newest {MAX_ROWS} are kept. Each rule&apos;s
          logging can be toggled individually when editing it under{" "}
          <Link href="/firewall/rules" className="text-[var(--cds-alias-typography-color-300)]">
            Rules
          </Link>
          .
        </p>

        {configState === "error" && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">Couldn&apos;t read the firewall config — rule names are unavailable.</div>
            <div className="alert-actions">
              <Button kind="secondary" size="sm" icon="refresh" onClick={loadConfig}>
                Retry
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
