"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { RowActions } from "@/components/dashboard/RowActions";
import { deleteDnsDomain, DnsForwardingConfig, DnsForwardingDomain, fetchDnsForwarding } from "@/lib/services";
import { useDashboard } from "@/lib/DashboardContext";
import { SettingsFormModal } from "./SettingsFormModal";
import { DomainFormModal } from "./DomainFormModal";

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
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="m-0">DNS Forwarding</h2>
          <p className="clr-secondary" style={{ marginTop: 4 }}>
            Recursive DNS forwarder and cache for the networks behind this firewall.
          </p>
        </div>
        {status === "ready" && data && (
          <>
            <button type="button" className="btn" onClick={() => setSettingsModal(true)}>
              Edit Settings
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setDomainModal({})}>
              Add Domain
            </button>
          </>
        )}
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
        <>
          <div className="card">
            <div
              className="card-block"
              style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 24px", fontSize: 13 }}
            >
              <InfoRow label="Listen addresses"><MonoList items={data.listen_addresses} /></InfoRow>
              <InfoRow label="Allow from"><MonoList items={data.allow_from} /></InfoRow>
              <InfoRow label="Upstream"><MonoList items={data.name_servers} /></InfoRow>
              <InfoRow label="Use system name servers">
                <span className={data.system ? "badge badge-ok" : "badge badge-muted"}>{data.system ? "Yes" : "No"}</span>
              </InfoRow>
              <InfoRow label="Cache size">
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>{data.cache_size ?? "10000 (default)"}</span>
              </InfoRow>
              <InfoRow label="DNSSEC">
                <span
                  className={`label${data.dnssec ? " label-success" : ""}`}
                  style={{
                    fontFamily: "var(--qz-font-mono)",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    width: "fit-content",
                  }}
                >
                  {data.dnssec ?? "process-no-validate"}
                </span>
              </InfoRow>
            </div>
          </div>

          <div className="card">
            <div className="card-header">Per-Domain Forwarding</div>
            <table className="table table-noborder" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Name servers</th>
                  <th style={{ width: 90 }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {data.domains.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-center" style={{ color: "var(--cds-alias-typography-color-200)" }}>
                      No per-domain forwarding configured.
                    </td>
                  </tr>
                ) : (
                  data.domains.map((d) => (
                    <tr key={d.name} style={{ cursor: "pointer" }} onClick={() => setDomainModal({ domain: d })}>
                      <td className="mono">{d.name}</td>
                      <td className="mono">{d.name_servers.length ? d.name_servers.join(", ") : "—"}</td>
                      <td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <RowActions
                          label={`domain ${d.name}`}
                          onEdit={() => setDomainModal({ domain: d })}
                          onDelete={() => removeDomain(d)}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
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
