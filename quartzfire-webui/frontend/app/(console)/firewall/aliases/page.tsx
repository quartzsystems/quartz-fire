"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import {
  ALIAS_GROUP,
  aliasUsage,
  AliasType,
  deleteAlias,
  emptyFirewallConfig,
  fetchFirewall,
  FirewallAlias,
  FirewallConfig,
  InterfaceAlias,
  interfaceAliases,
  interfaceUsage,
} from "@/lib/firewall";
import { fetchEthernet, fetchVlans } from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { RowActions } from "@/components/dashboard/RowActions";
import { AliasFormModal } from "./AliasFormModal";

const TYPE_BADGE: Record<AliasType, string> = {
  host: "badge-info",
  network: "badge-ok",
  fqdn: "badge-warn",
  // Interface-flavored rows read muted like the built-in interface aliases —
  // the label ("Interface group" vs "Interface") tells them apart; red/amber
  // would miscue severity.
  iface: "badge-muted",
};

/// Pill/filter casing per the DC mock (IPV4 HOST, INTERFACE GROUP once the
/// badge uppercases) — ALIAS_GROUP keeps the short labels used in messages.
const TYPE_LABEL: Record<AliasType, string> = {
  host: "IPv4 host",
  network: "IPv4 network",
  fqdn: "FQDN",
  iface: "Interface group",
};

function TypePill({ type }: { type: AliasType }) {
  return <span className={`badge ${TYPE_BADGE[type]}`}>{TYPE_LABEL[type]}</span>;
}

/// Table row: a user-defined alias, or a built-in one derived from a
/// configured interface (named by the interface description, edited by
/// editing the interface).
type AliasRow = { kind: "user"; alias: FirewallAlias } | { kind: "builtin"; alias: InterfaceAlias };

export default function FirewallAliasesPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<FirewallConfig>(emptyFirewallConfig);
  const [builtins, setBuiltins] = useState<InterfaceAlias[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { alias: undefined } = create; { alias } = edit.
  const [modal, setModal] = useState<{ alias?: FirewallAlias } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface reads back the built-in aliases; tolerate their failure so
      // the user-defined aliases still render.
      const [fw, eth, vlans] = await Promise.all([
        fetchFirewall(),
        fetchEthernet().catch(() => []),
        fetchVlans().catch(() => []),
      ]);
      setData(fw);
      setBuiltins(interfaceAliases([...eth, ...vlans]));
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load firewall aliases.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const usedBy = (alias: FirewallAlias) => aliasUsage(data.rules, data.auto_groups, alias);
  const rowUsage = (r: AliasRow) =>
    r.kind === "user" ? usedBy(r.alias) : interfaceUsage(data.rules, data.auto_groups, r.alias.iface);

  const rows: AliasRow[] = [
    ...data.aliases.map((alias): AliasRow => ({ kind: "user", alias })),
    ...builtins.map((alias): AliasRow => ({ kind: "builtin", alias })),
  ];

  const remove = async (alias: FirewallAlias) => {
    const rules = usedBy(alias);
    if (rules.length > 0) {
      setToast(`Cannot delete ${alias.display} — used by rule${rules.length === 1 ? "" : "s"} ${rules.join(", ")}.`);
      return;
    }
    try {
      await deleteAlias(alias);
      setToast(`Deleted alias ${alias.display}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete alias ${alias.display}.`);
    }
  };

  const columns: Column<AliasRow>[] = [
    {
      key: "name",
      header: "Name",
      value: (r) => r.alias.display,
      render: (r) => (
        <span title={r.kind === "user" ? `Device name: ${r.alias.name}` : `Interface ${r.alias.iface}`}>
          {r.alias.display}
        </span>
      ),
      mono: true,
      sortable: true,
      width: 180,
    },
    {
      key: "type",
      header: "Type",
      value: (r) => (r.kind === "user" ? r.alias.type : "interface"),
      render: (r) =>
        r.kind === "user" ? <TypePill type={r.alias.type} /> : <span className="badge badge-muted">Interface</span>,
      sortable: true,
      width: 110,
    },
    {
      key: "members",
      header: "Members",
      value: (r) => (r.kind === "user" ? r.alias.members.join(", ") : r.alias.iface),
      render: (r) => (r.kind === "user" ? (r.alias.members.length ? r.alias.members.join(", ") : "—") : r.alias.iface),
      mono: true,
    },
    {
      key: "description",
      header: "Description",
      value: (r) => (r.kind === "user" ? r.alias.description ?? "" : "Built-in"),
      render: (r) =>
        r.kind === "user" ? (
          r.alias.description ?? "—"
        ) : (
          <span className="text-[var(--cds-alias-typography-color-200)]">Built-in — edit under Interfaces</span>
        ),
      sortable: true,
    },
    {
      key: "used",
      header: "In use",
      value: (r) => rowUsage(r).length,
      render: (r) => {
        const n = rowUsage(r).length;
        return n > 0 ? (
          <span className="badge badge-ok">{n} rule{n === 1 ? "" : "s"}</span>
        ) : (
          <span className="badge badge-muted">unused</span>
        );
      },
      sortable: true,
      width: 110,
    },
  ];

  const filters: FilterDef<AliasRow>[] = [
    {
      key: "type",
      label: "Type",
      options: [
        ...(Object.keys(ALIAS_GROUP) as AliasType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] })),
        { value: "interface", label: "Built-in Interface" },
      ],
      predicate: (r, v) => (v === "interface" ? r.kind === "builtin" : r.kind === "user" && r.alias.type === v),
    },
  ];

  // Title block — standalone while loading/errored, in the DataTable's
  // header row (headerLeft) once the grid is up, per the DC reference.
  const header = (
    <div>
      <h2>Aliases</h2>
      <p className="clr-secondary" style={{ marginTop: 4 }}>
        Named hosts, networks, FQDNs, and interface groups used as From/To targets — every configured interface
        also gets a built-in alias named by its description.
      </p>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {status !== "ready" && header}

      {status === "loading" && <div className="clr-secondary">Loading aliases…</div>}
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
        <DataTable
          rows={rows}
          columns={columns}
          rowId={(r) => (r.kind === "user" ? `${r.alias.type}:${r.alias.name}` : `iface:${r.alias.iface}`)}
          filters={filters}
          storageKey="firewall-aliases"
          searchPlaceholder="Search aliases…"
          emptyMessage="No aliases defined."
          headerLeft={header}
          onRefresh={() => load("refresh")}
          onRowOpen={(r) => {
            // Built-in interface aliases are read-only here — they're edited
            // under Interfaces, so double-click opens nothing for them.
            if (r.kind === "user") setModal({ alias: r.alias });
          }}
          toolbar={
            <Button kind="primary" onClick={() => setModal({})}>
              Create Alias
            </Button>
          }
          actions={(row) =>
            row.kind === "user" ? (
              <RowActions
                label={`alias ${row.alias.display}`}
                onEdit={() => setModal({ alias: row.alias })}
                onDelete={() => remove(row.alias)}
              />
            ) : null
          }
        />
      )}

      {modal && (
        <AliasFormModal
          initial={modal.alias}
          existing={data.aliases}
          usedByRules={modal.alias ? usedBy(modal.alias) : []}
          interfaces={builtins.map((b) => ({
            name: b.iface,
            label: b.display === b.iface ? b.iface : `${b.display} (${b.iface})`,
          }))}
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
