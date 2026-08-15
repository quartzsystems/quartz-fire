"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import {
  aliasDisplayName,
  counterKey,
  defaultDropBlockedReason,
  emptyFirewallConfig,
  fetchFirewall,
  fetchRuleCounters,
  FirewallConfig,
  FirewallRule,
  PROTOCOL_LABEL,
  RuleCounter,
  ruleKey,
  ruleSelection,
  setDefaultAction,
} from "@/lib/firewall";
import { applyRuleOrderWithCascade, deleteRuleWithCascade } from "@/lib/rule-cascade";
import { bridgeVifInterfaceNames, fetchBridges, fetchInterfaceDescriptions } from "@/lib/interfaces";
import { formatBytes } from "@/lib/format";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { RowActions } from "@/components/dashboard/RowActions";
import { useColumnResize } from "@/components/dashboard/ColumnResize";
import { RuleFormModal } from "./RuleFormModal";

/** Resizable columns of the rules table (the trailing Actions cell is fixed). */
const RULE_COLS = [
  { key: "order", header: "Order", width: 70 },
  { key: "action", header: "Action", width: 100 },
  { key: "name", header: "Name" },
  { key: "from", header: "From" },
  { key: "to", header: "To" },
  { key: "policy", header: "Policy" },
  { key: "hits", header: "Hits", width: 80 },
  { key: "status", header: "Status", width: 100 },
];

function ActionPill({ action }: { action: FirewallRule["action"] }) {
  if (action === "accept") return <span className="badge badge-ok">Allow</span>;
  if (action === "drop") return <span className="badge badge-crit">Deny</span>;
  if (action === "reject") return <span className="badge badge-warn">Reject</span>;
  return <span className="badge badge-muted">—</span>;
}


function EndpointCell({
  rule,
  side,
  config,
  descriptions,
}: {
  rule: FirewallRule;
  side: "from" | "to";
  config: FirewallConfig;
  descriptions: Record<string, string>;
}) {
  const sel = ruleSelection(rule, side, config.auto_groups, config);
  if (sel.length === 0) return <span className="text-[var(--cds-alias-typography-color-200)]">Any</span>;
  // Friendly names — interface descriptions, alias and zone display names; the
  // tooltip keeps the technical names.
  const raw = sel.map((e) =>
    e.kind === "address" ? e.address : e.kind === "inline" ? e.value : e.kind === "firewall" ? "Firewall" : e.name,
  );
  const names = sel.map((e) => {
    if (e.kind === "address") return e.address;
    if (e.kind === "inline") return e.value;
    if (e.kind === "firewall") return "Firewall";
    if (e.kind === "interface") return descriptions[e.name] ?? e.name;
    if (e.kind === "alias") return aliasDisplayName(config.aliases, e.type, e.name);
    if (e.kind === "zone") return config.zones.find((z) => z.name === e.name)?.display ?? e.name;
    return e.name;
  });
  const allIfaces = sel.every(
    (e) => e.kind === "interface" || e.kind === "ifgroup" || (e.kind === "alias" && e.type === "iface"),
  );
  // Long endpoint lists blow out the column and get truncated mid-word; show
  // the first few names plus a "+N" overflow chip instead. The full list stays
  // in the tooltip.
  const SHOWN = 3;
  const overflow = names.length - SHOWN;
  const shown = overflow > 0 ? names.slice(0, SHOWN) : names;
  return (
    <span
      style={{ fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}
      title={raw.join(", ")}
    >
      {shown.join(", ")}
      {overflow > 0 && <span className="text-[var(--cds-alias-typography-color-200)]"> +{overflow}</span>}
      {allIfaces && <span className="text-[var(--cds-alias-typography-color-200)]"> · iface</span>}
    </span>
  );
}

export default function FirewallRulesPage() {
  const { setToast } = useDashboard();
  const resize = useColumnResize("firewall-rules", RULE_COLS, { fixed: true });
  const [data, setData] = useState<FirewallConfig>(emptyFirewallConfig);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [ifaceDescriptions, setIfaceDescriptions] = useState<Record<string, string>>({});
  const [counters, setCounters] = useState<Map<string, RuleCounter>>(new Map());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  // null = closed; { rule: undefined } = create; { rule } = edit.
  const [modal, setModal] = useState<{ rule?: FirewallRule } | null>(null);

  // Display order as a list of rule keys. Dragging edits this locally;
  // "Apply Order" commits the renumbering in one transaction.
  const [order, setOrder] = useState<string[]>([]);
  const [applyingOrder, setApplyingOrder] = useState(false);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface names populate the rule form's From/To pickers; tolerate
      // their failure so a firewall read still renders.
      const [fw, ifs, descs, bridges] = await Promise.all([
        fetchFirewall(),
        fetchInterfaceStats().catch(() => []),
        fetchInterfaceDescriptions().catch(() => ({})),
        fetchBridges().catch(() => []),
      ]);
      // Counters wait on the firewall read: which zone-pair rulesets to read
      // counters from is only known once the pairs are.
      const hits = await fetchRuleCounters(fw.zone_pairs).catch(() => new Map<string, RuleCounter>());
      setData(fw);
      // Include config-derived bridge VIFs (e.g. br0.10) so a rule can match on
      // one — the rule picker is a fixed select, not free text.
      const names = new Set(ifs.map((i) => i.name));
      for (const n of bridgeVifInterfaceNames(bridges)) names.add(n);
      setInterfaces([...names].sort((a, b) => a.localeCompare(b)));
      setIfaceDescriptions(descs);
      setCounters(hits);
      setOrder(fw.rules.map(ruleKey));
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load firewall rules.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load("refresh");
    } finally {
      setRefreshing(false);
    }
  };

  const byKey = useMemo(() => new Map(data.rules.map((r) => [ruleKey(r), r])), [data.rules]);
  const orderedRules = useMemo(
    () => order.map((k) => byKey.get(k)).filter((r): r is FirewallRule => !!r),
    [order, byKey],
  );
  const orderDirty = useMemo(
    () =>
      orderedRules.some((r, i) => {
        const original = data.rules[i];
        return !original || ruleKey(original) !== ruleKey(r);
      }),
    [orderedRules, data.rules],
  );

  const policyByName = useMemo(() => new Map(data.policies.map((p) => [p.name, p])), [data.policies]);

  const q = query.trim().toLowerCase();
  const visibleRules = useMemo(() => {
    if (!q) return orderedRules;
    return orderedRules.filter((r) => {
      const hay = [
        r.name,
        r.action,
        r.chain !== "forward" ? "firewall" : null,
        r.from.group_name,
        r.from.address,
        r.from.iface,
        r.to.group_name,
        r.to.address,
        r.to.iface,
        r.policy,
        r.protocol,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [orderedRules, q]);
  // Dragging against a filtered list would reorder rules the user can't see.
  const dragEnabled = !q && visibleRules.length > 1;

  // ── row drag-and-drop (native HTML5, reorders live while hovering) ──────────
  const dragIndex = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const onRowDragOver = (e: React.DragEvent, over: number) => {
    const from = dragIndex.current;
    if (from === null || from === over) return;
    e.preventDefault();
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(over, 0, moved);
      return next;
    });
    dragIndex.current = over;
  };

  const commitOrder = async () => {
    setApplyingOrder(true);
    try {
      const { renumbered, repointedGeoPolicies, repointedAcBindings } =
        await applyRuleOrderWithCascade(orderedRules);
      const also: string[] = [];
      if (repointedAcBindings) {
        also.push(`${repointedAcBindings} Application Control binding${repointedAcBindings === 1 ? "" : "s"}`);
      }
      if (repointedGeoPolicies) {
        also.push(`${repointedGeoPolicies} Geolocation polic${repointedGeoPolicies === 1 ? "y" : "ies"}`);
      }
      setToast(
        `Reordered ${renumbered} rule${renumbered === 1 ? "" : "s"}.${also.length ? ` Repointed ${also.join(" and ")}.` : ""}`,
      );
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to apply the new rule order.");
    } finally {
      setApplyingOrder(false);
    }
  };

  const remove = async (rule: FirewallRule) => {
    try {
      const { removedGeoPolicies, removedAcBinding } = await deleteRuleWithCascade(
        rule,
        data.auto_groups,
        data,
      );
      const also: string[] = [];
      if (removedAcBinding) also.push("Application Control binding");
      if (removedGeoPolicies.length) {
        also.push(
          `${removedGeoPolicies.length} Geolocation polic${removedGeoPolicies.length === 1 ? "y" : "ies"}`,
        );
      }
      setToast(
        `Deleted rule ${rule.rule}.${also.length ? ` Also removed its ${also.join(" and ")}.` : ""}`,
      );
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete rule ${rule.rule}.`);
    }
  };

  // Denying by default in the forward chain would black-hole every zone rule's
  // traffic before the zone chains ever run — see defaultDropBlockedReason.
  const defaultDropBlocked = defaultDropBlockedReason(data);

  const changeDefaultAction = async (action: "accept" | "drop") => {
    try {
      await setDefaultAction(data, action);
      setToast(`Default action set to ${action === "accept" ? "Allow" : "Deny"}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to set the default action.");
    }
  };

  // Live nftables packet counter for the rule — how often it has matched.
  const hitFormat = useMemo(
    () => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }),
    [],
  );
  const hitsCell = (r: FirewallRule) => {
    // A rule spanning several zone pairs is counted once per pair — its real
    // hit count is the total across them.
    const parts = r.scopes.map((s) => counters.get(counterKey(s.chain, r.rule))).filter((x) => x !== undefined);
    if (parts.length === 0) return <span className="text-[var(--cds-alias-typography-color-200)]">—</span>;
    const c = parts.reduce((a, b) => ({ packets: a.packets + b.packets, bytes: a.bytes + b.bytes }));
    return (
      <span
        style={{
          fontFamily: "var(--qz-font-mono)",
          color: c.packets > 0 ? "var(--cds-alias-typography-color-450)" : "var(--cds-alias-typography-color-200)",
        }}
        title={`${c.packets.toLocaleString()} packets · ${formatBytes(c.bytes)}`}
      >
        {hitFormat.format(c.packets)}
      </span>
    );
  };

  const policyCell = (r: FirewallRule) => {
    if (r.policy) {
      const p = policyByName.get(r.policy);
      return (
        <span style={{ fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}>
          {r.policy}
          {p && (
            <span className="text-[var(--cds-alias-typography-color-200)]">
              {" "}
              · {PROTOCOL_LABEL[p.protocol].toLowerCase()}:{p.ports.join(",")}
            </span>
          )}
        </span>
      );
    }
    if (r.protocol) {
      return (
        <span style={{ fontFamily: "var(--qz-font-mono)", color: "var(--cds-alias-typography-color-450)" }}>
          {r.protocol === "icmp" ? "ping" : r.protocol}
        </span>
      );
    }
    return <span className="text-[var(--cds-alias-typography-color-200)]">Any</span>;
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Page header per the DC reference: title/sub left; search, the inline
          Default-action select, and the plain Refresh / primary Create buttons
          right-aligned beside it. */}
      <div className="flex items-start gap-2 flex-wrap">
        <div className="mr-auto">
          <h2>Rules</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            IPv4 rules for forwarded traffic and traffic to or from the firewall itself, evaluated top to bottom.
          </p>
        </div>
        {status === "ready" && (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search rules…"
              className="clr-input"
              style={{ width: 240, maxWidth: 240 }}
            />
            <span
              className="inline-flex items-center gap-2"
              style={{ fontSize: 12, color: "var(--cds-alias-typography-color-300)" }}
            >
              Default action
              {/* Unset means the VyOS base-chain default, accept — showing
                  drop would both misreport it and make Deny unselectable
                  (the change event never fires on an unchanged value). */}
              <span className="clr-select-wrapper" style={{ width: "auto" }}>
                <select
                  value={data.default_action === "drop" ? "drop" : "accept"}
                  onChange={(e) => changeDefaultAction(e.target.value as "accept" | "drop")}
                  disabled={defaultDropBlocked !== null}
                  title={defaultDropBlocked ?? undefined}
                  className="clr-select"
                  style={{ width: "auto", minWidth: 100, fontFamily: "var(--qz-font-mono)" }}
                >
                  <option value="drop">Deny</option>
                  <option value="accept">Allow</option>
                </select>
              </span>
            </span>
            <button type="button" className="btn" onClick={refresh} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setModal({})}>
              Create Rule
            </button>
          </>
        )}
      </div>

      {status === "loading" && <div className="clr-secondary">Loading firewall rules…</div>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
          <div className="alert-actions">
            <Button kind="secondary" size="sm" icon="refresh" onClick={() => load()}>Retry</Button>
          </div>
        </div>
      )}
      {status === "ready" && (
        <div className="flex flex-col gap-3">
          {/* Zones add a second layer of filtering, and the two AND together —
              say so, because a rule that allows traffic here can still be
              denied by a zone (and vice versa). */}
          {data.zones.length > 0 && (
            <div className="alert alert-info alert-sm">
              <Icon shape="info-circle" size={14} className="alert-icon" />
              <div className="alert-text">
                Zones are configured. Rules without a zone are checked first, for every packet — traffic has to pass
                both them and the rules of its zone pair. Deny by default is set per zone on the{" "}
                <Link href="/firewall/zones" className="text-[var(--cds-alias-typography-color-450)] underline">
                  Zones
                </Link>{" "}
                page.
              </div>
            </div>
          )}
          {/* Pending-order bar */}
          {orderDirty && (
            <div className="alert alert-warning alert-sm">
              <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
              <div className="alert-text">
                Rule order changed — not applied yet. Applying renumbers the rules and repoints any
                Application Control bindings and Geolocation policies.
              </div>
              <div className="alert-actions" style={{ display: "flex", gap: 8 }}>
                <Button kind="secondary" size="sm" icon="undo" onClick={() => setOrder(data.rules.map(ruleKey))} disabled={applyingOrder}>
                  Reset
                </Button>
                <Button kind="primary" size="sm" icon="check" onClick={commitOrder} disabled={applyingOrder}>
                  {applyingOrder ? "Applying…" : "Apply Order"}
                </Button>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
            <table ref={resize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: resize.tableLayout }}>
              <colgroup>
                {RULE_COLS.map((c) => (
                  <col key={c.key} style={{ width: resize.colWidth(c.key) }} />
                ))}
                <col style={{ width: 90 }} />
              </colgroup>
              <thead>
                <tr>
                  {RULE_COLS.map((c, i) => (
                    <th key={c.key} {...resize.thProps(i)}>
                      {c.header}
                      {resize.handle(i)}
                    </th>
                  ))}
                  {/* Actions column carries no header label, per the DC reference. */}
                  <th className="text-right" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visibleRules.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="text-center text-[var(--cds-alias-typography-color-200)]"
                      style={{ cursor: "default" }}
                    >
                      {q ? "No rules match the search." : "No firewall rules configured."}
                    </td>
                  </tr>
                ) : (
                  visibleRules.map((r) => {
                    const position = orderedRules.indexOf(r) + 1;
                    return (
                      <tr
                        key={ruleKey(r)}
                        draggable={dragEnabled}
                        onDragStart={(e) => {
                          dragIndex.current = orderedRules.indexOf(r);
                          setDragging(true);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => onRowDragOver(e, orderedRules.indexOf(r))}
                        onDrop={(e) => e.preventDefault()}
                        onDragEnd={() => {
                          dragIndex.current = null;
                          setDragging(false);
                        }}
                        style={{
                          opacity: r.enabled ? 1 : 0.55,
                          cursor: dragEnabled ? (dragging ? "grabbing" : "grab") : "default",
                        }}
                      >
                        <td className="mono">
                          <span className="inline-flex items-center gap-[6px]">
                            {dragEnabled && (
                              <Icon
                                shape="drag-handle"
                                size={13}
                                className="flex-shrink-0"
                                style={{ color: "var(--cds-alias-typography-color-200)" }}
                              />
                            )}
                            {position}
                          </span>
                        </td>
                        <td>
                          <span className="inline-flex items-center gap-[5px]">
                            <ActionPill action={r.action} />
                            {r.ips && (
                              <span className="badge badge-warn" title="Matches are inspected by the IPS engine">
                                IPS
                              </span>
                            )}
                          </span>
                        </td>
                        <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.name ?? <span className="text-[var(--cds-alias-typography-color-200)]">—</span>}
                        </td>
                        <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <EndpointCell rule={r} side="from" config={data} descriptions={ifaceDescriptions} />
                        </td>
                        <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <EndpointCell rule={r} side="to" config={data} descriptions={ifaceDescriptions} />
                        </td>
                        <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {policyCell(r)}
                        </td>
                        <td>{hitsCell(r)}</td>
                        <td>
                          <span className={r.enabled ? "badge badge-ok" : "badge badge-muted"}>
                            {r.enabled ? "Enabled" : "Disabled"}
                          </span>
                        </td>
                        <td onMouseDown={(e) => e.stopPropagation()} style={{ cursor: "default" }} className="text-right">
                          <RowActions
                            label={`rule ${r.rule}`}
                            onEdit={() => setModal({ rule: r })}
                            onDelete={() => remove(r)}
                          />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
            Forwarded traffic matching no rule falls through to the default action. Traffic to or from the firewall
            itself is allowed unless a rule denies it. Reordering is disabled while a search filter is active.
          </p>
        </div>
      )}

      {modal && (
        <RuleFormModal
          initial={modal.rule}
          interfaces={interfaces}
          descriptions={ifaceDescriptions}
          config={data}
          onClose={() => setModal(null)}
          onSaved={(msg) => {
            setModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
