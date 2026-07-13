// Content Filtering data layer — e2guardian ICAP server behind the Squid bump.
//
// Two halves, mirroring the device (quartzfire-content-filtering/docs/design.md):
//   * CONFIG is real VyOS config under `service content-filtering …` (nodes
//     shipped by the quartzfire-content-filtering package). Read via the VyOS
//     API proxy, edited diff-style under commit-confirm — like ssl-inspection.
//   * STATUS / CATEGORIES / UPDATE / LOGS / TEST-URL come from the backend's
//     /api/content-filtering/* endpoints (qfcf helpers + the JSON log feed).
//
// Hard dependency: Content Filtering requires SSL Inspection enabled — the box
// refuses the commit otherwise. The page warns prominently before that bites.

import { apiFetch, vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

// Filtering can block the operator's own browsing, so writes commit under
// commit-confirm like the other risky domains.
const commitAndSave = (commands: VyosCommand[]) =>
  guardedCommitAndSave(commands, "Content Filtering configuration change");

export type LogLevel = "none" | "blocked-only" | "all";

export interface FilterGroup {
  name: string;
  description: string | null;
  sourceAddress: string[];
  blanketBlock: boolean;
  categories: string[];
  blockDomains: string[];
  allowDomains: string[];
  blockUrlRegex: string[];
  phraseFiltering: boolean;
  naughtynessLimit: number;
  safeSearch: boolean;
  blockFileExtensions: string[];
  blockMimeTypes: string[];
}

export interface Blocklists {
  sources: string[];
  autoUpdate: boolean;
  updateIntervalHours: number;
}

export interface ContentFilteringConfig {
  enabled: boolean;
  listenPort: number;
  groups: FilterGroup[];
  blocklists: Blocklists;
  blockPage: { message: string | null; contact: string | null };
  logLevel: LogLevel;
}

export const DEFAULT_NAUGHTYNESS = 150;
/// Name of the implicit default/unmatched action synthesized when none is
/// configured (mirrors the backend's DEFAULT_GROUP_NAME). Applies to every
/// client; blocks nothing until categories/lists are added.
export const DEFAULT_GROUP_NAME = "Global";

export function emptyGroup(name: string): FilterGroup {
  return {
    name,
    description: null,
    sourceAddress: [],
    blanketBlock: false,
    categories: [],
    blockDomains: [],
    allowDomains: [],
    blockUrlRegex: [],
    phraseFiltering: false,
    naughtynessLimit: DEFAULT_NAUGHTYNESS,
    safeSearch: false,
    blockFileExtensions: [],
    blockMimeTypes: [],
  };
}

export function emptyContentFilteringConfig(): ContentFilteringConfig {
  return {
    enabled: false,
    listenPort: 1344,
    groups: [],
    blocklists: { sources: [], autoUpdate: false, updateIntervalHours: 24 },
    blockPage: { message: null, contact: null },
    logLevel: "blocked-only",
  };
}

const BASE = ["service", "content-filtering"];

// ── config reads ────────────────────────────────────────────────────────────

type Cfg = Record<string, unknown>;

function childStr(v: Cfg, key: string): string | null {
  const x = v[key];
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s === "" ? null : s;
}
function childCfg(v: Cfg, key: string): Cfg | null {
  const x = v[key];
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Cfg) : null;
}
function childList(v: Cfg, key: string): string[] {
  const x = v[key];
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.filter((m): m is string => typeof m === "string");
  return [];
}

function readGroups(node: Cfg | null): FilterGroup[] {
  if (!node) return [];
  const out: FilterGroup[] = [];
  for (const [name, raw] of Object.entries(node)) {
    const g = (raw && typeof raw === "object" ? (raw as Cfg) : {}) as Cfg;
    out.push({
      name,
      description: childStr(g, "description"),
      sourceAddress: childList(g, "source-address"),
      blanketBlock: "blanket-block" in g,
      categories: childList(g, "category"),
      blockDomains: childList(g, "block-domain"),
      allowDomains: childList(g, "allow-domain"),
      blockUrlRegex: childList(g, "block-url-regex"),
      phraseFiltering: "phrase-filtering" in g,
      naughtynessLimit: Number(childStr(g, "naughtyness-limit")) || DEFAULT_NAUGHTYNESS,
      safeSearch: "safe-search" in g,
      blockFileExtensions: childList(g, "block-file-extension"),
      blockMimeTypes: childList(g, "block-mime-type"),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchContentFiltering(): Promise<ContentFilteringConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: BASE,
  });
  if (!resp.success) {
    if ((resp.error ?? "").toLowerCase().includes("empty")) return emptyContentFilteringConfig();
    throw new Error(resp.error || "Device returned an error reading the content-filtering config.");
  }
  const cfg = resp.data ?? {};
  const bl = childCfg(cfg, "blocklists") ?? {};
  const bp = childCfg(cfg, "block-page") ?? {};
  const log = childCfg(cfg, "log") ?? {};
  const lvl = childStr(log, "level");
  // The backend synthesizes a default "Global" group when none is configured
  // (config.rs read_service); mirror that here so the default action is always
  // visible/editable and the two views agree.
  const groups = readGroups(childCfg(cfg, "filter-group"));
  return {
    enabled: "enable" in cfg,
    listenPort: Number(childStr(cfg, "listen-port")) || 1344,
    groups: groups.length ? groups : [emptyGroup(DEFAULT_GROUP_NAME)],
    blocklists: {
      sources: childList(bl, "source"),
      autoUpdate: "auto-update" in bl,
      updateIntervalHours: Number(childStr(bl, "update-interval")) || 24,
    },
    blockPage: { message: childStr(bp, "message"), contact: childStr(bp, "contact") },
    logLevel: lvl === "none" || lvl === "all" ? lvl : "blocked-only",
  };
}

// ── writes (diff) ─────────────────────────────────────────────────────────────

function multiDiff(out: VyosCommand[], path: string[], live: string[], desired: string[]) {
  const liveSet = new Set(live);
  const desiredSet = new Set(desired);
  for (const v of desiredSet) if (!liveSet.has(v)) out.push({ op: "set", path: [...path, v] });
  for (const v of liveSet) if (!desiredSet.has(v)) out.push({ op: "delete", path: [...path, v] });
}

function valuelessDiff(out: VyosCommand[], path: string[], live: boolean, desired: boolean) {
  if (live === desired) return;
  out.push(desired ? { op: "set", path } : { op: "delete", path });
}

function leafDiff(out: VyosCommand[], path: string[], live: string | null, desired: string | null) {
  if (live === desired) return;
  if (desired !== null) out.push({ op: "set", path: [...path, desired] });
  else out.push({ op: "delete", path });
}

function groupDiff(out: VyosCommand[], live: FilterGroup[], desired: FilterGroup[]) {
  const G = (name: string) => [...BASE, "filter-group", name];
  const liveByName = new Map(live.map((g) => [g.name, g]));
  const desiredByName = new Map(desired.map((g) => [g.name, g]));

  for (const g of desired) {
    const p = G(g.name);
    const prev = liveByName.get(g.name) ?? emptyGroup(g.name);
    leafDiff(out, [...p, "description"], prev.description, g.description);
    multiDiff(out, [...p, "source-address"], prev.sourceAddress, g.sourceAddress);
    valuelessDiff(out, [...p, "blanket-block"], prev.blanketBlock, g.blanketBlock);
    multiDiff(out, [...p, "category"], prev.categories, g.categories);
    multiDiff(out, [...p, "block-domain"], prev.blockDomains, g.blockDomains);
    multiDiff(out, [...p, "allow-domain"], prev.allowDomains, g.allowDomains);
    multiDiff(out, [...p, "block-url-regex"], prev.blockUrlRegex, g.blockUrlRegex);
    valuelessDiff(out, [...p, "phrase-filtering"], prev.phraseFiltering, g.phraseFiltering);
    leafDiff(out, [...p, "naughtyness-limit"], String(prev.naughtynessLimit), String(g.naughtynessLimit));
    valuelessDiff(out, [...p, "safe-search"], prev.safeSearch, g.safeSearch);
    multiDiff(out, [...p, "block-file-extension"], prev.blockFileExtensions, g.blockFileExtensions);
    multiDiff(out, [...p, "block-mime-type"], prev.blockMimeTypes, g.blockMimeTypes);
  }
  for (const g of live) {
    if (!desiredByName.has(g.name)) out.push({ op: "delete", path: G(g.name) });
  }
}

export function diffContentFiltering(
  live: ContentFilteringConfig,
  desired: ContentFilteringConfig,
): VyosCommand[] {
  const out: VyosCommand[] = [];
  valuelessDiff(out, [...BASE, "enable"], live.enabled, desired.enabled);
  leafDiff(out, [...BASE, "listen-port"], String(live.listenPort), String(desired.listenPort));

  groupDiff(out, live.groups, desired.groups);

  const bl = [...BASE, "blocklists"];
  multiDiff(out, [...bl, "source"], live.blocklists.sources, desired.blocklists.sources);
  valuelessDiff(out, [...bl, "auto-update"], live.blocklists.autoUpdate, desired.blocklists.autoUpdate);
  leafDiff(out, [...bl, "update-interval"],
    String(live.blocklists.updateIntervalHours), String(desired.blocklists.updateIntervalHours));

  leafDiff(out, [...BASE, "block-page", "message"], live.blockPage.message, desired.blockPage.message);
  leafDiff(out, [...BASE, "block-page", "contact"], live.blockPage.contact, desired.blockPage.contact);

  leafDiff(out, [...BASE, "log", "level"],
    live.logLevel === "blocked-only" ? "blocked-only" : live.logLevel,
    desired.logLevel === "blocked-only" ? "blocked-only" : desired.logLevel);

  return out;
}

export function applyContentFiltering(
  live: ContentFilteringConfig,
  desired: ContentFilteringConfig,
): Promise<number> {
  const cmds = diffContentFiltering(live, desired);
  if (cmds.length === 0) return Promise.resolve(0);
  return commitAndSave(cmds);
}

export function setContentFilteringEnabled(
  live: ContentFilteringConfig,
  enabled: boolean,
): Promise<number> {
  if (live.enabled === enabled) return Promise.resolve(0);
  return commitAndSave([
    enabled
      ? { op: "set", path: [...BASE, "enable"] }
      : { op: "delete", path: [...BASE, "enable"] },
  ]);
}

// ── client-side validation mirrors ───────────────────────────────────────────

export function validateDomain(pat: string): string | null {
  const core = pat.replace(/^\*\./, "").replace(/^\./, "");
  const ok = /^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
  if (!core || core.length > 253 || !ok.test(core)) return "Enter a domain (e.g. example.com).";
  return null;
}

export function validateCidr(cidr: string): string | null {
  const m = cidr.match(/^([^/]+)\/(\d+)$/);
  if (!m) return "Use CIDR notation (e.g. 10.0.20.0/24).";
  const len = Number(m[2]);
  const v4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(m[1]);
  if (v4 && len <= 32) return null;
  if (m[1].includes(":") && len <= 128) return null;
  return "Use a valid IPv4 or IPv6 CIDR (e.g. 10.0.20.0/24).";
}

// ── backend API: status / categories / update / logs / test-url ──────────────

export interface CfBlocklistUpdate {
  state?: "running" | "ok" | "failed";
  categories?: number;
  error?: string;
  finished?: number;
  source?: string;
}

export interface CfStatusReport {
  enabled?: boolean;
  e2guardian_active?: boolean;
  icap_listening?: boolean;
  icap_port?: number;
  installed_categories?: number;
  groups?: number;
  log_level?: string;
  applied_time?: number;
  apply_ok?: boolean;
  apply_error?: string | null;
  blocklist_update?: CfBlocklistUpdate;
}

export async function fetchCfStatus(): Promise<CfStatusReport | null> {
  const r = await apiFetch<{ status: CfStatusReport | null }>("/content-filtering/status");
  return r.status;
}

export interface CfCategory {
  name: string;
  entries: number;
}
export async function fetchCfCategories(): Promise<CfCategory[]> {
  const r = await apiFetch<{ categories: CfCategory[] }>("/content-filtering/categories");
  return r.categories ?? [];
}

export async function requestCfUpdate(): Promise<{ requested: boolean; seq: number }> {
  return apiFetch("/content-filtering/update", { method: "POST" });
}

export interface CfLogEntry {
  ts: string;
  client_ip: string;
  user: string | null;
  group: string | null;
  url: string;
  action: "blocked" | "allowed" | "scanned";
  category: string | null;
  reason: string | null;
  http_status: number | null;
  method: string | null;
  naughtyness: number;
}

export async function fetchCfLogs(opts: {
  limit?: number;
  group?: string;
  action?: string;
} = {}): Promise<CfLogEntry[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.group) params.set("group", opts.group);
  if (opts.action) params.set("action", opts.action);
  const qs = params.toString();
  const r = await apiFetch<{ entries: CfLogEntry[] }>(
    `/content-filtering/logs${qs ? `?${qs}` : ""}`,
  );
  return r.entries ?? [];
}

export interface CfVerdict {
  url: string;
  host: string;
  group?: string;
  action: "blocked" | "allowed";
  matched?: string;
  category?: string;
  reason?: string;
}
export async function testCfUrl(url: string, group?: string): Promise<CfVerdict> {
  return apiFetch("/content-filtering/test-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, group: group || undefined }),
  });
}
