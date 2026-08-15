"use client";

// Application Control — WatchGuard-style app identification on top of qfappd.
//
// Actions tab: named allow/block actions built from a category/app tree (the
// left-hand WatchGuard dialog), the "when application does not match" default,
// and drop-vs-reset block mode — stored as a desired-state policy a root helper
// applies to qfappd. Policies tab: which firewall rules enforce which action
// (each becomes a binding). Alerts tab: the live decision-event stream from the
// journal, with persistent history.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { ColumnsMenu, useColumnVisibility } from "@/components/dashboard/ColumnsMenu";
import { useColumnResize } from "@/components/dashboard/ColumnResize";

/** Resizable columns of the Actions tab table (the trailing edit/delete cell is fixed). */
const AC_ACTION_COLS = [
  { key: "action", header: "Action", width: 200 },
  { key: "apps", header: "Applications & categories" },
  { key: "default", header: "Default", width: 110 },
  { key: "policies", header: "Policies", width: 90 },
];

/** Resizable columns of the Policies tab's rules table. */
const AC_RULE_COLS = [
  { key: "rule", header: "#", width: 60, minWidth: 40 },
  { key: "name", header: "Name" },
  { key: "fromto", header: "From → To", width: 140 },
  { key: "action", header: "Action", width: 90 },
  { key: "ac", header: "Application control", width: 220 },
];
import { Segmented } from "@/components/ui/Segmented";
import { Tabs } from "@/components/ui/Tabs";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { useDashboard } from "@/lib/DashboardContext";
import {
  AcAction,
  AcConfig,
  AcEvent,
  AcStatus,
  Catalog,
  CATALOG_FIXTURE,
  CatalogApp,
  effectiveVerdict,
  emptyAcConfig,
  eventKey,
  fetchAcAlertHistory,
  fetchAcStatus,
  fetchCatalog,
  groupByCategory,
  saveAcConfig,
  Verdict,
} from "@/lib/appcontrol";
import { emptyFirewallConfig, fetchFirewall, FirewallConfig, FirewallRule, isBaseChain, ruleSelection } from "@/lib/firewall";
import { acMatchFromSelections } from "@/lib/rule-services";

type Tab = "actions" | "policies" | "alerts";

const dash = <span className="text-[var(--cds-alias-typography-color-200)]">—</span>;

/// Clarity status pill (mono uppercase), per the design reference.
const pillStyle = { fontFamily: "var(--qz-font-mono)", letterSpacing: "0.06em" } as const;

/// The ct-mark ACTION_ID field is 3 bits → at most 7 actions bound at once.
const MAX_BOUND_ACTIONS = 7;

// ── Actions tab ────────────────────────────────────────────────────────────────

function verdictBadge(v: Verdict) {
  return v === "block" ? (
    <span className="badge badge-crit">Block</span>
  ) : (
    <span className="badge badge-ok">Allow</span>
  );
}

function ActionsTab({
  config,
  catalog,
  onSave,
  saving,
  pendingCreate,
  onCreateConsumed,
}: {
  config: AcConfig;
  catalog: Catalog;
  onSave: (next: AcConfig) => void;
  saving: boolean;
  /** Set when the page-header "New Action" button was clicked — open the editor. */
  pendingCreate: boolean;
  onCreateConsumed: () => void;
}) {
  const [editing, setEditing] = useState<{ name: string; action: AcAction } | null>(null);
  const [creating, setCreating] = useState(false);
  const resize = useColumnResize("ac-actions", AC_ACTION_COLS);

  // The create button lives in the page-header row (DC anatomy); it survives
  // tab switches because the request is page state consumed here.
  useEffect(() => {
    if (!pendingCreate) return;
    onCreateConsumed();
    setCreating(true);
    setEditing({
      name: "",
      action: { default_action: "allow", block_mode: "drop", categories: {}, applications: {} },
    });
  }, [pendingCreate, onCreateConsumed]);

  const actionNames = Object.keys(config.actions);
  const bindingsByAction = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of config.bindings) m.set(b.action, (m.get(b.action) ?? 0) + 1);
    return m;
  }, [config.bindings]);

  const summarize = (a: AcAction) => {
    const apps = Object.keys(a.applications).length;
    const cats = Object.keys(a.categories).length;
    if (apps === 0 && cats === 0) return `Default ${a.default_action} for all`;
    const parts: string[] = [];
    if (cats) parts.push(`${cats} categor${cats === 1 ? "y" : "ies"}`);
    if (apps) parts.push(`${apps} app${apps === 1 ? "" : "s"}`);
    return parts.join(", ");
  };

  const removeAction = (name: string) => {
    if ((bindingsByAction.get(name) ?? 0) > 0) return;
    const actions = { ...config.actions };
    delete actions[name];
    onSave({ ...config, actions });
  };

  const commitEdit = (name: string, action: AcAction, originalName: string | null) => {
    const actions = { ...config.actions };
    if (originalName && originalName !== name) delete actions[originalName];
    actions[name] = action;
    // Rename: keep bindings pointing at the action.
    const bindings =
      originalName && originalName !== name
        ? config.bindings.map((b) => (b.action === originalName ? { ...b, action: name } : b))
        : config.bindings;
    onSave({ ...config, actions, bindings });
    setEditing(null);
    setCreating(false);
  };

  return (
    <div className="flex flex-col gap-4 max-w-[980px]">
      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
        <table ref={resize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: resize.tableLayout }}>
          <colgroup>
            {AC_ACTION_COLS.map((c) => (
              <col key={c.key} style={{ width: resize.colWidth(c.key) }} />
            ))}
            <col style={{ width: 130 }} />
          </colgroup>
          <thead>
            <tr>
              {AC_ACTION_COLS.map((c, i) => (
                <th key={c.key} {...resize.thProps(i)}>
                  {c.header}
                  {resize.handle(i)}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {actionNames.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-[var(--cds-alias-typography-color-200)]" style={{ cursor: "default" }}>
                  No actions yet — add one to get started.
                </td>
              </tr>
            ) : (
              actionNames.map((name) => {
                const a = config.actions[name];
                const uses = bindingsByAction.get(name) ?? 0;
                return (
                  <tr
                    key={name}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      setCreating(false);
                      setEditing({ name, action: structuredClone(a) });
                    }}
                  >
                    <td className="font-semibold text-[var(--cds-alias-typography-color-450)]">{name}</td>
                    <td className="text-[var(--cds-alias-typography-color-300)]">{summarize(a)}</td>
                    <td>{verdictBadge(a.default_action)}</td>
                    <td className="mono text-[var(--cds-alias-typography-color-300)]">{uses > 0 ? uses : dash}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className="btn btn-sm btn-link-neutral btn-icon"
                          title="Edit"
                          onClick={() => {
                            setCreating(false);
                            setEditing({ name, action: structuredClone(a) });
                          }}
                        >
                          <Icon shape="pencil" size={15} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-link-neutral btn-icon"
                          title={uses > 0 ? "In use by policies — detach first" : "Remove"}
                          disabled={uses > 0}
                          onClick={() => removeAction(name)}
                          style={{ color: uses > 0 ? undefined : "var(--cds-alias-status-danger)" }}
                        >
                          <Icon shape="trash" size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
        <div>Unset applications follow their category&apos;s verdict, then the action&apos;s default.</div>
        <div>
          Signature set:{" "}
          {catalog.available
            ? `nDPI ${catalog.ndpi_version} · ${catalog.num_protocols} applications`
            : "qfappd has not reported its catalog yet — showing a built-in sample until the service runs."}
          {saving && " · Saving…"}
        </div>
      </div>

      {editing && (
        <ActionEditor
          catalog={catalog}
          initialName={editing.name}
          initialAction={editing.action}
          existingNames={actionNames}
          isNew={creating}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onCommit={commitEdit}
        />
      )}
    </div>
  );
}

// ── Action editor (the WatchGuard left-hand dialog) ─────────────────────────────

function ActionEditor({
  catalog,
  initialName,
  initialAction,
  existingNames,
  isNew,
  onCancel,
  onCommit,
}: {
  catalog: Catalog;
  initialName: string;
  initialAction: AcAction;
  existingNames: string[];
  isNew: boolean;
  onCancel: () => void;
  onCommit: (name: string, action: AcAction, originalName: string | null) => void;
}) {
  const { setToast } = useDashboard();
  const [name, setName] = useState(initialName);
  const [action, setAction] = useState<AcAction>(initialAction);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

  const groups = useMemo(() => groupByCategory(catalog), [catalog]);
  const q = query.trim().toLowerCase();

  const setAppVerdict = (app: CatalogApp, verdict: Verdict | "inherit") => {
    setAction((a) => {
      const applications = { ...a.applications };
      if (verdict === "inherit") delete applications[app.name];
      else applications[app.name] = verdict;
      return { ...a, applications };
    });
  };

  const setCategoryVerdict = (category: string, verdict: Verdict) => {
    setAction((a) => {
      const categories = { ...a.categories };
      const apps = { ...a.applications };
      categories[category] = verdict;
      // "Select by Category" clears per-app overrides in that category so the
      // category rule is what shows.
      for (const app of catalog.applications) if (app.category === category) delete apps[app.name];
      return { ...a, categories, applications: apps };
    });
  };

  const clearCategory = (category: string) => {
    setAction((a) => {
      const categories = { ...a.categories };
      delete categories[category];
      return { ...a, categories };
    });
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return setToast("Give the action a name.");
    if ((isNew || trimmed !== initialName) && existingNames.includes(trimmed))
      return setToast(`An action named "${trimmed}" already exists.`);
    onCommit(trimmed, action, isNew ? null : initialName);
  };

  const visibleGroups = groups
    .filter((g) => categoryFilter === "all" || g.category === categoryFilter)
    .map((g) => ({
      ...g,
      apps: g.apps.filter((app) => !q || app.name.toLowerCase().includes(q) || app.category.toLowerCase().includes(q)),
    }))
    .filter((g) => g.apps.length > 0);

  return (
    <ModalShell onClose={onCancel} maxWidth={760}>
      <ModalHeader
        title="Application Control Action"
        subtitle={
          isNew
            ? "Set a per-application or per-category verdict; unset apps follow their category, then the default."
            : initialName
        }
        onClose={onCancel}
      />

      <div className="flex flex-col gap-4">
        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <label className="clr-control-label">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Global"
            className="clr-input"
            style={{ maxWidth: "none" }}
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Icon shape="search" size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--cds-alias-typography-color-200)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search applications…"
              className="clr-input"
              style={{ width: 220, maxWidth: "none", paddingLeft: 30 }}
            />
          </div>
          <div className="clr-select-wrapper" style={{ width: "auto" }}>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="clr-select"
            >
              <option value="all">All categories</option>
              {groups.map((g) => (
                <option key={g.category} value={g.category}>
                  {g.category}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div
          className="rounded-lg overflow-auto"
          style={{ border: "1px solid var(--cds-alias-object-border-color)", maxHeight: "42vh" }}
        >
          {visibleGroups.length === 0 ? (
            <div className="text-center text-[13px] text-[var(--cds-alias-typography-color-200)] py-6">No applications match.</div>
          ) : (
            visibleGroups.map((g) => {
              const catVerdict = action.categories[g.category];
              return (
                <div key={g.category}>
                  <div
                    className="flex items-center gap-3 px-3 py-[7px] sticky top-0"
                    style={{ background: "var(--cds-alias-object-container-background-shade)", borderBottom: "1px solid var(--cds-alias-object-border-subtle)" }}
                  >
                    <span className="text-[13px] font-semibold text-[var(--cds-alias-typography-color-450)] flex-1">{g.category}</span>
                    <span className="text-[11px] text-[var(--cds-alias-typography-color-200)]">Select by category:</span>
                    <span className="btn-group">
                      <button
                        type="button"
                        onClick={() => setCategoryVerdict(g.category, "allow")}
                        className={`btn btn-sm${catVerdict === "allow" ? " btn-primary" : ""}`}
                      >
                        Allow All
                      </button>
                      <button
                        type="button"
                        onClick={() => setCategoryVerdict(g.category, "block")}
                        className={`btn btn-sm${catVerdict === "block" ? " btn-danger" : ""}`}
                      >
                        Block All
                      </button>
                    </span>
                    {catVerdict && (
                      <button
                        type="button"
                        onClick={() => clearCategory(g.category)}
                        className="btn btn-sm btn-link-neutral"
                        title="Clear category rule"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {g.apps.map((app) => {
                    const explicit = action.applications[app.name];
                    const eff = effectiveVerdict(action, app);
                    return (
                      <div
                        key={app.id}
                        className="flex items-center gap-3 px-3 py-[6px]"
                        style={{ borderBottom: "1px solid var(--cds-alias-object-border-subtle)" }}
                      >
                        <span className="text-[13px] text-[var(--cds-alias-typography-color-450)] flex-1">{app.name}</span>
                        <span className="text-[11px] text-[var(--cds-alias-typography-color-200)] w-[64px] text-right">
                          {explicit ? "app rule" : action.categories[app.category] ? "category" : "default"}
                        </span>
                        <Segmented
                          items={[
                            { value: "allow", label: "Allow" },
                            { value: "block", label: "Block" },
                            { value: "inherit", label: "Auto" },
                          ]}
                          value={explicit ?? "inherit"}
                          onChange={(v) => setAppVerdict(app, v as Verdict | "inherit")}
                        />
                        <span className="w-[54px] text-right">{verdictBadge(eff)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-start gap-5 flex-wrap">
          <div className="clr-form-control" style={{ marginTop: 0 }}>
            <label className="clr-control-label">When application does not match</label>
            <Segmented
              items={[
                { value: "allow", label: "Allow" },
                { value: "block", label: "Block" },
              ]}
              value={action.default_action}
              onChange={(v) => setAction((a) => ({ ...a, default_action: v as Verdict }))}
            />
          </div>
          <div className="clr-form-control" style={{ marginTop: 0 }}>
            <label className="clr-control-label">Block mode</label>
            <Segmented
              items={[
                { value: "drop", label: "Drop" },
                { value: "reset", label: "Reset (TCP RST)" },
              ]}
              value={action.block_mode}
              onChange={(v) => setAction((a) => ({ ...a, block_mode: v as "drop" | "reset" }))}
            />
          </div>
        </div>

        <ModalFooter>
          <Button kind="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button kind="primary" onClick={save}>
            {isNew ? "Add Action" : "Save Action"}
          </Button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}

// ── Policies tab ────────────────────────────────────────────────────────────────

/// Rules that can carry an App Control binding: Allow rules on routed traffic.
/// qfappd classifies in its own table on the forward hook, so it sees forwarded
/// traffic — including zone rules between two network zones — but never traffic
/// to or from the box itself.
function bindable(rules: FirewallRule[]): FirewallRule[] {
  return rules.filter((r) => r.action === "accept" && (r.chain === "forward" || !isBaseChain(r.chain)));
}

function PoliciesTab({
  config,
  onSave,
  saving,
}: {
  config: AcConfig;
  onSave: (next: AcConfig) => void;
  saving: boolean;
}) {
  const { setToast } = useDashboard();
  const resize = useColumnResize("ac-rules", AC_RULE_COLS);
  const [fw, setFw] = useState<FirewallConfig>(emptyFirewallConfig);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setFw(await fetchFirewall());
      setState("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load the firewall config.");
      setState("error");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const actionNames = Object.keys(config.actions);
  const bindingByRule = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of config.bindings) m.set(b.id, b.action);
    return m;
  }, [config.bindings]);

  const boundActionCount = new Set(config.bindings.map((b) => b.action)).size;

  // Self-heal: drop bindings whose rule no longer exists (e.g. a rule deleted
  // before the delete-cascade shipped, or removed outside the WebUI). A binding
  // id is a rule number, so an id absent from every bindable rule is an orphan.
  // Zone rules count — keying this on the forward chain alone would delete every
  // zone rule's binding on the first visit to this page. Runs once, after the
  // live firewall config loads, so a stale "Policies N" count settles on its own.
  const healedRef = useRef(false);
  useEffect(() => {
    if (state !== "ready" || healedRef.current) return;
    const bindableNums = new Set(bindable(fw.rules).map((r) => r.rule));
    const kept = config.bindings.filter((b) => bindableNums.has(b.id));
    if (kept.length !== config.bindings.length) {
      healedRef.current = true;
      onSave({ ...config, bindings: kept });
    }
  }, [state, fw, config, onSave]);

  const setRuleAction = (rule: FirewallRule, action: string | null) => {
    const bindings = config.bindings.filter((b) => b.id !== rule.rule);
    if (action) {
      // Enforce the concurrently-bound-action ceiling before saving.
      const wouldBind = new Set([...bindings.map((b) => b.action), action]);
      if (wouldBind.size > MAX_BOUND_ACTIONS) {
        setToast(`At most ${MAX_BOUND_ACTIONS} actions can be active at once. Reuse an action already in use.`);
        return;
      }
      // The derivation fails closed — an unexpressible rule is refused rather
      // than bound with a match that would classify more traffic than the rule.
      let match;
      try {
        match = acMatchFromSelections(
          ruleSelection(rule, "from", fw.auto_groups, fw),
          ruleSelection(rule, "to", fw.auto_groups, fw),
          fw,
        );
      } catch (e) {
        setToast(e instanceof Error ? e.message : "This rule can't carry an Application Control action.");
        return;
      }
      bindings.push({
        id: rule.rule,
        action,
        description: rule.name ?? `rule ${rule.rule}`,
        match,
      });
    }
    onSave({ ...config, bindings });
  };

  if (state === "loading") return <div className="text-[13px] text-[var(--cds-alias-typography-color-200)]">Loading firewall rules…</div>;
  if (state === "error")
    return (
      <div className="flex flex-col gap-3">
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
        </div>
        <div>
          <Button kind="secondary" icon="refresh" onClick={load}>
            Retry
          </Button>
        </div>
      </div>
    );

  const eligible = bindable(fw.rules);

  return (
    <div className="flex flex-col gap-3 max-w-[900px]">
      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
        <table ref={resize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: resize.tableLayout }}>
          <colgroup>
            {AC_RULE_COLS.map((c) => (
              <col key={c.key} style={{ width: resize.colWidth(c.key) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {AC_RULE_COLS.map((c, i) => (
                <th key={c.key} {...resize.thProps(i)}>
                  {c.header}
                  {resize.handle(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {eligible.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-[var(--cds-alias-typography-color-200)]" style={{ cursor: "default" }}>
                  No eligible Allow rules — create them under{" "}
                  <Link href="/firewall/rules" className="text-[var(--cds-alias-typography-color-300)]">
                    Firewall → Rules
                  </Link>
                  .
                </td>
              </tr>
            ) : (
              eligible.map((r) => {
                const bound = bindingByRule.get(r.rule) ?? "";
                return (
                  <tr key={r.rule} style={{ cursor: "default", opacity: r.enabled ? 1 : 0.55 }}>
                    <td className="mono text-[var(--cds-alias-typography-color-300)]">{r.rule}</td>
                    <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name ?? <span className="text-[var(--cds-alias-typography-color-200)]">Rule {r.rule}</span>}
                    </td>
                    <td className="mono text-[12px] text-[var(--cds-alias-typography-color-300)]">
                      {(r.from.iface ?? "any") + " → " + (r.to.iface ?? "any")}
                    </td>
                    <td>
                      <span className="badge badge-ok">Allow</span>
                    </td>
                    <td onMouseDown={(e) => e.stopPropagation()}>
                      <div className="clr-select-wrapper" style={{ maxWidth: "none" }}>
                        <select
                          value={bound}
                          onChange={(e) => setRuleAction(r, e.target.value || null)}
                          className="clr-select"
                          style={{
                            maxWidth: "none",
                            color: bound ? "var(--cds-alias-interaction-action)" : "var(--cds-alias-typography-color-200)",
                          }}
                        >
                          <option value="">None</option>
                          {actionNames.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
        Attach an Application Control action to an Allow rule to classify and enforce its traffic.
        Rules for routed traffic are eligible — not traffic to or from the firewall itself. At most{" "}
        {MAX_BOUND_ACTIONS} actions can be active at once ({boundActionCount} in use
        {saving ? " · Saving…" : ""}).
      </div>
    </div>
  );
}

// ── Alerts tab ──────────────────────────────────────────────────────────────────

type AlertRow = AcEvent & { key: string };
const MAX_ALERTS = 500;

// Toggleable columns for the alerts log. Cells are plain values, so the render
// lives on the column.
interface AcAlertCol {
  key: string;
  header: string;
  width?: number;
  className?: string;
  ellipsis?: boolean;
  cell: (r: AlertRow) => React.ReactNode;
}

const AC_ALERT_COLUMNS: AcAlertCol[] = [
  { key: "time", header: "Time", width: 90, className: "mono text-[var(--cds-alias-typography-color-300)]", cell: (r) => (r.ts ? new Date(r.ts).toLocaleTimeString(undefined, { hour12: false }) : "—") },
  {
    key: "action",
    header: "Action",
    width: 90,
    cell: (r) =>
      r.action === "block" ? (
        <span className="label label-danger" style={pillStyle}>BLOCKED</span>
      ) : (
        <span className="label label-success" style={pillStyle}>ALLOWED</span>
      ),
  },
  { key: "app", header: "Application", width: 150, className: "text-[var(--cds-alias-typography-color-450)]", cell: (r) => r.app },
  { key: "category", header: "Category", width: 130, className: "text-[var(--cds-alias-typography-color-300)]", cell: (r) => r.category ?? dash },
  {
    key: "srcdst",
    header: "Source → destination",
    className: "mono text-[12px]",
    ellipsis: true,
    cell: (r) => (
      <>
        {r.src ?? "?"}
        {r.spt != null && <span className="text-[var(--cds-alias-typography-color-200)]">:{r.spt}</span>}
        {" → "}
        {r.dst ?? "?"}
        {r.dpt != null && <span className="text-[var(--cds-alias-typography-color-200)]">:{r.dpt}</span>}
      </>
    ),
  },
  { key: "sni", header: "SNI / host", width: 150, className: "mono text-[12px]", ellipsis: true, cell: (r) => r.sni ?? dash },
  { key: "policy", header: "Policy", width: 130, className: "text-[12px] text-[var(--cds-alias-typography-color-300)]", cell: (r) => r.action_name || dash },
];

function AlertsTab() {
  const rowsRef = useRef<AlertRow[]>([]);
  const dirtyRef = useRef(false);
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [stream, setStream] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [streamGen, setStreamGen] = useState(0);

  useEffect(() => {
    const es = new EventSource("/api/appcontrol/alerts");
    es.onopen = () => setStream("live");
    es.onerror = () => setStream("reconnecting");
    let throttle: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (!dirtyRef.current || pausedRef.current) return;
      dirtyRef.current = false;
      setRows(rowsRef.current);
    };
    const scheduleFlush = () => {
      if (throttle) return;
      flush();
      throttle = setTimeout(() => {
        throttle = null;
        flush();
      }, 75);
    };
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as AcEvent;
        rowsRef.current = [{ ...e, key: `${eventKey(e)}:${Math.random()}` }, ...rowsRef.current].slice(0, MAX_ALERTS);
        dirtyRef.current = true;
        scheduleFlush();
      } catch {
        // tolerate a malformed event
      }
    };

    let cancelled = false;
    fetchAcAlertHistory()
      .then((history) => {
        if (cancelled || history.length === 0) return;
        const seen = new Set(rowsRef.current.map((r) => eventKey(r)));
        const merged = [
          ...rowsRef.current,
          ...history.filter((e) => !seen.has(eventKey(e))).map((e) => ({ ...e, key: `${eventKey(e)}:${Math.random()}` })),
        ];
        merged.sort((a, b) => b.ts - a.ts);
        rowsRef.current = merged.slice(0, MAX_ALERTS);
        dirtyRef.current = true;
        scheduleFlush();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (throttle) clearTimeout(throttle);
      es.close();
    };
  }, [streamGen]);

  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<"all" | "block" | "allow">("block");

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (actionFilter !== "all" && r.action !== actionFilter) return false;
        if (!q) return true;
        const hay = [r.app, r.category, r.src, r.dst, r.action_name, r.sni, r.proto]
          .filter((v) => v != null && v !== "")
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      }),
    [rows, q, actionFilter],
  );

  const togglePause = () =>
    setPaused((p) => {
      pausedRef.current = !p;
      if (p) setRows(rowsRef.current);
      return !p;
    });
  const clear = () => {
    rowsRef.current = [];
    dirtyRef.current = false;
    setRows([]);
  };
  const vis = useColumnVisibility("ac-alerts", AC_ALERT_COLUMNS);
  const cols = AC_ALERT_COLUMNS.filter((c) => vis.isVisible(c.key));
  const alertResize = useColumnResize("ac-alerts", cols.map((c) => ({ key: c.key, width: c.width })));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Icon shape="search" size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--cds-alias-typography-color-200)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter alerts…"
            className="clr-input"
            style={{ width: 240, maxWidth: "none", paddingLeft: 30 }}
          />
        </div>
        <Segmented
          items={[
            { value: "block", label: "Blocked" },
            { value: "allow", label: "Allowed" },
            { value: "all", label: "All" },
          ]}
          value={actionFilter}
          onChange={(v) => setActionFilter(v as typeof actionFilter)}
        />
        <div className="ml-auto flex items-center gap-3">
          <ColumnsMenu vis={vis} />
          <Button
            kind="outline"
            size="sm"
            onClick={() => {
              clear();
              setStream("connecting");
              setStreamGen((g) => g + 1);
            }}
          >
            Refresh
          </Button>
          <Button kind="secondary" size="sm" icon={paused ? "play" : "pause"} onClick={togglePause}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button kind="secondary" size="sm" icon="times" onClick={clear}>
            Clear
          </Button>
          <span className="inline-flex items-center gap-[6px] text-[12px] text-[var(--cds-alias-typography-color-200)]">
            <span
              className="inline-block w-[7px] h-[7px] rounded-full"
              style={{ background: paused ? "var(--cds-alias-typography-color-200)" : stream === "live" ? "var(--cds-alias-status-success)" : "var(--cds-alias-status-warning)" }}
            />
            {paused ? "Paused" : stream === "live" ? "Live" : stream === "connecting" ? "Connecting…" : "Reconnecting…"}
            {" · "}
            {visible.length} {visible.length === 1 ? "alert" : "alerts"}
          </span>
        </div>
      </div>

      <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
        <table ref={alertResize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: alertResize.tableLayout }}>
          <colgroup>
            {cols.map((c) => (
              <col key={c.key} style={{ width: alertResize.colWidth(c.key) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={c.key} {...alertResize.thProps(i)}>
                  {c.header}
                  {alertResize.handle(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={cols.length} className="text-center text-[var(--cds-alias-typography-color-200)]" style={{ cursor: "default" }}>
                  {rows.length === 0
                    ? "No alerts yet — they appear when classified traffic matches an action."
                    : "No alerts match the filter."}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr
                  key={r.key}
                  style={{
                    cursor: "default",
                    background: r.action === "block" ? "var(--cds-alias-status-danger-tint)" : undefined,
                  }}
                >
                  {cols.map((c) => (
                    <td
                      key={c.key}
                      className={c.className}
                      style={c.ellipsis ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : undefined}
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

      <p className="text-[12px] text-[var(--cds-alias-typography-color-200)] m-0">
        Live decisions stream from qfappd; history is read from the persistent event log on the device
        (survives reboots). The newest {MAX_ALERTS} are shown. Blocked rows are highlighted.
      </p>
    </div>
  );
}

// ── page shell ──────────────────────────────────────────────────────────────────

export default function ApplicationControlPage() {
  const { setToast } = useDashboard();
  const [tab, setTab] = useState<Tab>("actions");
  const [status, setStatus] = useState<AcStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(CATALOG_FIXTURE);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [saving, setSaving] = useState(false);
  // Set by the page-header "New Action" button; consumed by the Actions tab.
  const [pendingCreate, setPendingCreate] = useState(false);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setState("loading");
    try {
      const [s, c] = await Promise.all([fetchAcStatus(), fetchCatalog().catch(() => CATALOG_FIXTURE)]);
      setStatus(s);
      setCatalog(c && (c.applications?.length ?? 0) > 0 ? c : CATALOG_FIXTURE);
      setState("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load Application Control.");
      setState("error");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const config = status?.settings ?? emptyAcConfig();

  const save = useCallback(
    async (next: AcConfig) => {
      // Optimistic: reflect immediately, persist, then re-read the applied state.
      setStatus((s) => (s ? { ...s, settings: next } : s));
      setSaving(true);
      try {
        await saveAcConfig(next);
        setToast("Application Control saved — applying on the device…");
        // The root helper applies asynchronously: re-read once quickly and
        // again after it has had time to run, so the apply banners settle.
        setTimeout(() => load("refresh"), 800);
        setTimeout(() => load("refresh"), 3500);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Failed to save Application Control.");
        load("refresh");
      } finally {
        setSaving(false);
      }
    },
    [load, setToast],
  );

  // Engine-state pill in the page header, per the DC reference.
  const rejected = !!(status?.status?.policy_last_error || status?.apply?.ok === false);
  const pill = rejected ? (
    <span
      className="label label-danger"
      style={pillStyle}
      title={status?.status?.policy_last_error || status?.apply?.error || undefined}
    >
      APPLY REJECTED
    </span>
  ) : status?.running ? (
    <span className="label label-success" style={pillStyle}>RUNNING</span>
  ) : (
    <span className="label" style={pillStyle}>NOT REPORTING</span>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="m-0">Application Control</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Classify flows by application and enforce per-app or per-category verdicts on Allow rules.
          </p>
        </div>
        <span className="flex items-center gap-2">
          {pill}
          <button type="button" className="btn" onClick={() => load("refresh")}>
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setTab("actions");
              setPendingCreate(true);
            }}
          >
            New Action
          </button>
        </span>
      </div>

      {status?.apply?.ok === false && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
          <div className="alert-text">
            The saved configuration failed validation and was <strong>not</strong> applied — the
            previously applied policy is still enforced. {status.apply.error}
          </div>
        </div>
      )}
      {status?.apply?.ok === true &&
        status.settings_mtime != null &&
        status.settings_mtime > status.apply.desired_mtime && (
          <div className="alert alert-warning alert-sm">
            <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
            <div className="alert-text">
              Saved changes have not been applied yet. This normally takes a second — if it
              persists, check <span className="mono">journalctl -u quartzfire-appcontrol-apply</span>{" "}
              on the device.
            </div>
          </div>
        )}

      <Tabs
        items={[
          { value: "actions", label: "Actions", count: Object.keys(config.actions).length },
          { value: "policies", label: "Policies", count: config.bindings.length },
          { value: "alerts", label: "Log" },
        ]}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
      />

      <div>
        {state === "loading" && <div className="text-[13px] text-[var(--cds-alias-typography-color-200)]">Loading Application Control…</div>}
        {state === "error" && (
          <div className="flex flex-col gap-3">
            <div className="alert alert-danger alert-sm">
              <Icon shape="exclamation-triangle" size={14} className="alert-icon" />
              <div className="alert-text">{errorMsg}</div>
            </div>
            <div>
              <Button kind="secondary" icon="refresh" onClick={() => load()}>
                Retry
              </Button>
            </div>
          </div>
        )}
        {state === "ready" && (
          <>
            {tab === "actions" && (
              <ActionsTab
                config={config}
                catalog={catalog}
                onSave={save}
                saving={saving}
                pendingCreate={pendingCreate}
                onCreateConsumed={() => setPendingCreate(false)}
              />
            )}
            {tab === "policies" && <PoliciesTab config={config} onSave={save} saving={saving} />}
            {tab === "alerts" && <AlertsTab />}
          </>
        )}
      </div>
    </div>
  );
}
