"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { deleteDnsDomain, DnsForwardingConfig, DnsForwardingDomain, fetchDnsForwarding } from "@/lib/services";
import { useDashboard } from "@/lib/DashboardContext";
import { SettingsFormModal } from "./SettingsFormModal";
import { DomainFormModal } from "./DomainFormModal";

const domainColumns: Column<DnsForwardingDomain>[] = [
  { key: "name", header: "Domain", value: (r) => r.name, mono: true, sortable: true },
  {
    key: "name_servers",
    header: "Name Servers",
    value: (r) => r.name_servers.join(", "),
    render: (r) => (r.name_servers.length ? r.name_servers.join(", ") : "—"),
    mono: true,
  },
];

/// One label/value line of the settings card.
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span style={{ color: "var(--cds-alias-typography-color-200)" }}>{label}</span>
      <span style={{ color: "var(--cds-alias-typography-color-400)", minWidth: 0 }}>{children}</span>
    </>
  );
}

function MonoList({ items }: { items: string[] }) {
  if (items.length === 0) return <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1" style={{ fontFamily: "var(--qz-font-mono)" }}>
      {items.map((v) => (
        <span key={v}>{v}</span>
      ))}
    </span>
  );
}

export default function DnsForwardingPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<DnsForwardingConfig | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const [settingsModal, setSettingsModal] = useState(false);
  // null = closed; { domain: undefined } = create; { domain } = edit.
  const [domainModal, setDomainModal] = useState<{ domain?: DnsForwardingDomain } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setData(await fetchDnsForwarding());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load DNS forwarding.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const removeDomain = async (domain: DnsForwardingDomain) => {
    try {
      await deleteDnsDomain(domain.name);
      setToast(`Deleted domain ${domain.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete domain ${domain.name}.`);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>DNS Forwarding</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Recursive DNS forwarder / cache configuration
        </p>
      </div>

      {status === "loading" && <p className="clr-secondary">Loading DNS forwarding…</p>}
      {status === "error" && (
        <div className="alert alert-danger alert-sm">
          <Icon shape="exclamation-circle" size={14} className="alert-icon" />
          <div className="alert-text">{errorMsg}</div>
          <div className="alert-actions">
            <button type="button" className="alert-action" onClick={() => load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {status === "ready" && data && (
        <div className="flex flex-col gap-7">
          <div className="card">
            <div className="card-header">
              Forwarder Settings
              <span style={{ marginLeft: "auto" }}>
                <Button kind="secondary" size="sm" icon="pencil" onClick={() => setSettingsModal(true)}>
                  Edit Settings
                </Button>
              </span>
            </div>
            <div
              className="card-block"
              style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 24px", fontSize: 13 }}
            >
              <InfoRow label="Listen Addresses"><MonoList items={data.listen_addresses} /></InfoRow>
              <InfoRow label="Allow From"><MonoList items={data.allow_from} /></InfoRow>
              <InfoRow label="Upstream Name Servers"><MonoList items={data.name_servers} /></InfoRow>
              <InfoRow label="Use System Name Servers">
                <span className={data.system ? "badge badge-ok" : "badge badge-muted"}>{data.system ? "Yes" : "No"}</span>
              </InfoRow>
              <InfoRow label="Cache Size">
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>{data.cache_size ?? "10000 (default)"}</span>
              </InfoRow>
              <InfoRow label="DNSSEC">
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>{data.dnssec ?? "process-no-validate (default)"}</span>
              </InfoRow>
            </div>
          </div>

          <section className="flex flex-col gap-3">
            <h3 className="clr-section" style={{ color: "var(--cds-alias-typography-color-450)" }}>
              Conditional Domains
            </h3>
            <DataTable
              rows={data.domains}
              columns={domainColumns}
              rowId={(r) => r.name}
              storageKey="services-dns-domains"
              searchPlaceholder="Search domains…"
              emptyMessage="No conditional forwarding domains configured."
              onRefresh={() => load("refresh")}
              onRowOpen={(row) => setDomainModal({ domain: row })}
              toolbar={
                <Button kind="primary" size="sm" icon="plus" onClick={() => setDomainModal({})}>
                  Create Domain
                </Button>
              }
              actions={(row) => (
                <RowActions
                  label={`domain ${row.name}`}
                  onEdit={() => setDomainModal({ domain: row })}
                  onDelete={() => removeDomain(row)}
                />
              )}
            />
          </section>
        </div>
      )}

      {settingsModal && data && (
        <SettingsFormModal
          live={data}
          onClose={() => setSettingsModal(false)}
          onSaved={(msg) => {
            setSettingsModal(false);
            setToast(msg);
            load("refresh");
          }}
        />
      )}

      {domainModal && data && (
        <DomainFormModal
          initial={domainModal.domain}
          existing={data.domains}
          onClose={() => setDomainModal(null)}
          onSaved={(msg) => {
            setDomainModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
