"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { addDhcpRelayEntries, addDhcpRelayEntry, deleteDhcpRelayEntry, DhcpRelayConfig, fetchDhcpRelay } from "@/lib/services";
import { fetchInterfaceDescriptions } from "@/lib/interfaces";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";

type EntryKind = "interface" | "server";

interface NameRow {
  value: string;
}

const interfaceColumns: Column<NameRow>[] = [
  { key: "value", header: "Interface", value: (r) => r.value, mono: true, sortable: true },
];

const serverColumns: Column<NameRow>[] = [
  { key: "value", header: "Upstream Server", value: (r) => r.value, mono: true, sortable: true },
];

/// Delete-only row action with inline confirmation (relay entries are single
/// values — there is nothing to edit).
function DeleteAction({ label, onDelete }: { label: string; onDelete: () => Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  return (
    <div className="inline-flex items-center gap-1 justify-end">
      {confirming ? (
        <>
          <button
            type="button"
            title="Confirm delete"
            aria-label="Confirm delete"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              try {
                await onDelete();
              } finally {
                setWorking(false);
                setConfirming(false);
              }
            }}
            className="btn btn-sm btn-danger btn-icon"
          >
            <Icon shape="check" size={14} />
          </button>
          <button
            type="button"
            title="Cancel"
            aria-label="Cancel"
            onClick={() => setConfirming(false)}
            className="btn btn-sm btn-neutral btn-icon"
          >
            <Icon shape="times" size={14} />
          </button>
        </>
      ) : (
        <button
          type="button"
          title={`Delete ${label}`}
          aria-label="Delete"
          onClick={() => setConfirming(true)}
          className="btn btn-sm btn-link-neutral btn-icon"
        >
          <Icon shape="trash" size={14} />
        </button>
      )}
    </div>
  );
}

const KIND_META: Record<EntryKind, { title: string; label: string; hint: string; placeholder: string }> = {
  interface: {
    title: "Add Listen Interfaces",
    label: "Interfaces",
    hint: "The relay listens for DHCP requests on the selected interfaces.",
    placeholder: "eth1",
  },
  server: {
    title: "Add Upstream Server",
    label: "Server Address",
    hint: "DHCP requests are forwarded to this server.",
    placeholder: "10.0.0.5",
  },
};

/// Add one relay listen interface or upstream server.
function AddEntryModal({
  kind,
  interfaces,
  descriptions,
  existing,
  onClose,
  onSaved,
}: {
  kind: EntryKind;
  /** Interface names offered as a datalist when adding an interface. */
  interfaces: string[];
  /** Interface descriptions by name, shown next to the datalist entries. */
  descriptions?: Record<string, string>;
  existing: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const meta = KIND_META[kind];
  // Servers use a single text field; interfaces use a multi-select checklist.
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Interfaces already added can't be picked again — drop them from the list.
  const available = useMemo(
    () => interfaces.filter((n) => !existing.includes(n)),
    [interfaces, existing],
  );
  const allSelected = available.length > 0 && available.every((n) => selected.has(n));

  const toggle = (n: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => (allSelected ? new Set() : new Set(available)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (kind === "interface") {
      const chosen = available.filter((n) => selected.has(n));
      if (chosen.length === 0) {
        setError("Select at least one interface.");
        return;
      }
      setSaving(true);
      try {
        await addDhcpRelayEntries("interface", chosen);
        onSaved(`Added ${chosen.length} listen interface${chosen.length === 1 ? "" : "s"}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to apply change.");
      } finally {
        setSaving(false);
      }
      return;
    }

    const v = value.trim();
    if (!v) {
      setError(`${meta.label} is required.`);
      return;
    }
    if (existing.includes(v)) {
      setError(`${v} is already configured.`);
      return;
    }

    setSaving(true);
    try {
      await addDhcpRelayEntry(kind, v);
      onSaved(`Added DHCP relay ${kind} ${v}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply change.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={440}>
      <ModalHeader title={meta.title} subtitle="DHCP relay" onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="clr-form-control" style={{ marginTop: 0 }}>
          <div className="flex items-center justify-between">
            <label className="clr-control-label" style={{ marginBottom: 6 }}>
              {meta.label}
              {kind === "interface" && selected.size > 0 && (
                <span style={{ fontWeight: 400, color: "var(--cds-alias-typography-color-200)" }}>
                  {" "}· {selected.size} selected
                </span>
              )}
            </label>
            {kind === "interface" && available.length > 0 && (
              <button
                type="button"
                onClick={toggleAll}
                className="btn btn-sm btn-link"
                style={{ marginBottom: 6 }}
              >
                {allSelected ? "Clear All" : "Select All"}
              </button>
            )}
          </div>
          {kind === "interface" ? (
            available.length === 0 ? (
              <div
                className="clr-secondary"
                style={{
                  background: "var(--qz-input-bg)",
                  border: "1px solid var(--cds-alias-object-border-color)",
                  borderRadius: "var(--clr-base-border-radius-s)",
                  padding: "9px 12px",
                }}
              >
                All interfaces already added.
              </div>
            ) : (
              <div
                className="max-h-[240px] overflow-auto"
                style={{
                  background: "var(--qz-input-bg)",
                  border: "1px solid var(--cds-alias-object-border-color)",
                  borderRadius: "var(--clr-base-border-radius-s)",
                  padding: "4px 0",
                }}
              >
                {available.map((n) => (
                  <label key={n} className="clr-checkbox-wrapper cursor-pointer" style={{ padding: "2px 12px" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(n)}
                      onChange={() => toggle(n)}
                    />
                    <span
                      style={{
                        fontSize: 13,
                        color: "var(--cds-alias-typography-color-450)",
                        fontFamily: "var(--qz-font-mono)",
                      }}
                    >
                      {n}
                      {descriptions?.[n] && (
                        <span style={{ color: "var(--cds-alias-typography-color-200)" }}> — {descriptions[n]}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )
          ) : (
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={meta.placeholder}
              autoFocus
              className="clr-input"
              style={{ maxWidth: "none", fontFamily: "var(--qz-font-mono)" }}
            />
          )}
          <div className="clr-subtext">{meta.hint}</div>
        </div>

        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || (kind === "interface" && selected.size === 0)}
          >
            {saving
              ? "Applying…"
              : kind === "interface" && selected.size > 0
                ? `Add ${selected.size}`
                : "Add"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}

export default function DhcpRelayPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<DhcpRelayConfig>({ interfaces: [], servers: [] });
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [ifaceDescriptions, setIfaceDescriptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [modal, setModal] = useState<EntryKind | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface names populate the add form's picker; tolerate their failure
      // so the relay read still renders.
      const [relay, ifs, descs] = await Promise.all([
        fetchDhcpRelay(),
        fetchInterfaceStats().catch(() => []),
        fetchInterfaceDescriptions().catch(() => ({})),
      ]);
      setData(relay);
      setInterfaces(ifs.map((i) => i.name).sort());
      setIfaceDescriptions(descs);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load DHCP relay.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (kind: EntryKind, value: string) => {
    try {
      await deleteDhcpRelayEntry(kind, value);
      setToast(`Deleted DHCP relay ${kind} ${value}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${value}.`);
    }
  };

  const interfaceRows: NameRow[] = useMemo(() => data.interfaces.map((value) => ({ value })), [data]);
  const serverRows: NameRow[] = useMemo(() => data.servers.map((value) => ({ value })), [data]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>DHCP Relay</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Forward DHCP requests to upstream servers across subnets
        </p>
      </div>

      {status === "loading" && <p className="clr-secondary">Loading DHCP relay…</p>}
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
      {status === "ready" && (
        <div className="flex flex-col gap-7">
          <section className="flex flex-col gap-3">
            <h3 className="clr-section" style={{ color: "var(--cds-alias-typography-color-450)" }}>
              Listen Interfaces
            </h3>
            <DataTable
              rows={interfaceRows}
              columns={interfaceColumns}
              rowId={(r) => r.value}
              storageKey="services-dhcp-relay-interfaces"
              searchPlaceholder="Search interfaces…"
              emptyMessage="No relay interfaces configured."
              onRefresh={() => load("refresh")}
              toolbar={
                <Button kind="primary" size="sm" icon="plus" onClick={() => setModal("interface")}>
                  Add Interfaces
                </Button>
              }
              actions={(row) => (
                <DeleteAction label={`interface ${row.value}`} onDelete={() => remove("interface", row.value)} />
              )}
            />
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="clr-section" style={{ color: "var(--cds-alias-typography-color-450)" }}>
              Upstream Servers
            </h3>
            <DataTable
              rows={serverRows}
              columns={serverColumns}
              rowId={(r) => r.value}
              storageKey="services-dhcp-relay-servers"
              searchPlaceholder="Search servers…"
              emptyMessage="No upstream servers configured."
              onRefresh={() => load("refresh")}
              toolbar={
                <Button kind="primary" size="sm" icon="plus" onClick={() => setModal("server")}>
                  Add Server
                </Button>
              }
              actions={(row) => (
                <DeleteAction label={`server ${row.value}`} onDelete={() => remove("server", row.value)} />
              )}
            />
          </section>
        </div>
      )}

      {modal && (
        <AddEntryModal
          kind={modal}
          interfaces={interfaces}
          descriptions={ifaceDescriptions}
          existing={modal === "interface" ? data.interfaces : data.servers}
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
