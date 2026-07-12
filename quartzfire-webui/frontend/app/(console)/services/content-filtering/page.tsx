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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, Check, Plus, RotateCw, Trash2, ShieldCheck, Search, X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { Tabs } from "@/components/ui/Tabs";
import { useDashboard } from "@/lib/DashboardContext";
import { emptySslInspectionConfig, fetchSslInspection, SslInspectionConfig } from "@/lib/ssl-inspection";
import {
  applyContentFiltering, CfCategory, CfLogEntry, CfStatusReport, ContentFilteringConfig,
  DEFAULT_NAUGHTYNESS, emptyContentFilteringConfig, emptyGroup, fetchCfCategories, fetchCfLogs,
  fetchCfStatus, fetchContentFiltering, FilterGroup, LogLevel, requestCfUpdate,
  setContentFilteringEnabled, testCfUrl, validateCidr, validateDomain,
} from "@/lib/content-filtering";

const inputStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const cardStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;

function Indicator({ label, state, detail }: { label: string; state: "ok" | "warn" | "muted"; detail?: string }) {
  const cls = state === "ok" ? "badge-ok" : state === "warn" ? "badge-warn" : "badge-muted";
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[13px] text-[var(--qz-text-muted)]">{label}</span>
      <span className={`text-[12px] px-2 py-0.5 rounded ${cls}`}>{detail ?? (state === "ok" ? "OK" : "—")}</span>
    </div>
  );
}

/** A comma/enter list editor for multi-value string fields. */
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
    <div>
      <label className="text-[12px] text-[var(--qz-text-muted)]">{label}</label>
      <div className="flex flex-wrap gap-1 mt-1 mb-1">
        {items.map((it) => (
          <span key={it} className="inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded badge-muted">
            {it}
            <button type="button" onClick={() => onChange(items.filter((x) => x !== it))} className="cursor-pointer opacity-60 hover:opacity-100">
              <X size={11} />
            </button>
          </span>
        ))}
        {items.length === 0 && <span className="text-[12px] text-[var(--qz-text-muted)] italic">none</span>}
      </div>
      <div className="flex gap-1">
        <input
          value={draft} placeholder={placeholder} style={inputStyle}
          onChange={(e) => { setDraft(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          className="flex-1 rounded px-2 py-1 text-[13px]"
        />
        <Button kind="ghost" onClick={add}><Plus size={14} /></Button>
      </div>
      {err && <p className="text-[11px] text-[var(--qz-danger)] mt-1">{err}</p>}
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

  return (
    <ModalShell onClose={onClose} maxWidth={720}>
      <ModalHeader title={`Filter group: ${g.name}`} onClose={onClose} />
      <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
        <div>
          <label className="text-[12px] text-[var(--qz-text-muted)]">Description</label>
          <input value={g.description ?? ""} style={inputStyle}
            onChange={(e) => set("description", e.target.value || null)}
            className="w-full rounded px-2 py-1 text-[13px] mt-1" />
        </div>

        {isDefault ? (
          <p className="text-[12px] text-[var(--qz-text-muted)]">
            This is the <b>default</b> group — clients not matched by any other group&apos;s source subnet
            land here. It needs no source subnets.
          </p>
        ) : (
          <ListEditor label="Source subnets (clients mapped to this group)" items={g.sourceAddress}
            onChange={(v) => set("sourceAddress", v)} placeholder="10.0.20.0/24" validate={validateCidr} />
        )}

        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px]">Blanket block (whitelist mode)</div>
            <div className="text-[11px] text-[var(--qz-text-muted)]">Deny everything except the allow list below.</div>
          </div>
          <Switch on={g.blanketBlock} onChange={(v) => set("blanketBlock", v)} />
        </div>

        <div>
          <label className="text-[12px] text-[var(--qz-text-muted)]">
            Blocked categories ({g.categories.length} selected)
          </label>
          <div className="flex items-center gap-1 mt-1 mb-1">
            <Search size={13} className="text-[var(--qz-text-muted)]" />
            <input value={catSearch} placeholder="Search categories…" style={inputStyle}
              onChange={(e) => setCatSearch(e.target.value)} className="flex-1 rounded px-2 py-1 text-[12px]" />
          </div>
          <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto rounded p-1" style={cardStyle}>
            {shownCats.length === 0 && (
              <span className="text-[12px] text-[var(--qz-text-muted)] italic col-span-2 p-2">
                No categories installed yet — run a blocklist update on the Overview tab.
              </span>
            )}
            {shownCats.map((c) => (
              <label key={c.name} className="flex items-center gap-2 text-[12px] px-1 py-0.5 cursor-pointer">
                <input type="checkbox" checked={g.categories.includes(c.name)} onChange={() => toggleCat(c.name)} />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-[10px] text-[var(--qz-text-muted)]">{c.entries.toLocaleString()}</span>
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

        <div className="flex items-center justify-between">
          <div className="text-[13px]">Safe search (Google/Bing/DDG + YouTube Restricted)</div>
          <Switch on={g.safeSearch} onChange={(v) => set("safeSearch", v)} />
        </div>

        <div className="flex items-center justify-between">
          <div className="text-[13px]">Phrase filtering (content scanning)</div>
          <Switch on={g.phraseFiltering} onChange={(v) => set("phraseFiltering", v)} />
        </div>
        {g.phraseFiltering && (
          <div>
            <label className="text-[12px] text-[var(--qz-text-muted)]">
              Naughtyness limit: <b>{g.naughtynessLimit}</b> (lower = stricter)
            </label>
            <input type="range" min={50} max={500} step={10} value={g.naughtynessLimit}
              onChange={(e) => set("naughtynessLimit", Number(e.target.value))} className="w-full mt-1" />
          </div>
        )}

        <ListEditor label="Blocked file extensions" items={g.blockFileExtensions} onChange={(v) => set("blockFileExtensions", v)}
          placeholder=".exe" />
        <ListEditor label="Blocked MIME types" items={g.blockMimeTypes} onChange={(v) => set("blockMimeTypes", v)}
          placeholder="application/x-dosexec" />
      </div>
      <div className="flex justify-end gap-2 p-3 border-t border-[var(--qz-border)]">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => onSave(g)}>Save group</Button>
      </div>
    </ModalShell>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function ContentFilteringPage() {
  const { setToast } = useDashboard();
  const [tab, setTab] = useState("overview");
  const [live, setLive] = useState<ContentFilteringConfig>(emptyContentFilteringConfig());
  const [draft, setDraft] = useState<ContentFilteringConfig>(emptyContentFilteringConfig());
  const [ssl, setSsl] = useState<SslInspectionConfig>(emptySslInspectionConfig());
  const [status, setStatus] = useState<CfStatusReport | null>(null);
  const [categories, setCategories] = useState<CfCategory[]>([]);
  const [logs, setLogs] = useState<CfLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<FilterGroup | null>(null);
  const [logFilter, setLogFilter] = useState<{ group: string; action: string }>({ group: "", action: "" });

  const reloadConfig = useCallback(async () => {
    const [cf, s] = await Promise.all([fetchContentFiltering(), fetchSslInspection().catch(() => emptySslInspectionConfig())]);
    setLive(cf); setDraft(cf); setSsl(s);
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

  const onToggleEnable = async (on: boolean) => {
    if (on && !ssl.enabled) {
      setToast("Enable SSL Inspection first — Content Filtering needs the decrypted traffic.");
      return;
    }
    if (on && !window.confirm("Enable Content Filtering? All bumped HTTPS will be filtered by e2guardian (fail-closed).")) return;
    setSaving(true);
    try {
      await setContentFilteringEnabled(live, on);
      await reloadConfig(); await reloadStatus();
      setToast(on ? "Content Filtering enabled" : "Content Filtering disabled");
    } catch (e) { setToast(`Failed: ${(e as Error).message}`); } finally { setSaving(false); }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const n = await applyContentFiltering(live, draft);
      await reloadConfig();
      setToast(n === 0 ? "No changes" : `Applied ${n} change${n === 1 ? "" : "s"}`);
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

  if (loading) return <div className="p-6 text-[13px] text-[var(--qz-text-muted)]">Loading…</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold">Content Filtering</h1>
          <p className="text-[13px] text-[var(--qz-text-muted)]">
            URL/category filtering &amp; content scanning via e2guardian (ICAP) behind SSL Inspection.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-[var(--qz-text-muted)]">{live.enabled ? "Enabled" : "Disabled"}</span>
          <Switch on={live.enabled} onChange={onToggleEnable} />
        </div>
      </div>

      {!ssl.enabled && (
        <div className="flex items-start gap-2 mb-4 p-3 rounded badge-warn text-[13px]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <b>SSL Inspection is disabled.</b> Content Filtering has no decrypted traffic to inspect and the
            commit will be refused. Enable it on the{" "}
            <Link href="/services/ssl-inspection" className="underline">SSL Inspection</Link> page first.
          </div>
        </div>
      )}

      <Tabs
        value={tab} onChange={setTab}
        items={[
          { value: "overview", label: "Overview" },
          { value: "groups", label: "Filter Groups", count: draft.groups.length },
          { value: "blockpage", label: "Block Page" },
          { value: "logs", label: "Logs" },
        ]}
        trailing={
          dirty ? (
            <Button onClick={onSave} disabled={saving}>
              <Check size={14} /> Apply changes
            </Button>
          ) : undefined
        }
      />

      <div className="mt-4">
        {tab === "overview" && (
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded p-3" style={cardStyle}>
              <div className="text-[13px] font-medium mb-2">Daemon &amp; ICAP</div>
              <Indicator label="e2guardian running" state={status?.e2guardian_active ? "ok" : "muted"}
                detail={status?.e2guardian_active ? "active" : "stopped"} />
              <Indicator label="ICAP listener" state={status?.icap_listening ? "ok" : "muted"}
                detail={status?.icap_listening ? `:${status?.icap_port ?? live.listenPort}` : "down"} />
              <Indicator label="SSL Inspection (required)" state={ssl.enabled ? "ok" : "warn"}
                detail={ssl.enabled ? "enabled" : "disabled"} />
              <Indicator label="Last apply" state={status?.apply_ok === false ? "warn" : "muted"}
                detail={status?.apply_error ? "error" : status?.apply_ok ? "ok" : "—"} />
            </div>

            <div className="rounded p-3" style={cardStyle}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[13px] font-medium">Blocklists (UT1)</div>
                <Button kind="ghost" onClick={onUpdateNow}><RotateCw size={13} /> Update now</Button>
              </div>
              <Indicator label="Installed categories" state={(status?.installed_categories ?? 0) > 0 ? "ok" : "muted"}
                detail={String(status?.installed_categories ?? 0)} />
              <Indicator label="Last update"
                state={bl?.state === "failed" ? "warn" : bl?.state === "ok" ? "ok" : "muted"}
                detail={bl?.state === "ok" ? `${bl.categories ?? "?"} cats` : bl?.state ?? "never"} />
              {bl?.error && <p className="text-[11px] text-[var(--qz-danger)] mt-1">{bl.error}</p>}
              <Indicator label="Blocked (last 200 log lines)" state={blocked24h > 0 ? "warn" : "muted"} detail={String(blocked24h)} />
            </div>

            <TestUrlWidget groups={draft.groups} setToast={setToast} />
          </div>
        )}

        {tab === "groups" && (
          <div>
            <div className="flex justify-end mb-2">
              <Button onClick={() => {
                const name = window.prompt("New filter group name (letters, digits, hyphen):")?.trim();
                if (!name) return;
                if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) { setToast("Invalid group name"); return; }
                if (draft.groups.some((g) => g.name === name)) { setToast("Group already exists"); return; }
                setEditing(emptyGroup(name));
              }}><Plus size={14} /> Add group</Button>
            </div>
            <div className="rounded overflow-hidden" style={cardStyle}>
              <table className="w-full text-[13px]">
                <thead className="text-[12px] text-[var(--qz-text-muted)] border-b border-[var(--qz-border)]">
                  <tr><th className="text-left px-3 py-2">Group</th><th className="text-left px-3 py-2">Sources</th>
                    <th className="text-left px-3 py-2">Categories</th><th className="text-left px-3 py-2">Custom</th><th /></tr>
                </thead>
                <tbody>
                  {draft.groups.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-[var(--qz-text-muted)] italic">
                      No filter groups — add one to start filtering. The first group is the default (unmatched clients).
                    </td></tr>
                  )}
                  {draft.groups.map((g, i) => (
                    <tr key={g.name} className="border-b border-[var(--qz-border)] last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-medium">{g.name}{i === 0 && <span className="ml-1 text-[10px] badge-muted px-1 rounded">default</span>}</div>
                        {g.description && <div className="text-[11px] text-[var(--qz-text-muted)]">{g.description}</div>}
                      </td>
                      <td className="px-3 py-2 text-[12px]">{i === 0 ? "unmatched" : (g.sourceAddress.join(", ") || "—")}</td>
                      <td className="px-3 py-2 text-[12px]">{g.blanketBlock ? "blanket-block" : (g.categories.length || 0)}</td>
                      <td className="px-3 py-2 text-[12px]">
                        {g.blockDomains.length + g.blockUrlRegex.length}b / {g.allowDomains.length}a
                        {g.phraseFiltering && " · phrase"}{g.safeSearch && " · safe"}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Button kind="ghost" onClick={() => setEditing(g)}>Edit</Button>
                        <Button kind="ghost" onClick={() => setDraft({ ...draft, groups: draft.groups.filter((x) => x.name !== g.name) })}>
                          <Trash2 size={13} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "blockpage" && (
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded p-3 space-y-3" style={cardStyle}>
              <div>
                <label className="text-[12px] text-[var(--qz-text-muted)]">Message</label>
                <textarea value={draft.blockPage.message ?? ""} style={inputStyle} rows={3}
                  onChange={(e) => setDraft({ ...draft, blockPage: { ...draft.blockPage, message: e.target.value || null } })}
                  className="w-full rounded px-2 py-1 text-[13px] mt-1" placeholder="This site is blocked by policy." />
              </div>
              <div>
                <label className="text-[12px] text-[var(--qz-text-muted)]">Contact</label>
                <input value={draft.blockPage.contact ?? ""} style={inputStyle}
                  onChange={(e) => setDraft({ ...draft, blockPage: { ...draft.blockPage, contact: e.target.value || null } })}
                  className="w-full rounded px-2 py-1 text-[13px] mt-1" placeholder="it@example.com" />
              </div>
              <div>
                <label className="text-[12px] text-[var(--qz-text-muted)]">Access log level</label>
                <div className="mt-1">
                  <Segmented value={draft.logLevel}
                    onChange={(v) => setDraft({ ...draft, logLevel: v as LogLevel })}
                    items={[
                      { value: "none", label: "None" },
                      { value: "blocked-only", label: "Blocked only" },
                      { value: "all", label: "All" },
                    ]} />
                </div>
              </div>
            </div>
            <div className="rounded p-4" style={{ ...cardStyle, minHeight: 200 }}>
              <div className="text-[11px] text-[var(--qz-text-muted)] mb-2">Live preview</div>
              <div className="rounded p-4 text-center" style={{ background: "#0f1115", color: "#e6e8ec" }}>
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
          </div>
        )}

        {tab === "logs" && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <input value={logFilter.group} placeholder="Filter by group" style={inputStyle}
                onChange={(e) => setLogFilter((f) => ({ ...f, group: e.target.value }))}
                className="rounded px-2 py-1 text-[12px]" />
              <Segmented value={logFilter.action || "all"}
                onChange={(v) => setLogFilter((f) => ({ ...f, action: v === "all" ? "" : v }))}
                items={[
                  { value: "all", label: "All" },
                  { value: "blocked", label: "Blocked" },
                  { value: "allowed", label: "Allowed" },
                ]} />
              <span className="text-[11px] text-[var(--qz-text-muted)] ml-auto">auto-refresh · {logs.length} shown</span>
            </div>
            <div className="rounded overflow-hidden" style={cardStyle}>
              <table className="w-full text-[12px]">
                <thead className="text-[11px] text-[var(--qz-text-muted)] border-b border-[var(--qz-border)]">
                  <tr><th className="text-left px-2 py-1.5">Time</th><th className="text-left px-2 py-1.5">Client</th>
                    <th className="text-left px-2 py-1.5">Group</th><th className="text-left px-2 py-1.5">URL</th>
                    <th className="text-left px-2 py-1.5">Category</th><th className="text-left px-2 py-1.5">Action</th></tr>
                </thead>
                <tbody>
                  {logs.length === 0 && (
                    <tr><td colSpan={6} className="px-2 py-6 text-center text-[var(--qz-text-muted)] italic">No log entries.</td></tr>
                  )}
                  {logs.map((l, i) => (
                    <tr key={i} className="border-b border-[var(--qz-border)] last:border-0">
                      <td className="px-2 py-1 whitespace-nowrap">{l.ts.replace("T", " ")}</td>
                      <td className="px-2 py-1">{l.client_ip}</td>
                      <td className="px-2 py-1">{l.group ?? "—"}</td>
                      <td className="px-2 py-1 max-w-[22rem] truncate" title={l.url}>{l.url}</td>
                      <td className="px-2 py-1">{l.category ?? "—"}</td>
                      <td className="px-2 py-1">
                        <span className={`px-1.5 py-0.5 rounded text-[11px] ${l.action === "blocked" ? "badge-warn" : "badge-ok"}`}>{l.action}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {editing && (
        <GroupEditor
          group={editing} categories={categories}
          isDefault={draft.groups[0]?.name === editing.name || draft.groups.length === 0}
          onSave={saveGroup} onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

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
    <div className="rounded p-3 md:col-span-2" style={cardStyle}>
      <div className="text-[13px] font-medium mb-2 flex items-center gap-1"><Search size={14} /> Test URL</div>
      <div className="flex flex-wrap gap-2">
        <input value={url} placeholder="https://example.com/page" style={inputStyle}
          onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()}
          className="flex-1 min-w-[16rem] rounded px-2 py-1 text-[13px]" />
        <select value={group} onChange={(e) => setGroup(e.target.value)} style={inputStyle} className="rounded px-2 py-1 text-[13px]">
          <option value="">Default group</option>
          {groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
        </select>
        <Button onClick={run} disabled={busy}>Test</Button>
      </div>
      {verdict && (
        <div className="mt-2 flex items-center gap-2 text-[13px]">
          {verdict.action === "blocked"
            ? <span className="px-2 py-0.5 rounded badge-warn">BLOCKED</span>
            : <span className="px-2 py-0.5 rounded badge-ok inline-flex items-center gap-1"><ShieldCheck size={13} /> ALLOWED</span>}
          <span className="text-[var(--qz-text-muted)]">
            {verdict.matched ? `matched ${verdict.matched}` : verdict.reason}{verdict.category ? ` (${verdict.category})` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
