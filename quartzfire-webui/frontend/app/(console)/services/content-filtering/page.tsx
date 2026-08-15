"use client";

// Content Filtering — e2guardian ICAP server behind the Squid ssl_bump.
//
// e2guardian runs in ICAP SERVER mode only (no proxy, no MITM): Squid bumps TLS
// and forwards decrypted plaintext over ICAP; e2guardian applies URL/domain/
// category filtering + phrase scanning and returns the block page. Config edits
// are real VyOS config (`service content-filtering …`) committed under
// commit-confirm. Status/categories/update/logs/test-url come from the backend
// (qfcf helpers). Requires SSL Inspection enabled — the box refuses the commit
// otherwise, and this page warns before that bites.
//
// UI conventions mirror the SSL Inspection page (the sibling this feature sits
// behind): Clarity cards, tabs, .badge indicators, and themed modals instead of
// window.confirm/window.prompt.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { ColumnsMenu, useColumnVisibility } from "@/components/dashboard/ColumnsMenu";
import { useColumnResize } from "@/components/dashboard/ColumnResize";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { Tabs } from "@/components/ui/Tabs";
import { useDashboard } from "@/lib/DashboardContext";
import { emptySslInspectionConfig, fetchSslInspection, SslInspectionConfig } from "@/lib/ssl-inspection";
import {
  applyContentFiltering, CfCategory, CfLogEntry, CfStatusReport, ContentFilteringConfig,
  emptyContentFilteringConfig, emptyGroup, fetchCfCategories, fetchCfLogs,
  fetchCfStatus, fetchContentFiltering, FilterGroup, LogLevel, requestCfUpdate,
  setContentFilteringEnabled, testCfUrl, validateCidr, validateDomain,
} from "@/lib/content-filtering";

const fieldLabel = "clr-control-label";

/// Clarity status pill (mono uppercase), per the design reference.
const pillStyle = { fontFamily: "var(--qz-font-mono)", letterSpacing: "0.06em" } as const;

// ── status indicator (label + badge row) ─────────────────────────────────────

function Indicator({ label, state, detail }: { label: string; state: "ok" | "warn" | "muted"; detail?: string }) {
  const cls = state === "ok" ? "badge-ok" : state === "warn" ? "badge-warn" : "badge-muted";
  return (
    <div className="flex items-center justify-between gap-3 py-[5px]">
      <span className="text-[13px] text-[var(--cds-alias-typography-color-300)]">{label}</span>
      <span className={`badge ${cls}`}>{detail ?? (state === "ok" ? "OK" : "—")}</span>
    </div>
  );
}

// ── comma/enter list editor for multi-value string fields ─────────────────────

function ListEditor({
  label, items, onChange, placeholder, validate,
}: {
  label: string; items: string[]; onChange: (v: string[]) => void;
  placeholder: string; validate?: (v: string) => string | null;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    const e = validate?.(v) ?? null;
    if (e) { setErr(e); return; }
    if (!items.includes(v)) onChange([...items, v]);
    setDraft(""); setErr(null);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className={fieldLabel}>{label}</span>
      <div className="flex flex-wrap gap-1.5 my-1">
        {items.map((it) => (
          <span key={it} className="inline-flex items-center gap-1 badge badge-muted mono">
            {it}
            <button type="button" onClick={() => onChange(items.filter((x) => x !== it))}
              className="hover:text-[var(--cds-alias-status-danger)]" title="Remove"
              style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
              <Icon shape="times" size={12} />
            </button>
          </span>
        ))}
        {items.length === 0 && <span className="text-[12px] text-[var(--cds-alias-typography-color-200)]">none</span>}
      </div>
      <div className="flex gap-2">
        <input
          value={draft} placeholder={placeholder}
          onChange={(e) => { setDraft(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          className="clr-input flex-1 mono"
          style={{ maxWidth: "none" }}
        />
        <Button kind="secondary" size="sm" icon="plus" onClick={add}>Add</Button>
      </div>
      {err && <span className="text-[12px] text-[var(--cds-alias-status-danger)]">{err}</span>}
    </div>
  );
}

// ── filter-group editor modal ────────────────────────────────────────────────

function GroupEditor({
  group, categories, isDefault, onSave, onClose,
}: {
  group: FilterGroup; categories: CfCategory[]; isDefault: boolean;
  onSave: (g: FilterGroup) => void; onClose: () => void;
}) {
  const [g, setG] = useState<FilterGroup>(group);
  const [catSearch, setCatSearch] = useState("");
  const set = <K extends keyof FilterGroup>(k: K, v: FilterGroup[K]) => setG((p) => ({ ...p, [k]: v }));
  const shownCats = useMemo(
    () => categories.filter((c) => c.name.toLowerCase().includes(catSearch.toLowerCase())),
    [categories, catSearch],
  );
  const toggleCat = (name: string) =>
    set("categories", g.categories.includes(name) ? g.categories.filter((c) => c !== name) : [...g.categories, name]);

  const toggleRow = (title: string, hint: string, on: boolean, onToggle: (v: boolean) => void) => (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-[13px] text-[var(--cds-alias-typography-color-400)]">{title}</div>
        <div className="text-[12px] text-[var(--cds-alias-typography-color-200)]">{hint}</div>
      </div>
      <Switch on={on} onChange={onToggle} />
    </div>
  );

  return (
    <ModalShell onClose={onClose} maxWidth={720}>
      <ModalHeader title={`Action: ${g.name}`} onClose={onClose} />
      <div className="flex flex-col gap-4">
        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <label className={fieldLabel}>Description</label>
          <input value={g.description ?? ""}
            onChange={(e) => set("description", e.target.value || null)}
            className="clr-input" style={{ maxWidth: "none" }} />
        </div>

        {isDefault ? (
          <p className="text-[13px] text-[var(--cds-alias-typography-color-300)] m-0">
            This is the <b>default</b> action — clients not matched by any other action&apos;s source subnet
            land here. It needs no source subnets.
          </p>
        ) : (
          <ListEditor label="Source subnets (clients mapped to this group)" items={g.sourceAddress}
            onChange={(v) => set("sourceAddress", v)} placeholder="10.0.20.0/24" validate={validateCidr} />
        )}

        {toggleRow("Blanket block (whitelist mode)", "Deny everything except the allow list below.",
          g.blanketBlock, (v) => set("blanketBlock", v))}

        <div className="flex flex-col gap-1">
          <span className={fieldLabel}>Blocked categories ({g.categories.length} selected)</span>
          <div className="flex items-center gap-2 my-1">
            <Icon shape="search" size={13} className="text-[var(--cds-alias-typography-color-200)]" />
            <input value={catSearch} placeholder="Search categories…"
              onChange={(e) => setCatSearch(e.target.value)}
              className="clr-input flex-1" style={{ maxWidth: "none" }} />
          </div>
          <div
            className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto rounded-lg p-1"
            style={{ background: "var(--cds-alias-object-container-background)", border: "1px solid var(--cds-alias-object-border-color)" }}
          >
            {shownCats.length === 0 && (
              <span className="text-[12px] text-[var(--cds-alias-typography-color-200)] col-span-2 p-2">
                No categories installed yet — run a blocklist update on the Overview tab.
              </span>
            )}
            {shownCats.map((c) => (
              <label key={c.name} className="clr-checkbox-wrapper cursor-pointer text-[12px] px-1 py-0.5 text-[var(--cds-alias-typography-color-400)]">
                <input type="checkbox" checked={g.categories.includes(c.name)} onChange={() => toggleCat(c.name)} />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-[10px] text-[var(--cds-alias-typography-color-200)]">{c.entries.toLocaleString()}</span>
              </label>
            ))}
          </div>
        </div>

        <ListEditor label="Custom blocked domains" items={g.blockDomains} onChange={(v) => set("blockDomains", v)}
          placeholder="ads.example.com" validate={validateDomain} />
        <ListEditor label="Allowed / bypass domains (override blocks)" items={g.allowDomains} onChange={(v) => set("allowDomains", v)}
          placeholder="safe.example.com" validate={validateDomain} />
        <ListEditor label="Blocked URL regexes" items={g.blockUrlRegex} onChange={(v) => set("blockUrlRegex", v)}
          placeholder="/tracker/.*" />

        {toggleRow("Safe search", "Google / Bing / DuckDuckGo + YouTube Restricted.",
          g.safeSearch, (v) => set("safeSearch", v))}
        {toggleRow("Phrase filtering", "Content scanning of page text.",
          g.phraseFiltering, (v) => set("phraseFiltering", v))}
        {g.phraseFiltering && (
          <div className="flex flex-col gap-1">
            <span className={fieldLabel}>Naughtyness limit: {g.naughtynessLimit} (lower = stricter)</span>
            <input type="range" min={50} max={500} step={10} value={g.naughtynessLimit}
              onChange={(e) => set("naughtynessLimit", Number(e.target.value))} className="clr-range w-full mt-1" />
          </div>
        )}

        <ListEditor label="Blocked file extensions" items={g.blockFileExtensions} onChange={(v) => set("blockFileExtensions", v)}
          placeholder=".exe" />
        <ListEditor label="Blocked MIME types" items={g.blockMimeTypes} onChange={(v) => set("blockMimeTypes", v)}
          placeholder="application/x-dosexec" />
      </div>
      <ModalFooter>
        <Button kind="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button kind="primary" size="sm" icon="check" onClick={() => onSave(g)}>Save Group</Button>
      </ModalFooter>
    </ModalShell>
  );
}

// ── new-group name modal (themed replacement for window.prompt) ───────────────

function NameModal({ existing, onCreate, onClose }: {
  existing: string[]; onCreate: (name: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const n = name.trim();
    if (!n) { setErr("Enter a name."); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n)) { setErr("Letters, digits, hyphen and underscore only."); return; }
    if (existing.includes(n)) { setErr("A group with that name already exists."); return; }
    onCreate(n);
  };
  return (
    <ModalShell onClose={onClose} maxWidth={440}>
      <ModalHeader title="New Action" subtitle="Clients are mapped to an action by source subnet." onClose={onClose} />
      <div className="flex flex-col gap-3">
        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <label className={fieldLabel}>Action name</label>
          <input autoFocus value={name} placeholder="engineering"
            onChange={(e) => { setName(e.target.value); setErr(null); }}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
            className="clr-input" style={{ maxWidth: "none" }} />
          {err && <div className="clr-subtext" style={{ color: "var(--cds-alias-status-danger)" }}>{err}</div>}
        </div>
        <ModalFooter>
          <Button kind="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button kind="primary" size="sm" icon="plus" onClick={submit}>Create</Button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}

// ── themed confirm (mirrors the SSL Inspection page) ──────────────────────────

function ConfirmModal({
  title, confirmLabel, onCancel, onConfirm, children,
}: {
  title: string; confirmLabel: string;
  onCancel: () => void; onConfirm: () => Promise<void>; children: React.ReactNode;
}) {
  const [working, setWorking] = useState(false);
  const close = () => { if (!working) onCancel(); };
  const run = async () => { setWorking(true); try { await onConfirm(); } finally { setWorking(false); } };
  return (
    <ModalShell onClose={close} maxWidth={460}>
      <ModalHeader title={title} onClose={close} />
      <div className="flex flex-col gap-4">
        <div className="alert alert-warning">
          <Icon shape="shield-x" size={16} className="alert-icon" />
          <div className="alert-text flex flex-col gap-2 [&_p]:m-0">{children}</div>
        </div>
        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={close} disabled={working}>
            Cancel
          </button>
          <button type="button" className="btn btn-warning" onClick={run} disabled={working}>
            {working ? "Working…" : confirmLabel}
          </button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

// Toggleable columns for the access log. Every cell is a plain value, so the
// render lives right on the column.
interface CfLogCol {
  key: string;
  header: string;
  className?: string;
  title?: (l: CfLogEntry) => string | undefined;
  cell: (l: CfLogEntry) => React.ReactNode;
}

/** Resizable columns of the Actions (groups) table — the trailing edit cell is fixed. */
const CF_GROUP_COLS = [
  { key: "action", header: "Action", width: 220 },
  { key: "sources", header: "Sources" },
  { key: "categories", header: "Categories", width: 120 },
  { key: "custom", header: "Custom", width: 170 },
];

const CF_LOG_COLUMNS: CfLogCol[] = [
  { key: "time", header: "Time", className: "mono text-[12px] text-[var(--cds-alias-typography-color-300)] whitespace-nowrap", cell: (l) => l.ts.replace("T", " ") },
  { key: "client", header: "Client", className: "mono text-[12px] text-[var(--cds-alias-typography-color-300)]", cell: (l) => l.client_ip },
  { key: "group", header: "Group", className: "text-[12px] text-[var(--cds-alias-typography-color-400)]", cell: (l) => l.group ?? "—" },
  { key: "url", header: "URL", className: "text-[12px] text-[var(--cds-alias-typography-color-400)] max-w-[22rem] truncate", title: (l) => l.url, cell: (l) => l.url },
  { key: "category", header: "Category", className: "text-[12px] text-[var(--cds-alias-typography-color-300)]", cell: (l) => l.category ?? "—" },
  {
    key: "action",
    header: "Action",
    cell: (l) => (
      <span className={`label ${l.action === "blocked" ? "label-danger" : "label-success"}`} style={pillStyle}>
        {l.action.toUpperCase()}
      </span>
    ),
  },
];

export default function ContentFilteringPage() {
  const { setToast } = useDashboard();
  const [tab, setTab] = useState("overview");
  const [live, setLive] = useState<ContentFilteringConfig>(emptyContentFilteringConfig());
  const [draft, setDraft] = useState<ContentFilteringConfig>(emptyContentFilteringConfig());
  const [ssl, setSsl] = useState<SslInspectionConfig>(emptySslInspectionConfig());
  // null = the SSL Inspection config read succeeded (so `ssl.enabled` is
  // authoritative); a string = we couldn't read it, so we must NOT infer
  // "disabled" from the fallback and gate on it.
  const [sslReadError, setSslReadError] = useState<string | null>(null);
  const [status, setStatus] = useState<CfStatusReport | null>(null);
  const [categories, setCategories] = useState<CfCategory[]>([]);
  const [logs, setLogs] = useState<CfLogEntry[]>([]);
  const logVis = useColumnVisibility("cf-logs", CF_LOG_COLUMNS);
  const logCols = CF_LOG_COLUMNS.filter((c) => logVis.isVisible(c.key));
  const logResize = useColumnResize("cf-logs", logCols.map((c) => ({ key: c.key })));
  const groupResize = useColumnResize("cf-groups", CF_GROUP_COLS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<FilterGroup | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [logFilter, setLogFilter] = useState<{ group: string; action: string }>({ group: "", action: "" });

  const reloadConfig = useCallback(async () => {
    const cf = await fetchContentFiltering();
    setLive(cf); setDraft(cf);
    // Read SSL Inspection separately so a failure here is reported as
    // "couldn't read" rather than silently collapsing to "disabled" — the
    // latter fabricates a gate that blocks enabling even when SSL is on.
    try {
      setSsl(await fetchSslInspection());
      setSslReadError(null);
    } catch (e) {
      setSslReadError((e as Error).message || "Could not read the SSL Inspection status.");
    }
  }, []);

  const reloadStatus = useCallback(async () => {
    const [st, cats] = await Promise.all([fetchCfStatus().catch(() => null), fetchCfCategories().catch(() => [])]);
    setStatus(st); setCategories(cats);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try { await Promise.all([reloadConfig(), reloadStatus()]); } finally { setLoading(false); }
    })();
  }, [reloadConfig, reloadStatus]);

  // Logs auto-refresh while the Logs tab is open.
  useEffect(() => {
    if (tab !== "logs") return;
    let active = true;
    const load = () => fetchCfLogs({ limit: 200, group: logFilter.group, action: logFilter.action })
      .then((e) => active && setLogs(e)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { active = false; clearInterval(t); };
  }, [tab, logFilter]);

  const dirty = useMemo(() => JSON.stringify(live) !== JSON.stringify(draft), [live, draft]);
  const blocked24h = useMemo(() => logs.filter((l) => l.action === "blocked").length, [logs]);

  const applyEnable = async (on: boolean) => {
    setSaving(true);
    try {
      await setContentFilteringEnabled(live, on);
      await reloadConfig(); await reloadStatus();
      setToast(on ? "Content Filtering enabled." : "Content Filtering disabled.");
    } catch (e) { setToast(`Failed: ${(e as Error).message}`); } finally { setSaving(false); }
  };

  // Enabling filters all bumped HTTPS fail-closed, so confirm first; disabling
  // is safe and applies straight away. Requires SSL Inspection for plaintext.
  const onToggleRequest = (on: boolean) => {
    // Only block on a KNOWN-disabled read. If the SSL read failed
    // (sslReadError set), don't fabricate the gate — let the attempt through;
    // the device's own commit check is authoritative and will refuse with a
    // clear message if SSL really is off.
    if (on && sslReadError === null && !ssl.enabled) {
      setToast("Enable SSL Inspection first — Content Filtering needs the decrypted traffic.");
      return;
    }
    if (on) { setConfirmEnable(true); return; }
    applyEnable(false);
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const n = await applyContentFiltering(live, draft);
      await reloadConfig();
      setToast(n === 0 ? "No changes to apply." : `Applied ${n} change${n === 1 ? "" : "s"}.`);
    } catch (e) { setToast(`Failed: ${(e as Error).message}`); } finally { setSaving(false); }
  };

  const onUpdateNow = async () => {
    try { await requestCfUpdate(); setToast("Blocklist update requested — refreshing shortly…"); setTimeout(reloadStatus, 4000); }
    catch (e) { setToast(`Failed: ${(e as Error).message}`); }
  };

  const saveGroup = (g: FilterGroup) => {
    const groups = draft.groups.some((x) => x.name === g.name)
      ? draft.groups.map((x) => (x.name === g.name ? g : x))
      : [...draft.groups, g];
    setDraft({ ...draft, groups });
    setEditing(null);
  };

  const bl = status?.blocklist_update;

  if (loading) {
    return <div className="text-[13px] text-[var(--cds-alias-typography-color-200)]">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div style={{ marginRight: "auto" }}>
          <h2>Content Filtering</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            URL and category filtering — clients are mapped to an action by source subnet.
          </p>
        </div>
        <span className="flex items-center gap-2 pt-1">
          <span className={`label${live.enabled ? " label-success" : ""}`} style={pillStyle}>
            {live.enabled ? "ENABLED" : "DISABLED"}
          </span>
          <span aria-disabled={saving} style={{ opacity: saving ? 0.5 : 1 }}>
            <Switch on={live.enabled} onChange={onToggleRequest} />
          </span>
        </span>
      </div>

      <Tabs
        value={tab} onChange={setTab}
        items={[
          { value: "overview", label: "Overview" },
          { value: "groups", label: "Actions", count: draft.groups.length },
          { value: "blockpage", label: "Block Page" },
          { value: "logs", label: "Logs" },
        ]}
        trailing={
          dirty ? (
            <Button size="sm" icon="check" onClick={onSave} disabled={saving}>
              {saving ? "Applying…" : "Apply Changes"}
            </Button>
          ) : undefined
        }
      />

      <div>
        <div className="max-w-[1000px] flex flex-col gap-4">
          {sslReadError !== null ? (
            <div className="alert alert-warning">
              <Icon shape="exclamation-triangle" size={16} className="alert-icon" />
              <div className="alert-text">
                <b>Couldn&apos;t read the SSL Inspection status.</b> Content Filtering needs SSL Inspection
                enabled, but this page couldn&apos;t confirm its state ({sslReadError}). Check the{" "}
                <Link href="/services/ssl-inspection" className="underline" style={{ color: "var(--cds-alias-typography-link-color)" }}>SSL Inspection</Link>{" "}
                page — if it&apos;s enabled there, you can still enable Content Filtering here.
              </div>
            </div>
          ) : !ssl.enabled && (
            <div className="alert alert-warning">
              <Icon shape="exclamation-triangle" size={16} className="alert-icon" />
              <div className="alert-text">
                <b>SSL Inspection is disabled.</b> Content Filtering has no decrypted traffic to inspect and the
                commit will be refused. Enable it on the{" "}
                <Link href="/services/ssl-inspection" className="underline" style={{ color: "var(--cds-alias-typography-link-color)" }}>SSL Inspection</Link> page first.
              </div>
            </div>
          )}

          {tab === "overview" && (
            <div className="grid md:grid-cols-2 gap-4">
              <section className="card">
                <div className="card-header">Daemon &amp; ICAP</div>
                <div className="card-block flex flex-col gap-1">
                  <Indicator label="e2guardian running" state={status?.e2guardian_active ? "ok" : "muted"}
                    detail={status?.e2guardian_active ? "active" : "stopped"} />
                  <Indicator label="ICAP listener" state={status?.icap_listening ? "ok" : "muted"}
                    detail={status?.icap_listening ? `:${status?.icap_port ?? live.listenPort}` : "down"} />
                  <Indicator label="SSL Inspection (required)"
                    state={sslReadError !== null ? "warn" : ssl.enabled ? "ok" : "warn"}
                    detail={sslReadError !== null ? "unknown" : ssl.enabled ? "enabled" : "disabled"} />
                  <Indicator label="Last apply" state={status?.apply_ok === false ? "warn" : "muted"}
                    detail={status?.apply_error ? "error" : status?.apply_ok ? "ok" : "—"} />
                </div>
              </section>

              <section className="card">
                <div className="card-header">
                  Blocklists (UT1)
                  <span style={{ marginLeft: "auto" }}>
                    <Button kind="secondary" size="sm" icon="refresh" onClick={onUpdateNow}>Update Now</Button>
                  </span>
                </div>
                <div className="card-block flex flex-col gap-1">
                  <Indicator label="Installed categories" state={(status?.installed_categories ?? 0) > 0 ? "ok" : "muted"}
                    detail={String(status?.installed_categories ?? 0)} />
                  <Indicator label="Last update"
                    state={bl?.state === "failed" ? "warn" : bl?.state === "ok" ? "ok" : "muted"}
                    detail={bl?.state === "ok" ? `${bl.categories ?? "?"} cats` : bl?.state ?? "never"} />
                  {bl?.error && <p className="text-[12px] text-[var(--cds-alias-status-danger)] mt-1 m-0">{bl.error}</p>}
                  <Indicator label="Blocked (last 200 log lines)" state={blocked24h > 0 ? "warn" : "muted"} detail={String(blocked24h)} />
                </div>
              </section>

              <TestUrlWidget groups={draft.groups} setToast={setToast} />
            </div>
          )}

          {tab === "groups" && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <p className="text-[13px] text-[var(--cds-alias-typography-color-200)] m-0 flex-1">
                  An action decides what a set of clients can reach — blocked categories, custom allow/block
                  lists, and content scanning. Clients are mapped to an action by source subnet; the first
                  action is the default that unmatched clients fall to.
                </p>
                <Button kind="primary" size="sm" onClick={() => setAddingGroup(true)}>Add Action</Button>
              </div>
              <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
                <table ref={groupResize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: groupResize.tableLayout }}>
                  <colgroup>
                    {CF_GROUP_COLS.map((c) => (
                      <col key={c.key} style={{ width: groupResize.colWidth(c.key) }} />
                    ))}
                    <col style={{ width: 90 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {CF_GROUP_COLS.map((c, i) => (
                        <th key={c.key} {...groupResize.thProps(i)}>
                          {c.header}
                          {groupResize.handle(i)}
                        </th>
                      ))}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {draft.groups.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center text-[var(--cds-alias-typography-color-200)]" style={{ cursor: "default" }}>
                          No actions — add one to start filtering. The first action is the default (unmatched clients).
                        </td>
                      </tr>
                    ) : (
                      draft.groups.map((g, i) => (
                        <tr key={g.name} style={{ cursor: "pointer" }} onClick={() => setEditing(g)}>
                          <td>
                            <div className="font-semibold text-[var(--cds-alias-typography-color-450)] flex items-center gap-1.5">
                              {g.name}
                              {i === 0 && <span className="badge badge-muted">default</span>}
                            </div>
                            {g.description && <div className="text-[11px] text-[var(--cds-alias-typography-color-200)]">{g.description}</div>}
                          </td>
                          <td className="text-[12px] text-[var(--cds-alias-typography-color-300)]">{i === 0 ? "unmatched" : (g.sourceAddress.join(", ") || "—")}</td>
                          <td className="text-[12px] text-[var(--cds-alias-typography-color-300)]">
                            {g.blanketBlock
                              ? <span className="badge badge-warn">blanket block</span>
                              : `${g.categories.length} categor${g.categories.length === 1 ? "y" : "ies"}`}
                          </td>
                          <td className="text-[12px] text-[var(--cds-alias-typography-color-300)]">
                            {g.blockDomains.length + g.blockUrlRegex.length}b / {g.allowDomains.length}a
                            {g.phraseFiltering && " · phrase"}{g.safeSearch && " · safe"}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1">
                              <button type="button" className="btn btn-sm btn-link-neutral btn-icon" title="Edit" onClick={() => setEditing(g)}>
                                <Icon shape="pencil" size={15} />
                              </button>
                              {/* The default (first) action always exists — deleting it just
                                  re-seeds on reload, so only non-default actions are removable. */}
                              <button type="button" className="btn btn-sm btn-link-neutral btn-icon"
                                title={i === 0 ? "The default action cannot be removed" : "Remove"}
                                disabled={i === 0}
                                onClick={() => setDraft({ ...draft, groups: draft.groups.filter((x) => x.name !== g.name) })}
                                style={{ color: i === 0 ? undefined : "var(--cds-alias-status-danger)" }}>
                                <Icon shape="trash" size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "blockpage" && (
            <div className="grid md:grid-cols-2 gap-4">
              <section className="card">
                <div className="card-block flex flex-col gap-3">
                  <div className="clr-form-control" style={{ marginTop: 0 }}>
                    <label className={fieldLabel}>Message</label>
                    <textarea value={draft.blockPage.message ?? ""} rows={3}
                      onChange={(e) => setDraft({ ...draft, blockPage: { ...draft.blockPage, message: e.target.value || null } })}
                      className="clr-textarea" style={{ maxWidth: "none" }} placeholder="This site is blocked by policy." />
                  </div>
                  <div className="clr-form-control" style={{ marginTop: 0 }}>
                    <label className={fieldLabel}>Contact</label>
                    <input value={draft.blockPage.contact ?? ""}
                      onChange={(e) => setDraft({ ...draft, blockPage: { ...draft.blockPage, contact: e.target.value || null } })}
                      className="clr-input" style={{ maxWidth: "none" }} placeholder="it@example.com" />
                  </div>
                  <div className="clr-form-control" style={{ marginTop: 0 }}>
                    <label className={fieldLabel}>Access log level</label>
                    <Segmented value={draft.logLevel}
                      onChange={(v) => setDraft({ ...draft, logLevel: v as LogLevel })}
                      items={[
                        { value: "none", label: "None" },
                        { value: "blocked-only", label: "Blocked only" },
                        { value: "all", label: "All" },
                      ]} />
                  </div>
                </div>
              </section>
              <section className="card" style={{ minHeight: 200 }}>
                <div className="card-block">
                  <div className={`${fieldLabel} mb-2`}>Live preview</div>
                  {/* Mirrors the real e2guardian block page — its colors and radius are intentional. */}
                  <div className="p-4 text-center" style={{ background: "#0f1115", color: "#e6e8ec", borderRadius: 14 }}>
                    <div className="text-[15px] font-semibold" style={{ color: "#ff5c5c" }}>Access blocked</div>
                    <p className="text-[12px] mt-1" style={{ color: "#c3c8d1" }}>
                      {draft.blockPage.message || "This site is blocked by QuartzFire Content Filtering."}
                    </p>
                    <div className="text-[11px] mt-3 text-left inline-block" style={{ color: "#8b93a1" }}>
                      URL: example.com · Category: adult · Group: default
                    </div>
                    {draft.blockPage.contact && (
                      <p className="text-[11px] mt-2" style={{ color: "#8b93a1" }}>Need access? Contact {draft.blockPage.contact}.</p>
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}

          {tab === "logs" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input value={logFilter.group} placeholder="Filter by group"
                  onChange={(e) => setLogFilter((f) => ({ ...f, group: e.target.value }))}
                  className="clr-input" style={{ width: 200, maxWidth: "none" }} />
                <Segmented value={logFilter.action || "all"}
                  onChange={(v) => setLogFilter((f) => ({ ...f, action: v === "all" ? "" : v }))}
                  items={[
                    { value: "all", label: "All" },
                    { value: "blocked", label: "Blocked" },
                    { value: "allowed", label: "Allowed" },
                  ]} />
                <div className="ml-auto flex items-center gap-3">
                  <ColumnsMenu vis={logVis} />
                  <span className="text-[11px] text-[var(--cds-alias-typography-color-200)]">auto-refresh · {logs.length} shown</span>
                </div>
              </div>
              <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--cds-alias-object-border-color)" }}>
                <table ref={logResize.tableRef} className="qz-table" style={{ width: "100%", tableLayout: logResize.tableLayout }}>
                  <colgroup>
                    {logCols.map((c) => (
                      <col key={c.key} style={{ width: logResize.colWidth(c.key) }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      {logCols.map((c, i) => (
                        <th key={c.key} {...logResize.thProps(i)}>
                          {c.header}
                          {logResize.handle(i)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {logs.length === 0 && (
                      <tr>
                        <td colSpan={logCols.length} className="text-center text-[var(--cds-alias-typography-color-200)]" style={{ cursor: "default" }}>No log entries.</td>
                      </tr>
                    )}
                    {logs.map((l, i) => (
                      <tr key={i} style={{ cursor: "default" }}>
                        {logCols.map((c) => (
                          <td key={c.key} className={c.className} title={c.title?.(l)}>
                            {c.cell(l)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <GroupEditor
          group={editing} categories={categories}
          isDefault={draft.groups[0]?.name === editing.name || draft.groups.length === 0}
          onSave={saveGroup} onClose={() => setEditing(null)}
        />
      )}

      {addingGroup && (
        <NameModal
          existing={draft.groups.map((g) => g.name)}
          onClose={() => setAddingGroup(false)}
          onCreate={(name) => { setAddingGroup(false); setEditing(emptyGroup(name)); }}
        />
      )}

      {confirmEnable && (
        <ConfirmModal
          title="Enable Content Filtering?"
          confirmLabel="Enable Filtering"
          onCancel={() => setConfirmEnable(false)}
          onConfirm={async () => { setConfirmEnable(false); await applyEnable(true); }}
        >
          <p>
            All bumped HTTPS will be filtered by e2guardian in <strong>fail-closed</strong> mode: if the
            filter engine is unavailable, matching traffic is blocked rather than passed.
          </p>
          <p>Make sure your actions and allow lists are set up before enabling.</p>
        </ConfirmModal>
      )}
    </div>
  );
}

// ── test-URL widget ───────────────────────────────────────────────────────────

function TestUrlWidget({ groups, setToast }: { groups: FilterGroup[]; setToast: (s: string) => void }) {
  const [url, setUrl] = useState("");
  const [group, setGroup] = useState("");
  const [verdict, setVerdict] = useState<Awaited<ReturnType<typeof testCfUrl>> | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try { setVerdict(await testCfUrl(url.trim(), group || undefined)); }
    catch (e) { setToast(`Test failed: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  return (
    <section className="card md:col-span-2">
      <div className="card-header">
        <Icon shape="search" size={14} />
        Test URL
      </div>
      <div className="card-block flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <input value={url} placeholder="https://example.com/page"
            onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()}
            className="clr-input flex-1 min-w-[16rem] mono" style={{ maxWidth: "none" }} />
          <div className="clr-select-wrapper" style={{ width: "auto" }}>
            <select value={group} onChange={(e) => setGroup(e.target.value)} className="clr-select">
              <option value="">Default group</option>
              {groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
            </select>
          </div>
          <Button size="sm" onClick={run} disabled={busy}>{busy ? "Testing…" : "Test"}</Button>
        </div>
        {verdict && (
          <div className="flex items-center gap-2 text-[13px]">
            {verdict.action === "blocked"
              ? <span className="badge badge-crit">Blocked</span>
              : <span className="badge badge-ok">Allowed</span>}
            <span className="text-[var(--cds-alias-typography-color-200)]">
              {verdict.matched ? `matched ${verdict.matched}` : verdict.reason}{verdict.category ? ` (${verdict.category})` : ""}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
