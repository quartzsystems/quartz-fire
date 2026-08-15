"use client";

// Monitoring → Traffic Flow — a FireWatch-style Sankey over the last few
// minutes of traffic: reorderable facet columns (interface, rule, destination,
// …), ribbon thickness ∝ bytes, ribbon color = the firewall's verdict.
//
// Data is /api/monitoring/flows (lib/flows): conntrack byte sums per service
// tuple joined against the nftables log for rule attribution. All facet
// aggregation happens here, client-side, so reordering/filtering columns never
// refetches. Flows whose rules don't log arrive unattributed and render
// through "(not logged)" nodes — the byte totals stay honest either way.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { ChartTooltip } from "@/components/ui/ChartTooltip";
import type { TooltipRow } from "@/components/ui/ChartTooltip";
import { emptyFirewallConfig, fetchFirewall, FirewallConfig } from "@/lib/firewall";
import { fetchFlows, FlowRecord, FlowsResponse, FlowWindow } from "@/lib/flows";
import type { FlowMetric } from "@/lib/flows";
import { formatBytes } from "@/lib/format";
import { useColumnResize } from "@/components/dashboard/ColumnResize";

const POLL_MS = 5000;
/** Nodes kept per column before folding the tail into "Other". */
const TOP_NODES = 14;
/** Sentinel node key for the per-column tail rollup (never a real value). */
const OTHER = "\x00other";

// ── verdict (the status encoding carried by ribbon color) ───────────────────

type Verdict = "allow" | "block" | "none";

// Ribbon colors per the Clarity chart contract: allowed green #00d992 at .28,
// blocked red #ff5d6c at .38 (the tokens resolve to those hexes).
const VERDICT_META: Record<Verdict, { label: string; color: string; opacity: number; hover: number }> = {
  allow: { label: "Allowed", color: "var(--qz-success)", opacity: 0.28, hover: 0.6 },
  block: { label: "Blocked", color: "var(--qz-danger)", opacity: 0.38, hover: 0.68 },
  none: { label: "Not logged", color: "var(--qz-fg-4)", opacity: 0.2, hover: 0.42 },
};
const VERDICT_ORDER: Verdict[] = ["allow", "block", "none"];

function verdictOf(r: FlowRecord): Verdict {
  if (!r.action) return "none";
  return r.action === "accept" ? "allow" : "block";
}

// ── facets (the reorderable columns) ────────────────────────────────────────

type FacetId = "src" | "in_if" | "rule" | "out_if" | "dst" | "service";

interface Facet {
  id: FacetId;
  label: string;
  /** Grouping key for a flow (stable), or null → "—" bucket. */
  key: (r: FlowRecord) => string | null;
}

const FACETS: Facet[] = [
  { id: "src", label: "Source", key: (r) => r.src },
  { id: "in_if", label: "In Interface", key: (r) => r.in_if ?? null },
  { id: "rule", label: "Rule", key: (r) => (r.chain ? `${r.chain}:${r.rule ?? "default"}` : null) },
  { id: "out_if", label: "Out Interface", key: (r) => r.out_if ?? null },
  { id: "dst", label: "Destination", key: (r) => r.dst },
  { id: "service", label: "Service", key: (r) => (r.proto ? (r.dport ? `${r.proto}/${r.dport}` : r.proto) : null) },
];
const FACET_BY_ID = new Map(FACETS.map((f) => [f.id, f]));

/** The user's original ask: interfaces on the left, rules in the middle,
 * destinations on the right. Everything else is one click away. */
const DEFAULT_ORDER: FacetId[] = ["in_if", "rule", "dst"];
type VerdictFilter = "all" | "allow" | "block";

/** Everything a view captures: facet columns + metric + window + verdict. */
interface SankeyView {
  order: FacetId[];
  metric: FlowMetric;
  window: FlowWindow;
  verdict: VerdictFilter;
}

/** localStorage keys: the last-used view (auto-restored on mount) and the
 * user's named views. */
const LAST_VIEW_KEY = "qz-sankey:traffic-flow";
const VIEWS_KEY = "qz-sankey-views:traffic-flow";

/** Coerce untrusted storage into a valid view (null when unusable). */
function sanitizeView(v: unknown): SankeyView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const order = Array.isArray(o.order)
    ? (o.order as FacetId[]).filter((id) => FACET_BY_ID.has(id))
    : [];
  if (order.length < 2) return null;
  return {
    order,
    metric: o.metric === "hits" ? "hits" : "bytes",
    window: o.window === "15m" || o.window === "1h" ? o.window : "5m",
    verdict: o.verdict === "allow" || o.verdict === "block" ? o.verdict : "all",
  };
}

function loadLastView(): SankeyView | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_VIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // An early build stored just the facet-order array.
    return sanitizeView(Array.isArray(parsed) ? { order: parsed } : parsed);
  } catch {
    return null;
  }
}

function loadViews(): Record<string, SankeyView> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(VIEWS_KEY);
    if (!raw) return {};
    const out: Record<string, SankeyView> = {};
    for (const [name, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      const s = sanitizeView(v);
      if (s) out[name] = s;
    }
    return out;
  } catch {
    return {};
  }
}

/** Columns of the "top flows" table under the Sankey. */
const TOP_FLOW_COLS: { key: string; header: string; right?: boolean }[] = [
  { key: "src", header: "Source" },
  { key: "in_if", header: "In if" },
  { key: "rule", header: "Rule" },
  { key: "out_if", header: "Out if" },
  { key: "dst", header: "Destination" },
  { key: "service", header: "Service" },
  { key: "hits", header: "Hits", right: true },
  { key: "bytes", header: "Bytes", right: true },
];

// ── sankey geometry ─────────────────────────────────────────────────────────

const CHART_H = 520;
const NODE_W = 10;
const NODE_GAP = 8;
const PAD_TOP = 6;
/** Reserves a clear strip under the ribbons for the column-name labels —
 * without it they render on top of the edge ribbons and become unreadable. */
const PAD_BOTTOM = 28;
const PAD_X = 4;

interface SNode {
  key: string;
  label: string;
  /** Weight in the active metric (bytes or hits). */
  value: number;
  col: number;
  y0: number;
  y1: number;
  /** Real facet value (clickable filter); false for the Other/— rollups. */
  filterable: boolean;
}

interface SLink {
  /** Left column index (right column is col + 1). */
  col: number;
  a: string;
  b: string;
  verdict: Verdict;
  /** Weight in the active metric (bytes or hits). */
  value: number;
  sy0: number;
  sy1: number;
  ty0: number;
  ty1: number;
}

interface Layout {
  nodes: SNode[][];
  links: SLink[];
  total: number;
  /** Per input flow, its node key in every column (same order as the flows
   * array) — what lets a node hover trace its flows' full paths. */
  mapped: string[][];
}

/** Stable identity for a ribbon (link objects are rebuilt every poll). */
const linkId = (col: number, a: string, b: string, v: Verdict) => `${col}\x00${a}\x00${b}\x00${v}`;

/** Aggregate the filtered flows into positioned nodes + ribbons, weighted by
 * the active metric (`weight` maps a flow to bytes or hits). */
function layoutSankey(
  flows: FlowRecord[],
  order: FacetId[],
  labelOf: (facet: FacetId, key: string) => string,
  weight: (r: FlowRecord) => number,
): Layout {
  const nCols = order.length;
  const total = flows.reduce((s, r) => s + weight(r), 0);
  if (total <= 0 || nCols < 2) return { nodes: order.map(() => []), links: [], total: 0, mapped: [] };

  // Per column: weight per raw key, then keep the top N and fold the rest.
  const keyed = flows.map((r) => order.map((id) => FACET_BY_ID.get(id)!.key(r) ?? "\x00none"));
  const mapped: string[][] = keyed.map(() => new Array(nCols));
  const nodeCols: SNode[][] = [];
  for (let c = 0; c < nCols; c++) {
    const sums = new Map<string, number>();
    for (let i = 0; i < flows.length; i++) {
      sums.set(keyed[i][c], (sums.get(keyed[i][c]) ?? 0) + weight(flows[i]));
    }
    const ranked = [...sums.entries()].sort((x, y) => y[1] - x[1]);
    const kept = new Set(ranked.slice(0, TOP_NODES).map(([k]) => k));
    const folded = ranked.length > TOP_NODES;
    for (let i = 0; i < flows.length; i++) {
      mapped[i][c] = kept.has(keyed[i][c]) ? keyed[i][c] : OTHER;
    }
    const colNodes: SNode[] = ranked
      .filter(([k]) => kept.has(k))
      .map(([k, value]) => ({
        key: k,
        label: k === "\x00none" ? "—" : labelOf(order[c], k),
        value,
        col: c,
        y0: 0,
        y1: 0,
        filterable: k !== "\x00none",
      }));
    if (folded) {
      const otherValue = ranked.slice(TOP_NODES).reduce((s, [, b]) => s + b, 0);
      colNodes.push({ key: OTHER, label: `Other (${ranked.length - TOP_NODES})`, value: otherValue, col: c, y0: 0, y1: 0, filterable: false });
    }
    nodeCols.push(colNodes);
  }

  // Vertical layout: every column sums to the same filtered total, so one
  // scale keeps ribbon widths consistent across the whole diagram.
  const maxNodes = Math.max(...nodeCols.map((c) => c.length));
  const usable = CHART_H - PAD_TOP - PAD_BOTTOM - NODE_GAP * Math.max(0, maxNodes - 1);
  const scale = usable / total;
  for (const col of nodeCols) {
    let y = PAD_TOP;
    for (const n of col) {
      n.y0 = y;
      n.y1 = y + Math.max(n.value * scale, 1.5);
      y = n.y1 + NODE_GAP;
    }
  }

  // Links between adjacent columns, split by verdict so a mixed pair renders
  // as separate allow/block ribbons rather than one unreadable blend.
  const links: SLink[] = [];
  for (let c = 0; c < nCols - 1; c++) {
    const sums = new Map<string, { a: string; b: string; verdict: Verdict; value: number }>();
    for (let i = 0; i < flows.length; i++) {
      const a = mapped[i][c];
      const b = mapped[i][c + 1];
      const v = verdictOf(flows[i]);
      const k = `${a}\x01${b}\x01${v}`;
      const slot = sums.get(k) ?? { a, b, verdict: v, value: 0 };
      slot.value += weight(flows[i]);
      sums.set(k, slot);
    }
    const aOrder = new Map(nodeCols[c].map((n, i) => [n.key, i]));
    const bOrder = new Map(nodeCols[c + 1].map((n, i) => [n.key, i]));
    const colLinks: SLink[] = [...sums.values()].map((l) => ({
      col: c,
      ...l,
      sy0: 0,
      sy1: 0,
      ty0: 0,
      ty1: 0,
    }));
    // Allocate vertical extent on each node edge: source side ordered by
    // target position (and vice versa) so ribbons don't cross more than the
    // data demands.
    const vIdx = (v: Verdict) => VERDICT_ORDER.indexOf(v);
    const srcOff = new Map<string, number>();
    for (const l of [...colLinks].sort(
      (x, y) => aOrder.get(x.a)! - aOrder.get(y.a)! || bOrder.get(x.b)! - bOrder.get(y.b)! || vIdx(x.verdict) - vIdx(y.verdict),
    )) {
      const node = nodeCols[c][aOrder.get(l.a)!];
      const off = srcOff.get(l.a) ?? 0;
      const h = l.value * scale;
      l.sy0 = node.y0 + off;
      l.sy1 = l.sy0 + h;
      srcOff.set(l.a, off + h);
    }
    const tgtOff = new Map<string, number>();
    for (const l of [...colLinks].sort(
      (x, y) => bOrder.get(x.b)! - bOrder.get(y.b)! || aOrder.get(x.a)! - aOrder.get(y.a)! || vIdx(x.verdict) - vIdx(y.verdict),
    )) {
      const node = nodeCols[c + 1][bOrder.get(l.b)!];
      const off = tgtOff.get(l.b) ?? 0;
      const h = l.value * scale;
      l.ty0 = node.y0 + off;
      l.ty1 = l.ty0 + h;
      tgtOff.set(l.b, off + h);
    }
    links.push(...colLinks);
  }

  return { nodes: nodeCols, links, total, mapped };
}

// ── page ────────────────────────────────────────────────────────────────────

type Hover =
  | { kind: "node"; col: number; key: string; x: number; y: number }
  | { kind: "link"; link: SLink; x: number; y: number }
  | null;

export default function TrafficFlowPage() {
  // The last-used view auto-restores; named views are applied on demand.
  const [initView] = useState(loadLastView);

  // ── data ──
  const [resp, setResp] = useState<FlowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [window_, setWindow] = useState<FlowWindow>(initView?.window ?? "5m");
  const [metric, setMetric] = useState<FlowMetric>(initView?.metric ?? "bytes");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  const load = useCallback(async (w: FlowWindow, m: FlowMetric) => {
    try {
      const r = await fetchFlows(w, m);
      setResp(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load flows");
    }
  }, []);

  useEffect(() => {
    load(window_, metric);
    const t = setInterval(() => {
      if (!document.hidden && !pausedRef.current) load(window_, metric);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load, window_, metric]);

  // Rule names, so the middle column reads "Allow LAN to WAN", not "Rule 20".
  const [config, setConfig] = useState<FirewallConfig>(emptyFirewallConfig);
  useEffect(() => {
    fetchFirewall().then(setConfig).catch(() => {});
  }, []);
  const ruleNames = useMemo(
    () => new Map(config.rules.map((r) => [`${r.chain}:${r.rule}`, r.name])),
    [config],
  );

  // IP → device name from the flow records themselves (backend enriches).
  // Derived synchronously so a poll that brings new names re-lays-out at once.
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of resp?.flows ?? []) {
      if (r.src_name) m.set(r.src, r.src_name);
      if (r.dst_name) m.set(r.dst, r.dst_name);
    }
    return m;
  }, [resp]);

  const labelOf = useCallback(
    (facet: FacetId, key: string): string => {
      if (facet === "rule") {
        const [chain, rule] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
        if (rule === "default") return "Default action";
        return ruleNames.get(`${chain}:${rule}`) ?? `Rule ${rule}`;
      }
      if (facet === "src" || facet === "dst") return names.get(key) ?? key;
      return key;
    },
    [ruleNames, names],
  );

  const resize = useColumnResize("traffic-flow-top", TOP_FLOW_COLS);

  // ── facet order + filters ──
  const [order, setOrder] = useState<FacetId[]>(initView?.order ?? DEFAULT_ORDER);
  /** facet → selected node keys; a flow must match every filtered facet. */
  const [filters, setFilters] = useState<Map<FacetId, Set<string>>>(new Map());
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>(initView?.verdict ?? "all");

  // Whatever is selected right now IS the last-used view; keep it saved.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        LAST_VIEW_KEY,
        JSON.stringify({ order, metric, window: window_, verdict: verdictFilter } satisfies SankeyView),
      );
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [order, metric, window_, verdictFilter]);

  // ── named views ──
  const [views, setViews] = useState<Record<string, SankeyView>>(loadViews);
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [views]);

  const [viewName, setViewName] = useState("");

  const applyView = (v: SankeyView) => {
    setOrder(v.order);
    setMetric(v.metric);
    setWindow(v.window);
    setVerdictFilter(v.verdict);
  };

  const saveView = () => {
    const name = viewName.trim();
    if (!name) return;
    setViews((prev) => ({
      ...prev,
      [name]: { order, metric, window: window_, verdict: verdictFilter },
    }));
    setViewName("");
  };

  const move = (id: FacetId, dir: -1 | 1) =>
    setOrder((o) => {
      const i = o.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const remove = (id: FacetId) =>
    setOrder((o) => (o.length > 2 ? o.filter((f) => f !== id) : o));
  const add = (id: FacetId) => setOrder((o) => (o.includes(id) ? o : [...o, id]));

  const dragId = useRef<FacetId | null>(null);
  const dropOn = (target: FacetId) => {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === target) return;
    setOrder((o) => {
      const next = o.filter((f) => f !== from);
      next.splice(next.indexOf(target), 0, from);
      return next;
    });
  };

  const toggleFilter = (facet: FacetId, key: string) =>
    setFilters((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(facet) ?? []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      if (set.size === 0) next.delete(facet);
      else next.set(facet, set);
      return next;
    });

  // ── filtered flows + layout ──
  /** Free-text filter over a flow's addresses, names, interfaces, and service. */
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const all = resp?.flows ?? [];
    const q = query.trim().toLowerCase();
    return all.filter((r) => {
      if (verdictFilter !== "all" && verdictOf(r) !== verdictFilter) return false;
      for (const [facet, keys] of filters) {
        const k = FACET_BY_ID.get(facet)!.key(r) ?? "\x00none";
        if (!keys.has(k)) return false;
      }
      if (!q) return true;
      const hay = [r.src, r.src_name, r.dst, r.dst_name, r.in_if, r.out_if, r.proto, r.dport, r.chain, r.rule]
        .filter((v) => v != null && v !== "")
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [resp, filters, verdictFilter, query]);

  // Metric weight + its value formatter, together so they can't disagree.
  const weight = useCallback(
    (r: FlowRecord) => (metric === "bytes" ? r.bytes : r.conns),
    [metric],
  );
  const fmtVal = useCallback(
    (v: number) => (metric === "bytes" ? formatBytes(v) : v.toLocaleString()),
    [metric],
  );

  const layout = useMemo(
    () => layoutSankey(filtered, order, labelOf, weight),
    [filtered, order, labelOf, weight],
  );

  // ── measuring + hover ──
  // The diagram div only mounts once data exists, so measure via a callback
  // ref (state), not a plain ref — an effect keyed on [] runs while the
  // loading placeholder is up, never observes the real element, and the SVG
  // would stay at its 900px fallback instead of filling the page.
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const attachWrap = useCallback((el: HTMLDivElement | null) => {
    wrapRef.current = el;
    setWrapEl(el);
  }, []);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    if (!wrapEl) return;
    setWidth(wrapEl.getBoundingClientRect().width || 900);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(wrapEl);
    return () => ro.disconnect();
  }, [wrapEl]);

  const [hover, setHover] = useState<Hover>(null);

  // Cross-highlight sets for the current hover. A ribbon hover lights the
  // ribbon plus both endpoint nodes; a node hover traces every flow through
  // that node END-TO-END — all its ribbons and nodes in every column, so
  // hovering a rule shows exactly which interfaces/sources/destinations that
  // rule carries (and vice versa). One nuance: ribbons are per-column-pair
  // aggregates, so a lit ribbon in a *distant* column may also carry flows
  // that don't pass the hovered node — it lights when at least one does.
  const highlight = useMemo((): { links: Set<string>; nodes: Set<string> } | null => {
    if (!hover) return null;
    const links = new Set<string>();
    const nodes = new Set<string>();
    if (hover.kind === "link") {
      const l = hover.link;
      links.add(linkId(l.col, l.a, l.b, l.verdict));
      nodes.add(`${l.col}\x00${l.a}`);
      nodes.add(`${l.col + 1}\x00${l.b}`);
      return { links, nodes };
    }
    for (let i = 0; i < filtered.length; i++) {
      const path = layout.mapped[i];
      if (!path || path[hover.col] !== hover.key) continue;
      const v = verdictOf(filtered[i]);
      for (let c = 0; c < path.length; c++) {
        nodes.add(`${c}\x00${path[c]}`);
        if (c < path.length - 1) links.add(linkId(c, path[c], path[c + 1], v));
      }
    }
    return { links, nodes };
  }, [hover, layout, filtered]);

  const colX = useCallback(
    (c: number) => PAD_X + (c * (width - 2 * PAD_X - NODE_W)) / Math.max(1, order.length - 1),
    [width, order.length],
  );

  const ribbonPath = (l: SLink) => {
    const x0 = colX(l.col) + NODE_W;
    const x1 = colX(l.col + 1);
    const mx = (x0 + x1) / 2;
    return `M ${x0} ${l.sy0} C ${mx} ${l.sy0}, ${mx} ${l.ty0}, ${x1} ${l.ty0} L ${x1} ${l.ty1} C ${mx} ${l.ty1}, ${mx} ${l.sy1}, ${x0} ${l.sy1} Z`;
  };

  const svgPos = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const attributedPct = useMemo(() => {
    if (!resp) return null;
    const [attributed, total] =
      metric === "bytes"
        ? [resp.attributed_bytes, resp.total_bytes]
        : [resp.attributed_conns, resp.total_conns];
    return total > 0 ? Math.round((100 * attributed) / total) : null;
  }, [resp, metric]);

  // Tooltip content for the current hover.
  const tip = useMemo((): { title: string; rows: TooltipRow[] } | null => {
    if (!hover) return null;
    if (hover.kind === "link") {
      const l = hover.link;
      const aLabel = layout.nodes[l.col].find((n) => n.key === l.a)?.label ?? l.a;
      const bLabel = layout.nodes[l.col + 1].find((n) => n.key === l.b)?.label ?? l.b;
      return {
        title: `${aLabel} → ${bLabel}`,
        rows: [
          {
            label: VERDICT_META[l.verdict].label,
            value: fmtVal(l.value),
            color: VERDICT_META[l.verdict].color,
          },
        ],
      };
    }
    const n = layout.nodes[hover.col]?.find((x) => x.key === hover.key);
    if (!n) return null;
    let count = 0;
    for (let i = 0; i < filtered.length; i++) {
      if (layout.mapped[i]?.[hover.col] === hover.key) count++;
    }
    return {
      title: n.label,
      rows: [
        { label: metric === "bytes" ? "Bytes" : "Hits", value: fmtVal(n.value), color: "var(--qz-accent)" },
        { label: "Flows", value: String(count), color: "var(--qz-fg-4)" },
      ],
    };
  }, [hover, layout, filtered, metric, fmtVal]);

  const activeFilterChips = useMemo(() => {
    const chips: { facet: FacetId; key: string; label: string }[] = [];
    for (const [facet, keys] of filters) {
      for (const k of keys) chips.push({ facet, key: k, label: labelOf(facet, k) });
    }
    return chips;
  }, [filters, labelOf]);

  const topFlows = useMemo(() => filtered.slice(0, 10), [filtered]);

  return (
    <div className="flex flex-col gap-3">
      {/* Page header per the DC reference: title/sub left; save-view input +
          plain Save View / Refresh buttons right-aligned beside it. */}
      <div className="flex items-start gap-2 flex-wrap">
        <div className="mr-auto">
          <h2>Traffic Flow</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Aggregated connections from conntrack — group, filter, and save the views you keep coming back to.
          </p>
        </div>
        <input
          value={viewName}
          onChange={(e) => setViewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveView();
          }}
          placeholder="Save current as…"
          className="clr-input"
        />
        <button type="button" className="btn" onClick={saveView} disabled={!viewName.trim()}>
          Save View
        </button>
        <button type="button" className="btn" onClick={() => load(window_, metric)}>
          Refresh
        </button>
      </div>

      <div>
        <div className="flex flex-col gap-3">
          {/* Controls — DC row order: verdict tabs · grouping · filter input,
              saved views right-aligned. Window/metric selectors and Pause are
              kept as extras beyond the reference. */}
          <div className="flex items-center gap-2 flex-wrap">
            <Segmented
              items={[
                { value: "all", label: "All" },
                { value: "allow", label: "Allowed" },
                { value: "block", label: "Blocked" },
              ]}
              value={verdictFilter}
              onChange={(v) => setVerdictFilter(v as typeof verdictFilter)}
            />
            <Segmented
              items={[
                { value: "5m", label: "5 min" },
                { value: "15m", label: "15 min" },
                { value: "1h", label: "1 hour" },
              ]}
              value={window_}
              onChange={(v) => setWindow(v as FlowWindow)}
            />
            <Segmented
              items={[
                { value: "bytes", label: "Bytes" },
                { value: "hits", label: "Hits" },
              ]}
              value={metric}
              onChange={(v) => setMetric(v as FlowMetric)}
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter flows…"
              className="clr-input"
              style={{ width: 240, maxWidth: 240 }}
            />
            <div className="ml-auto flex items-center gap-3">
              <Button
                kind="outline"
                size="sm"
                onClick={() =>
                  setPaused((p) => {
                    pausedRef.current = !p;
                    return !p;
                  })
                }
              >
                {paused ? "Resume" : "Pause"}
              </Button>
              {/* Saved views, inline per the DC reference: name links that
                  recall a saved column/metric/window/verdict combination. */}
              <span style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
                Saved views:{" "}
                {Object.keys(views).length === 0
                  ? "none yet"
                  : Object.entries(views).map(([name, v], i) => (
                      <span key={name}>
                        {i > 0 && " · "}
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            applyView(v);
                          }}
                          title={`${v.order.map((id) => FACET_BY_ID.get(id)?.label ?? id).join(" → ")} · ${v.window} · ${v.metric === "bytes" ? "Bytes" : "Hits"}`}
                        >
                          {name}
                        </a>
                        <button
                          type="button"
                          onClick={() =>
                            setViews((prev) => {
                              const next = { ...prev };
                              delete next[name];
                              return next;
                            })
                          }
                          title="Delete this view"
                          aria-label={`Delete view ${name}`}
                          style={{
                            background: "none",
                            border: "none",
                            padding: "0 2px",
                            cursor: "pointer",
                            color: "var(--cds-alias-typography-color-200)",
                            fontSize: 11,
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
              </span>
            </div>
          </div>

          {/* Facet columns: drag to reorder, ◀ ▶ to nudge, ✕ to drop, + to add */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] text-[var(--qz-fg-4)]">Columns:</span>
            {order.map((id, i) => (
              <span
                key={id}
                draggable
                onDragStart={() => (dragId.current = id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropOn(id)}
                className="inline-flex items-center gap-[4px] pl-[6px] pr-[4px] py-[4px] rounded-full text-[12px] font-medium border cursor-grab select-none"
                style={{
                  background: "var(--qz-accent-soft)",
                  borderColor: "color-mix(in oklab, var(--qz-accent) 30%, transparent)",
                  color: "var(--qz-fg-1)",
                }}
              >
                <Icon shape="two-way-arrows" size={12} className="text-[var(--qz-fg-4)]" />
                {FACET_BY_ID.get(id)!.label}
                <button
                  type="button"
                  onClick={() => move(id, -1)}
                  disabled={i === 0}
                  className="btn btn-sm btn-link-neutral btn-icon"
                  title="Move left"
                >
                  <Icon shape="angle" dir="left" size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => move(id, 1)}
                  disabled={i === order.length - 1}
                  className="btn btn-sm btn-link-neutral btn-icon"
                  title="Move right"
                >
                  <Icon shape="angle" dir="right" size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => remove(id)}
                  disabled={order.length <= 2}
                  className="btn btn-sm btn-link-neutral btn-icon"
                  title={order.length <= 2 ? "At least two columns" : "Remove column"}
                >
                  <Icon shape="times" size={12} />
                </button>
              </span>
            ))}
            {FACETS.filter((f) => !order.includes(f.id)).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => add(f.id)}
                className="btn btn-sm"
                title="Add column"
              >
                <Icon shape="plus" size={12} />
                {f.label}
              </button>
            ))}
          </div>

          {/* Active node filters */}
          {(activeFilterChips.length > 0 || verdictFilter !== "all") && (
            <div className="flex items-center gap-2 flex-wrap text-[12px]">
              <span className="text-[var(--qz-fg-4)]">Filtered to:</span>
              {activeFilterChips.map((c) => (
                <span key={`${c.facet}:${c.key}`} className="label label-accent">
                  {FACET_BY_ID.get(c.facet)!.label}: {c.label}
                  <button
                    type="button"
                    className="label-dismiss"
                    onClick={() => toggleFilter(c.facet, c.key)}
                    title="Remove this filter"
                    aria-label="Remove this filter"
                  >
                    ✕
                  </button>
                </span>
              ))}
              {activeFilterChips.length > 0 && (
                <button type="button" onClick={() => setFilters(new Map())} className="btn btn-sm btn-link">
                  Clear
                </button>
              )}
            </div>
          )}

          {/* The diagram */}
          <div className="card">
            <div className="card-header">
              Where Traffic Goes
              <span
                className="ml-auto"
                style={{ fontSize: 12, fontWeight: 400, color: "var(--cds-alias-typography-color-200)" }}
              >
                {metric === "bytes" ? "bytes" : "hits"} over the last{" "}
                {window_ === "1h" ? "hour" : window_ === "15m" ? "15 min" : "5 min"} · green flows allowed, red
                blocked
              </span>
            </div>
            <div className="card-block">
            {resp && !resp.available ? (
              <div className="p-8 text-center text-[13px] text-[var(--qz-fg-4)]">
                Flow recording isn&apos;t available yet. It needs a qfdevd build with per-flow
                buckets — update the system image (or restart qfdevd) and traffic will appear
                within a snapshot interval.
              </div>
            ) : error ? (
              <div className="p-8 text-center text-[13px] text-[var(--qz-fg-4)]">{error}</div>
            ) : layout.total === 0 ? (
              <div className="p-8 text-center text-[13px] text-[var(--qz-fg-4)]">
                {resp
                  ? filters.size > 0 || verdictFilter !== "all"
                    ? "No flows match the current filters."
                    : "No traffic recorded in this window yet — flows appear within one conntrack snapshot (~30s) of qfdevd seeing them."
                  : "Loading…"}
              </div>
            ) : (
              <div ref={attachWrap} className="relative" onMouseLeave={() => setHover(null)}>
                <svg width={width} height={CHART_H} style={{ display: "block" }}>
                  {/* ribbons under nodes */}
                  {layout.links.map((l, i) => {
                    const lit = highlight?.links.has(linkId(l.col, l.a, l.b, l.verdict)) ?? false;
                    const m = VERDICT_META[l.verdict];
                    return (
                      <path
                        key={i}
                        d={ribbonPath(l)}
                        fill={m.color}
                        fillOpacity={highlight ? (lit ? m.hover : m.opacity * 0.35) : m.opacity}
                        style={{ transition: "fill-opacity 120ms" }}
                        onMouseMove={(e) => {
                          const p = svgPos(e);
                          setHover({ kind: "link", link: l, x: p.x, y: p.y });
                        }}
                        onMouseLeave={() => setHover(null)}
                      />
                    );
                  })}
                  {/* nodes + labels */}
                  {layout.nodes.map((col, c) =>
                    col.map((n) => {
                      const x = colX(c);
                      const selected = filters.get(order[c])?.has(n.key) ?? false;
                      // On the hovered flow's path → strong ink; off-path while
                      // a hover is active → recede (whole group, label too).
                      const lit = highlight?.nodes.has(`${c}\x00${n.key}`) ?? false;
                      const lastCol = c === order.length - 1;
                      const labelX = lastCol ? x - 6 : x + NODE_W + 6;
                      const label = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
                      return (
                        <g
                          key={n.key}
                          opacity={highlight && !lit && !selected ? 0.4 : 1}
                          style={{ cursor: n.filterable ? "pointer" : "default", transition: "opacity 120ms" }}
                          onMouseMove={(e) => {
                            const p = svgPos(e);
                            setHover({ kind: "node", col: c, key: n.key, x: p.x, y: p.y });
                          }}
                          onMouseLeave={() => setHover(null)}
                          onClick={() => n.filterable && toggleFilter(order[c], n.key)}
                        >
                          <rect
                            x={x}
                            y={n.y0}
                            width={NODE_W}
                            height={Math.max(n.y1 - n.y0, 1.5)}
                            rx={2}
                            fill={selected ? "var(--qz-accent)" : lit ? "var(--qz-fg-1)" : "var(--qz-fg-3)"}
                            stroke={selected ? "var(--qz-accent)" : "none"}
                            strokeWidth={selected ? 2 : 0}
                          />
                          <text
                            x={labelX}
                            y={(n.y0 + n.y1) / 2}
                            dominantBaseline="middle"
                            textAnchor={lastCol ? "end" : "start"}
                            fontSize={11}
                            fontWeight={lit ? 600 : 400}
                            fill={lit ? "var(--qz-fg-1)" : "var(--qz-fg-2)"}
                            style={{ paintOrder: "stroke", stroke: "var(--qz-surface)", strokeWidth: 3, strokeLinejoin: "round" }}
                          >
                            {label}
                          </text>
                        </g>
                      );
                    }),
                  )}
                  {/* column headers, in the strip PAD_BOTTOM reserves below the ribbons */}
                  {order.map((id, c) => (
                    <text
                      key={id}
                      x={c === order.length - 1 ? colX(c) + NODE_W : colX(c)}
                      y={CHART_H - 8}
                      textAnchor={c === order.length - 1 ? "end" : "start"}
                      fontSize={11}
                      fontWeight={600}
                      fill="var(--qz-fg-4)"
                    >
                      {FACET_BY_ID.get(id)!.label}
                    </text>
                  ))}
                </svg>
                {tip && hover && (
                  <ChartTooltip x={hover.x} width={width} title={tip.title} rows={tip.rows} top={Math.min(hover.y + 12, CHART_H - 70)} />
                )}
              </div>
            )}
            </div>
          </div>

          {/* Legend (verdict is a status encoding — never color alone) */}
          <div className="flex items-center gap-4 text-[12px] text-[var(--qz-fg-3)] flex-wrap">
            {VERDICT_ORDER.map((v) => (
              <span key={v} className="inline-flex items-center gap-[6px]">
                <span
                  className="inline-block w-[14px] h-[8px] rounded-[2px]"
                  style={{ background: VERDICT_META[v].color, opacity: v === "none" ? 0.5 : 0.75 }}
                />
                {VERDICT_META[v].label}
              </span>
            ))}
            <span className="text-[var(--qz-fg-4)]">
              {resp && (
                <>
                  {metric === "bytes"
                    ? formatBytes(resp.total_bytes)
                    : `${resp.total_conns.toLocaleString()} hits`}
                  {" · "}
                  {resp.flow_count} flows
                  {attributedPct !== null && <> · {attributedPct}% rule-attributed</>}
                  {" · "}
                </>
              )}
              Click a node to filter · only rules with logging enabled attribute flows to rules
              {resp?.truncated && <> · showing the top {resp.flows.length} of {resp.flow_count} flows</>}
            </span>
          </div>

          {/* Top flows (table view of the same data) */}
          {topFlows.length > 0 && (
            <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-subtle)" }}>
              <table ref={resize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: resize.tableLayout }}>
                <colgroup>
                  {TOP_FLOW_COLS.map((c) => (
                    <col key={c.key} style={{ width: resize.colWidth(c.key) }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    {TOP_FLOW_COLS.map((c, i) => (
                      <th key={c.key} {...resize.thProps(i)} style={c.right ? { textAlign: "right" } : undefined}>
                        {c.header}
                        {resize.handle(i)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topFlows.map((r, i) => {
                    const v = verdictOf(r);
                    return (
                      <tr key={i} style={{ cursor: "default" }}>
                        <td className="mono text-[12px]">{r.src_name ?? r.src}</td>
                        <td className="mono text-[12px]">{r.in_if ?? "—"}</td>
                        <td className="text-[12px]">
                          <span className="inline-flex items-center gap-[6px]">
                            <span className={`badge ${v === "allow" ? "badge-ok" : v === "block" ? "badge-crit" : "badge-muted"} flex-shrink-0`}>
                              {VERDICT_META[v].label}
                            </span>
                            {r.chain
                              ? r.rule !== undefined
                                ? ruleNames.get(`${r.chain}:${r.rule}`) ?? `Rule ${r.rule}`
                                : "Default action"
                              : "(not logged)"}
                          </span>
                        </td>
                        <td className="mono text-[12px]">{r.out_if ?? "—"}</td>
                        <td className="mono text-[12px]">{r.dst_name ?? r.dst}</td>
                        <td className="mono text-[12px]">{r.proto ? (r.dport ? `${r.proto}/${r.dport}` : r.proto) : "—"}</td>
                        <td className="mono text-[12px]" style={{ textAlign: "right" }}>{r.conns.toLocaleString()}</td>
                        <td className="mono text-[12px]" style={{ textAlign: "right" }}>{formatBytes(r.bytes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
