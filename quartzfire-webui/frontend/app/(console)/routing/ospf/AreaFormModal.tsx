"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { applyOspfArea, emptyOspfArea, OspfArea, OspfAreaType } from "@/lib/ospf";

const inputStyle = { maxWidth: "none", width: "100%" } as const;
const monoStyle = { ...inputStyle, fontFamily: "var(--qz-font-mono)" } as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <label className="clr-control-label">{label}</label>
      {children}
      {hint && <div className="clr-subtext">{hint}</div>}
    </div>
  );
}

let keyCounter = 0;
const nextKey = () => `ospf-area-row-${keyCounter++}`;
interface ListRow { key: string; value: string }
const toRows = (values: string[]): ListRow[] => values.map((value) => ({ key: nextKey(), value }));

function ListEditor({ label, addLabel, placeholder, emptyText, rows, setRows }: {
  label: string;
  addLabel: string;
  placeholder: string;
  emptyText: string;
  rows: ListRow[];
  setRows: (u: (p: ListRow[]) => ListRow[]) => void;
}) {
  return (
    <div className="clr-form-control" style={{ marginTop: 0 }}>
      <div className="flex items-center justify-between">
        <label className="clr-control-label" style={{ marginBottom: 0 }}>{label}</label>
        <button
          type="button"
          onClick={() => setRows((p) => [...p, { key: nextKey(), value: "" }])}
          className="btn btn-sm btn-link-neutral"
        >
          <Icon shape="plus" size={12} /> {addLabel}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="clr-subtext" style={{ margin: 0 }}>{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-2" style={{ marginTop: 6 }}>
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-2">
              <input
                value={r.value}
                onChange={(e) => setRows((p) => p.map((x) => (x.key === r.key ? { ...x, value: e.target.value } : x)))}
                placeholder={placeholder}
                className="clr-input"
                style={monoStyle}
              />
              <button
                type="button"
                onClick={() => setRows((p) => p.filter((x) => x.key !== r.key))}
                title="Remove"
                aria-label="Remove"
                className="btn btn-sm btn-link-neutral btn-icon"
              >
                <Icon shape="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// Create/edit an OSPF area. Diffs against the live config and commits under
/// commit-confirm.
export function AreaFormModal({ initial, existingAreas, onClose, onSaved }: {
  initial?: OspfArea;
  existingAreas: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyOspfArea();
  const [area, setArea] = useState(base.area);
  const [areaType, setAreaType] = useState<OspfAreaType>(base.area_type);
  const [noSummary, setNoSummary] = useState(base.no_summary);
  const [networks, setNetworks] = useState<ListRow[]>(toRows(base.networks));
  const [ranges, setRanges] = useState<ListRow[]>(toRows(base.ranges));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const id = area.trim();
    if (!id) {
      setError("Enter an area id (a number like 0, or a dotted-quad like 0.0.0.0).");
      return;
    }
    if (!isEdit && existingAreas.includes(id)) {
      setError(`Area ${id} already exists.`);
      return;
    }
    const desired: OspfArea = {
      area: id,
      area_type: areaType,
      no_summary: areaType !== "normal" && noSummary,
      networks: networks.map((r) => r.value.trim()).filter(Boolean),
      ranges: ranges.map((r) => r.value.trim()).filter(Boolean),
    };
    setSaving(true);
    try {
      const applied = await applyOspfArea(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to area ${id}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} Area`} subtitle={isEdit ? `Area ${initial!.area}` : "OSPF area"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Area ID" hint="A number (0) or dotted-quad (0.0.0.0).">
            <input value={area} disabled={isEdit} onChange={(e) => setArea(e.target.value)} placeholder="0" className="clr-input" style={monoStyle} />
          </Field>
          <Field label="Area type">
            <Segmented
              items={[
                { value: "normal", label: "Normal" },
                { value: "stub", label: "Stub" },
                { value: "nssa", label: "NSSA" },
              ]}
              value={areaType}
              onChange={(v) => setAreaType(v as OspfAreaType)}
            />
          </Field>
        </div>

        {areaType !== "normal" && (
          <label className="flex items-center gap-2 cursor-pointer select-none" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
            <Switch on={noSummary} onChange={setNoSummary} />
            No summary (totally stubby — block inter-area summaries)
          </label>
        )}

        <ListEditor
          label="Networks"
          addLabel="Add Network"
          placeholder="10.0.0.0/24"
          emptyText="No networks — interfaces join this area explicitly instead."
          rows={networks}
          setRows={setNetworks}
        />

        <ListEditor
          label="Ranges"
          addLabel="Add Range"
          placeholder="10.0.0.0/16"
          emptyText="No area ranges (summarisation) configured."
          rows={ranges}
          setRows={setRanges}
        />

        {error && (
          <div className="alert alert-danger alert-sm">
            <Icon shape="exclamation-circle" size={14} className="alert-icon" />
            <div className="alert-text">{error}</div>
          </div>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Applying…" : isEdit ? "Apply Changes" : "Add Area"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}
